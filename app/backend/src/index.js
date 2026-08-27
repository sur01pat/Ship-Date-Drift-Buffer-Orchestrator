/**
 * Application Entry Point
 *
 * OTel tracing MUST be initialised before any other require so that
 * auto-instrumentation patches Node.js core modules (http, express, etc.)
 * before they are first imported.
 */

// 1. Load OTel SDK first (before any other imports)
require('./observability/tracing');

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const WebSocket = require('ws');

const config = require('./config');
const logger = require('./logger');
const { db, initSchema } = require('./db');
const registry = require('./registry/agentRegistry');
const memoryBank = require('./memory/memoryBank');
const erpSimulator = require('./erp/erpSimulator');
const gateway = require('./gateway/agentGateway');
const warehouseAgent = require('./warehouse/warehouseAgent');
const freightAgent = require('./freight/freightAgent');
const orchestrator = require('./orchestrator/orchestrator');
const routes = require('./api/routes');

// ── Express Setup ─────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server, health checks)
    if (!origin) return callback(null, true);
    const allowed = [
      config.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:3001',
      // Cloud Run — ship-date-drift project (icnkyenovq)
      'https://orchestrator-frontend-icnkyenovq-uc.a.run.app',
      // Cloud Run — previous gen-lang-client project (backward compat)
      'https://orchestrator-frontend-mdyqup7kmq-uc.a.run.app',
      'https://orchestrator-frontend-619200633547.us-central1.run.app',
    ];
    if (allowed.includes(origin) || origin.endsWith('.run.app')) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ── WebSocket Server (real-time event push) ────────────────────────────────────

const wss = new WebSocket.Server({ server, path: '/ws' });

const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  logger.info('WebSocket client connected', { total: wsClients.size });
  ws.send(JSON.stringify({ type: 'connected', message: 'Orchestrator live feed active' }));

  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info('WebSocket client disconnected', { total: wsClients.size });
  });
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(event, data) {
  const msg = JSON.stringify({ type: event, data, timestamp: new Date().toISOString() });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// Inject broadcaster into orchestrator
orchestrator.setBroadcast(broadcast);

// ── Database Bootstrap ─────────────────────────────────────────────────────────

initSchema();
registry.seed();
memoryBank.seed();
erpSimulator.seed();

// ── Register Sub-Agent Handlers ────────────────────────────────────────────────

gateway.registerAgentHandler('agent-warehouse-v1', warehouseAgent.handle);
gateway.registerAgentHandler('agent-freight-v1', freightAgent.handle);

// ── API Routes ─────────────────────────────────────────────────────────────────

app.use('/api', routes);

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ship-date-drift-orchestrator',
    version: '1.0.0-FINAL',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(config.PORT, () => {
  logger.info(`🚀 Orchestrator backend running on port ${config.PORT}`);
  logger.info(`📡 WebSocket server active at ws://localhost:${config.PORT}/ws`);
  logger.info(`🌐 REST API at http://localhost:${config.PORT}/api`);
  logger.info(`❤️  Health check at http://localhost:${config.PORT}/health`);
});

module.exports = { app, server, db };
