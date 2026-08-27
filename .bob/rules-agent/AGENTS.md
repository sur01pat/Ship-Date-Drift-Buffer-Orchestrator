# Project Coding Rules (Non-Obvious Only)

## JavaScript (Backend – `app/backend/src/`)

- **OTel must be `require`d first** in `src/index.js` — never move `require('./observability/tracing')` below any other import or auto-instrumentation breaks silently.
- **All GCP SDK packages are lazy-`require`d inside functions** (e.g. `const { Firestore } = require('@google-cloud/firestore')` inside the function body) — never at module top-level. This keeps test startup fast and makes GCP packages optional.
- **`scan()` vs `scanAsync()`** in `modelArmor.js`: orchestrator hot path is synchronous (`scan()`); only the `/api/armor/scan` route uses `scanAsync()` (GCP Model Armor → Cloud DLP → local). Swapping them breaks either the event loop or GCP results.
- **All DB JSON columns** (`payload`, `reasoning_chain`, `processing_steps`, etc.) are plain TEXT in SQLite. Always `JSON.stringify()` on write, `JSON.parse()` on read. No ORM.
- **`better-sqlite3` is synchronous** — never `await` a DB call. Wrap async work around it.
- **`logger`** (`src/logger.js`) is the only allowed logging mechanism. `console.log` is never used in `src/`.
- **Gateway sub-agent handlers** are injected at startup in `src/index.js` via `gateway.registerAgentHandler(...)`. New sub-agents must be registered there.
- **`orchestrator.setBroadcast(broadcast)`** must be called after creating the WebSocket server but before any route handlers.
- **All GCP async calls** use `.catch(() => {})` or `.catch(err => logger.warn(...))` — they must never throw into the orchestration hot path.
- **Cloud Monitoring metrics** (`src/observability/auditLog.js` `metrics.*` helpers) are called from `orchestrator.js` with `.catch(() => {})`. Never await them on the critical path.
- **Cloud Pub/Sub and Cloud Tasks** calls in `orchestrator.js` are similarly fire-and-forget with `.catch(() => {})`.

## Python (ADK – `app/adk/`)

- **All ADK tool functions** follow the pattern: private `_function()` implementation → `name = FunctionTool(_function)`. Call `.func(...)` in tests.
- **Type hints are required on tool parameters** — ADK generates JSON Schema from them. Missing types fail at agent instantiation.
- **Every `LlmAgent` must attach both callbacks**: `before_model_callback=model_armor_before_model_callback` and `after_model_callback=model_armor_after_model_callback`.
- **`output_key` on `LlmAgent`** stores the final text response into session state for downstream agents.
- **`make_model()` is `@lru_cache(maxsize=1)` returning a `_RoutedGemini` subclass** — it injects the pre-built `google.genai.Client` via an `api_client` property override so ADK never re-authenticates. Always call `make_model.cache_clear()` in tests that reload `config` or `model_factory`.
- **ADK tests run fully offline** — `conftest.py` `mock_tool_server` fixture patches all `tool_server_client` functions. Any test importing tools *without* this fixture triggers a live `GET /api/auth/bootstrap` call.
- **`asyncio_mode = "auto"`** in `pyproject.toml` — all async test functions auto-run without `@pytest.mark.asyncio`.
- **`GEMINI_API_KEY` is an accepted alias** for `GOOGLE_API_KEY` in both `config.py` and auto-detection logic.
- **`_build_gemini_api_client()` raises `EnvironmentError`** (not `ValueError`) — match this in `pytest.raises(EnvironmentError, ...)`.
- **`callbacks/observability_callbacks.py`** exists alongside `model_armor_callbacks.py` — use it for agents needing audit-trail callbacks.
- **Two `.venv`s** in `app/adk/`: `.venv` (Python 3.14, used by `start-dev.sh`) and `.venv311` (Python 3.11, Docker). All new dependencies must be 3.11-compatible.

## Adding a New Tool (End-to-End Checklist)

1. Add Node.js endpoint in the relevant `app/backend/src/` module
2. Register route in `app/backend/src/api/routes.js`
3. Add `tool_server_client.py` wrapper function
4. Add private `_function()` + `FunctionTool` in `app/adk/tools/<domain>_tools.py`
5. Add tool to the relevant agent's `tools=[...]` list in `app/adk/agents/`
6. Add mock in `conftest.py` `mock_tool_server` fixture
7. Add test in `app/adk/tests/test_tools.py`

## Non-obvious Backend Test Gotchas

- **`process.env.PORT = '0'` before `require('../src/index')`** in every test file that loads the server — without it the server binds to 4000 and collides when suites run together (`--runInBand`).
- **`generateWTONumber()` / `generateFRNumber()` use `Date.now().slice(-6)`** — back-to-back calls within the same millisecond throw `UNIQUE constraint failed`. Fix: `await new Promise(r => setTimeout(r, 2))` between creates.
- **`agentRegistry.register()` is `INSERT` not upsert** — duplicate `id` throws. Always use a unique ID per test run (e.g. `'agent-' + Date.now()`).
- **`SESSION_TIMEOUT_MS` is a module-load-time `const`** — to test timeout behaviour, use `jest.resetModules()`, set the env var, then re-`require` the module.
- **`EVENT_BLOCKED` Pub/Sub never fires from `/api/orchestrator/ingest`** — `armorMiddleware` returns HTTP 400 before `processEvent()` runs. Call `processEvent()` directly to trigger the event.
- **Pub/Sub assertions need a 100ms yield** — messages are published fire-and-forget; `await new Promise(r => setTimeout(r, 100))` is needed before checking captured messages.

## GCP Service Integration Pattern

All GCP services follow the same pattern to stay fail-open:

```js
async function _gcpOperation(data) {
  try {
    const { GcpClient } = require('@google-cloud/service');  // lazy require
    const client = new GcpClient({ projectId: GCP_PROJECT });
    // ... do work ...
  } catch (err) {
    logger.warn('GCP service: operation failed', { error: err.message });
    // return null or fall back to local — never throw
  }
}
// Called as: _gcpOperation(data).catch(() => {});  // fire-and-forget
```

Never use `await` on GCP calls in the hot path. Always `.catch(() => {})`.
