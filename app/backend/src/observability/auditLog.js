/**
 * Agent Observability – Audit Logs, Reasoning Traces, Cloud Trace & Cloud Monitoring
 *
 * Implements §2.F – Agent Observability:
 *
 *  Audit Ledger:
 *   - Append-only SQLite (local, always available, used by REST API).
 *   - Structured JSON stdout → Cloud Logging (auto-ingested by Cloud Run).
 *   - 'logging.googleapis.com/trace' field links log entries to Cloud Trace spans
 *     for correlated log → trace drill-down in the GCP console.
 *
 *  OpenTelemetry / Cloud Trace:
 *   - Every audit event emits an OTel span via the Node SDK (initialised in
 *     tracing.js) and exported to Cloud Trace via OTLP/gRPC.
 *   - W3C traceparent propagation links Node.js + ADK (Python) spans in a
 *     single Cloud Trace waterfall (cross-language distributed tracing).
 *
 *  Cloud Monitoring Custom Metrics:
 *   - orchestrator/events_processed    (CUMULATIVE counter)
 *   - orchestrator/revenue_at_risk     (GAUGE, in USD)
 *   - orchestrator/armor_blocks        (CUMULATIVE counter)
 *   - orchestrator/pending_approvals   (GAUGE)
 *   Written via the Cloud Monitoring API (monitoring.googleapis.com).
 *
 *  Immutability:
 *   - SQLite audit_logs has no DELETE/UPDATE path in this module.
 *   - Cloud Logging log sink with LOCKED retention ensures append-only
 *     compliance in production.
 *
 * Spec reference: §2.F – Agent Observability
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const logger = require('../logger');

// ── OpenTelemetry setup ───────────────────────────────────────────────────────

let _tracer = null;
let _propagator = null;

/**
 * Lazy-init OTel tracer. Called once on first use.
 * Uses @opentelemetry/sdk-node + Cloud Trace OTLP exporter if available.
 * Gracefully degrades to a no-op tracer if the SDK is not installed.
 */
function _getTracer() {
  if (_tracer) return _tracer;

  try {
    const { trace, context } = require('@opentelemetry/api');
    const { W3CTraceContextPropagator } = require('@opentelemetry/core');
    _propagator = new W3CTraceContextPropagator();
    _tracer = trace.getTracer('orchestrator-backend', '1.0.0');
    return _tracer;
  } catch (_) {
    // OTel SDK not installed — use no-op stub
    _tracer = {
      startActiveSpan: (name, opts, fn) => {
        if (typeof opts === 'function') return opts({ end: () => {}, setAttribute: () => {}, setStatus: () => {}, recordException: () => {} });
        return fn({ end: () => {}, setAttribute: () => {}, setStatus: () => {}, recordException: () => {} });
      },
      startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {}, recordException: () => {} }),
    };
    return _tracer;
  }
}

/**
 * Extract W3C traceparent from an incoming request header and return
 * an OTel Context object that carries the remote span parent.
 * Returns undefined if header is absent or OTel is not available.
 */
function extractTraceContext(headers) {
  try {
    const { propagation, context } = require('@opentelemetry/api');
    const carrier = { traceparent: headers['traceparent'], tracestate: headers['tracestate'] };
    return propagation.extract(context.active(), carrier);
  } catch (_) {
    return undefined;
  }
}

/**
 * Inject W3C traceparent into an outgoing headers object.
 * Used when Node.js makes HTTP calls to ADK / Cloud Run so spans are linked.
 */
function injectTraceContext(headers = {}) {
  try {
    const { propagation, context } = require('@opentelemetry/api');
    propagation.inject(context.active(), headers);
  } catch (_) {}
  return headers;
}

// ── Audit log core ────────────────────────────────────────────────────────────

/**
 * Append an audit record and emit an OTel span.
 *
 * @param {object} opts
 * @param {string} opts.event_type       - e.g. 'INGEST', 'ERP_QUERY', 'GATEWAY_DISPATCH'
 * @param {string} [opts.agent_id]       - which agent emitted this
 * @param {string} [opts.session_id]     - orchestration session
 * @param {object} [opts.payload]        - arbitrary structured data
 * @param {Array}  [opts.reasoning_chain]- array of { step, description, result }
 * @param {string} [opts.outcome]        - 'success' | 'failure' | 'pending'
 * @param {string} [opts.severity]       - 'info' | 'warn' | 'error'
 * @param {string} [opts.traceparent]    - W3C traceparent from caller (links Cloud Trace spans)
 */
function log({ event_type, agent_id, session_id, payload, reasoning_chain, outcome, severity = 'info', traceparent }) {
  const id = uuidv4();

  // Write to SQLite
  db.prepare(`
    INSERT INTO audit_logs (id, event_type, agent_id, session_id, payload, reasoning_chain, outcome, severity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    event_type,
    agent_id || null,
    session_id || null,
    payload ? JSON.stringify(payload) : null,
    reasoning_chain ? JSON.stringify(reasoning_chain) : null,
    outcome || null,
    severity
  );

  // Structured Cloud Logging entry (picked up by Cloud Logging agent)
  const logEntry = {
    severity: severity.toUpperCase(),
    message: `[AUDIT] ${event_type}`,
    auditId: id,
    sessionId: session_id,
    agentId: agent_id,
    outcome,
    eventType: event_type,
    // W3C trace context for Cloud Trace correlation
    ...(traceparent ? { 'logging.googleapis.com/trace': traceparent } : {}),
  };
  logger.info(logEntry.message, logEntry);

  // Emit OTel span for Cloud Trace
  const tracer = _getTracer();
  const span = tracer.startSpan(`audit.${event_type}`, {
    attributes: {
      'audit.id': id,
      'audit.event_type': event_type,
      'audit.agent_id': agent_id || '',
      'audit.session_id': session_id || '',
      'audit.outcome': outcome || '',
      'audit.severity': severity,
    },
  });
  span.end();

  return id;
}

// ── Query API (unchanged interface) ──────────────────────────────────────────

function query({ limit = 50, offset = 0, session_id, event_type, severity } = {}) {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];

  if (session_id)  { sql += ' AND session_id = ?';  params.push(session_id); }
  if (event_type)  { sql += ' AND event_type = ?';   params.push(event_type); }
  if (severity)    { sql += ' AND severity = ?';     params.push(severity); }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : null,
    reasoning_chain: row.reasoning_chain ? JSON.parse(row.reasoning_chain) : [],
  }));
}

function getSessionTrace(sessionId) {
  return db.prepare(
    'SELECT * FROM audit_logs WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId).map(row => ({
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : null,
    reasoning_chain: row.reasoning_chain ? JSON.parse(row.reasoning_chain) : [],
  }));
}

function getSummaryStats() {
  return {
    total: db.prepare('SELECT COUNT(*) as c FROM audit_logs').get().c,
    byType: db.prepare('SELECT event_type, COUNT(*) as count FROM audit_logs GROUP BY event_type').all(),
    bySeverity: db.prepare('SELECT severity, COUNT(*) as count FROM audit_logs GROUP BY severity').all(),
    recentErrors: db.prepare("SELECT * FROM audit_logs WHERE severity = 'error' ORDER BY created_at DESC LIMIT 5").all().map(r => ({
      ...r, payload: r.payload ? JSON.parse(r.payload) : null, reasoning_chain: r.reasoning_chain ? JSON.parse(r.reasoning_chain) : [],
    })),
  };
}

// ── Cloud Monitoring Custom Metrics ──────────────────────────────────────────

/**
 * Write a custom metric data point to Cloud Monitoring.
 *
 * Metric types (all under custom.googleapis.com/orchestrator/):
 *   events_processed  – CUMULATIVE INT64 counter (value=1 per call)
 *   revenue_at_risk   – GAUGE DOUBLE (value in USD)
 *   armor_blocks      – CUMULATIVE INT64 counter (value=1 per call)
 *   pending_approvals – GAUGE INT64
 *
 * Spec reference: §2.F – Agent Observability (Cloud Monitoring)
 *
 * @param {string} metricType  - one of the metric names above
 * @param {number} value       - data point value
 * @param {string} metricKind  - 'GAUGE' | 'CUMULATIVE'
 * @param {string} valueType   - 'INT64' | 'DOUBLE'
 */
async function writeCustomMetric(metricType, value, { metricKind = 'GAUGE', valueType = 'INT64' } = {}) {
  const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'ship-date-drift';
  try {
    const { MetricServiceClient } = require('@google-cloud/monitoring');
    const client = new MetricServiceClient();
    const projectName = client.projectPath(GCP_PROJECT);
    const now = new Date();
    const seconds = Math.floor(now.getTime() / 1000);

    const timeSeries = [{
      metric: {
        type: `custom.googleapis.com/orchestrator/${metricType}`,
        labels: { service: 'orchestrator-backend' },
      },
      resource: {
        type: 'global',
        labels: { project_id: GCP_PROJECT },
      },
      points: [{
        interval: {
          endTime: { seconds },
          ...(metricKind === 'CUMULATIVE' ? { startTime: { seconds: seconds - 60 } } : {}),
        },
        value: valueType === 'DOUBLE'
          ? { doubleValue: value }
          : { int64Value: String(Math.round(value)) },
      }],
      metricKind,
      valueType,
    }];

    await client.createTimeSeries({ name: projectName, timeSeries });
  } catch (err) {
    // Non-critical — metrics write failure should not affect orchestration
    // logger.warn omitted to avoid log spam in dev environments
  }
}

/**
 * Convenience helpers for the four orchestrator custom metrics.
 * These are called from orchestrator.js at the appropriate workflow step.
 */
const metrics = {
  /** Increment events_processed counter after a workflow completes. */
  incrementEventsProcessed: () => writeCustomMetric('events_processed', 1, { metricKind: 'CUMULATIVE', valueType: 'INT64' }),
  /** Record current total revenue at risk (USD) as a GAUGE. */
  setRevenueAtRisk: (usd) => writeCustomMetric('revenue_at_risk', usd, { metricKind: 'GAUGE', valueType: 'DOUBLE' }),
  /** Increment armor_blocks counter when Model Armor blocks a request. */
  incrementArmorBlocks: () => writeCustomMetric('armor_blocks', 1, { metricKind: 'CUMULATIVE', valueType: 'INT64' }),
  /** Set current pending_approvals gauge. */
  setPendingApprovals: (count) => writeCustomMetric('pending_approvals', count, { metricKind: 'GAUGE', valueType: 'INT64' }),
};

module.exports = {
  log,
  query,
  getSessionTrace,
  getSummaryStats,
  extractTraceContext,
  injectTraceContext,
  writeCustomMetric,
  metrics,
};
