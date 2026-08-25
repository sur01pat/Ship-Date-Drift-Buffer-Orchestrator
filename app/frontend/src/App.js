import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api/client';
import { useWebSocket } from './hooks/useWebSocket';

// ── Shared Styles ─────────────────────────────────────────────────────────────
const S = {
  badge: (color) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    background: color === 'green' ? '#d1fae5' : color === 'red' ? '#fee2e2' : color === 'yellow' ? '#fef3c7' : color === 'blue' ? '#dbeafe' : '#f3f4f6',
    color: color === 'green' ? '#065f46' : color === 'red' ? '#991b1b' : color === 'yellow' ? '#92400e' : color === 'blue' ? '#1e40af' : '#374151',
  }),
  card: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: '16px 20px',
    marginBottom: 16,
  },
  section: { marginBottom: 32 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { background: '#f7f8fa', padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb', fontWeight: 600, fontSize: 12, color: '#57606a' },
  td: { padding: '8px 12px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' },
  btn: (variant = 'primary') => ({
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    background: variant === 'primary' ? '#3b82d4' : variant === 'danger' ? '#ef4444' : variant === 'success' ? '#10b981' : '#f3f4f6',
    color: variant === 'ghost' ? '#374151' : '#fff',
    marginRight: 8,
  }),
  input: {
    padding: '6px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: 13,
    width: '100%',
    boxSizing: 'border-box',
  },
  metricCard: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: '16px 20px',
    textAlign: 'center',
  },
};

function statusBadge(status) {
  const map = {
    open: 'blue', delayed: 'red', at_risk: 'yellow', completed: 'green',
    awaiting_approval: 'yellow', blocked: 'red', failed: 'red', rejected: 'red',
    active: 'green', draft: 'blue', approved: 'green', pending: 'yellow',
    on_time: 'green', delivered_late: 'red',
  };
  return <span style={S.badge(map[status] || 'gray')}>{status?.replace(/_/g, ' ')}</span>;
}

function formatCurrency(n) { return n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0 })}` : '—'; }
function formatDate(d) { return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }

// ── Sub-components ─────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, color }) {
  return (
    <div style={{ ...S.metricCard, borderLeft: `4px solid ${color || '#3b82d4'}` }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || '#1f2328' }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#57606a', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function LiveFeed({ events }) {
  return (
    <div style={{ ...S.card, maxHeight: 220, overflowY: 'auto' }}>
      <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>📡 Live Feed</div>
      {events.length === 0 && <div style={{ color: '#57606a', fontSize: 12 }}>Waiting for events…</div>}
      {events.map((e, i) => (
        <div key={i} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f3f4f6', color: '#374151' }}>
          <span style={{ color: '#57606a', marginRight: 8 }}>{new Date(e.timestamp).toLocaleTimeString()}</span>
          <strong>{e.type}</strong>
          {e.data?.sessionId && <span style={{ color: '#57606a', marginLeft: 6 }}>session:{e.data.sessionId.slice(0, 8)}</span>}
        </div>
      ))}
    </div>
  );
}

function ReasoningChainModal({ steps, onClose }) {
  if (!steps || steps.length === 0) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 8, padding: 24, maxWidth: 700, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>🔗 Reasoning Chain</h3>
          <button onClick={onClose} style={{ ...S.btn('ghost'), padding: '2px 8px' }}>✕</button>
        </div>
        {steps.map((s, i) => (
          <div key={i} style={{ ...S.card, background: '#f7f8fa', marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: '#57606a', marginBottom: 4 }}>Step {s.step}: {s.description}</div>
            <div style={{ fontSize: 13 }}>{typeof s.result === 'string' ? s.result : JSON.stringify(s.result, null, 2)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Pages ──────────────────────────────────────────────────────────────────────

function DashboardPage({ summary, summaryError, onRetry, onSimulate, simulating }) {
  if (summaryError) return (
    <div style={{ padding: 40 }}>
      <div style={{ color: '#991b1b', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '16px 20px', marginBottom: 16 }}>
        <strong>Dashboard failed to load:</strong> {summaryError}
      </div>
      <button onClick={onRetry} style={{ padding: '8px 16px', background: '#3b82d4', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
        Retry
      </button>
    </div>
  );
  if (!summary) return <div style={{ padding: 40, color: '#57606a' }}>Loading dashboard…</div>;

  const byStatus = {};
  (summary.event_summary || []).forEach(r => { byStatus[r.status] = r.count; });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>Orchestrator Dashboard</h2>
          <div style={{ fontSize: 12, color: '#57606a', marginTop: 2 }}>Last updated: {formatDate(summary.timestamp)}</div>
        </div>
        <button onClick={() => onSimulate(null)} disabled={simulating} style={S.btn('primary')}>
          {simulating ? '⚙️ Processing…' : '⚡ Simulate Inbound Event'}
        </button>
      </div>

      <div style={{ ...S.grid3, marginBottom: 24 }}>
        <MetricCard label="Pending Approvals" value={summary.pending_approvals} color="#f59e0b" sub="Require human sign-off" />
        <MetricCard label="Delayed POs" value={summary.delayed_pos} color="#ef4444" sub="Active purchase orders" />
        <MetricCard label="At-Risk Sales Orders" value={summary.at_risk_sos} color="#f97316" sub="Impacted by delays" />
        <MetricCard label="Revenue at Risk" value={formatCurrency(summary.total_revenue_at_risk)} color="#8b5cf6" />
        <MetricCard label="Total Audit Events" value={summary.audit_stats?.total || 0} color="#3b82d4" sub="Reasoning traces" />
        <MetricCard label="System Status" value="✅ Live" color="#10b981" sub="All sub-agents operational" />
      </div>

      <div style={S.grid2}>
        <div style={S.card}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Event Status Breakdown</div>
          {Object.entries(byStatus).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, borderBottom: '1px solid #f3f4f6' }}>
              <span>{statusBadge(k)}</span>
              <strong>{v}</strong>
            </div>
          ))}
        </div>
        <div style={S.card}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Audit Event Types</div>
          {(summary.audit_stats?.byType || []).slice(0, 6).map(r => (
            <div key={r.event_type} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, borderBottom: '1px solid #f3f4f6' }}>
              <span style={{ color: '#374151' }}>{r.event_type}</span>
              <strong>{r.count}</strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventsPage({ onRefresh }) {
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [trace, setTrace] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getEvents();
      setEvents(res.data);
    } catch (_) {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = async (id) => {
    try {
      await api.approveEvent(id);
      load();
    } catch (e) { alert('Approval failed: ' + e.message); }
  };

  const reject = async (id) => {
    const reason = prompt('Reason for rejection:');
    if (!reason) return;
    try {
      await api.rejectEvent(id, reason);
      load();
    } catch (e) { alert('Rejection failed: ' + e.message); }
  };

  const viewTrace = async (sessionId) => {
    const res = await api.getSessionTrace(sessionId);
    setTrace(res.data);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Orchestration Events</h2>
        <button onClick={load} style={S.btn('ghost')}>↺ Refresh</button>
      </div>
      {loading && <div style={{ color: '#57606a', marginBottom: 12, fontSize: 13 }}>Loading…</div>}
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Session ID</th>
            <th style={S.th}>Source</th>
            <th style={S.th}>Status</th>
            <th style={S.th}>Approval</th>
            <th style={S.th}>Created</th>
            <th style={S.th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {events.map(e => (
            <tr key={e.id}>
              <td style={S.td}><code style={{ fontSize: 11 }}>{e.session_id?.slice(0, 12)}…</code></td>
              <td style={S.td}>{e.event_source}</td>
              <td style={S.td}>{statusBadge(e.status)}</td>
              <td style={S.td}>{statusBadge(e.human_approval_status || 'pending')}</td>
              <td style={S.td}>{formatDate(e.created_at)}</td>
              <td style={S.td}>
                <button onClick={() => setSelected(e)} style={{ ...S.btn('ghost'), padding: '2px 8px', fontSize: 11 }}>View</button>
                {e.status === 'awaiting_approval' && <>
                  <button onClick={() => approve(e.id)} style={{ ...S.btn('success'), padding: '2px 8px', fontSize: 11 }}>✓ Approve</button>
                  <button onClick={() => reject(e.id)} style={{ ...S.btn('danger'), padding: '2px 8px', fontSize: 11 }}>✕ Reject</button>
                </>}
                {e.session_id && <button onClick={() => viewTrace(e.session_id)} style={{ ...S.btn('ghost'), padding: '2px 8px', fontSize: 11 }}>Trace</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Event Detail Modal */}
      {selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, maxWidth: 800, width: '92%', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>Event Detail</h3>
              <button onClick={() => setSelected(null)} style={{ ...S.btn('ghost') }}>✕</button>
            </div>
            <div style={S.grid2}>
              <div><strong>Status:</strong> {statusBadge(selected.status)}</div>
              <div><strong>Source:</strong> {selected.event_source}</div>
              <div><strong>Approval:</strong> {statusBadge(selected.human_approval_status || 'pending')}</div>
              <div><strong>Created:</strong> {formatDate(selected.created_at)}</div>
            </div>
            {selected.remediation_plan && (
              <div style={{ marginTop: 16 }}>
                <strong>Remediation Plan</strong>
                <div style={{ ...S.card, background: '#f7f8fa', marginTop: 8 }}>
                  <div><strong>PO:</strong> {selected.remediation_plan.po?.po_number} — Delayed {selected.remediation_plan.po?.delay_days} days</div>
                  <div><strong>Revenue at Risk:</strong> {formatCurrency(selected.remediation_plan.total_revenue_at_risk)}</div>
                  <div><strong>Impacted SOs:</strong> {selected.remediation_plan.impacted_sales_orders?.length || 0}</div>
                  {selected.remediation_plan.credit_claim && (
                    <div><strong>Credit Claim:</strong> {selected.remediation_plan.credit_claim.claim_number} — {formatCurrency(selected.remediation_plan.credit_claim.penalty_amount)}</div>
                  )}
                </div>
                <strong>Reasoning Chain</strong>
                {(selected.processing_steps || []).map((s, i) => (
                  <div key={i} style={{ ...S.card, background: '#f7f8fa', marginTop: 6, fontSize: 12 }}>
                    <div style={{ fontWeight: 600, color: '#57606a' }}>Step {s.step}: {s.description}</div>
                    <div>{typeof s.result === 'string' ? s.result : JSON.stringify(s.result)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Reasoning Trace Modal */}
      {trace && <ReasoningChainModal steps={trace.flatMap(r => r.reasoning_chain || [])} onClose={() => setTrace(null)} />}
    </div>
  );
}

function ERPPage() {
  const [pos, setPOs] = useState([]);
  const [sos, setSOs] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [tab, setTab] = useState('pos');

  useEffect(() => {
    api.getPOs().then(r => setPOs(r.data)).catch(() => {});
    api.getSOs().then(r => setSOs(r.data)).catch(() => {});
    api.getInventory().then(r => setInventory(r.data)).catch(() => {});
  }, []);

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>ERP / SAP Simulator</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['pos', 'sos', 'inventory'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.btn(tab === t ? 'primary' : 'ghost') }}>
            {{ pos: 'Purchase Orders', sos: 'Sales Orders', inventory: 'Inventory Buffers' }[t]}
          </button>
        ))}
      </div>

      {tab === 'pos' && (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>PO Number</th><th style={S.th}>Item</th><th style={S.th}>Qty</th>
            <th style={S.th}>Promised Ship</th><th style={S.th}>Delay</th><th style={S.th}>Status</th>
          </tr></thead>
          <tbody>{pos.map(p => (
            <tr key={p.id}>
              <td style={S.td}><strong>{p.po_number}</strong></td>
              <td style={S.td}>{p.item_name}</td>
              <td style={S.td}>{p.quantity.toLocaleString()}</td>
              <td style={S.td}>{formatDate(p.promised_ship_date)}</td>
              <td style={S.td}>{p.delay_days > 0 ? <span style={{ color: '#ef4444', fontWeight: 600 }}>+{p.delay_days}d</span> : '—'}</td>
              <td style={S.td}>{statusBadge(p.status)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      {tab === 'sos' && (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>SO Number</th><th style={S.th}>Customer</th><th style={S.th}>Item</th>
            <th style={S.th}>Promised Delivery</th><th style={S.th}>Revised</th><th style={S.th}>Revenue</th><th style={S.th}>Status</th>
          </tr></thead>
          <tbody>{sos.map(s => (
            <tr key={s.id}>
              <td style={S.td}><strong>{s.so_number}</strong></td>
              <td style={S.td}>{s.customer_name}</td>
              <td style={S.td}>{s.item_code}</td>
              <td style={S.td}>{formatDate(s.promised_delivery_date)}</td>
              <td style={S.td}>{s.updated_delivery_date ? <span style={{ color: '#f97316' }}>{formatDate(s.updated_delivery_date)}</span> : '—'}</td>
              <td style={S.td}>{formatCurrency(s.revenue)}</td>
              <td style={S.td}>{statusBadge(s.status)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      {tab === 'inventory' && (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Item Code</th><th style={S.th}>Region</th><th style={S.th}>On Hand</th>
            <th style={S.th}>Reorder Point</th><th style={S.th}>Safety Stock</th><th style={S.th}>On Order</th><th style={S.th}>Health</th>
          </tr></thead>
          <tbody>{inventory.map(b => {
            const health = b.on_hand >= b.safety_stock ? 'green' : b.on_hand >= b.reorder_point ? 'yellow' : 'red';
            return (
              <tr key={b.id}>
                <td style={S.td}><strong>{b.item_code}</strong></td>
                <td style={S.td}>{b.region}</td>
                <td style={S.td}>{b.on_hand.toLocaleString()}</td>
                <td style={S.td}>{b.reorder_point.toLocaleString()}</td>
                <td style={S.td}>{b.safety_stock.toLocaleString()}</td>
                <td style={S.td}>{b.on_order.toLocaleString()}</td>
                <td style={S.td}>{statusBadge(health === 'green' ? 'open' : health === 'yellow' ? 'awaiting_approval' : 'delayed')}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </div>
  );
}

function VendorsPage() {
  const [vendors, setVendors] = useState([]);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => { api.getVendors().then(r => setVendors(r.data)).catch(() => {}); }, []);

  const viewHistory = async (v) => {
    setSelected(v);
    const res = await api.getVendorHistory(v.id);
    setHistory(res.data);
  };

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Memory Bank – Vendor Profiles</h2>
      <div style={S.grid2}>
        {vendors.map(v => (
          <div key={v.id} style={{ ...S.card, cursor: 'pointer', borderLeft: `4px solid ${v.reliability_score > 0.85 ? '#10b981' : v.reliability_score > 0.70 ? '#f59e0b' : '#ef4444'}` }} onClick={() => viewHistory(v)}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{v.name}</div>
            <div style={{ fontSize: 12, color: '#57606a', marginBottom: 6 }}>{v.region} · Reliability: {(v.reliability_score * 100).toFixed(0)}% · Avg delay: {v.avg_delay_days}d</div>
            <div style={{ fontSize: 11, color: '#57606a' }}>{v.sla_clause}</div>
          </div>
        ))}
      </div>

      {selected && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 15 }}>Delivery History: {selected.name}</h3>
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>PO Number</th><th style={S.th}>Promised</th><th style={S.th}>Actual</th><th style={S.th}>Delay</th><th style={S.th}>Status</th>
            </tr></thead>
            <tbody>{history.map(h => (
              <tr key={h.id}>
                <td style={S.td}>{h.po_number}</td>
                <td style={S.td}>{formatDate(h.promised_date)}</td>
                <td style={S.td}>{formatDate(h.actual_date)}</td>
                <td style={S.td}>{h.delay_days > 0 ? <span style={{ color: '#ef4444' }}>+{h.delay_days}d</span> : '0d'}</td>
                <td style={S.td}>{statusBadge(h.status)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WarehousePage() {
  const [transfers, setTransfers] = useState([]);
  const [freights, setFreights] = useState([]);

  useEffect(() => {
    api.getTransfers().then(r => setTransfers(r.data)).catch(() => {});
    api.getFreightRequests().then(r => setFreights(r.data)).catch(() => {});
  }, []);

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Warehouse & Freight Sub-Agents</h2>
      <h3 style={{ fontSize: 15 }}>Warehouse Transfer Orders</h3>
      <table style={S.table}>
        <thead><tr>
          <th style={S.th}>WTO Number</th><th style={S.th}>Item</th><th style={S.th}>From</th><th style={S.th}>To</th><th style={S.th}>Qty</th><th style={S.th}>Status</th>
        </tr></thead>
        <tbody>{transfers.map(t => (
          <tr key={t.id}>
            <td style={S.td}><strong>{t.wto_number}</strong></td>
            <td style={S.td}>{t.item_code}</td>
            <td style={S.td}>{t.from_location}</td>
            <td style={S.td}>{t.to_location}</td>
            <td style={S.td}>{t.quantity}</td>
            <td style={S.td}>{statusBadge(t.status)}</td>
          </tr>
        ))}
        {transfers.length === 0 && <tr><td colSpan={6} style={{ ...S.td, color: '#57606a', textAlign: 'center' }}>No transfer orders yet</td></tr>}
        </tbody>
      </table>

      <h3 style={{ fontSize: 15, marginTop: 24 }}>Freight Requests</h3>
      <table style={S.table}>
        <thead><tr>
          <th style={S.th}>FR Number</th><th style={S.th}>Mode</th><th style={S.th}>Origin</th><th style={S.th}>Destination</th><th style={S.th}>Cost</th><th style={S.th}>Status</th>
        </tr></thead>
        <tbody>{freights.map(f => (
          <tr key={f.id}>
            <td style={S.td}><strong>{f.fr_number}</strong></td>
            <td style={S.td}><strong>{f.mode?.toUpperCase()}</strong></td>
            <td style={S.td}>{f.origin}</td>
            <td style={S.td}>{f.destination}</td>
            <td style={S.td}>{formatCurrency(f.estimated_cost)}</td>
            <td style={S.td}>{statusBadge(f.status)}</td>
          </tr>
        ))}
        {freights.length === 0 && <tr><td colSpan={6} style={{ ...S.td, color: '#57606a', textAlign: 'center' }}>No freight requests yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AuditPage() {
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.getAuditLogs({ limit: 100 }).then(r => setLogs(r.data)).catch(() => {});
    api.getAuditStats().then(r => setStats(r.data)).catch(() => {});
  }, []);

  const filtered = filter ? logs.filter(l => l.event_type?.includes(filter.toUpperCase()) || l.session_id?.includes(filter)) : logs;

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Agent Observability – Audit Ledger</h2>
      {stats && (
        <div style={{ ...S.grid3, marginBottom: 20 }}>
          <MetricCard label="Total Events" value={stats.total} color="#3b82d4" />
          <MetricCard label="Event Types" value={stats.byType?.length || 0} color="#8b5cf6" />
          <MetricCard label="Errors" value={stats.bySeverity?.find(s => s.severity === 'error')?.count || 0} color="#ef4444" />
        </div>
      )}
      <input
        style={{ ...S.input, width: 320, marginBottom: 12 }}
        placeholder="Filter by event type or session ID…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <table style={S.table}>
        <thead><tr>
          <th style={S.th}>Time</th><th style={S.th}>Event Type</th><th style={S.th}>Agent</th>
          <th style={S.th}>Session</th><th style={S.th}>Outcome</th><th style={S.th}>Severity</th>
        </tr></thead>
        <tbody>{filtered.map(l => (
          <tr key={l.id}>
            <td style={S.td}>{new Date(l.created_at).toLocaleTimeString()}</td>
            <td style={S.td}><code style={{ fontSize: 11 }}>{l.event_type}</code></td>
            <td style={S.td}>{l.agent_id}</td>
            <td style={S.td}><code style={{ fontSize: 11 }}>{l.session_id?.slice(0, 8)}…</code></td>
            <td style={S.td}>{l.outcome ? statusBadge(l.outcome === 'success' ? 'open' : l.outcome === 'failure' ? 'delayed' : 'awaiting_approval') : '—'}</td>
            <td style={S.td}>{statusBadge(l.severity === 'error' ? 'delayed' : l.severity === 'warn' ? 'awaiting_approval' : 'open')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const MEMORY_TYPES = ['vendor_preference', 'risk_threshold', 'escalation_pattern', 'observation'];
function importanceLabel(imp) {
  if (imp >= 0.8) return { label: 'Critical', color: 'red' };
  if (imp >= 0.6) return { label: 'High', color: 'yellow' };
  if (imp >= 0.4) return { label: 'Medium', color: 'blue' };
  return { label: 'Low', color: 'gray' };
}

function MemoryPage() {
  const [memories, setMemories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterAgent, setFilterAgent] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ agent_id: 'agent-orchestrator-v1', memory_type: 'observation', content: '', importance: 0.5 });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      let res;
      if (q && q.trim()) {
        res = await api.searchMemories(q.trim(), 50);
      } else {
        res = await api.getMemories({
          memory_type: filterType || undefined,
          agent_id: filterAgent || undefined,
          limit: 100,
        });
      }
      setMemories(res.data);
    } catch (_) { setMemories([]); }
    setLoading(false);
  }, [filterType, filterAgent]);

  useEffect(() => { load(search); }, [load, search]);

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this memory permanently?')) return;
    try {
      await api.deleteMemory(id);
      setMemories(prev => prev.filter(m => m.id !== id));
    } catch (e) { alert('Delete failed: ' + e.message); }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.storeMemory({ ...form, importance: parseFloat(form.importance) });
      setShowForm(false);
      setForm({ agent_id: 'agent-orchestrator-v1', memory_type: 'observation', content: '', importance: 0.5 });
      load(search);
    } catch (err) { alert('Save failed: ' + (err.response?.data?.error || err.message)); }
    setSaving(false);
  };

  const imp = importanceLabel;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Long-Term Agent Memories</h2>
        <button onClick={() => setShowForm(f => !f)} style={S.btn('primary')}>
          {showForm ? '✕ Cancel' : '+ Add Memory'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSave} style={{ ...S.card, marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>Store New Memory</div>
          <div style={S.grid2}>
            <div>
              <div style={{ fontSize: 12, color: '#57606a', marginBottom: 4 }}>Agent ID</div>
              <input style={S.input} value={form.agent_id} onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))} placeholder="agent-orchestrator-v1" required />
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#57606a', marginBottom: 4 }}>Memory Type</div>
              <select style={{ ...S.input }} value={form.memory_type} onChange={e => setForm(f => ({ ...f, memory_type: e.target.value }))}>
                {MEMORY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: '#57606a', marginBottom: 4 }}>Learned Fact / Content</div>
            <textarea
              style={{ ...S.input, height: 80, resize: 'vertical', fontFamily: 'inherit' }}
              value={form.content}
              onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
              placeholder="e.g. Pacific Rim Fabricators consistently delays by 7+ days during Q1 typhoon season — always escalate immediately."
              required
            />
          </div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: '#57606a', marginBottom: 4 }}>Importance (0–1)</div>
              <input type="number" min="0" max="1" step="0.1" style={{ ...S.input, width: 90 }} value={form.importance} onChange={e => setForm(f => ({ ...f, importance: e.target.value }))} />
            </div>
            <div style={{ marginTop: 18 }}>{statusBadge(imp(parseFloat(form.importance)).label === 'Critical' ? 'delayed' : imp(parseFloat(form.importance)).label === 'High' ? 'awaiting_approval' : 'open')}</div>
          </div>
          <div style={{ marginTop: 14 }}>
            <button type="submit" disabled={saving} style={S.btn('primary')}>{saving ? 'Saving…' : 'Save Memory'}</button>
          </div>
        </form>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <input
          style={{ ...S.input, width: 260 }}
          placeholder="Search memories…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select style={{ ...S.input, width: 200 }} value={filterType} onChange={e => { setFilterType(e.target.value); setSearch(''); }}>
          <option value="">All types</option>
          {MEMORY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select style={{ ...S.input, width: 240 }} value={filterAgent} onChange={e => { setFilterAgent(e.target.value); setSearch(''); }}>
          <option value="">All agents</option>
          <option value="agent-orchestrator-v1">agent-orchestrator-v1</option>
          <option value="agent-memory-v1">agent-memory-v1</option>
          <option value="agent-warehouse-v1">agent-warehouse-v1</option>
          <option value="agent-freight-v1">agent-freight-v1</option>
        </select>
        <button onClick={() => load(search)} style={S.btn('ghost')}>↺ Refresh</button>
      </div>

      {loading && <div style={{ color: '#57606a', fontSize: 13, marginBottom: 10 }}>Loading…</div>}

      {memories.length === 0 && !loading && (
        <div style={{ ...S.card, color: '#57606a', textAlign: 'center', padding: 32, fontSize: 13 }}>
          No memories stored yet. Memories are created by agents during processing sessions,
          or you can add one manually above.
        </div>
      )}

      {memories.map(m => {
        const { label, color } = imp(m.importance);
        return (
          <div key={m.id} style={{ ...S.card, borderLeft: `4px solid ${color === 'red' ? '#ef4444' : color === 'yellow' ? '#f59e0b' : color === 'blue' ? '#3b82d4' : '#d1d5db'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, marginRight: 16 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={S.badge('blue')}>{m.memory_type?.replace(/_/g, ' ')}</span>
                  <span style={S.badge(color)}>{label}</span>
                  <span style={{ fontSize: 11, color: '#57606a' }}>{m.agent_id}</span>
                  {m.session_id && <span style={{ fontSize: 11, color: '#57606a' }}>session:{m.session_id.slice(0, 8)}</span>}
                </div>
                <div style={{ fontSize: 13, color: '#1f2328', marginBottom: 6, lineHeight: 1.5 }}>{m.content}</div>
                {m.metadata && Object.keys(m.metadata).length > 0 && (
                  <div style={{ fontSize: 11, color: '#57606a' }}>
                    {Object.entries(m.metadata).map(([k, v]) => (
                      <span key={k} style={{ marginRight: 10 }}><strong>{k}:</strong> {String(v)}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 11, color: '#57606a', marginBottom: 6 }}>{formatDate(m.created_at)}</div>
                <div style={{ fontSize: 11, color: '#57606a', marginBottom: 8 }}>importance: {m.importance?.toFixed(1)}</div>
                <button onClick={() => handleDelete(m.id)} style={{ ...S.btn('danger'), padding: '3px 10px', fontSize: 11 }}>Delete</button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RegistryPage() {
  const [agents, setAgents] = useState([]);
  useEffect(() => { api.getAgents().then(r => setAgents(r.data)).catch(() => {}); }, []);

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Agent Registry</h2>
      {agents.map(a => (
        <div key={a.id} style={{ ...S.card, borderLeft: `4px solid ${a.status === 'active' ? '#10b981' : '#e5e7eb'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{a.name}</div>
              <div style={{ fontSize: 11, color: '#57606a' }}>{a.id} · {a.version}</div>
            </div>
            {statusBadge(a.status)}
          </div>
          <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>{a.description}</div>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {(a.capabilities || []).map(c => (
              <span key={c} style={{ background: '#dbeafe', color: '#1e40af', borderRadius: 4, fontSize: 10, padding: '2px 6px', fontWeight: 500 }}>{c}</span>
            ))}
          </div>
          <div style={{ fontSize: 11, color: '#57606a', marginTop: 6 }}>Endpoint: <code>{a.endpoint}</code></div>
        </div>
      ))}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [liveFeed, setLiveFeed] = useState([]);
  const [simulating, setSimulating] = useState(false);
  // Prevent multiple simultaneous refreshes
  const fetchingRef = useRef(false);

  const refreshSummary = useCallback(() => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setSummaryError(null);
    api.getSummary()
      .then(r => { setSummary(r.data); })
      .catch(e => {
        const msg = e?.response?.data?.error || e?.message || 'Network error';
        setSummaryError(msg);
      })
      .finally(() => { fetchingRef.current = false; });
  }, []);

  useEffect(() => { refreshSummary(); }, [refreshSummary]);

  const handleWsMessage = useCallback((msg) => {
    setLiveFeed(prev => [msg, ...prev].slice(0, 50));
    if (['event_approved', 'event_rejected', 'approval_required', 'impact_analysis'].includes(msg.type)) {
      refreshSummary();
    }
  }, [refreshSummary]);

  const wsConnected = useWebSocket(handleWsMessage);

  const simulate = async (scenario) => {
    setSimulating(true);
    try {
      await api.simulate(scenario);
      refreshSummary();
    } catch (e) {
      alert('Simulation error: ' + (e.response?.data?.error || e.message));
    }
    setSimulating(false);
  };

  const NAV = [
    { id: 'dashboard', label: '🏠 Dashboard' },
    { id: 'events', label: '⚡ Events' },
    { id: 'erp', label: '🏭 ERP/SAP' },
    { id: 'vendors', label: '🏢 Vendors' },
    { id: 'warehouse', label: '📦 Warehouse & Freight' },
    { id: 'audit', label: '📋 Audit Ledger' },
    { id: 'registry', label: '🗂️ Agent Registry' },
    { id: 'memories', label: '🧠 Agent Memories' },
  ];

  return (
    <div style={{ fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif', fontSize: 14, background: '#f7f8fa', minHeight: '100vh', color: '#1f2328' }}>
      {/* Header */}
      <div style={{ background: '#1f2328', color: '#fff', padding: '0 24px', height: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>🚢 Ship-Date Drift Orchestrator</div>
          <div style={{ fontSize: 10, background: '#3b82d4', borderRadius: 3, padding: '2px 6px', fontWeight: 600 }}>v1.0.0-FINAL</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: wsConnected ? '#10b981' : '#ef4444' }} />
          <span style={{ color: '#9ca3af' }}>{wsConnected ? 'Live' : 'Connecting…'}</span>
        </div>
      </div>

      <div style={{ display: 'flex', minHeight: 'calc(100vh - 54px)' }}>
        {/* Sidebar */}
        <div style={{ width: 220, background: '#fff', borderRight: '1px solid #e5e7eb', padding: '16px 0', flexShrink: 0 }}>
          {NAV.map(n => (
            <div key={n.id} onClick={() => setPage(n.id)} style={{ padding: '8px 20px', cursor: 'pointer', fontSize: 13, fontWeight: page === n.id ? 600 : 400, background: page === n.id ? '#eff6ff' : 'transparent', color: page === n.id ? '#3b82d4' : '#374151', borderLeft: page === n.id ? '3px solid #3b82d4' : '3px solid transparent' }}>
              {n.label}
            </div>
          ))}

          <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 16, padding: '16px 16px 0' }}>
            <LiveFeed events={liveFeed} />
          </div>
        </div>

        {/* Main Content */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          {page === 'dashboard' && <DashboardPage summary={summary} summaryError={summaryError} onRetry={refreshSummary} onSimulate={simulate} simulating={simulating} />}
          {page === 'events' && <EventsPage onRefresh={refreshSummary} />}
          {page === 'erp' && <ERPPage />}
          {page === 'vendors' && <VendorsPage />}
          {page === 'warehouse' && <WarehousePage />}
          {page === 'audit' && <AuditPage />}
          {page === 'registry' && <RegistryPage />}
          {page === 'memories' && <MemoryPage />}
        </div>
      </div>
    </div>
  );
}
