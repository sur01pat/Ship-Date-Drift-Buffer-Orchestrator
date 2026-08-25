import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000/api';

let token = null;

async function ensureToken() {
  if (token) return token;
  try {
    const res = await axios.get(`${API_URL}/auth/bootstrap`);
    // Use admin token for dashboard
    token = res.data['user-admin'];
  } catch (e) {
    console.error('Failed to bootstrap token', e);
  }
  return token;
}

async function get(path) {
  const t = await ensureToken();
  return axios.get(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${t}` } });
}

async function post(path, data) {
  const t = await ensureToken();
  return axios.post(`${API_URL}${path}`, data, { headers: { Authorization: `Bearer ${t}` } });
}

export const api = {
  // Dashboard
  getSummary: () => get('/dashboard/summary'),

  // Orchestrator
  getEvents: (status) => get(`/orchestrator/events${status ? `?status=${status}` : ''}`),
  getEvent: (id) => get(`/orchestrator/events/${id}`),
  approveEvent: (id) => post(`/orchestrator/events/${id}/approve`, {}),
  rejectEvent: (id, reason) => post(`/orchestrator/events/${id}/reject`, { reason }),
  simulate: (scenario) => post('/demo/simulate', { scenario }),

  // ERP
  getPOs: (status) => get(`/erp/purchase-orders${status ? `?status=${status}` : ''}`),
  getSOs: (status) => get(`/erp/sales-orders${status ? `?status=${status}` : ''}`),
  getInventory: () => get('/erp/inventory'),
  getCreditClaims: () => get('/erp/credit-claims'),

  // Vendors
  getVendors: () => get('/memory/vendors'),
  getVendorHistory: (id) => get(`/memory/vendors/${id}/history`),

  // Warehouse & Freight
  getTransfers: () => get('/warehouse/transfers'),
  getFreightRequests: () => get('/freight/requests'),

  // Audit
  getAuditLogs: (params) => {
    const q = new URLSearchParams(params).toString();
    return get(`/audit/logs${q ? `?${q}` : ''}`);
  },
  getAuditStats: () => get('/audit/stats'),
  getSessionTrace: (id) => get(`/audit/session/${id}`),

  // Registry
  getAgents: () => get('/registry/agents'),

  // Model Armor
  scanPayload: (payload) => post('/armor/scan', payload),

  // Long-term memories
  getMemories: (params) => {
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v != null))
    ).toString();
    return get(`/memory/memories${q ? `?${q}` : ''}`);
  },
  searchMemories: (query, limit) => get(`/memory/memories/search?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ''}`),
  storeMemory: (body) => post('/memory/memories', body),
  deleteMemory: async (id) => {
    const t = await ensureToken();
    return axios.delete(`${API_URL}/memory/memories/${id}`, { headers: { Authorization: `Bearer ${t}` } });
  },
};
