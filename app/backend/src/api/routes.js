/**
 * REST API Routes
 */

const express = require('express');
const router = express.Router();

const armor = require('../armor/modelArmor');
const registry = require('../registry/agentRegistry');
const memoryBank = require('../memory/memoryBank');
const erp = require('../erp/erpSimulator');
const warehouse = require('../warehouse/warehouseAgent');
const freight = require('../freight/freightAgent');
const observability = require('../observability/auditLog');
const orchestrator = require('../orchestrator/orchestrator');
const runtime = require('../runtime/agentRuntime');
const { issueToken, authMiddleware, bootstrapTokens } = require('../identity/agentIdentity');
const { db } = require('../db');

// ── Auth ───────────────────────────────────────────────────────────────────────

router.post('/auth/token', (req, res) => {
  const { subject_id } = req.body || {};
  if (!subject_id) return res.status(400).json({ error: 'subject_id required' });
  try {
    const token = issueToken(subject_id, subject_id.startsWith('agent-') ? 'agent' : 'user');
    res.json({ token, subject_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auth/bootstrap', (req, res) => {
  res.json(bootstrapTokens());
});

// ── Agent Registry ────────────────────────────────────────────────────────────

router.get('/registry/agents', authMiddleware(), (req, res) => {
  res.json(registry.list());
});

router.get('/registry/agents/:id', authMiddleware(), (req, res) => {
  const agent = registry.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

router.post('/registry/agents', authMiddleware(['admin']), (req, res) => {
  try {
    const agent = registry.register(req.body);
    res.status(201).json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Memory Bank ───────────────────────────────────────────────────────────────

router.get('/memory/vendors', authMiddleware(['memory:read']), (req, res) => {
  res.json(memoryBank.listVendors());
});

router.get('/memory/vendors/:id', authMiddleware(['memory:read']), (req, res) => {
  const vendor = memoryBank.getVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  res.json(vendor);
});

router.get('/memory/vendors/:id/history', authMiddleware(['memory:read']), (req, res) => {
  res.json(memoryBank.getVendorHistory(req.params.id, parseInt(req.query.limit) || 20));
});

router.get('/memory/buffers', authMiddleware(['memory:read']), (req, res) => {
  res.json(memoryBank.listBufferRules());
});

// ── Long-Term Agent Memories ──────────────────────────────────────────────────

router.get('/memory/memories', authMiddleware(['memory:read']), (req, res) => {
  const { agent_id, memory_type, limit } = req.query;
  res.json(memoryBank.listMemories({
    agent_id: agent_id || undefined,
    memory_type: memory_type || undefined,
    limit: parseInt(limit) || 50,
  }));
});

router.get('/memory/memories/search', authMiddleware(['memory:read']), (req, res) => {
  const { q, limit } = req.query;
  res.json(memoryBank.searchMemories(q || '', parseInt(limit) || 20));
});

router.get('/memory/memories/:id', authMiddleware(['memory:read']), (req, res) => {
  const record = memoryBank.getMemory(req.params.id);
  if (!record) return res.status(404).json({ error: 'Memory not found' });
  res.json(record);
});

router.post('/memory/memories', authMiddleware(['memory:write']), (req, res) => {
  try {
    const id = memoryBank.storeMemory(req.body);
    res.status(201).json({ id, ...memoryBank.getMemory(id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/memory/memories/:id', authMiddleware(['memory:write']), (req, res) => {
  const ok = memoryBank.deleteMemory(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Memory not found' });
  res.json({ deleted: true, id: req.params.id });
});

// ── ERP / SAP ────────────────────────────────────────────────────────────────

router.get('/erp/purchase-orders', authMiddleware(['erp:read']), (req, res) => {
  res.json(erp.listPOs(req.query.status));
});

router.get('/erp/purchase-orders/:id', authMiddleware(['erp:read']), (req, res) => {
  const po = erp.getPO(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  res.json(po);
});

router.get('/erp/sales-orders', authMiddleware(['erp:read']), (req, res) => {
  res.json(erp.listSOs(req.query.status));
});

router.get('/erp/sales-orders/:id', authMiddleware(['erp:read']), (req, res) => {
  const so = erp.getSO(req.params.id);
  if (!so) return res.status(404).json({ error: 'SO not found' });
  res.json(so);
});

router.get('/erp/inventory', authMiddleware(['erp:read']), (req, res) => {
  res.json(erp.listInventoryBuffers());
});

router.get('/erp/bom/:productCode', authMiddleware(['erp:read']), (req, res) => {
  res.json(erp.getBOM(req.params.productCode));
});

router.get('/erp/impact/:itemCode', authMiddleware(['erp:read']), (req, res) => {
  const delayDays = parseInt(req.query.delay_days) || 0;
  res.json(erp.calculateImpact(req.params.itemCode, delayDays));
});

// ── Warehouse Sub-Agent ────────────────────────────────────────────────────────

router.get('/warehouse/transfers', authMiddleware(['wms:read']), (req, res) => {
  res.json(warehouse.listTransferOrders(req.query.status));
});

router.post('/warehouse/transfer', authMiddleware(['wms:write']), (req, res) => {
  try {
    const result = warehouse.createTransferOrder({ ...req.body, session_id: req.body.session_id || 'manual' });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/warehouse/transfer/:id/approve', authMiddleware(['wms:write']), (req, res) => {
  const result = warehouse.approveTransferOrder(req.params.id, req.agent.sub);
  if (!result) return res.status(404).json({ error: 'Transfer order not found' });
  res.json(result);
});

// ── Freight Sub-Agent ─────────────────────────────────────────────────────────

router.get('/freight/requests', authMiddleware(['freight:read']), (req, res) => {
  res.json(freight.listFreightRequests(req.query.status));
});

router.post('/freight/request', authMiddleware(['freight:write']), (req, res) => {
  try {
    const result = freight.createFreightRequest({ ...req.body, session_id: req.body.session_id || 'manual' });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Observability ─────────────────────────────────────────────────────────────

router.get('/audit/logs', authMiddleware(['audit:read']), (req, res) => {
  res.json(observability.query({
    limit: parseInt(req.query.limit) || 50,
    offset: parseInt(req.query.offset) || 0,
    session_id: req.query.session_id,
    event_type: req.query.event_type,
    severity: req.query.severity,
  }));
});

router.get('/audit/session/:sessionId', authMiddleware(['audit:read']), (req, res) => {
  res.json(observability.getSessionTrace(req.params.sessionId));
});

router.get('/audit/stats', authMiddleware(['audit:read']), (req, res) => {
  res.json(observability.getSummaryStats());
});

// ── Model Armor ────────────────────────────────────────────────────────────────

router.post('/armor/scan', authMiddleware(), async (req, res) => {
  try {
    const result = await armor.scanAsync(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Orchestrator ──────────────────────────────────────────────────────────────

router.post('/orchestrator/ingest', armor.armorMiddleware, authMiddleware(['erp:write']), async (req, res) => {
  try {
    const result = await orchestrator.processEvent(req.body);
    res.status(result.status === 'blocked' ? 400 : 202).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/orchestrator/events', authMiddleware(['erp:read']), (req, res) => {
  res.json(orchestrator.listEvents(req.query.status, parseInt(req.query.limit) || 50));
});

router.get('/orchestrator/events/:id', authMiddleware(['erp:read']), (req, res) => {
  const event = orchestrator.getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

router.post('/orchestrator/events/:id/approve', authMiddleware(['erp:write']), (req, res) => {
  try {
    const result = orchestrator.approveEvent(req.params.id, req.agent.sub);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orchestrator/events/:id/reject', authMiddleware(['erp:write']), (req, res) => {
  try {
    const result = orchestrator.rejectEvent(req.params.id, req.agent.sub, req.body.reason);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Dashboard Summary ─────────────────────────────────────────────────────────

router.get('/dashboard/summary', authMiddleware(['erp:read']), (req, res) => {
  const allEvents = db.prepare('SELECT status, COUNT(*) as count FROM orchestration_events GROUP BY status').all();
  const pendingApprovals = db.prepare("SELECT COUNT(*) as c FROM orchestration_events WHERE status = 'awaiting_approval'").get().c;
  const delayedPOs = erp.listPOs('delayed');
  const atRiskSOs = erp.listSOs('at_risk');
  const totalRevenueAtRisk = atRiskSOs.reduce((s, so) => s + so.revenue, 0);
  const auditStats = observability.getSummaryStats();

  res.json({
    event_summary: allEvents,
    pending_approvals: pendingApprovals,
    delayed_pos: delayedPOs.length,
    at_risk_sos: atRiskSOs.length,
    total_revenue_at_risk: totalRevenueAtRisk,
    audit_stats: auditStats,
    system_status: 'operational',
    timestamp: new Date().toISOString(),
  });
});

// ── Credit Claims ─────────────────────────────────────────────────────────────

router.get('/erp/credit-claims', authMiddleware(['erp:read']), (req, res) => {
  const rows = db.prepare('SELECT * FROM credit_claims ORDER BY created_at DESC').all();
  res.json(rows);
});

// ── Simulate Inbound Event (demo helper) ──────────────────────────────────────

router.post('/demo/simulate', authMiddleware(), async (req, res) => {
  const demos = [
    { source: 'supplier_email', vendor_id: 'vendor-001', po_number: 'PO-2025-001', reported_delay_days: 6, notes: 'Port congestion in Shanghai has caused a 6-day delay. Expected new ship date updated.' },
    { source: 'carrier_webhook', vendor_id: 'vendor-003', po_number: 'PO-2025-002', reported_delay_days: 5, notes: 'Carrier tracking update: shipment PO-2025-002 further delayed by 5 business days.' },
    { source: 'supplier_email', vendor_id: 'vendor-004', po_number: 'PO-2025-004', reported_delay_days: 3, notes: 'Manufacturing line issue resolved. Shipment now delayed 3 days.' },
  ];

  const pick = req.body.scenario !== undefined
    ? demos[req.body.scenario % demos.length]
    : demos[Math.floor(Math.random() * demos.length)];

  try {
    const result = await orchestrator.processEvent(pick);
    res.status(202).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Runtime ─────────────────────────────────────────────────────────────

router.get('/runtime/sessions', authMiddleware(['admin']), async (req, res) => {
  try {
    const sessions = await runtime.listActiveSessions();
    res.json({ sessions, count: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/runtime/sessions/:sessionId', authMiddleware(), async (req, res) => {
  try {
    const { checkpointSession, resumeSession } = runtime;
    // Attempt to resume from Firestore if not in memory
    const session = await resumeSession(req.params.sessionId).catch(() => null);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Heartbeat — called by Cloud Scheduler every 5 minutes
router.post('/runtime/heartbeat', authMiddleware(), async (req, res) => {
  try {
    const result = await runtime.heartbeat();
    res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Human-approval reminder — called by Cloud Tasks after delay
router.post('/orchestrator/events/:id/remind', authMiddleware(['erp:read']), async (req, res) => {
  const event = orchestrator.getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status !== 'awaiting_approval') {
    return res.json({ message: 'No reminder needed — event already resolved', status: event.status });
  }
  // Re-broadcast the approval_required event as a reminder
  // The orchestrator's broadcast function is not exported; we log and return the pending event
  observability.log({
    event_type: 'APPROVAL_REMINDER',
    agent_id: 'agent-orchestrator-v1',
    session_id: event.session_id,
    payload: { eventId: req.params.id, reminder: true },
    outcome: 'pending_human_approval',
    severity: 'warn',
  });
  res.json({ message: 'Reminder logged', eventId: req.params.id, status: event.status });
});

module.exports = router;
