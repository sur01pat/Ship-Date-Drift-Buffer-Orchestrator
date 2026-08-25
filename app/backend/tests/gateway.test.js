/**
 * Tests: Agent Gateway
 */

const { validateTask, enforcePolicy, POLICY } = require('../src/gateway/agentGateway');

describe('Agent Gateway', () => {
  describe('validateTask', () => {
    test('passes a valid task', () => {
      const result = validateTask({ target_agent: 'agent-warehouse-v1', action: 'create_transfer_order', payload: { item_code: 'ITEM-PCB-200' } });
      expect(result.valid).toBe(true);
    });

    test('fails missing target_agent', () => {
      const result = validateTask({ action: 'create', payload: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/target_agent/);
    });

    test('fails missing action', () => {
      const result = validateTask({ target_agent: 'agent-warehouse-v1', payload: {} });
      expect(result.valid).toBe(false);
    });

    test('fails null task', () => {
      const result = validateTask(null);
      expect(result.valid).toBe(false);
    });
  });

  describe('enforcePolicy', () => {
    test('allows low-cost freight', () => {
      const result = enforcePolicy({
        target_agent: 'agent-freight-v1',
        action: 'create_freight_request',
        payload: { estimated_cost: 5000, delay_days: 3 },
      });
      expect(result.allowed).toBe(true);
    });

    test('blocks freight exceeding cost limit', () => {
      const result = enforcePolicy({
        target_agent: 'agent-freight-v1',
        action: 'create_freight_request',
        payload: { estimated_cost: POLICY.MAX_AUTO_FREIGHT_COST + 1, delay_days: 3 },
      });
      expect(result.allowed).toBe(false);
      expect(result.requiresHumanApproval).toBe(true);
    });

    test('blocks WTO exceeding quantity limit', () => {
      const result = enforcePolicy({
        target_agent: 'agent-warehouse-v1',
        action: 'create_transfer_order',
        payload: { quantity: POLICY.MAX_AUTO_WTO_QUANTITY + 1 },
      });
      expect(result.allowed).toBe(false);
    });

    test('escalates high delay days', () => {
      const result = enforcePolicy({
        target_agent: 'agent-freight-v1',
        action: 'create_freight_request',
        payload: { delay_days: POLICY.MAX_AUTO_APPROVE_DELAY_DAYS + 1, estimated_cost: 1000 },
      });
      expect(result.allowed).toBe(false);
    });

    test('allows low delay days', () => {
      const result = enforcePolicy({
        target_agent: 'agent-warehouse-v1',
        action: 'create_transfer_order',
        payload: { delay_days: 2, quantity: 100 },
      });
      expect(result.allowed).toBe(true);
    });
  });
});
