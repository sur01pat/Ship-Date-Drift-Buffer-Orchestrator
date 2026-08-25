/**
 * ERP/SAP Simulator
 *
 * Simulates:
 *  - Purchase Orders (with promised vs actual ship dates)
 *  - Bill of Materials (BOM)
 *  - Sales Orders (with downstream delivery commitments)
 *  - Inventory Buffers
 *
 * Provides impact analysis: given a delayed PO, determine which
 * sales orders are at risk and by how many days.
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const logger = require('../logger');

// ── Seed Data ─────────────────────────────────────────────────────────────────

function seed() {
  // Purchase Orders
  const pos = [
    { id: 'po-001', vendor_id: 'vendor-001', po_number: 'PO-2025-001', item_code: 'ITEM-MCU-100', item_name: 'Microcontroller Unit 100', quantity: 5000, unit_cost: 12.50, promised_ship_date: addDays(0), actual_ship_date: null, status: 'open', delay_days: 0 },
    { id: 'po-002', vendor_id: 'vendor-003', po_number: 'PO-2025-002', item_code: 'ITEM-PCB-200', item_name: 'PCB Assembly Board', quantity: 2000, unit_cost: 35.00, promised_ship_date: addDays(-2), actual_ship_date: null, status: 'delayed', delay_days: 7 },
    { id: 'po-003', vendor_id: 'vendor-002', po_number: 'PO-2025-003', item_code: 'ITEM-CAP-050', item_name: 'Capacitor Array 50µF', quantity: 20000, unit_cost: 0.85, promised_ship_date: addDays(3), actual_ship_date: null, status: 'open', delay_days: 0 },
    { id: 'po-004', vendor_id: 'vendor-004', po_number: 'PO-2025-004', item_code: 'ITEM-PWR-300', item_name: 'Power Supply Module', quantity: 1000, unit_cost: 62.00, promised_ship_date: addDays(-5), actual_ship_date: null, status: 'delayed', delay_days: 5 },
    { id: 'po-005', vendor_id: 'vendor-001', po_number: 'PO-2025-005', item_code: 'ITEM-SEN-010', item_name: 'Sensor Array Module', quantity: 3000, unit_cost: 22.00, promised_ship_date: addDays(10), actual_ship_date: null, status: 'open', delay_days: 0 },
  ];

  const upsertPO = db.prepare(`
    INSERT INTO purchase_orders (id, vendor_id, po_number, item_code, item_name, quantity, unit_cost, promised_ship_date, actual_ship_date, status, delay_days)
    VALUES (@id, @vendor_id, @po_number, @item_code, @item_name, @quantity, @unit_cost, @promised_ship_date, @actual_ship_date, @status, @delay_days)
    ON CONFLICT(po_number) DO UPDATE SET
      status=excluded.status, delay_days=excluded.delay_days, actual_ship_date=excluded.actual_ship_date,
      updated_at=datetime('now')
  `);
  for (const po of pos) upsertPO.run(po);

  // BOM
  const boms = [
    { id: uuidv4(), item_code: 'PROD-CTRL-500', component_code: 'ITEM-MCU-100', component_name: 'Microcontroller Unit 100', quantity_required: 2, unit: 'EA' },
    { id: uuidv4(), item_code: 'PROD-CTRL-500', component_code: 'ITEM-PCB-200', component_name: 'PCB Assembly Board', quantity_required: 1, unit: 'EA' },
    { id: uuidv4(), item_code: 'PROD-CTRL-500', component_code: 'ITEM-CAP-050', component_name: 'Capacitor Array 50µF', quantity_required: 8, unit: 'EA' },
    { id: uuidv4(), item_code: 'PROD-CTRL-500', component_code: 'ITEM-PWR-300', component_name: 'Power Supply Module', quantity_required: 1, unit: 'EA' },
    { id: uuidv4(), item_code: 'PROD-SENSOR-200', component_code: 'ITEM-SEN-010', component_name: 'Sensor Array Module', quantity_required: 3, unit: 'EA' },
    { id: uuidv4(), item_code: 'PROD-SENSOR-200', component_code: 'ITEM-MCU-100', component_name: 'Microcontroller Unit 100', quantity_required: 1, unit: 'EA' },
  ];

  const insertBOM = db.prepare(`
    INSERT OR IGNORE INTO bom_items (id, item_code, component_code, component_name, quantity_required, unit)
    VALUES (@id, @item_code, @component_code, @component_name, @quantity_required, @unit)
  `);
  for (const b of boms) insertBOM.run(b);

  // Sales Orders
  const sos = [
    { id: 'so-001', so_number: 'SO-2025-001', customer_name: 'TechCorp Industries', item_code: 'PROD-CTRL-500', quantity: 500, promised_delivery_date: addDays(14), updated_delivery_date: null, status: 'open', revenue: 150000 },
    { id: 'so-002', so_number: 'SO-2025-002', customer_name: 'Global Automation Inc.', item_code: 'PROD-CTRL-500', quantity: 300, promised_delivery_date: addDays(10), updated_delivery_date: null, status: 'open', revenue: 95000 },
    { id: 'so-003', so_number: 'SO-2025-003', customer_name: 'Meridian Systems', item_code: 'PROD-SENSOR-200', quantity: 800, promised_delivery_date: addDays(21), updated_delivery_date: null, status: 'open', revenue: 64000 },
    { id: 'so-004', so_number: 'SO-2025-004', customer_name: 'NextWave Electronics', item_code: 'PROD-CTRL-500', quantity: 200, promised_delivery_date: addDays(7), updated_delivery_date: null, status: 'open', revenue: 62000 },
    { id: 'so-005', so_number: 'SO-2025-005', customer_name: 'Pinnacle Manufacturing', item_code: 'PROD-SENSOR-200', quantity: 400, promised_delivery_date: addDays(18), updated_delivery_date: null, status: 'open', revenue: 32000 },
  ];

  const upsertSO = db.prepare(`
    INSERT INTO sales_orders (id, so_number, customer_name, item_code, quantity, promised_delivery_date, updated_delivery_date, status, revenue)
    VALUES (@id, @so_number, @customer_name, @item_code, @quantity, @promised_delivery_date, @updated_delivery_date, @status, @revenue)
    ON CONFLICT(so_number) DO UPDATE SET status=excluded.status, updated_delivery_date=excluded.updated_delivery_date, updated_at=datetime('now')
  `);
  for (const so of sos) upsertSO.run(so);

  // Inventory Buffers
  const buffers = [
    { id: uuidv4(), item_code: 'ITEM-MCU-100', region: 'NA', safety_stock: 2000, reorder_point: 1000, on_hand: 1500, on_order: 5000 },
    { id: uuidv4(), item_code: 'ITEM-PCB-200', region: 'NA', safety_stock: 500, reorder_point: 200, on_hand: 180, on_order: 2000 },
    { id: uuidv4(), item_code: 'ITEM-CAP-050', region: 'NA', safety_stock: 5000, reorder_point: 2000, on_hand: 8000, on_order: 20000 },
    { id: uuidv4(), item_code: 'ITEM-PWR-300', region: 'NA', safety_stock: 300, reorder_point: 150, on_hand: 90, on_order: 1000 },
    { id: uuidv4(), item_code: 'ITEM-SEN-010', region: 'APAC', safety_stock: 1000, reorder_point: 500, on_hand: 600, on_order: 3000 },
  ];

  const insertBuffer = db.prepare(`
    INSERT OR IGNORE INTO inventory_buffers (id, item_code, region, safety_stock, reorder_point, on_hand, on_order)
    VALUES (@id, @item_code, @region, @safety_stock, @reorder_point, @on_hand, @on_order)
  `);
  for (const b of buffers) insertBuffer.run(b);

  logger.info('ERP/SAP seeded', { pos: pos.length, boms: boms.length, sos: sos.length });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// ── PO API ────────────────────────────────────────────────────────────────────

function getPO(id) {
  return db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
}

function getPOByNumber(poNumber) {
  return db.prepare('SELECT * FROM purchase_orders WHERE po_number = ?').get(poNumber);
}

function listPOs(status) {
  if (status) return db.prepare('SELECT * FROM purchase_orders WHERE status = ? ORDER BY promised_ship_date').all(status);
  return db.prepare('SELECT * FROM purchase_orders ORDER BY promised_ship_date').all();
}

function updatePODelay(poId, actualShipDate, delayDays) {
  db.prepare(`
    UPDATE purchase_orders
    SET actual_ship_date = ?, delay_days = ?, status = 'delayed', updated_at = datetime('now')
    WHERE id = ?
  `).run(actualShipDate, delayDays, poId);
  return getPO(poId);
}

// ── BOM API ───────────────────────────────────────────────────────────────────

function getBOM(productCode) {
  return db.prepare('SELECT * FROM bom_items WHERE item_code = ?').all(productCode);
}

/**
 * Reverse-lookup: which finished goods use a given component?
 */
function getProductsUsingComponent(componentCode) {
  return db.prepare('SELECT DISTINCT item_code FROM bom_items WHERE component_code = ?').all(componentCode);
}

// ── Sales Order API ───────────────────────────────────────────────────────────

function getSO(id) {
  return db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(id);
}

function listSOs(status) {
  if (status) return db.prepare('SELECT * FROM sales_orders WHERE status = ? ORDER BY promised_delivery_date').all(status);
  return db.prepare('SELECT * FROM sales_orders ORDER BY promised_delivery_date').all();
}

function updateSODeliveryDate(soId, newDate) {
  db.prepare(`
    UPDATE sales_orders SET updated_delivery_date = ?, status = 'at_risk', updated_at = datetime('now') WHERE id = ?
  `).run(newDate, soId);
  return getSO(soId);
}

// ── Impact Analysis ───────────────────────────────────────────────────────────

/**
 * Given a delayed item_code and delay days, determine impacted sales orders.
 */
function calculateImpact(itemCode, delayDays) {
  const products = getProductsUsingComponent(itemCode);
  const impactedSOs = [];

  for (const { item_code: productCode } of products) {
    const sos = db.prepare("SELECT * FROM sales_orders WHERE item_code = ? AND status = 'open'").all(productCode);
    for (const so of sos) {
      const existingDelay = new Date(so.promised_delivery_date);
      existingDelay.setDate(existingDelay.getDate() + delayDays);
      impactedSOs.push({
        ...so,
        delay_days: delayDays,
        revised_delivery_date: existingDelay.toISOString().split('T')[0],
        product_code: productCode,
        revenue_at_risk: so.revenue,
      });
    }
  }

  return impactedSOs;
}

function getInventoryBuffer(itemCode) {
  return db.prepare('SELECT * FROM inventory_buffers WHERE item_code = ?').all(itemCode);
}

function listInventoryBuffers() {
  return db.prepare('SELECT * FROM inventory_buffers').all();
}

module.exports = {
  seed,
  getPO, getPOByNumber, listPOs, updatePODelay,
  getBOM, getProductsUsingComponent,
  getSO, listSOs, updateSODeliveryDate,
  calculateImpact,
  getInventoryBuffer, listInventoryBuffers,
};
