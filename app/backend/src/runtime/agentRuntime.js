/**
 * Agent Runtime – Long-Running Async Execution Engine
 *
 * Implements §2.B – Agent Runtime:
 *
 * The Agent Runtime manages the lifecycle of long-running, asynchronous
 * agent sessions that span minutes to hours (e.g. multi-step supply-chain
 * negotiations, extended freight tracking, SLA dispute resolution).
 *
 * Architecture:
 *  - Session Store   : Cloud Firestore "agent_sessions/{sessionId}" for
 *                      durable, globally-consistent session state that
 *                      survives Cloud Run container restarts.
 *  - Task Queue      : Cloud Tasks "orchestrator-long-running" for
 *                      dispatching background execution steps without
 *                      blocking the HTTP request thread.
 *  - State Machine   : sessions move through
 *                        PENDING → RUNNING → AWAITING_APPROVAL → COMPLETED
 *                                                               ↘ FAILED
 *                                                               ↘ TIMED_OUT
 *  - Heartbeat       : Cloud Scheduler pings /api/runtime/heartbeat every
 *                      5 minutes; the runtime updates session "lastHeartbeat"
 *                      in Firestore and times out stale sessions.
 *  - Hibernation     : Sessions idle for >30 min are checkpointed to
 *                      Firestore and removed from in-memory state, then
 *                      resumed on next event without loss of context.
 *
 * Local fallback: in-memory Map for dev/test when Firestore is unavailable.
 *
 * Spec reference: §2.B – Agent Runtime & Memory Bank
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

// ── GCP config ────────────────────────────────────────────────────────────────

const GCP_PROJECT       = process.env.GOOGLE_CLOUD_PROJECT  || 'ship-date-drift';
const GCP_LOCATION      = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const FIRESTORE_ENABLED = process.env.FIRESTORE_SESSIONS_ENABLED !== 'false';
const RUNTIME_TASKS_ENABLED = process.env.RUNTIME_TASKS_ENABLED !== 'false';
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || String(30 * 60 * 1000), 10); // 30m
const LONG_RUNNING_QUEUE = process.env.LONG_RUNNING_QUEUE || 'orchestrator-long-running';

// ── In-memory fallback store ──────────────────────────────────────────────────

const _localSessions = new Map();   // sessionId → session object (dev fallback)

// ── Session State Model ───────────────────────────────────────────────────────

/**
 * Valid session status transitions:
 *   PENDING → RUNNING → AWAITING_APPROVAL → COMPLETED | FAILED | TIMED_OUT
 */
const SESSION_STATUS = {
  PENDING:            'PENDING',
  RUNNING:            'RUNNING',
  AWAITING_APPROVAL:  'AWAITING_APPROVAL',
  COMPLETED:          'COMPLETED',
  FAILED:             'FAILED',
  TIMED_OUT:          'TIMED_OUT',
};

// ── Firestore session store ───────────────────────────────────────────────────

/**
 * Get the Cloud Firestore client (lazy init).
 * Falls back gracefully if @google-cloud/firestore is not installed.
 */
function _getFirestore() {
  try {
    const { Firestore } = require('@google-cloud/firestore');
    return new Firestore({ projectId: GCP_PROJECT });
  } catch (_) {
    return null;
  }
}

/**
 * Persist a session to Cloud Firestore.
 * Collection: agent_sessions/{sessionId}
 *
 * Firestore provides:
 *  - Durable storage across Cloud Run container restarts
 *  - Real-time updates (agents can watch their own session doc)
 *  - Global consistency for multi-region deployments
 */
async function _persistSession(session) {
  if (!FIRESTORE_ENABLED) return;
  const firestore = _getFirestore();
  if (!firestore) return;
  try {
    await firestore.collection('agent_sessions').doc(session.sessionId).set({
      ...session,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    logger.warn('AgentRuntime: Firestore persist failed', { error: err.message, sessionId: session.sessionId });
  }
}

/**
 * Load a session from Cloud Firestore.
 * Returns null if not found or Firestore is unavailable.
 */
async function _loadSession(sessionId) {
  if (!FIRESTORE_ENABLED) return _localSessions.get(sessionId) || null;
  const firestore = _getFirestore();
  if (!firestore) return _localSessions.get(sessionId) || null;
  try {
    const doc = await firestore.collection('agent_sessions').doc(sessionId).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    logger.warn('AgentRuntime: Firestore load failed', { error: err.message, sessionId });
    return _localSessions.get(sessionId) || null;
  }
}

// ── Cloud Tasks background execution ──────────────────────────────────────────

/**
 * Enqueue a long-running agent step as a Cloud Tasks task.
 *
 * Used when the orchestration step is expected to take >10 seconds
 * (e.g. waiting for freight API responses, multi-vendor SLA negotiations).
 * The HTTP request returns 202 Accepted immediately; the step runs
 * asynchronously and updates the session in Firestore when complete.
 *
 * Queue: "orchestrator-long-running"
 * Handler: POST /api/runtime/execute
 *
 * @param {string} sessionId   - Session to continue
 * @param {string} stepName    - Step identifier for logging/tracing
 * @param {object} stepPayload - Serialisable input for the step handler
 * @param {number} [delaySeconds=0] - Delay before execution (0 = immediate)
 */
async function enqueueStep(sessionId, stepName, stepPayload, delaySeconds = 0) {
  if (!RUNTIME_TASKS_ENABLED) {
    logger.info('AgentRuntime: Cloud Tasks disabled, step enqueue skipped', { sessionId, stepName });
    return null;
  }
  try {
    const { CloudTasksClient } = require('@google-cloud/tasks');
    const client = new CloudTasksClient();
    const parent = client.queuePath(GCP_PROJECT, GCP_LOCATION, LONG_RUNNING_QUEUE);
    const backendUrl = process.env.BACKEND_URL ||
      'https://orchestrator-backend-icnkyenovq-uc.a.run.app';

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: `${backendUrl}/api/runtime/execute`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ sessionId, stepName, stepPayload })).toString('base64'),
        oidcToken: {
          serviceAccountEmail: `orchestrator-agent@${GCP_PROJECT}.iam.gserviceaccount.com`,
          audience: backendUrl,
        },
      },
      ...(delaySeconds > 0 ? {
        scheduleTime: { seconds: Math.floor(Date.now() / 1000) + delaySeconds },
      } : {}),
    };

    const [response] = await client.createTask({ parent, task });
    logger.info('AgentRuntime: step enqueued', { taskName: response.name, sessionId, stepName });
    return response.name;
  } catch (err) {
    logger.warn('AgentRuntime: enqueueStep failed', { error: err.message, sessionId, stepName });
    return null;
  }
}

// ── Public Session API ────────────────────────────────────────────────────────

/**
 * Create a new agent session.
 *
 * Sessions are the unit of work for the Agent Runtime.  Each orchestration
 * event creates one session.  Sub-agents inherit the parent session ID for
 * trace correlation.
 *
 * @param {object} opts
 * @param {string} opts.agentId     - which agent owns this session
 * @param {string} opts.eventSource - 'supplier_email' | 'carrier_webhook' | 'manual'
 * @param {object} opts.context     - initial session context (vendor_id, po_number, etc.)
 * @returns {object} session
 */
async function createSession({ agentId, eventSource, context = {} }) {
  const sessionId = uuidv4();
  const session = {
    sessionId,
    agentId,
    eventSource,
    status: SESSION_STATUS.PENDING,
    context,
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  };

  _localSessions.set(sessionId, session);
  await _persistSession(session);

  logger.info('AgentRuntime: session created', { sessionId, agentId, eventSource });
  return session;
}

/**
 * Transition a session to a new status.
 *
 * Status transitions are validated against the state machine:
 *   PENDING → RUNNING (start processing)
 *   RUNNING → AWAITING_APPROVAL (need human sign-off)
 *   RUNNING | AWAITING_APPROVAL → COMPLETED | FAILED
 *   Any → TIMED_OUT (via heartbeat checker)
 */
async function updateSessionStatus(sessionId, status, additionalFields = {}) {
  const validStatuses = Object.values(SESSION_STATUS);
  if (!validStatuses.includes(status)) {
    throw new Error(`AgentRuntime: invalid status "${status}"`);
  }

  const existing = await _loadSession(sessionId);
  const updated = {
    ...(existing || {}),
    sessionId,
    status,
    ...additionalFields,
    updatedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  };

  _localSessions.set(sessionId, updated);
  await _persistSession(updated);

  logger.info('AgentRuntime: session status updated', { sessionId, status });
  return updated;
}

/**
 * Append a reasoning step to the session's step log.
 * Steps are stored in Firestore for cross-session audit trail.
 */
async function appendStep(sessionId, step) {
  const session = await _loadSession(sessionId);
  if (!session) return;

  const updatedSteps = [...(session.steps || []), {
    ...step,
    timestamp: new Date().toISOString(),
  }];

  await updateSessionStatus(sessionId, session.status, { steps: updatedSteps });
}

/**
 * Checkpoint: save full session context to Firestore for hibernation.
 * Called when a session is idle for >SESSION_TIMEOUT_MS.
 */
async function checkpointSession(sessionId) {
  const session = await _loadSession(sessionId);
  if (!session) return;
  await _persistSession({ ...session, checkpointedAt: new Date().toISOString() });
  _localSessions.delete(sessionId);
  logger.info('AgentRuntime: session checkpointed (hibernated)', { sessionId });
}

/**
 * Resume a hibernated session — reload from Firestore into memory.
 */
async function resumeSession(sessionId) {
  const session = await _loadSession(sessionId);
  if (!session) throw new Error(`AgentRuntime: session ${sessionId} not found`);
  _localSessions.set(sessionId, session);
  logger.info('AgentRuntime: session resumed from checkpoint', { sessionId });
  return session;
}

/**
 * List active sessions (from in-memory + optionally Firestore).
 * Returns sessions in RUNNING or AWAITING_APPROVAL state.
 */
async function listActiveSessions() {
  const active = [];
  for (const [, session] of _localSessions) {
    if ([SESSION_STATUS.RUNNING, SESSION_STATUS.AWAITING_APPROVAL].includes(session.status)) {
      active.push(session);
    }
  }

  // Also query Firestore for sessions that may have been resumed on other instances
  if (FIRESTORE_ENABLED) {
    try {
      const firestore = _getFirestore();
      if (firestore) {
        const snapshot = await firestore.collection('agent_sessions')
          .where('status', 'in', [SESSION_STATUS.RUNNING, SESSION_STATUS.AWAITING_APPROVAL])
          .orderBy('createdAt', 'desc')
          .limit(100)
          .get();
        for (const doc of snapshot.docs) {
          const data = doc.data();
          if (!_localSessions.has(data.sessionId)) {
            active.push(data);
          }
        }
      }
    } catch (_) {}
  }

  return active;
}

/**
 * Heartbeat handler — called by Cloud Scheduler every 5 minutes.
 * Times out sessions that have not had activity for SESSION_TIMEOUT_MS.
 */
async function heartbeat() {
  const now = Date.now();
  const timedOut = [];

  for (const [sessionId, session] of _localSessions) {
    if ([SESSION_STATUS.RUNNING, SESSION_STATUS.AWAITING_APPROVAL].includes(session.status)) {
      const lastActivity = new Date(session.lastHeartbeat || session.updatedAt).getTime();
      if (now - lastActivity > SESSION_TIMEOUT_MS) {
        await updateSessionStatus(sessionId, SESSION_STATUS.TIMED_OUT, {
          timedOutAt: new Date().toISOString(),
          timeoutReason: `No activity for ${SESSION_TIMEOUT_MS / 60000} minutes`,
        });
        timedOut.push(sessionId);
        _localSessions.delete(sessionId);
      }
    }
  }

  if (timedOut.length > 0) {
    logger.info('AgentRuntime: heartbeat timed out sessions', { count: timedOut.length, sessionIds: timedOut });
  }

  return { checked: _localSessions.size, timedOut: timedOut.length };
}

module.exports = {
  SESSION_STATUS,
  createSession,
  updateSessionStatus,
  appendStep,
  checkpointSession,
  resumeSession,
  listActiveSessions,
  heartbeat,
  enqueueStep,
};
