/**
 * Warehouse Sub-Agent
 *
 * Manages Warehouse Transfer Orders (WTO):
 *  - Create draft WTOs for inventory rebalancing
 *  - Query current inventory levels
 *  - Approve / reject WTOs
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const observability = require('../observability/auditLog');
const logger = require('../logger');

function generateWTONumber() {
  const ts = Date.now().toString().slice(-6);
  return `WTO-${new Date().getFullYear()}-${ts}`;
}

// ── Core Actions ──────────────────────────────────────────────────────────────

function createTransferOrder({ item_code, from_location, to_location, quantity, session_id }) {
  const id = uuidv4();
  const wto_number = generateWTONumber();

  db.prepare(`
    INSERT INTO warehouse_transfer_orders (id, wto_number, item_code, from_location, to_location, quantity, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `).run(id, wto_number, item_code, from_location, to_location, quantity);

  observability.log({
    event_type: 'WTO_CREATED',
    agent_id: 'agent-warehouse-v1',
    session_id,
    payload: { id, wto_number, item_code, from_location, to_location, quantity },
    reasoning_chain: [
      { step: 1, description: 'Inventory rebalancing required', result: `${quantity} units of ${item_code} needed at ${to_location}` },
      { step: 2, description: 'WTO drafted', result: wto_number },
    ],
    outcome: 'success',
  });

  logger.info(`WTO created: ${wto_number}`, { item_code, quantity });
  return { id, wto_number, item_code, from_location, to_location, quantity, status: 'draft' };
}

function approveTransferOrder(id, approvedBy) {
  db.prepare(`
    UPDATE warehouse_transfer_orders SET status = 'approved', approved_by = ?, updated_at = datetime('now') WHERE id = ?
  `).run(approvedBy, id);
  return db.prepare('SELECT * FROM warehouse_transfer_orders WHERE id = ?').get(id);
}

function listTransferOrders(status) {
  if (status) return db.prepare('SELECT * FROM warehouse_transfer_orders WHERE status = ? ORDER BY created_at DESC').all(status);
  return db.prepare('SELECT * FROM warehouse_transfer_orders ORDER BY created_at DESC').all();
}

function getTransferOrder(id) {
  return db.prepare('SELECT * FROM warehouse_transfer_orders WHERE id = ?').get(id);
}

// ── Gateway Handler ───────────────────────────────────────────────────────────

async function handle(action, payload, sessionId) {
  switch (action) {
    case 'create_transfer_order':
      return createTransferOrder({ ...payload, session_id: sessionId });
    case 'approve_transfer_order':
      return approveTransferOrder(payload.id, payload.approved_by || 'agent-orchestrator');
    case 'list_transfer_orders':
      return listTransferOrders(payload.status);
    default:
      throw new Error(`Unknown warehouse action: ${action}`);
  }
}

module.exports = { createTransferOrder, approveTransferOrder, listTransferOrders, getTransferOrder, handle };
