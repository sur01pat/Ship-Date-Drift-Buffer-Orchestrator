# Project Architecture Rules (Non-Obvious Only)

## Critical Constraints

- **Node backend is stateful; ADK agents must be stateless** — the backend holds SQLite + Firestore. ADK tools are HTTP clients. ADK agents must not store state locally.
- **The 4-step workflow is implemented twice** — `orchestrator.js` (sync, Node) and the ADK `SequentialAgent`. Changes to workflow logic must be applied to both.
- **Gateway policy is the enforcement boundary** — `agentGateway.js` is the only place financial/operational limits are enforced. ADK `config.py` limits are advisory for the LLM's reasoning only.
- **Model Armor is fail-open** — all three layers (local, GCP Model Armor, Cloud DLP) fail open. Security screening can be bypassed when GCP is down. This is intentional for resilience.
- **All GCP integrations are non-blocking** — Firestore, Pub/Sub, Cloud Tasks, Monitoring, Secret Manager are all called with `.catch(() => {})`. They enrich the system but are never on the critical path.

## GCP Service Boundaries

- **Firestore** is NOT the source of truth — SQLite is. Firestore is a mirror for cross-service discovery and resilience. If Firestore and SQLite diverge, SQLite wins.
- **Cloud Pub/Sub** publishes events after the orchestration step completes. Subscribers are external consumers (ERP connectors, Slack bots, BigQuery). The orchestrator does NOT consume from Pub/Sub.
- **Cloud Tasks queues** are one-way: orchestrator enqueues, tasks call back via HTTP. The `OIDC_TOKEN` on Cloud Tasks requests must be verified by `authMiddleware` (the backend is the audience).
- **Secret Manager** is read once per process start (cached in `_cachedJwtSecret`). No per-request Secret Manager calls.
- **Cloud Monitoring metrics** are GAUGE or CUMULATIVE — the four orchestrator metrics must not be misclassified or Cloud Monitoring will reject the time series.

## Agent Runtime State Machine

```
PENDING → RUNNING → AWAITING_APPROVAL → COMPLETED
                  ↘                    ↘ FAILED
                   → TIMED_OUT (via heartbeat after SESSION_TIMEOUT_MS)
```

- Sessions that time out while `AWAITING_APPROVAL` are **not** auto-rejected — they are marked `TIMED_OUT` and require manual intervention.
- `checkpointSession()` removes the session from in-memory `_localSessions` map but keeps it in Firestore. `resumeSession()` reloads it.
- Cloud Scheduler must hit `POST /api/runtime/heartbeat` every 5 minutes for timeout enforcement to work.

## Agent Registry — Dual-Path Design

- **SQLite** (via `src/db.js`) is the local registry — fast, always available, used by REST API.
- **Vertex AI Agent Engine** (reasoningEngines) is the GCP registry — visible in GCP console, enables A2A discovery. Published async at startup via `syncToGcpRegistry()`.
- **Firestore** `agent_registry/` is the cross-service registry — ADK tools and Cloud Run sidecars can look up agents without HTTP round-trip to the Node backend.
- Registration failures in GCP/Firestore do not affect local operation. Never block on them.

## Memory Bank — Three-Tier Design

- **Tier 1 (hot)**: SQLite — synchronous, always available, used by all REST endpoints.
- **Tier 2 (warm)**: Firestore `vendor_profiles/` — async mirror, used by ADK agents for low-latency reads without hitting the Node backend.
- **Tier 3 (cold)**: Cloud Storage `{project}-memory-archive` — delivery history archive for BQ/Looker. Written async from `recordDelivery()`. Not readable by the runtime API.
- **Secret Manager** enriches the SLA clause on async read path only (`getVendorAsync()`). The sync `getVendor()` always returns the DB-stored clause.

## FunctionTool JSON Schema — ADK Critical

- ADK generates JSON Schema from Python type hints + docstring `Args:` sections. The LLM uses this schema to decide when/how to call tools.
- Removing type hints or making docstrings vague reduces tool-use quality without any error at startup.
- Optional parameters must have a default value AND be typed as `str` (not `Optional[str]`) because ADK parses them as required if no default is visible.

## Model Factory — Architectural Detail

- **`make_model()` returns a `_RoutedGemini` inner class** (defined inside `make_model()`) that overrides `api_client` as a property returning the pre-built `google.genai.Client`. This is the mechanism that keeps one authenticated client per process and prevents ADK from building its own.
- **`config.py` auto-detects the backend**: if `GOOGLE_API_KEY` or `GEMINI_API_KEY` is set → `gemini_api`; else → `vertex_ai`. `GEMINI_BACKEND` env var overrides auto-detection.
- **`tool_server_client.py` auto-bootstraps its JWT** — on first tool call it calls `GET /api/auth/bootstrap` and caches the `user-admin` token. This is a dev convenience; production should set `TOOL_SERVER_TOKEN` explicitly.

## Docker vs Local Python Versions

- **Docker ADK service** uses `python:3.11-slim` (as specified in `docker-compose.yml`).
- **Two `.venv`s** at `app/adk/`: `.venv` (Python 3.14, used by `start-dev.sh`) and `.venv311` (Python 3.11). All packages must be 3.11-compatible; test with `.venv311` before adding a new dependency.
