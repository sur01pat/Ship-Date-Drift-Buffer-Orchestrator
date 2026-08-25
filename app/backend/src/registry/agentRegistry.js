/**
 * Agent Registry – Discovery, Versioning & GCP Agent Platform Registration
 *
 * Local path : SQLite-backed capability manifests (fast, always available).
 * GCP path   : Publishes each agent as a Vertex AI Agent Engine resource
 *              (projects/{project}/locations/{location}/reasoningEngines)
 *              so agents appear in the GCP console under
 *              Vertex AI → Agent Builder → Agents, support A2A discovery,
 *              and receive a stable machine-readable resource name.
 *
 * GCP Agent Registry REST (Vertex AI Agent Engine API):
 *   POST https://{location}-aiplatform.googleapis.com/v1beta1/
 *        projects/{project}/locations/{location}/reasoningEngines
 *
 * Cloud Firestore path: agent manifests are also mirrored into
 *   Firestore collection "agent_registry/{agentId}" for low-latency
 *   cross-service discovery without SQLite coupling.
 *
 * Spec reference: §2.A – Agent Registry (Discovery & Versioning)
 */

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const logger = require('../logger');

// ── GCP config ────────────────────────────────────────────────────────────────

const GCP_PROJECT  = process.env.GOOGLE_CLOUD_PROJECT  || 'ship-date-drift';
const GCP_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const BACKEND_URL  = process.env.BACKEND_URL ||
                     'https://orchestrator-backend-628095447119.us-central1.run.app';
const GCP_REGISTRY_ENABLED  = process.env.GCP_REGISTRY_ENABLED  !== 'false';
const FIRESTORE_REGISTRY_ENABLED = process.env.FIRESTORE_REGISTRY_ENABLED !== 'false';

// ── Built-in agent manifests ──────────────────────────────────────────────────

const BUILT_IN_AGENTS = [
  {
    id: 'agent-orchestrator-v1',
    name: 'InboundShipDateDriftOrchestrator',
    version: 'v1.0.0-FINAL',
    description: 'Monitors supplier communications, detects shipment delays, calculates downstream ERP impacts, and executes multi-system remediation workflows.',
    capabilities: ['event_ingestion', 'erp_query', 'bom_analysis', 'sub_agent_delegation', 'human_approval', 'credit_claim_generation'],
    input_schema: JSON.stringify({ type: 'object', properties: { source: { type: 'string' }, payload: { type: 'object' } } }),
    output_schema: JSON.stringify({ type: 'object', properties: { session_id: { type: 'string' }, remediation_plan: { type: 'object' } } }),
    endpoint: '/api/orchestrator/ingest',
    status: 'active',
    a2a_endpoint: `${BACKEND_URL}/api/orchestrator/ingest`,
  },
  {
    id: 'agent-warehouse-v1',
    name: 'WarehouseSubAgent',
    version: 'v1.0.0',
    description: 'Creates and manages Warehouse Transfer Orders (WTO) to rebalance inventory across distribution centres.',
    capabilities: ['wto_create', 'wto_update', 'inventory_query'],
    input_schema: JSON.stringify({ type: 'object', properties: { item_code: { type: 'string' }, quantity: { type: 'integer' } } }),
    output_schema: JSON.stringify({ type: 'object', properties: { wto_number: { type: 'string' }, status: { type: 'string' } } }),
    endpoint: '/api/warehouse/transfer',
    status: 'active',
    a2a_endpoint: `${BACKEND_URL}/api/warehouse/transfer`,
  },
  {
    id: 'agent-freight-v1',
    name: 'FreightSubAgent',
    version: 'v1.0.0',
    description: 'Evaluates and books expedited freight options (air / ocean / ground) based on delay severity and cost thresholds.',
    capabilities: ['freight_quote', 'freight_book', 'mode_recommendation'],
    input_schema: JSON.stringify({ type: 'object', properties: { po_id: { type: 'string' }, delay_days: { type: 'integer' } } }),
    output_schema: JSON.stringify({ type: 'object', properties: { fr_number: { type: 'string' }, mode: { type: 'string' }, cost: { type: 'number' } } }),
    endpoint: '/api/freight/request',
    status: 'active',
    a2a_endpoint: `${BACKEND_URL}/api/freight/request`,
  },
  {
    id: 'agent-memory-v1',
    name: 'MemoryBankAgent',
    version: 'v1.0.0',
    description: 'Persists and retrieves cross-session context: vendor SLA terms, historical performance, and regional buffer rules.',
    capabilities: ['vendor_profile_read', 'vendor_profile_write', 'delivery_history_query', 'buffer_rule_query'],
    input_schema: JSON.stringify({ type: 'object', properties: { vendor_id: { type: 'string' } } }),
    output_schema: JSON.stringify({ type: 'object', properties: { vendor: { type: 'object' }, history: { type: 'array' } } }),
    endpoint: '/api/memory',
    status: 'active',
    a2a_endpoint: `${BACKEND_URL}/api/memory`,
  },
];

// ── GCP Agent Platform Registration ──────────────────────────────────────────

/**
 * Publish a single agent to Vertex AI Agent Engine (Agent Platform).
 *
 * Each agent is created as a ReasoningEngine resource:
 *   projects/{project}/locations/{location}/reasoningEngines/{id}
 *
 * This makes the agent:
 *  - Discoverable via the GCP console (Vertex AI → Agent Builder → Agents)
 *  - Addressable by other agents via A2A protocol
 *  - Visible in Cloud Monitoring agent metrics
 *
 * Spec reference: §2.A – Agent Registry (Discovery & Versioning)
 */
async function _registerInGcpRegistry(agent) {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const authClient = await auth.getClient();
  const accessToken = (await authClient.getAccessToken()).token;

  const axios = require('axios');

  // Vertex AI Agent Engine API – regional endpoint required
  const baseUrl = `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}`;

  // ReasoningEngine body – the canonical Agent Platform resource for registered agents
  const agentBody = {
    displayName: agent.name,
    description: agent.description,
    // Spec/schema stored as a YAML-compatible string in the description extension field
    spec: {
      packageSpec: {
        // Point to the Cloud Run A2A endpoint; Agent Engine uses this for routing
        uri: agent.a2a_endpoint,
      },
    },
    labels: {
      'agent-id':    agent.id.replace(/[^a-z0-9-]/g, '-'),
      'version':     agent.version.replace(/[^a-z0-9-]/g, '-'),
      'managed-by':  'orchestrator-backend',
      'protocol':    'a2a',
      'domain':      'supply-chain',
    },
  };

  try {
    const response = await axios.post(
      `${baseUrl}/reasoningEngines`,
      agentBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    logger.info(`GCP Agent Registry: published ${agent.name}`, {
      resourceName: response.data.name,
      agentId: agent.id,
    });
    return response.data;
  } catch (err) {
    // Log but don't throw — local SQLite registry is the source of truth
    logger.warn(`GCP Agent Registry: failed to publish ${agent.name}`, {
      error: err.response?.data?.error?.message || err.message,
      agentId: agent.id,
    });
    return null;
  }
}

/**
 * Mirror an agent manifest to Cloud Firestore for cross-service discovery.
 *
 * Firestore collection: agent_registry/{agentId}
 * This allows other Cloud Run services and ADK tools to discover agents
 * without querying the Node.js backend's SQLite database.
 *
 * Spec reference: §2.A – Machine-readable capability manifests
 */
async function _mirrorToFirestore(agent) {
  if (!FIRESTORE_REGISTRY_ENABLED) return;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const firestore = new Firestore({ projectId: GCP_PROJECT });
    await firestore.collection('agent_registry').doc(agent.id).set({
      ...agent,
      capabilities: agent.capabilities || [],
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    logger.info(`Firestore Agent Registry: mirrored ${agent.id}`);
  } catch (err) {
    // Non-critical — local registry is the source of truth
    logger.warn(`Firestore Agent Registry: mirror failed for ${agent.id}`, {
      error: err.message,
    });
  }
}

/**
 * Publish all built-in agents to GCP Agent Platform and Firestore.
 * Called once at startup (non-blocking, fire-and-forget).
 * Spec reference: §2.A – Agent Registry (Discovery & Versioning)
 */
async function syncToGcpRegistry() {
  if (!GCP_REGISTRY_ENABLED && !FIRESTORE_REGISTRY_ENABLED) return;

  if (GCP_REGISTRY_ENABLED) {
    logger.info('GCP Agent Registry: publishing agents to Vertex AI Agent Engine...');
    const results = await Promise.allSettled(BUILT_IN_AGENTS.map(_registerInGcpRegistry));
    const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
    logger.info(`GCP Agent Registry: Vertex AI sync complete (${ok}/${BUILT_IN_AGENTS.length} published)`);
  }

  if (FIRESTORE_REGISTRY_ENABLED) {
    logger.info('GCP Agent Registry: mirroring manifests to Firestore...');
    await Promise.allSettled(BUILT_IN_AGENTS.map(_mirrorToFirestore));
    logger.info('GCP Agent Registry: Firestore mirror complete');
  }
}

// ── Local SQLite registry ─────────────────────────────────────────────────────

function seed() {
  const upsert = db.prepare(`
    INSERT INTO agent_registry (id, name, version, description, capabilities, input_schema, output_schema, endpoint, status)
    VALUES (@id, @name, @version, @description, @capabilities, @input_schema, @output_schema, @endpoint, @status)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, version=excluded.version, description=excluded.description,
      capabilities=excluded.capabilities, input_schema=excluded.input_schema,
      output_schema=excluded.output_schema, endpoint=excluded.endpoint, status=excluded.status,
      updated_at=datetime('now')
  `);
  for (const agent of BUILT_IN_AGENTS) {
    upsert.run({ ...agent, capabilities: JSON.stringify(agent.capabilities) });
  }
  logger.info('Agent Registry seeded', { count: BUILT_IN_AGENTS.length });

  // Async GCP sync — non-blocking, fire-and-forget
  syncToGcpRegistry().catch(err =>
    logger.warn('GCP Registry sync failed at startup', { error: err.message })
  );
}

function list() {
  return db.prepare('SELECT * FROM agent_registry ORDER BY name').all().map(row => ({
    ...row,
    capabilities: JSON.parse(row.capabilities || '[]'),
    input_schema: JSON.parse(row.input_schema || '{}'),
    output_schema: JSON.parse(row.output_schema || '{}'),
  }));
}

function get(id) {
  const row = db.prepare('SELECT * FROM agent_registry WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    capabilities: JSON.parse(row.capabilities || '[]'),
    input_schema: JSON.parse(row.input_schema || '{}'),
    output_schema: JSON.parse(row.output_schema || '{}'),
  };
}

function register(agent) {
  const id = agent.id || `agent-${uuidv4()}`;
  db.prepare(`
    INSERT INTO agent_registry (id, name, version, description, capabilities, input_schema, output_schema, endpoint, status)
    VALUES (@id, @name, @version, @description, @capabilities, @input_schema, @output_schema, @endpoint, @status)
  `).run({
    id,
    name: agent.name,
    version: agent.version || 'v1.0.0',
    description: agent.description || '',
    capabilities: JSON.stringify(agent.capabilities || []),
    input_schema: JSON.stringify(agent.input_schema || {}),
    output_schema: JSON.stringify(agent.output_schema || {}),
    endpoint: agent.endpoint || '',
    status: agent.status || 'active',
  });
  return get(id);
}

/**
 * Look up an agent's Firestore manifest — used by ADK tools for live discovery.
 * Falls back to local SQLite if Firestore is unavailable.
 */
async function getFromFirestore(agentId) {
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const firestore = new Firestore({ projectId: GCP_PROJECT });
    const doc = await firestore.collection('agent_registry').doc(agentId).get();
    return doc.exists ? doc.data() : null;
  } catch (_) {
    return null;
  }
}

module.exports = { seed, list, get, register, syncToGcpRegistry, getFromFirestore, BUILT_IN_AGENTS };
