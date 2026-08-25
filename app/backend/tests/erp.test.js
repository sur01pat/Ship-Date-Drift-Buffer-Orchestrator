/**
 * Tests: ERP Simulator
 */

const { db, initSchema } = require('../src/db');

// Bootstrap DB before tests
beforeAll(() => {
  initSchema();
  require('../src/memory/memoryBank').seed();
  require('../src/erp/erpSimulator').seed();
});

const erp = require('../src/erp/erpSimulator');

describe('ERP Simulator', () => {
  test('listPOs returns purchase orders', () => {
    const pos = erp.listPOs();
    expect(Array.isArray(pos)).toBe(true);
    expect(pos.length).toBeGreaterThan(0);
  });

  test('getPOByNumber returns a PO', () => {
    const po = erp.getPOByNumber('PO-2025-001');
    expect(po).toBeTruthy();
    expect(po.po_number).toBe('PO-2025-001');
  });

  test('listSOs returns sales orders', () => {
    const sos = erp.listSOs();
    expect(Array.isArray(sos)).toBe(true);
    expect(sos.length).toBeGreaterThan(0);
  });

  test('calculateImpact returns impacted SOs', () => {
    const impacts = erp.calculateImpact('ITEM-PCB-200', 5);
    expect(Array.isArray(impacts)).toBe(true);
    // PCB-200 is used in PROD-CTRL-500 which has open SOs
    expect(impacts.length).toBeGreaterThan(0);
  });

  test('calculateImpact returns empty for unknown item', () => {
    const impacts = erp.calculateImpact('ITEM-UNKNOWN', 5);
    expect(impacts).toHaveLength(0);
  });

  test('updatePODelay updates a PO', () => {
    const po = erp.getPOByNumber('PO-2025-001');
    const updated = erp.updatePODelay(po.id, '2025-12-31', 10);
    expect(updated.delay_days).toBe(10);
    expect(updated.status).toBe('delayed');
  });

  test('listInventoryBuffers returns inventory data', () => {
    const buffers = erp.listInventoryBuffers();
    expect(Array.isArray(buffers)).toBe(true);
    expect(buffers.length).toBeGreaterThan(0);
  });
});
