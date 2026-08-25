/**
 * Orchestrator Core – Event-Driven Workflow Engine
 *
 * Implements the full 4-step workflow:
 *  1. Inbound Event Ingestion & Model Armor Security Screening
 *  2. Context Retrieval (Memory Bank + ERP Impact Analysis)
 *  3. Sub-Agent Coordination via Agent Gateway (Warehouse + Freight)
 *  4. Remediation Staging & Human Sign-Off
 *
 * GCP Enhancements:
 *  - Cloud Monitoring custom metrics emitted at each workflow step
 *  - Cloud Tasks used for async human-approval reminder scheduling
 *  - Cloud Pub/Sub event bus: remediation plans published to the
 *    "orchestrator-events" topic so downstream consumers (ERP, ITSM,
 *    Slack bots) can subscribe without polling.
 *
 * Spec references: §3 – End-to-End Orchestration Workflow
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const armor = require('../armor/modelArmor');
const memoryBank = require('../memory/memoryBank');
const erp = require('../erp/erpSimulator');
const gateway = require('../gateway/agentGateway');
const observability = require('../observability/auditLog');
const logger = require('../logger');

// ── GCP config ────────────────────────────────────────────────────────────────

const GCP_PROJECT  = process.env.GOOGLE_CLOUD_PROJECT  || 'ship-date-drift';
const GCP_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const PUBSUB_TOPIC_ENABLED  = process.env.PUBSUB_EVENTS_ENABLED  !== 'false';
const CLOUD_TASKS_ENABLED   = process.env.CLOUD_TASKS_ENABLED    !== 'false';
const PUBSUB_TOPIC_ID = process.env.PUBSUB_TOPIC_ID || 'orchestrator-events';
const CLOUD_TASKS_QUEUE = process.env.CLOUD_TASKS_QUEUE || 'orchestrator-approval-reminders';
const APPROVAL_REMINDER_DELAY_SECONDS = parseInt(process.env.APPROVAL_REMINDER_DELAY_SECONDS || '3600', 10); // 1h default

// ── Cloud Pub/Sub event publisher ─────────────────────────────────────────────

/**
 * Publish an orchestration event to the Cloud Pub/Sub topic.
 *
 * Topic: "orchestrator-events"
 * This decouples the orchestrator from downstream consumers:
 *  - ERP connectors can subscribe to apply SO date changes.
 *  - Slack/Teams bots can subscribe for approval card delivery.
 *  - BigQuery streaming insert for analytics.
 *
 * Message attributes:
 *  - eventType : 'REMEDIATION_STAGED' | 'EVENT_APPROVED' | 'EVENT_BLOCKED' | etc.
 *  - sessionId : orchestration session ID
 *  - agentId   : 'agent-orchestrator-v1'
 *
 * Spec reference: §3 – Async event-driven architecture
 */
async function _publishToPubSub(eventType, data) {
  if (!PUBSUB_TOPIC_ENABLED) return;
  try {
    const { PubSub } = require('@google-cloud/pubsub');
    const pubsub = new PubSub({ projectId: GCP_PROJECT });
    const topic = pubsub.topic(PUBSUB_TOPIC_ID);
    const message = {
      data: Buffer.from(JSON.stringify(data)),
      attributes: {
        eventType,
        sessionId: data.sessionId || data.session_id || '',
        agentId: 'agent-orchestrator-v1',
        timestamp: new Date().toISOString(),
      },
    };
    const messageId = await topic.publishMessage(message);
    logger.info(`Pub/Sub: published ${eventType}`, { messageId, topic: PUBSUB_TOPIC_ID });
  } catch (err) {
    logger.warn('Pub/Sub: publish failed (non-critical)', { eventType, error: err.message });
  }
}

// ── Cloud Tasks approval reminder ─────────────────────────────────────────────

/**
 * Schedule a human-approval reminder via Cloud Tasks.
 *
 * When a remediation plan is staged for human approval, a Cloud Tasks task
 * is created with a configurable delay (default 1 hour). If the approver
 * has not responded, the task fires a reminder to the backend's
 * POST /api/orchestrator/events/{eventId}/remind endpoint.
 *
 * Queue: "orchestrator-approval-reminders" in us-central1
 * Spec reference: §4 – Human Sign-Off (1-click)
 */
async function _scheduleApprovalReminder(eventId, sessionId) {
  if (!CLOUD_TASKS_ENABLED) return;
  try {
    const { CloudTasksClient } = require('@google-cloud/tasks');
    const client = new CloudTasksClient();
    const parent = client.queuePath(GCP_PROJECT, GCP_LOCATION, CLOUD_TASKS_QUEUE);
    const backendUrl = process.env.BACKEND_URL ||
      'https://orchestrator-backend-628095447119.us-central1.run.app';

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: `${backendUrl}/api/orchestrator/events/${eventId}/remind`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ eventId, sessionId, reminder: true })).toString('base64'),
        // Use the orchestrator SA identity so the backend can verify the caller
        oidcToken: {
          serviceAccountEmail: `orchestrator-agent@${GCP_PROJECT}.iam.gserviceaccount.com`,
          audience: backendUrl,
        },
      },
      scheduleTime: {
        seconds: Math.floor(Date.now() / 1000) + APPROVAL_REMINDER_DELAY_SECONDS,
      },
    };

    const [response] = await client.createTask({ parent, task });
    logger.info('Cloud Tasks: approval reminder scheduled', {
      taskName: response.name,
      delaySeconds: APPROVAL_REMINDER_DELAY_SECONDS,
      eventId,
    });
  } catch (err) {
    logger.warn('Cloud Tasks: reminder scheduling failed (non-critical)', { error: err.message, eventId });
  }
}

// ── WebSocket broadcast registry (injected at startup) ─────────────────────

let _broadcast = null;
function setBroadcast(fn) { _broadcast = fn; }
function broadcast(event, data) { if (_broadcast) _broadcast(event, data); }

// ── Credit Claim Generator ────────────────────────────────────────────────────

function generateCreditClaim(vendor, po, delayDays) {
  const id = uuidv4();
  const claim_number = `CC-${Date.now().toString().slice(-6)}`;
  const poValue = po.quantity * po.unit_cost;
  const penaltyAmount = Math.min(
    poValue * vendor.penalty_rate * delayDays,
    poValue * 0.10   // cap at 10% of PO value
  );

  db.prepare(`
    INSERT OR IGNORE INTO credit_claims (id, claim_number, vendor_id, po_id, delay_days, penalty_amount, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `).run(id, claim_number, vendor.id, po.id, delayDays, Math.round(penaltyAmount * 100) / 100);

  return { id, claim_number, vendor_id: vendor.id, vendor_name: vendor.name, po_number: po.po_number, delay_days: delayDays, penalty_amount: Math.round(penaltyAmount * 100) / 100, status: 'draft' };
}

// ── Main Orchestration Workflow ───────────────────────────────────────────────

/**
 * Primary entry point – process an inbound event (supplier email / webhook).
 *
 * payload shape:
 * {
 *   source: 'supplier_email' | 'carrier_webhook',
 *   vendor_id: string,
 *   po_number: string,
 *   reported_delay_days: number,
 *   notes: string
 * }
 */
async function processEvent(rawPayload) {
  const sessionId = uuidv4();
  const startedAt = new Date().toISOString();
  const reasoningChain = [];

  logger.info(`[Orchestrator] New event received`, { sessionId });

  // ── STEP 1: Model Armor Screening ─────────────────────────────────────────
  const scanResult = armor.scan(rawPayload);
  reasoningChain.push({
    step: 1,
    description: 'Model Armor input scanning',
    result: scanResult.safe ? 'PASS – no threats detected' : `BLOCKED – ${scanResult.threats.length} threat(s): ${scanResult.threats.map(t => t.type).join(', ')}`,
    scan_id: scanResult.scanId,
    pii_masked: scanResult.piiMasked,
  });

  // Create the event record
  const eventId = uuidv4();
  db.prepare(`
    INSERT INTO orchestration_events (id, session_id, event_source, raw_payload, sanitized_payload, status)
    VALUES (?, ?, ?, ?, ?, 'received')
  `).run(eventId, sessionId, rawPayload.source || 'unknown', JSON.stringify(rawPayload), JSON.stringify(scanResult.sanitized));

  observability.log({
    event_type: 'EVENT_INGESTED',
    agent_id: 'agent-orchestrator-v1',
    session_id: sessionId,
    payload: { eventId, source: rawPayload.source, scan_result: scanResult },
    reasoning_chain: [reasoningChain[0]],
    outcome: scanResult.safe ? 'success' : 'blocked',
    severity: scanResult.safe ? 'info' : 'warn',
  });

  if (!scanResult.safe) {
    db.prepare("UPDATE orchestration_events SET status = 'blocked', processing_steps = ? WHERE id = ?")
      .run(JSON.stringify(reasoningChain), eventId);
    broadcast('event_blocked', { sessionId, threats: scanResult.threats });
    // Cloud Monitoring: increment armor_blocks counter
    observability.metrics.incrementArmorBlocks().catch(() => {});
    // Cloud Pub/Sub: notify downstream subscribers about the blocked event
    _publishToPubSub('EVENT_BLOCKED', { sessionId, eventId, threats: scanResult.threats }).catch(() => {});
    return { sessionId, eventId, status: 'blocked', threats: scanResult.threats };
  }

  const payload = scanResult.sanitized;
  broadcast('event_received', { sessionId, source: payload.source });

  // ── STEP 2: Context Retrieval & ERP Impact Analysis ───────────────────────
  const vendor = memoryBank.getVendor(payload.vendor_id);
  const vendorHistory = vendor ? memoryBank.getVendorHistory(payload.vendor_id, 5) : [];
  const po = erp.getPOByNumber(payload.po_number);

  reasoningChain.push({
    step: 2,
    description: 'Memory Bank context retrieval',
    result: vendor
      ? `Vendor: ${vendor.name} | Reliability: ${(vendor.reliability_score * 100).toFixed(0)}% | SLA: ${vendor.sla_clause}`
      : 'Vendor not found in Memory Bank',
  });

  if (!po) {
    reasoningChain.push({ step: '2b', description: 'ERP PO lookup', result: `PO ${payload.po_number} not found in ERP` });
    db.prepare("UPDATE orchestration_events SET status = 'failed', processing_steps = ? WHERE id = ?")
      .run(JSON.stringify(reasoningChain), eventId);
    return { sessionId, eventId, status: 'failed', error: `PO ${payload.po_number} not found` };
  }

  const delayDays = parseInt(payload.reported_delay_days, 10) || 0;
  const updatedPO = erp.updatePODelay(po.id, addDays(delayDays), delayDays);
  const impactedSOs = erp.calculateImpact(po.item_code, delayDays);
  const totalRevenueAtRisk = impactedSOs.reduce((s, so) => s + so.revenue_at_risk, 0);

  reasoningChain.push({
    step: '2b',
    description: 'ERP BOM & Sales Order impact analysis',
    result: `PO ${po.po_number} delayed ${delayDays} days | ${impactedSOs.length} Sales Orders at risk | Revenue at risk: $${totalRevenueAtRisk.toLocaleString()}`,
    impacted_so_count: impactedSOs.length,
    total_revenue_at_risk: totalRevenueAtRisk,
  });

  // Update Sales Orders in ERP
  for (const so of impactedSOs) {
    erp.updateSODeliveryDate(so.id, so.revised_delivery_date);
  }

  observability.log({
    event_type: 'ERP_IMPACT_ANALYSIS',
    agent_id: 'agent-orchestrator-v1',
    session_id: sessionId,
    payload: { po: updatedPO, impacted_sos: impactedSOs, vendor, vendor_history: vendorHistory },
    reasoning_chain: reasoningChain.slice(1),
    outcome: 'success',
  });

  // Cloud Monitoring: update revenue at risk gauge
  observability.metrics.setRevenueAtRisk(totalRevenueAtRisk).catch(() => {});

  broadcast('impact_analysis', { sessionId, delayDays, impactedSOs: impactedSOs.length, totalRevenueAtRisk });

  // ── STEP 3: Sub-Agent Coordination ────────────────────────────────────────
  const subAgentResults = [];

  // 3a – Warehouse Transfer Order
  const bufferInfo = erp.getInventoryBuffer(po.item_code);
  const needsWTO = bufferInfo.some(b => b.on_hand < b.reorder_point);

  reasoningChain.push({
    step: '3a',
    description: 'Warehouse sub-agent: inventory buffer assessment',
    result: needsWTO
      ? `Buffer below reorder point for ${po.item_code} – dispatching WTO`
      : `Buffer adequate for ${po.item_code} – no WTO needed`,
  });

  if (needsWTO) {
    const wtoTask = {
      target_agent: 'agent-warehouse-v1',
      action: 'create_transfer_order',
      payload: {
        item_code: po.item_code,
        from_location: 'Central Warehouse – Chicago',
        to_location: 'Regional DC – Dallas',
        quantity: Math.min(po.quantity, 1000),
        delay_days: delayDays,
      },
    };
    const wtoResult = await gateway.dispatch(wtoTask, sessionId);
    subAgentResults.push({ type: 'WTO', ...wtoResult });
    reasoningChain[reasoningChain.length - 1].wto_result = wtoResult;
  }

  // 3b – Freight Request
  const freightTask = {
    target_agent: 'agent-freight-v1',
    action: 'create_freight_request',
    payload: {
      po_id: po.id,
      item_code: po.item_code,
      quantity: po.quantity,
      delay_days: delayDays,
      origin: vendor ? `${vendor.region} Distribution Hub` : 'Supplier Origin',
      destination: 'NA Central Warehouse',
    },
  };
  const freightResult = await gateway.dispatch(freightTask, sessionId);
  subAgentResults.push({ type: 'FREIGHT', ...freightResult });

  reasoningChain.push({
    step: '3b',
    description: 'Freight sub-agent: expedited shipping assessment',
    result: freightResult.status === 'completed'
      ? `Freight request ${freightResult.result?.fr_number} created | Mode: ${freightResult.result?.mode} | Cost: $${freightResult.result?.estimated_cost}`
      : `Freight requires human approval: ${freightResult.reason}`,
    freight_result: freightResult,
  });

  observability.log({
    event_type: 'SUB_AGENT_COORDINATION',
    agent_id: 'agent-orchestrator-v1',
    session_id: sessionId,
    payload: { sub_agent_results: subAgentResults },
    reasoning_chain: reasoningChain.slice(2),
    outcome: 'success',
  });

  broadcast('sub_agents_completed', { sessionId, subAgentResults });

  // ── STEP 4: Remediation Staging & Human Sign-Off ──────────────────────────
  const creditClaim = vendor ? generateCreditClaim(vendor, po, delayDays) : null;

  reasoningChain.push({
    step: 4,
    description: 'Remediation plan staged – awaiting human sign-off',
    result: [
      `ERP: PO ${po.po_number} updated with ${delayDays}-day delay`,
      `ERP: ${impactedSOs.length} Sales Orders revised`,
      needsWTO ? `WMS: WTO staged for inventory rebalancing` : 'WMS: No action required',
      `Freight: ${freightResult.status === 'completed' ? `${freightResult.result?.mode} request ${freightResult.result?.fr_number} created` : 'Pending approval'}`,
      creditClaim ? `Credit Claim ${creditClaim.claim_number}: $${creditClaim.penalty_amount}` : 'No credit claim',
    ].join(' | '),
  });

  const remediationPlan = {
    session_id: sessionId,
    event_id: eventId,
    vendor: vendor ? { id: vendor.id, name: vendor.name, sla_clause: vendor.sla_clause } : null,
    po: { id: po.id, po_number: po.po_number, item_code: po.item_code, delay_days: delayDays },
    impacted_sales_orders: impactedSOs,
    total_revenue_at_risk: totalRevenueAtRisk,
    sub_agent_results: subAgentResults,
    credit_claim: creditClaim,
    requires_human_approval: subAgentResults.some(r => r.status === 'requires_human_approval'),
    created_at: startedAt,
  };

  db.prepare(`
    UPDATE orchestration_events
    SET status = 'awaiting_approval', processing_steps = ?, remediation_plan = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(reasoningChain), JSON.stringify(remediationPlan), eventId);

  observability.log({
    event_type: 'REMEDIATION_STAGED',
    agent_id: 'agent-orchestrator-v1',
    session_id: sessionId,
    payload: remediationPlan,
    reasoning_chain: [reasoningChain[reasoningChain.length - 1]],
    outcome: 'pending_human_approval',
  });

  // Cloud Monitoring: track pending approvals and total events
  observability.metrics.incrementEventsProcessed().catch(() => {});
  const pendingCount = db.prepare("SELECT COUNT(*) as c FROM orchestration_events WHERE status = 'awaiting_approval'").get().c;
  observability.metrics.setPendingApprovals(pendingCount).catch(() => {});

  // Cloud Pub/Sub: publish remediation plan for downstream consumers
  _publishToPubSub('REMEDIATION_STAGED', { sessionId, eventId, remediationPlan }).catch(() => {});

  // Cloud Tasks: schedule a human-approval reminder
  _scheduleApprovalReminder(eventId, sessionId).catch(() => {});

  broadcast('approval_required', { sessionId, eventId, remediationPlan });

  return {
    sessionId,
    eventId,
    status: 'awaiting_approval',
    remediation_plan: remediationPlan,
    reasoning_chain: reasoningChain,
  };
}

// ── Human Approval ────────────────────────────────────────────────────────────

function approveEvent(eventId, approvedBy) {
  const event = db.prepare('SELECT * FROM orchestration_events WHERE id = ?').get(eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);

  db.prepare(`
    UPDATE orchestration_events
    SET human_approval_status = 'approved', approved_by = ?, approved_at = datetime('now'), status = 'completed', updated_at = datetime('now')
    WHERE id = ?
  `).run(approvedBy, eventId);

  observability.log({
    event_type: 'HUMAN_APPROVAL',
    agent_id: 'agent-orchestrator-v1',
    session_id: event.session_id,
    payload: { eventId, approved_by: approvedBy },
    outcome: 'approved',
  });

  // Cloud Pub/Sub: notify downstream systems about approval
  _publishToPubSub('EVENT_APPROVED', { eventId, sessionId: event.session_id, approvedBy }).catch(() => {});

  // Update pending approvals metric
  const pendingAfterApproval = db.prepare("SELECT COUNT(*) as c FROM orchestration_events WHERE status = 'awaiting_approval'").get().c;
  observability.metrics.setPendingApprovals(pendingAfterApproval).catch(() => {});

  broadcast('event_approved', { eventId, session_id: event.session_id, approved_by: approvedBy });

  return db.prepare('SELECT * FROM orchestration_events WHERE id = ?').get(eventId);
}

function rejectEvent(eventId, rejectedBy, reason) {
  const event = db.prepare('SELECT * FROM orchestration_events WHERE id = ?').get(eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);

  db.prepare(`
    UPDATE orchestration_events
    SET human_approval_status = 'rejected', approved_by = ?, status = 'rejected', updated_at = datetime('now')
    WHERE id = ?
  `).run(rejectedBy, eventId);

  observability.log({
    event_type: 'HUMAN_REJECTION',
    agent_id: 'agent-orchestrator-v1',
    session_id: event.session_id,
    payload: { eventId, rejected_by: rejectedBy, reason },
    outcome: 'rejected',
  });

  broadcast('event_rejected', { eventId, session_id: event.session_id, rejected_by: rejectedBy, reason });
  return db.prepare('SELECT * FROM orchestration_events WHERE id = ?').get(eventId);
}

// ── Query API ────────────────────────────────────────────────────────────────

function listEvents(status, limit = 50) {
  let events;
  if (status) {
    events = db.prepare('SELECT * FROM orchestration_events WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
  } else {
    events = db.prepare('SELECT * FROM orchestration_events ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  return events.map(e => ({
    ...e,
    raw_payload: e.raw_payload ? JSON.parse(e.raw_payload) : null,
    sanitized_payload: e.sanitized_payload ? JSON.parse(e.sanitized_payload) : null,
    processing_steps: e.processing_steps ? JSON.parse(e.processing_steps) : [],
    remediation_plan: e.remediation_plan ? JSON.parse(e.remediation_plan) : null,
  }));
}

function getEvent(id) {
  const e = db.prepare('SELECT * FROM orchestration_events WHERE id = ?').get(id);
  if (!e) return null;
  return {
    ...e,
    raw_payload: e.raw_payload ? JSON.parse(e.raw_payload) : null,
    sanitized_payload: e.sanitized_payload ? JSON.parse(e.sanitized_payload) : null,
    processing_steps: e.processing_steps ? JSON.parse(e.processing_steps) : [],
    remediation_plan: e.remediation_plan ? JSON.parse(e.remediation_plan) : null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

module.exports = { processEvent, approveEvent, rejectEvent, listEvents, getEvent, setBroadcast };
