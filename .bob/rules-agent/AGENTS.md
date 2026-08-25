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
- **`make_model()` is `@lru_cache(maxsize=1)`** — one `Gemini` instance per process.
- **ADK tests run fully offline** — `conftest.py` `mock_tool_server` fixture patches all `tool_server_client` functions.
- **`asyncio_mode = "auto"`** in `pyproject.toml` — all async test functions auto-run without `@pytest.mark.asyncio`.

## Adding a New Tool (End-to-End Checklist)

1. Add Node.js endpoint in the relevant `app/backend/src/` module
2. Register route in `app/backend/src/api/routes.js`
3. Add `tool_server_client.py` wrapper function
4. Add private `_function()` + `FunctionTool` in `app/adk/tools/<domain>_tools.py`
5. Add tool to the relevant agent's `tools=[...]` list in `app/adk/agents/`
6. Add mock in `conftest.py` `mock_tool_server` fixture
7. Add test in `app/adk/tests/test_tools.py`

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
