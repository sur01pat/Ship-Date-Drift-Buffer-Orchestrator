# Project Documentation Context (Non-Obvious Only)

## Architecture Overview

- **`app/adk/`** is NOT a standalone agent — it is a Gemini ADK layer that wraps the Node.js backend as its "tool server". Every ADK `FunctionTool` makes HTTP calls to `app/backend`. The Node backend is the authoritative data store.
- **`app/backend/` serves dual roles**: production REST API (used by React frontend) AND tool server for ADK agent tools.
- **Two parallel orchestration paths exist**: `orchestrator.js` (Node, in-process, synchronous) and the `SequentialAgent` in `app/adk/agents/orchestrator_agent.py` (ADK, async, Gemini-driven). Both implement the same 4-step workflow.
- **`app/adk/.adk/session.db`** is the ADK's SQLite session store (created by `adk web`) — unrelated to the backend's `app/backend/data/orchestrator.db`.

## GCP Service Topology

```
Cloud Armor (WAF)
  └── Cloud Run: orchestrator-backend (Node.js)
        ├── Firestore: agent_registry/, vendor_profiles/, agent_sessions/
        ├── Secret Manager: orchestrator-jwt-secret, vendor-*-sla-clause
        ├── Cloud Storage: {project}-memory-archive (delivery history)
        ├── Cloud Pub/Sub: orchestrator-events (event bus)
        ├── Cloud Tasks: orchestrator-approval-reminders, orchestrator-long-running
        ├── Cloud Monitoring: custom.googleapis.com/orchestrator/* metrics
        ├── Cloud Trace: OTel OTLP/gRPC → telemetry.googleapis.com
        └── Cloud Logging: structured JSON → Cloud Logging (auto-ingested)

Cloud Run: orchestrator-frontend (React)
Vertex AI Agent Engine: root_agent (ADK SequentialAgent)
  ├── GCP Model Armor API: modelarmor.{region}.rep.googleapis.com
  └── Cloud DLP: (DLP_ENABLED=true in production)
```

## Model Armor Architecture

- Two separate code paths: `scan()` (sync, local regex) and `scanAsync()` (async, 3-layer pipeline).
- `scanAsync()` pipeline: Layer 1 (local regex) → Layer 2 (GCP Model Armor REP endpoint) → Layer 3 (Cloud DLP, opt-in).
- Model Armor uses **regional endpoint** (`.rep.`) — global endpoint returns 403.
- Model Armor callbacks in ADK (`callbacks/model_armor_callbacks.py`) call the **Node backend** `/api/armor/scan` route, not GCP directly.

## Agent Runtime

- `src/runtime/agentRuntime.js` is the new **Agent Runtime** module — manages long-running sessions.
- Sessions stored in Firestore `agent_sessions/{sessionId}` — survive Cloud Run restarts.
- Sessions hibernate after 30 min idle (configurable via `SESSION_TIMEOUT_MS`).
- Cloud Tasks `orchestrator-long-running` queue dispatches background execution steps.
- Heartbeat: Cloud Scheduler should call `POST /api/runtime/heartbeat` every 5 minutes to time out stale sessions.

## What Each GCP Service Provides

| Service | Purpose | Enabled by |
|---|---|---|
| Firestore `agent_registry/` | Cross-service agent discovery (no SQLite coupling) | `FIRESTORE_REGISTRY_ENABLED` |
| Firestore `vendor_profiles/` | Low-latency vendor context (no HTTP round-trip) | `FIRESTORE_MEMORY_ENABLED` |
| Firestore `agent_sessions/` | Durable runtime session state (survives restarts) | `FIRESTORE_SESSIONS_ENABLED` |
| Secret Manager | JWT secret + SLA clauses (audit trail, versioning) | `SECRET_MANAGER_JWT_ENABLED`, `SECRET_MANAGER_SLA_ENABLED` |
| Cloud Storage | Long-term delivery history archive (Looker/BQ) | Always on when `recordDelivery()` called |
| Pub/Sub | Async event bus for downstream ERP/ITSM/Slack | `PUBSUB_EVENTS_ENABLED` |
| Cloud Tasks (reminders) | 1h approval reminder if human hasn't responded | `CLOUD_TASKS_ENABLED` |
| Cloud Tasks (runtime) | Background execution of long-running agent steps | `RUNTIME_TASKS_ENABLED` |
| Cloud Monitoring | 4 custom metrics dashboard in GCP console | Always attempted, fail-open |
| Cloud DLP | Enterprise PII redaction (IBAN, API keys, etc.) | `DLP_ENABLED=true` |
| Cloud Trace | Distributed tracing — Node.js + ADK spans joined | `OTEL_ENABLED=true` |
