const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '../data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'orchestrator.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    -- Agent Registry
    CREATE TABLE IF NOT EXISTS agent_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      description TEXT,
      capabilities TEXT,   -- JSON array
      input_schema TEXT,   -- JSON
      output_schema TEXT,  -- JSON
      endpoint TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Memory Bank: Vendor History & SLA
    CREATE TABLE IF NOT EXISTS vendor_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT,
      reliability_score REAL DEFAULT 0.85,
      avg_delay_days INTEGER DEFAULT 0,
      sla_clause TEXT,
      penalty_rate REAL DEFAULT 0.02,
      discount_tiers TEXT,   -- JSON
      contact_email TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS delivery_history (
      id TEXT PRIMARY KEY,
      vendor_id TEXT REFERENCES vendor_profiles(id),
      po_number TEXT,
      promised_date TEXT,
      actual_date TEXT,
      delay_days INTEGER DEFAULT 0,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ERP / SAP Simulator
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      vendor_id TEXT REFERENCES vendor_profiles(id),
      po_number TEXT UNIQUE NOT NULL,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_cost REAL NOT NULL,
      promised_ship_date TEXT NOT NULL,
      actual_ship_date TEXT,
      status TEXT DEFAULT 'open',
      delay_days INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bom_items (
      id TEXT PRIMARY KEY,
      item_code TEXT NOT NULL,
      component_code TEXT NOT NULL,
      component_name TEXT NOT NULL,
      quantity_required INTEGER NOT NULL,
      unit TEXT DEFAULT 'EA'
    );

    CREATE TABLE IF NOT EXISTS sales_orders (
      id TEXT PRIMARY KEY,
      so_number TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      item_code TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      promised_delivery_date TEXT NOT NULL,
      updated_delivery_date TEXT,
      status TEXT DEFAULT 'open',
      revenue REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_buffers (
      id TEXT PRIMARY KEY,
      item_code TEXT NOT NULL,
      region TEXT NOT NULL,
      safety_stock INTEGER DEFAULT 0,
      reorder_point INTEGER DEFAULT 0,
      on_hand INTEGER DEFAULT 0,
      on_order INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Warehouse & Freight
    CREATE TABLE IF NOT EXISTS warehouse_transfer_orders (
      id TEXT PRIMARY KEY,
      wto_number TEXT UNIQUE NOT NULL,
      item_code TEXT NOT NULL,
      from_location TEXT NOT NULL,
      to_location TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT DEFAULT 'draft',
      created_by TEXT DEFAULT 'orchestrator',
      approved_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS freight_requests (
      id TEXT PRIMARY KEY,
      fr_number TEXT UNIQUE NOT NULL,
      po_id TEXT REFERENCES purchase_orders(id),
      mode TEXT NOT NULL,   -- 'air' | 'ocean' | 'ground'
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      estimated_cost REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Observability: Audit Logs & Reasoning Traces
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      session_id TEXT,
      payload TEXT,          -- JSON
      reasoning_chain TEXT,  -- JSON array of steps
      outcome TEXT,
      severity TEXT DEFAULT 'info',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Orchestration Events
    CREATE TABLE IF NOT EXISTS orchestration_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_source TEXT NOT NULL,
      raw_payload TEXT,      -- JSON
      sanitized_payload TEXT, -- JSON
      status TEXT DEFAULT 'received',
      processing_steps TEXT, -- JSON array
      remediation_plan TEXT, -- JSON
      human_approval_status TEXT DEFAULT 'pending',
      approved_by TEXT,
      approved_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Vendor Credit Claims
    CREATE TABLE IF NOT EXISTS credit_claims (
      id TEXT PRIMARY KEY,
      claim_number TEXT UNIQUE NOT NULL,
      vendor_id TEXT REFERENCES vendor_profiles(id),
      po_id TEXT REFERENCES purchase_orders(id),
      delay_days INTEGER NOT NULL,
      penalty_amount REAL NOT NULL,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Agent Long-Term Memories (cross-session learned facts)
    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      memory_type TEXT NOT NULL,  -- e.g. 'vendor_preference', 'risk_threshold', 'escalation_pattern', 'observation'
      content TEXT NOT NULL,       -- free-text learned fact
      metadata TEXT,               -- JSON: { vendor_id, confidence, source, ... }
      importance REAL DEFAULT 0.5, -- 0.0–1.0; used for retrieval ranking
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_id ON agent_memories(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_type    ON agent_memories(memory_type);
  `);
}

module.exports = { db, initSchema };
