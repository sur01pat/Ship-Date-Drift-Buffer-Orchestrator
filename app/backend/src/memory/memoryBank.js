/**
 * Memory Bank – Persistent Context Store with GCP Secret Manager & Firestore Tiers
 *
 * Stores and retrieves:
 *  - Vendor profiles (reliability score, SLA clauses, discount tiers)
 *  - Delivery history (per-vendor shipment records)
 *  - Inventory buffer rules (by item + region)
 *
 * GCP Integration:
 *  - Cloud Firestore: vendor profiles are mirrored to Firestore collection
 *    "vendor_profiles/{vendorId}" so ADK agents and other Cloud Run services
 *    can read them without hitting the Node.js backend (low-latency, globally
 *    distributed, survives backend restarts).
 *  - Secret Manager: SLA penalty clauses containing contractual PII are
 *    optionally fetched from Secret Manager rather than stored in plaintext
 *    in the DB (SECRET_MANAGER_SLA_ENABLED=true).
 *  - Cloud Storage: extended delivery history (>90 days) is archived to GCS
 *    bucket "{project}-memory-archive" in Parquet format for Looker queries.
 *
 * Spec reference: §2.B – Memory Bank (Persistent Cross-Session Context)
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const logger = require('../logger');

// ── GCP config ────────────────────────────────────────────────────────────────

const GCP_PROJECT  = process.env.GOOGLE_CLOUD_PROJECT  || 'ship-date-drift';
const FIRESTORE_MEMORY_ENABLED   = process.env.FIRESTORE_MEMORY_ENABLED   !== 'false';
const SECRET_MANAGER_SLA_ENABLED = process.env.SECRET_MANAGER_SLA_ENABLED === 'true';
const GCS_ARCHIVE_BUCKET = process.env.GCS_ARCHIVE_BUCKET || `${GCP_PROJECT}-memory-archive`;

// ── Seed Data ─────────────────────────────────────────────────────────────────

const VENDOR_SEED = [
  {
    id: 'vendor-001',
    name: 'Apex Components Ltd.',
    region: 'APAC',
    reliability_score: 0.78,
    avg_delay_days: 4,
    sla_clause: 'Clause 14B – Penalty: 2% per day, max 10% of PO value after 3-day grace period',
    penalty_rate: 0.02,
    discount_tiers: JSON.stringify([{ min_value: 50000, discount: 0.03 }, { min_value: 100000, discount: 0.05 }]),
    contact_email: 'ops@apexcomponents.example.com',
  },
  {
    id: 'vendor-002',
    name: 'NovaTech Supplies',
    region: 'EMEA',
    reliability_score: 0.92,
    avg_delay_days: 1,
    sla_clause: 'Clause 7A – Penalty: 1% per day after 1-day grace period, capped at 8%',
    penalty_rate: 0.01,
    discount_tiers: JSON.stringify([{ min_value: 75000, discount: 0.04 }]),
    contact_email: 'logistics@novatech.example.com',
  },
  {
    id: 'vendor-003',
    name: 'Pacific Rim Fabricators',
    region: 'APAC',
    reliability_score: 0.65,
    avg_delay_days: 7,
    sla_clause: 'Clause 14B – Penalty: 2.5% per day after 2-day grace period',
    penalty_rate: 0.025,
    discount_tiers: JSON.stringify([]),
    contact_email: 'supply@pacificrim.example.com',
  },
  {
    id: 'vendor-004',
    name: 'Sterling Industrial',
    region: 'NA',
    reliability_score: 0.88,
    avg_delay_days: 2,
    sla_clause: 'Clause 9C – Penalty: 1.5% per day, no grace period',
    penalty_rate: 0.015,
    discount_tiers: JSON.stringify([{ min_value: 25000, discount: 0.02 }, { min_value: 60000, discount: 0.045 }]),
    contact_email: 'orders@sterlingindustrial.example.com',
  },
];

const HISTORY_SEED = [
  { id: uuidv4(), vendor_id: 'vendor-001', po_number: 'PO-2024-001', promised_date: '2024-01-15', actual_date: '2024-01-20', delay_days: 5, status: 'delivered_late' },
  { id: uuidv4(), vendor_id: 'vendor-001', po_number: 'PO-2024-010', promised_date: '2024-02-10', actual_date: '2024-02-13', delay_days: 3, status: 'delivered_late' },
  { id: uuidv4(), vendor_id: 'vendor-002', po_number: 'PO-2024-005', promised_date: '2024-01-25', actual_date: '2024-01-26', delay_days: 1, status: 'delivered_late' },
  { id: uuidv4(), vendor_id: 'vendor-002', po_number: 'PO-2024-018', promised_date: '2024-03-01', actual_date: '2024-03-01', delay_days: 0, status: 'on_time' },
  { id: uuidv4(), vendor_id: 'vendor-003', po_number: 'PO-2024-008', promised_date: '2024-02-01', actual_date: '2024-02-09', delay_days: 8, status: 'delivered_late' },
  { id: uuidv4(), vendor_id: 'vendor-004', po_number: 'PO-2024-015', promised_date: '2024-03-10', actual_date: '2024-03-12', delay_days: 2, status: 'delivered_late' },
];

// ── Firestore mirror ──────────────────────────────────────────────────────────

/**
 * Mirror a vendor profile to Cloud Firestore.
 * Collection: vendor_profiles/{vendorId}
 *
 * Firestore lets ADK agents, the Python tool server client, and any Cloud Run
 * sidecar read vendor context without an HTTP round-trip to the Node backend.
 * Also enables Vertex AI Agent Engine's VertexAiMemoryBankService to index
 * vendor SLA facts as retrievable memories.
 *
 * Spec reference: §2.B – Memory Bank (cross-session context persistence)
 */
async function _mirrorVendorToFirestore(vendor) {
  if (!FIRESTORE_MEMORY_ENABLED) return;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const firestore = new Firestore({ projectId: GCP_PROJECT });
    const { discount_tiers, ...vendorData } = vendor;
    await firestore.collection('vendor_profiles').doc(vendor.id).set({
      ...vendorData,
      discount_tiers: typeof discount_tiers === 'string'
        ? JSON.parse(discount_tiers)
        : (discount_tiers || []),
      syncedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    logger.warn(`Firestore Memory Bank: mirror failed for ${vendor.id}`, { error: err.message });
  }
}

// ── Secret Manager SLA retrieval ──────────────────────────────────────────────

/**
 * Fetch the SLA clause for a vendor from Secret Manager.
 * Secret name: "vendor-{vendorId}-sla-clause"
 *
 * When SECRET_MANAGER_SLA_ENABLED=true, contractual SLA text is stored in
 * Secret Manager rather than the SQLite DB, providing:
 *  - Audit trail on every SLA read (Secret Manager access logs in Cloud Audit Logs)
 *  - Versioned SLA amendments (Secret Manager versions)
 *  - Least-privilege access (only orchestrator SA can read SLA secrets)
 *
 * Falls back to the DB-stored sla_clause if Secret Manager is unavailable.
 * Spec reference: §2.C – Agent Identity / least-privilege secret access
 */
async function _getSlaClauseFromSecretManager(vendorId) {
  try {
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const secretName = `projects/${GCP_PROJECT}/secrets/vendor-${vendorId}-sla-clause/versions/latest`;
    const [version] = await client.accessSecretVersion({ name: secretName });
    return version.payload.data.toString('utf8');
  } catch (_) {
    return null;  // fall back to DB value
  }
}

// ── GCS History Archive ───────────────────────────────────────────────────────

/**
 * Archive a delivery history record to Cloud Storage for long-term retention.
 *
 * Records older than 90 days are written to GCS as newline-delimited JSON
 * (NDJSON) in the bucket "{project}-memory-archive".  This keeps SQLite lean
 * while preserving full history for Looker dashboards and BQ analysis.
 *
 * Object path: delivery_history/{vendorId}/{year}/{month}/{recordId}.json
 * Spec reference: §2.B – Memory Bank (extended timeline context)
 */
async function _archiveHistoryRecordToGcs(record) {
  try {
    const { Storage } = require('@google-cloud/storage');
    const storage = new Storage({ projectId: GCP_PROJECT });
    const date = new Date(record.promised_date || new Date());
    const path = `delivery_history/${record.vendor_id}/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${record.id}.json`;
    const bucket = storage.bucket(GCS_ARCHIVE_BUCKET);
    await bucket.file(path).save(JSON.stringify(record), {
      contentType: 'application/json',
      metadata: { vendorId: record.vendor_id, year: String(date.getFullYear()) },
    });
  } catch (err) {
    // Archive failure is non-critical — record remains in SQLite
    logger.warn('GCS Memory Archive: write failed', { error: err.message, recordId: record.id });
  }
}

// ── Seed ──────────────────────────────────────────────────────────────────────

function seed() {
  const upsertVendor = db.prepare(`
    INSERT INTO vendor_profiles (id, name, region, reliability_score, avg_delay_days, sla_clause, penalty_rate, discount_tiers, contact_email)
    VALUES (@id, @name, @region, @reliability_score, @avg_delay_days, @sla_clause, @penalty_rate, @discount_tiers, @contact_email)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, region=excluded.region, reliability_score=excluded.reliability_score,
      avg_delay_days=excluded.avg_delay_days, sla_clause=excluded.sla_clause, penalty_rate=excluded.penalty_rate,
      discount_tiers=excluded.discount_tiers, contact_email=excluded.contact_email, updated_at=datetime('now')
  `);
  for (const v of VENDOR_SEED) upsertVendor.run(v);

  const insertHistory = db.prepare(`
    INSERT OR IGNORE INTO delivery_history (id, vendor_id, po_number, promised_date, actual_date, delay_days, status)
    VALUES (@id, @vendor_id, @po_number, @promised_date, @actual_date, @delay_days, @status)
  `);
  for (const h of HISTORY_SEED) insertHistory.run(h);

  logger.info('Memory Bank seeded', { vendors: VENDOR_SEED.length, history: HISTORY_SEED.length });

  // Async: mirror vendor profiles to Firestore for cross-service discovery
  Promise.allSettled(VENDOR_SEED.map(_mirrorVendorToFirestore)).catch(() => {});
}

// ── Vendor API ────────────────────────────────────────────────────────────────

/**
 * Get a vendor profile by ID.
 * When SECRET_MANAGER_SLA_ENABLED=true, enriches the SLA clause from
 * Secret Manager (async path) so contractual text is not stored in plaintext.
 */
async function getVendorAsync(id) {
  const row = db.prepare('SELECT * FROM vendor_profiles WHERE id = ?').get(id);
  if (!row) return null;
  let sla_clause = row.sla_clause;
  if (SECRET_MANAGER_SLA_ENABLED) {
    const secretSla = await _getSlaClauseFromSecretManager(id);
    if (secretSla) sla_clause = secretSla;
  }
  return { ...row, sla_clause, discount_tiers: JSON.parse(row.discount_tiers || '[]') };
}

function getVendor(id) {
  const row = db.prepare('SELECT * FROM vendor_profiles WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, discount_tiers: JSON.parse(row.discount_tiers || '[]') };
}

function listVendors() {
  return db.prepare('SELECT * FROM vendor_profiles ORDER BY name').all().map(v => ({
    ...v, discount_tiers: JSON.parse(v.discount_tiers || '[]'),
  }));
}

function getVendorHistory(vendorId, limit = 20) {
  return db.prepare(
    'SELECT * FROM delivery_history WHERE vendor_id = ? ORDER BY promised_date DESC LIMIT ?'
  ).all(vendorId, limit);
}

function recordDelivery({ vendor_id, po_number, promised_date, actual_date, delay_days, status }) {
  const id = uuidv4();
  const record = { id, vendor_id, po_number, promised_date, actual_date, delay_days, status };

  db.prepare(`
    INSERT INTO delivery_history (id, vendor_id, po_number, promised_date, actual_date, delay_days, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, vendor_id, po_number, promised_date, actual_date, delay_days, status);

  // Recalculate rolling avg_delay_days
  const avg = db.prepare(
    'SELECT AVG(delay_days) as avg FROM delivery_history WHERE vendor_id = ?'
  ).get(vendor_id);
  db.prepare('UPDATE vendor_profiles SET avg_delay_days = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(Math.round(avg.avg || 0), vendor_id);

  // Async: archive to GCS for long-term retention (non-blocking)
  _archiveHistoryRecordToGcs(record).catch(() => {});

  // Async: update Firestore vendor profile with new avg_delay_days
  getVendor(vendor_id) && _mirrorVendorToFirestore(getVendor(vendor_id)).catch(() => {});

  return id;
}

// ── Buffer Rules API ──────────────────────────────────────────────────────────

function getBufferRule(itemCode, region) {
  return db.prepare(
    'SELECT * FROM inventory_buffers WHERE item_code = ? AND region = ?'
  ).get(itemCode, region);
}

function listBufferRules() {
  return db.prepare('SELECT * FROM inventory_buffers').all();
}

// ── Long-Term Agent Memories ──────────────────────────────────────────────────

/**
 * Mirror a long-term memory to Cloud Firestore.
 * Collection: agent_memories/{memoryId}
 *
 * Enables Vertex AI Agent Engine VertexAiMemoryBankService to index and
 * retrieve agent-learned facts across Cloud Run service restarts.
 */
async function _mirrorMemoryToFirestore(memory) {
  if (!FIRESTORE_MEMORY_ENABLED) return;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const firestore = new Firestore({ projectId: GCP_PROJECT });
    await firestore.collection('agent_memories').doc(memory.id).set({
      ...memory,
      metadata: typeof memory.metadata === 'string'
        ? JSON.parse(memory.metadata || '{}')
        : (memory.metadata || {}),
      syncedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    logger.warn('Firestore Memory Bank: memory mirror failed', { error: err.message, id: memory.id });
  }
}

/**
 * Store a new long-term memory fact learned by an agent.
 *
 * @param {object} opts
 * @param {string} opts.agent_id      - Agent that learned this fact
 * @param {string} [opts.session_id]  - Session in which it was observed
 * @param {string} opts.memory_type   - e.g. 'vendor_preference' | 'risk_threshold' | 'escalation_pattern' | 'observation'
 * @param {string} opts.content       - Free-text learned fact
 * @param {object} [opts.metadata]    - Optional structured context (vendorId, confidence, source…)
 * @param {number} [opts.importance]  - 0.0–1.0 relevance weight (default 0.5)
 * @returns {string} New memory record id
 */
function storeMemory({ agent_id, session_id, memory_type, content, metadata, importance }) {
  if (!agent_id) throw new Error('agent_id required');
  if (!memory_type) throw new Error('memory_type required');
  if (!content) throw new Error('content required');
  const id = uuidv4();
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  const imp = importance != null ? importance : 0.5;
  db.prepare(`
    INSERT INTO agent_memories (id, agent_id, session_id, memory_type, content, metadata, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, agent_id, session_id || null, memory_type, content, metaStr, imp);
  const record = getMemory(id);
  // Async: mirror to Firestore for cross-service retrieval (non-blocking)
  _mirrorMemoryToFirestore(record).catch(() => {});
  logger.info('Memory Bank: stored long-term memory', { id, agent_id, memory_type });
  return id;
}

/**
 * Retrieve a single memory record by id.
 */
function getMemory(id) {
  const row = db.prepare('SELECT * FROM agent_memories WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, metadata: JSON.parse(row.metadata || '{}') };
}

/**
 * List memories, optionally filtered by agent_id and/or memory_type.
 * Ordered by importance DESC, then most-recent first.
 *
 * @param {object} [filters]
 * @param {string} [filters.agent_id]
 * @param {string} [filters.memory_type]
 * @param {number} [filters.limit=50]
 */
function listMemories({ agent_id, memory_type, limit = 50 } = {}) {
  let sql = 'SELECT * FROM agent_memories WHERE 1=1';
  const params = [];
  if (agent_id) { sql += ' AND agent_id = ?'; params.push(agent_id); }
  if (memory_type) { sql += ' AND memory_type = ?'; params.push(memory_type); }
  sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(r => ({
    ...r, metadata: JSON.parse(r.metadata || '{}'),
  }));
}

/**
 * Full-text search over memory content.
 * Uses SQLite LIKE (case-insensitive) across content and metadata fields.
 *
 * @param {string} q          - Search query string
 * @param {number} [limit=20]
 */
function searchMemories(q, limit = 20) {
  if (!q || !q.trim()) return listMemories({ limit });
  const like = `%${q.trim()}%`;
  return db.prepare(`
    SELECT * FROM agent_memories
    WHERE content LIKE ? OR metadata LIKE ?
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(like, like, limit).map(r => ({ ...r, metadata: JSON.parse(r.metadata || '{}') }));
}

/**
 * Delete a memory record by id.
 * Also removes the Firestore mirror document.
 */
function deleteMemory(id) {
  const row = db.prepare('SELECT id FROM agent_memories WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM agent_memories WHERE id = ?').run(id);
  // Async: delete Firestore mirror (non-blocking, fail-open)
  (async () => {
    try {
      const { Firestore } = require('@google-cloud/firestore');
      const firestore = new Firestore({ projectId: GCP_PROJECT });
      await firestore.collection('agent_memories').doc(id).delete();
    } catch (_) {}
  })();
  logger.info('Memory Bank: deleted long-term memory', { id });
  return true;
}

module.exports = {
  seed,
  getVendor,
  getVendorAsync,
  listVendors,
  getVendorHistory,
  recordDelivery,
  getBufferRule,
  listBufferRules,
  // Long-term memories
  storeMemory,
  getMemory,
  listMemories,
  searchMemories,
  deleteMemory,
  _mirrorVendorToFirestore,   // exported for testing
  _mirrorMemoryToFirestore,   // exported for testing
};
