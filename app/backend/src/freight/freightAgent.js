/**
 * Freight Sub-Agent
 *
 * Evaluates and creates freight requests:
 *  - Recommends mode (air / ocean / ground) based on delay urgency
 *  - Calculates estimated cost
 *  - Creates freight request records
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const observability = require('../observability/auditLog');
const logger = require('../logger');

// Cost rate tables ($/unit/day equivalent)
const FREIGHT_RATES = {
  air:   { base: 3500, per_kg: 8.50 },
  ocean: { base: 1200, per_kg: 1.20 },
  ground:{ base: 600,  per_kg: 0.45 },
};

const ESTIMATED_WEIGHT_KG = {
  'ITEM-MCU-100': 0.05,
  'ITEM-PCB-200': 0.30,
  'ITEM-CAP-050': 0.01,
  'ITEM-PWR-300': 2.50,
  'ITEM-SEN-010': 0.80,
};

function recommendMode(delayDays) {
  if (delayDays >= 7) return 'air';
  if (delayDays >= 3) return 'ocean';
  return 'ground';
}

function estimateCost(itemCode, quantity, mode) {
  const rate = FREIGHT_RATES[mode] || FREIGHT_RATES.ground;
  const weightKg = (ESTIMATED_WEIGHT_KG[itemCode] || 1.0) * quantity;
  return Math.round((rate.base + rate.per_kg * weightKg) * 100) / 100;
}

function generateFRNumber() {
  const ts = Date.now().toString().slice(-6);
  return `FR-${new Date().getFullYear()}-${ts}`;
}

// ── Core Actions ──────────────────────────────────────────────────────────────

function createFreightRequest({ po_id, item_code, quantity, delay_days, origin, destination, session_id }) {
  const mode = recommendMode(delay_days);
  const estimated_cost = estimateCost(item_code, quantity, mode);
  const id = uuidv4();
  const fr_number = generateFRNumber();

  db.prepare(`
    INSERT INTO freight_requests (id, fr_number, po_id, mode, origin, destination, estimated_cost, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, fr_number, po_id, mode, origin, destination, estimated_cost);

  observability.log({
    event_type: 'FREIGHT_REQUEST_CREATED',
    agent_id: 'agent-freight-v1',
    session_id,
    payload: { id, fr_number, po_id, mode, estimated_cost, delay_days },
    reasoning_chain: [
      { step: 1, description: 'Delay severity assessed', result: `${delay_days} days → recommend ${mode} freight` },
      { step: 2, description: 'Cost estimated', result: `$${estimated_cost} for ${quantity} units via ${mode}` },
      { step: 3, description: 'Freight request drafted', result: fr_number },
    ],
    outcome: 'success',
  });

  logger.info(`Freight request created: ${fr_number}`, { mode, estimated_cost });
  return { id, fr_number, po_id, mode, origin, destination, estimated_cost, status: 'pending' };
}

function listFreightRequests(status) {
  if (status) return db.prepare('SELECT * FROM freight_requests WHERE status = ? ORDER BY created_at DESC').all(status);
  return db.prepare('SELECT * FROM freight_requests ORDER BY created_at DESC').all();
}

// ── Gateway Handler ───────────────────────────────────────────────────────────

async function handle(action, payload, sessionId) {
  switch (action) {
    case 'create_freight_request':
      return createFreightRequest({ ...payload, session_id: sessionId });
    case 'list_freight_requests':
      return listFreightRequests(payload.status);
    case 'recommend_mode':
      return { mode: recommendMode(payload.delay_days), estimated_cost: estimateCost(payload.item_code, payload.quantity, recommendMode(payload.delay_days)) };
    default:
      throw new Error(`Unknown freight action: ${action}`);
  }
}

module.exports = { createFreightRequest, listFreightRequests, recommendMode, estimateCost, handle };
