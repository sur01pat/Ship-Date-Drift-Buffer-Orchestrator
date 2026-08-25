/**
 * Agent Gateway – A2A Routing & Policy Enforcement
 *
 * Routes task delegations between the Orchestrator and sub-agents.
 * Enforces:
 *  - Financial limits (no auto-freight spend > $50k without human sign-off)
 *  - Operational thresholds (delay > 10 days → escalate)
 *  - Schema validation on A2A messages
 */

const { v4: uuidv4 } = require('uuid');
const observability = require('../observability/auditLog');
const logger = require('../logger');

// Policy thresholds
const POLICY = {
  MAX_AUTO_FREIGHT_COST: 50000,
  MAX_AUTO_APPROVE_DELAY_DAYS: 10,
  MAX_AUTO_WTO_QUANTITY: 10000,
};

const REGISTERED_AGENTS = {
  'agent-warehouse-v1': { handler: null },  // Injected at startup
  'agent-freight-v1':   { handler: null },
};

function registerAgentHandler(agentId, handler) {
  if (!REGISTERED_AGENTS[agentId]) REGISTERED_AGENTS[agentId] = {};
  REGISTERED_AGENTS[agentId].handler = handler;
}

/**
 * Validate a task message against minimum schema.
 */
function validateTask(task) {
  if (!task || typeof task !== 'object') return { valid: false, error: 'Task must be an object' };
  if (!task.target_agent) return { valid: false, error: 'target_agent is required' };
  if (!task.action) return { valid: false, error: 'action is required' };
  if (!task.payload || typeof task.payload !== 'object') return { valid: false, error: 'payload must be an object' };
  return { valid: true };
}

/**
 * Enforce policy on a task before dispatching.
 * Returns { allowed, requiresHumanApproval, reason }
 */
function enforcePolicy(task) {
  const { target_agent, payload } = task;

  if (target_agent === 'agent-freight-v1') {
    if (payload.estimated_cost && payload.estimated_cost > POLICY.MAX_AUTO_FREIGHT_COST) {
      return { allowed: false, requiresHumanApproval: true, reason: `Freight cost $${payload.estimated_cost} exceeds auto-approval limit of $${POLICY.MAX_AUTO_FREIGHT_COST}` };
    }
  }

  if (target_agent === 'agent-warehouse-v1') {
    if (payload.quantity && payload.quantity > POLICY.MAX_AUTO_WTO_QUANTITY) {
      return { allowed: false, requiresHumanApproval: true, reason: `WTO quantity ${payload.quantity} exceeds auto-approval limit of ${POLICY.MAX_AUTO_WTO_QUANTITY}` };
    }
  }

  if (payload.delay_days && payload.delay_days > POLICY.MAX_AUTO_APPROVE_DELAY_DAYS) {
    return { allowed: false, requiresHumanApproval: true, reason: `Delay of ${payload.delay_days} days exceeds escalation threshold of ${POLICY.MAX_AUTO_APPROVE_DELAY_DAYS} days` };
  }

  return { allowed: true, requiresHumanApproval: false, reason: null };
}

/**
 * Dispatch a task to a sub-agent via the A2A gateway.
 */
async function dispatch(task, sessionId) {
  const taskId = uuidv4();

  const validation = validateTask(task);
  if (!validation.valid) {
    observability.log({
      event_type: 'GATEWAY_VALIDATION_FAILURE',
      session_id: sessionId,
      agent_id: 'gateway',
      payload: { task, error: validation.error },
      severity: 'warn',
    });
    throw new Error(`Gateway validation failed: ${validation.error}`);
  }

  const policy = enforcePolicy(task);

  observability.log({
    event_type: 'GATEWAY_DISPATCH',
    session_id: sessionId,
    agent_id: 'gateway',
    payload: { taskId, target_agent: task.target_agent, action: task.action, policy_result: policy },
    reasoning_chain: [
      { step: 1, description: 'Task schema validated', result: 'pass' },
      { step: 2, description: 'Policy enforcement check', result: policy.allowed ? 'pass' : 'blocked', reason: policy.reason },
    ],
    outcome: policy.allowed ? 'dispatching' : 'requires_human_approval',
  });

  if (!policy.allowed) {
    return { taskId, status: 'requires_human_approval', reason: policy.reason, task };
  }

  const agent = REGISTERED_AGENTS[task.target_agent];
  if (!agent || !agent.handler) {
    logger.warn(`No handler registered for ${task.target_agent}`);
    return { taskId, status: 'queued', message: `No live handler for ${task.target_agent}; task queued` };
  }

  try {
    const result = await agent.handler(task.action, task.payload, sessionId);
    observability.log({
      event_type: 'GATEWAY_RESULT',
      session_id: sessionId,
      agent_id: task.target_agent,
      payload: { taskId, result },
      outcome: 'success',
    });
    return { taskId, status: 'completed', result };
  } catch (err) {
    observability.log({
      event_type: 'GATEWAY_ERROR',
      session_id: sessionId,
      agent_id: task.target_agent,
      payload: { taskId, error: err.message },
      outcome: 'failure',
      severity: 'error',
    });
    throw err;
  }
}

module.exports = { dispatch, registerAgentHandler, validateTask, enforcePolicy, POLICY };
