# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Stack

- **Backend** (`app/backend`): Node.js 18 + Express, CommonJS (`require`), SQLite via `better-sqlite3`
- **Frontend** (`app/frontend`): React 18 CRA, no TypeScript
- **ADK layer** (`app/adk`): Python ≥3.11, Google ADK 2.6+, pytest; has its own `.venv` at `app/adk/.venv`

## Commands

### Dev (all-in-one)
```bash
./start-dev.sh     # installs deps, runs all tests, then starts backend:4000 + frontend:3000
```

### Backend
```bash
cd app/backend
npm test                              # all tests (Jest, --runInBand --forceExit)
npm run test:coverage                 # all tests + Istanbul coverage report
npx jest tests/armor.test.js         # single test file
npx jest tests/e2e.test.js --runInBand --forceExit  # full e2e suite
```

### ADK Python
```bash
cd app/adk
.venv/bin/pytest tests/ -v --tb=short
.venv/bin/pytest tests/test_tools.py::test_list_purchase_orders  # single test
```

### Docker
```bash
cd app && docker compose up --build
```

## GCP Services Used (All Subsystems)

| Subsystem | GCP Service | Module |
|---|---|---|
| Agent Registry | Vertex AI Agent Engine API (reasoningEngines) + Firestore `agent_registry/` | `src/registry/agentRegistry.js` |
| Agent Runtime | Cloud Firestore `agent_sessions/` + Cloud Tasks `orchestrator-long-running` | `src/runtime/agentRuntime.js` |
| Memory Bank | Cloud Firestore `vendor_profiles/` + `agent_memories/` + Secret Manager (SLA clauses) + Cloud Storage (history archive) | `src/memory/memoryBank.js` |
| Agent Identity | GCP SA OIDC (iamcredentials API) + Secret Manager `orchestrator-jwt-secret` + Cloud Audit Logs | `src/identity/agentIdentity.js` |
| Agent Gateway | In-process policy engine (deterministic) + SQLite audit log | `src/gateway/agentGateway.js` |
| Model Armor | GCP Model Armor API (regional REP endpoint) + Cloud DLP (opt-in, `DLP_ENABLED=true`) | `src/armor/modelArmor.js` |
| Observability | Cloud Logging (structured JSON stdout) + Cloud Trace (OTel OTLP/gRPC) + Cloud Monitoring custom metrics | `src/observability/auditLog.js` + `src/observability/tracing.js` |
| Orchestrator | Cloud Pub/Sub `orchestrator-events` + Cloud Tasks `orchestrator-approval-reminders` | `src/orchestrator/orchestrator.js` |
| Deployment | Vertex AI Agent Engine (ADK `root_agent`) + Cloud Run + Cloud Build | `app/adk/deployment/` |

## Non-obvious Architecture Constraints

- **OTel tracing MUST be `require`d first** in `src/index.js` — auto-instrumentation patches Node.js core modules at import time. Never reorder.
- **`scan()` is synchronous; `scanAsync()` is async** in `modelArmor.js`. Orchestrator hot path uses `scan()`. Only `POST /api/armor/scan` calls `scanAsync()` (GCP Model Armor → Cloud DLP → local fallback).
- **Model Armor uses the Regional Endpoint (REP)** — `modelarmor.<LOCATION>.rep.googleapis.com`. Global endpoint returns 403. Controlled by `MODEL_ARMOR_BASE_URL`.
- **Cloud DLP is opt-in** (`DLP_ENABLED=true`). It runs as Layer 3 after GCP Model Armor. Disabled by default to avoid API costs in dev.
- **Backend is the "tool server"** for ADK — all ADK `FunctionTool` functions call the Node REST API via `app/adk/tool_server_client.py`. Adding a tool requires (1) Node endpoint in `routes.js`, (2) client function in `tool_server_client.py`, (3) `_private()` + `FunctionTool` in the tools file.
- **Long-term memories** are stored in SQLite `agent_memories` table, mirrored async to Firestore `agent_memories/`. REST: `GET/POST/DELETE /api/memory/memories`, `GET /api/memory/memories/search?q=`. Three ADK tools: `store_memory`, `retrieve_memories`, `search_memories` in `memory_tools.py` (memory_bank_agent now has 7 tools).
- **`root_agent` naming is mandatory** — `app/adk/agent.py` exports the `SequentialAgent` as `root_agent`. ADK runner discovers agents by this exact name.
- **ADK FunctionTool access in tests**: call `.func(...)` directly — `FunctionTool.func` is the unwrapped callable.
- **Gateway policy thresholds are mirrored** in `agentGateway.js` (`POLICY`) and `app/adk/config.py`. Both must stay in sync.
- **JWT bootstrap** (`bootstrapTokens()`) always issues local JWTs — GCP OIDC tokens are audience-specific and unsuitable for internal tool-server auth. `SECRET_MANAGER_JWT_ENABLED=true` enables Secret Manager for the JWT secret in production.
- **SQLite WAL mode + foreign keys** enabled in `src/db.js`. All DB JSON columns are stored as TEXT strings.
- **All GCP integrations are fail-open** — Firestore, Pub/Sub, Cloud Tasks, and Monitoring failures are caught and logged as warnings; they never block the orchestration workflow.
- **Agent Runtime** (`src/runtime/agentRuntime.js`) manages long-running session state in Firestore. Sessions hibernate after `SESSION_TIMEOUT_MS` (default 30 min) and resume on next event.
- **Cloud Monitoring custom metrics** (`custom.googleapis.com/orchestrator/*`) are written from `src/observability/auditLog.js`. The four metrics are: `events_processed`, `revenue_at_risk`, `armor_blocks`, `pending_approvals`.
- **Cloud Pub/Sub** publishes four event types: `REMEDIATION_STAGED`, `EVENT_APPROVED`, `EVENT_BLOCKED`, `EVENT_REJECTED` to topic `orchestrator-events`. Downstream consumers subscribe without polling.
- **Cloud Tasks queues**: `orchestrator-approval-reminders` (1h delay reminders) and `orchestrator-long-running` (background step execution). Both use OIDC tokens for caller verification.

## Environment Variables (New GCP Services)

| Variable | Default | Notes |
|---|---|---|
| `FIRESTORE_REGISTRY_ENABLED` | `true` | Mirror agent manifests to Firestore `agent_registry/` |
| `FIRESTORE_MEMORY_ENABLED` | `true` | Mirror vendor profiles to Firestore `vendor_profiles/` and agent memories to `agent_memories/` |
| `FIRESTORE_SESSIONS_ENABLED` | `true` | Persist runtime sessions to Firestore `agent_sessions/` |
| `SECRET_MANAGER_JWT_ENABLED` | `false` | Fetch JWT secret from Secret Manager `orchestrator-jwt-secret` |
| `SECRET_MANAGER_SLA_ENABLED` | `false` | Fetch vendor SLA clauses from Secret Manager |
| `PUBSUB_EVENTS_ENABLED` | `true` | Publish events to Cloud Pub/Sub |
| `PUBSUB_TOPIC_ID` | `orchestrator-events` | Pub/Sub topic name |
| `CLOUD_TASKS_ENABLED` | `true` | Schedule approval reminders via Cloud Tasks |
| `CLOUD_TASKS_QUEUE` | `orchestrator-approval-reminders` | Reminder queue name |
| `RUNTIME_TASKS_ENABLED` | `true` | Enqueue long-running steps via Cloud Tasks |
| `LONG_RUNNING_QUEUE` | `orchestrator-long-running` | Background execution queue |
| `DLP_ENABLED` | `false` | Enable Cloud DLP as Layer 3 in Model Armor pipeline |
| `GCS_ARCHIVE_BUCKET` | `{project}-memory-archive` | GCS bucket for delivery history archival |
| `GEMINI_BACKEND` | auto-detected | `gemini_api` (needs `GOOGLE_API_KEY`) or `vertex_ai` (needs ADC) |
| `TOOL_SERVER_URL` | Cloud Run URL | Override to `http://localhost:4000` for local ADK dev |
| `MODEL_ARMOR_ENABLED` | `true` | Set `false` to disable GCP calls in tests |
| `GCP_IDENTITY_ENABLED` | `true` | Set `false` to use local JWT in tests |

## Code Style

### JavaScript (Backend)
- CommonJS throughout (`require`/`module.exports`) — no ESM
- All GCP SDK calls are lazy-`require`d inside functions (not at module top-level) so the module loads fast and GCP packages are optional in test environments
- All DB JSON columns: `JSON.stringify()` on write, `JSON.parse()` on read — no ORM
- `better-sqlite3` is synchronous — never `await` a DB call
- Logging always through `require('../logger')` (winston) — never `console.log`
- All async GCP calls use `.catch(() => {})` or `.catch(err => logger.warn(...))` — fail-open

### Python (ADK)
- All tool functions: private `_name()` implementation → `name = FunctionTool(_name)` wrapper
- Type hints required on all tool parameters (ADK JSON Schema generation)
- Model via `get_model_string()` from `model_factory` — never hardcoded
- Every `LlmAgent` attaches both `before_model_callback` and `after_model_callback` from `callbacks/model_armor_callbacks.py`
- `output_key` on `LlmAgent` stores result in session state for downstream agents

## Non-obvious Model Factory Details

- **`make_model()` returns a `_RoutedGemini` inner class** (not plain `Gemini`) — it subclasses `Gemini` to inject the pre-built `google.genai.Client` via an `api_client` property override. This prevents ADK from constructing its own client (which would lose the `api_key` / `vertexai=True`).
- **`GEMINI_API_KEY` is a recognised alias** for `GOOGLE_API_KEY` in both `config.py` and `_detect_backend()`. Either env var activates Gemini API mode.
- **Default model is `gemini-3.7-flash`** (hardcoded in `config.py`). Override via `GEMINI_MODEL` env var.
- **`_build_gemini_api_client()` raises `EnvironmentError`** (not `ValueError`) when no API key is set — test assertions must match `EnvironmentError`.
- **Two `.venv`s exist** in `app/adk/`: `.venv` (Python 3.14, used by `start-dev.sh` and pytest) and `.venv311` (Python 3.11, matches Docker). Dependencies must stay compatible with 3.11.

## Non-obvious ADK Test Patterns

- **`tool_server_client.py` lazily bootstraps its JWT** via `GET /api/auth/bootstrap` on first use. Any test that imports a tool without the `mock_tool_server` fixture will attempt a live HTTP call and fail silently (returns empty token), causing downstream auth failures.
- **`make_model.cache_clear()`** must be called before and after any test that reloads `model_factory` or `config` — the `@lru_cache` persists across test modules unless explicitly cleared.
- **`callbacks/observability_callbacks.py`** exists alongside `model_armor_callbacks.py` — agents needing audit trail callbacks should attach from there (not documented in agent files yet).

## Non-obvious Backend Test Gotchas

- **`process.env.PORT = '0'` must be set before `require('../src/index')`** in every test file that loads the server. Without it, the server binds to port 4000 and collides when multiple test files run together. All test files must have this line first.
- **`generateWTONumber()` and `generateFRNumber()` use `Date.now().slice(-6)`** — two calls within the same millisecond produce a `UNIQUE constraint failed` on the `wto_number` / `fr_number` column. Insert `await new Promise(r => setTimeout(r, 2))` between back-to-back create calls in tests.
- **`agentRegistry.register()` uses `INSERT`, not upsert** — calling it twice with the same `id` throws `UNIQUE constraint failed`. Test IDs must be unique per run (e.g. append `Date.now()`).
- **`SESSION_TIMEOUT_MS` is read at module load time** in `agentRuntime.js` as a `const`. To test heartbeat timeout, you must `jest.resetModules()`, set `process.env.SESSION_TIMEOUT_MS = '1'`, then re-`require` the module.
- **`EVENT_BLOCKED` Pub/Sub is never published by the `/api/orchestrator/ingest` route** — `armorMiddleware` returns HTTP 400 before `processEvent()` runs. `EVENT_BLOCKED` only fires when `processEvent()` is called directly.
- **Pub/Sub is fire-and-forget (`.catch(() => {})`)** — after triggering an action that publishes, `await new Promise(r => setTimeout(r, 100))` is needed before asserting captured pub/sub messages in tests.
