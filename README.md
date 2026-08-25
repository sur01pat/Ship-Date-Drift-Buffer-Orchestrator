# Ship-Date Drift & Inventory Buffer Orchestrator

An autonomous, event-driven enterprise coordinator built on the specification of the **Gemini Enterprise Agent Platform**. It continuously monitors supplier communications, identifies shipment delays, calculates downstream ERP impacts, and executes multi-system remediation workflows.

---

## Architecture

```
[ Supplier Email / Carrier Webhook ]
           │
           ▼
  [ Model Armor Firewall ]        ← Prompt injection, PII masking, tool-poisoning defence
           │
           ▼
  [ Orchestrator Core ]           ← Event-driven 4-step workflow engine
     │     │     │
     │     │     └──────────────► [ Memory Bank ]       — Vendor profiles, SLA, history
     │     └────────────────────► [ ERP/SAP Simulator ] — BOM, POs, Sales Orders, Inventory
     │
     ├──── A2A Gateway ──────────► [ Warehouse Sub-Agent ] — Transfer Orders
     └──── A2A Gateway ──────────► [ Freight Sub-Agent ]   — Air/Ocean/Ground requests
           │
           ▼
  [ Agent Observability ]         ← Full reasoning chains, append-only audit ledger
           │
           ▼
  [ Human Sign-Off (1-click) ]   ← Approval card via REST API + WebSocket push
```

## Subsystems

| Layer | Module | Description |
|-------|--------|-------------|
| Security | Model Armor | Prompt injection, jailbreak, PII masking, tool-poisoning |
| Discovery | Agent Registry | Machine-readable capability manifests, versioning |
| State | Memory Bank | Vendor profiles, SLA terms, delivery history, buffer rules |
| ERP | SAP Simulator | Purchase Orders, BOM, Sales Orders, Inventory Buffers |
| Access | Agent Identity | Short-lived OIDC JWT tokens, least-privilege scopes |
| Routing | Agent Gateway | A2A task dispatch, policy enforcement, financial limits |
| Sub-agents | Warehouse + Freight | WTO creation, freight mode recommendation + booking |
| Observability | Audit Ledger | Append-only OpenTelemetry-style reasoning traces |
| Frontend | React Dashboard | Live event feed, approvals, ERP views, audit explorer |

## Quick Start (Development)

```bash
chmod +x start-dev.sh
./start-dev.sh
```

- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:4000/api
- **WebSocket:** ws://localhost:4000/ws
- **Health:** http://localhost:4000/health

## Quick Start (Docker)

```bash
cd app
docker compose up --build
```

## Simulate an Inbound Event

From the dashboard, click **"⚡ Simulate Inbound Event"** to trigger a full orchestration workflow:

1. Supplier email arrives (Model Armor screens it)
2. Memory Bank retrieves vendor SLA & history
3. ERP calculates BOM and Sales Order impact
4. Warehouse & Freight sub-agents are dispatched
5. Credit claim is drafted
6. Human 1-click approval card appears in the Events tab

## Reproducible Testing

All tests run **fully offline** — no GCP credentials, no running server, no network access required.

### Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | ≥ 18 | `node --version` |
| npm | ≥ 9 | `npm --version` |
| Python | ≥ 3.11 | `python3 --version` |

---

### 1 — Backend (Node.js / Jest)

```bash
cd app/backend
npm ci                          # install exact locked deps
npm test                        # jest --runInBand --forceExit
```

**Expected output:**

```
PASS tests/armor.test.js
PASS tests/gateway.test.js
PASS tests/erp.test.js
PASS tests/api.test.js

Test Suites: 4 passed, 4 total
Tests:       XX passed, XX total
```

Run a single suite:

```bash
npx jest tests/armor.test.js    # Model Armor only
npx jest tests/gateway.test.js  # Agent Gateway policy engine only
```

**What is tested:**

| Suite | File | Covers |
|---|---|---|
| Model Armor | `armor.test.js` | Prompt injection detection, jailbreak flags, PII masking (email / phone / SSN), clean payload pass-through |
| Agent Gateway | `gateway.test.js` | A2A task schema validation, freight cost limit, WTO quantity limit, delay-day escalation threshold |
| ERP Simulator | `erp.test.js` | PO lookup, BOM impact calculation, Sales Order revision, inventory buffer query |
| REST API | `api.test.js` | Full HTTP integration across all routes using `supertest` (no live server needed) |

> **GCP services are disabled during tests** via environment flags set automatically by Jest:
> `GCP_IDENTITY_ENABLED=false`, `FIRESTORE_*_ENABLED=false`, `PUBSUB_EVENTS_ENABLED=false`,
> `CLOUD_TASKS_ENABLED=false`, `MODEL_ARMOR_ENABLED=false`, `DLP_ENABLED=false`.

---

### 2 — ADK Layer (Python / pytest)

```bash
cd app/adk

# Create and activate a virtual environment (first time only)
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run all ADK tests
pytest tests/ -v --tb=short
```

**Expected output:**

```
tests/test_tools.py::test_list_purchase_orders          PASSED
tests/test_tools.py::test_calculate_bom_impact          PASSED
tests/test_tools.py::test_get_vendor_profile            PASSED
tests/test_tools.py::test_create_warehouse_transfer_order PASSED
tests/test_tools.py::test_create_freight_request        PASSED
tests/test_tools.py::test_scan_with_model_armor_safe    PASSED
tests/test_tools.py::test_scan_with_model_armor_blocked PASSED
...
XX passed in X.XXs
```

Run a single test:

```bash
pytest tests/test_tools.py::test_calculate_bom_impact -v
pytest tests/test_callbacks.py -v    # Model Armor ADK callbacks only
pytest tests/test_agents.py -v       # Agent composition tests only
```

**What is tested:**

| Module | File | Covers |
|---|---|---|
| ERP tools | `test_tools.py` | `list_purchase_orders`, `calculate_bom_impact`, `get_inventory_buffers`, `get_bill_of_materials` |
| Memory tools | `test_tools.py` | `get_vendor_profile` (including 404 path), `list_vendors`, `get_vendor_delivery_history`, `get_inventory_buffer_rules` |
| Warehouse tools | `test_tools.py` | `create_warehouse_transfer_order`, `list_warehouse_transfer_orders` |
| Freight tools | `test_tools.py` | `create_freight_request` (air + ground modes), `list_freight_requests` |
| Armor tool | `test_tools.py` | `scan_with_model_armor` — safe payload and blocked (PROMPT_INJECTION) payload |
| ADK callbacks | `test_callbacks.py` | `before_model_callback` blocking, PII masking in request; `after_model_callback` DLP on output |
| Agent structure | `test_agents.py` | Agent names, tool lists, callback attachment, `output_key` presence |
| Model factory | `test_model_factory.py` | Backend detection (`gemini_api` / `vertex_ai`), `@lru_cache` singleton behaviour |
| Tool server client | `test_tool_server_client.py` | HTTP wrapper correctness, `ToolServerError` on non-2xx responses |

> **All HTTP calls to the Node.js tool server are mocked** by the `mock_tool_server` fixture in
> `tests/conftest.py` — `monkeypatch` replaces every `tool_server_client` function with
> deterministic in-memory responses. No running backend is needed.

---

### 3 — All Tests at Once

```bash
# From the repo root
cd app/backend && npm ci && npm test && cd ../adk && pip install -r requirements.txt && pytest tests/ -v --tb=short
```

Or use the provided dev script which installs deps, runs all tests, then starts both servers:

```bash
chmod +x start-dev.sh
./start-dev.sh
```

---

### Environment Variables for Tests

No `.env` file is required for tests. The following flags are the key test-mode overrides (all default to values that disable live GCP calls):

| Variable | Test value | Effect |
|---|---|---|
| `GCP_IDENTITY_ENABLED` | `false` | Uses local JWT instead of GCP OIDC |
| `FIRESTORE_REGISTRY_ENABLED` | `false` | Skips Firestore agent registry mirror |
| `FIRESTORE_MEMORY_ENABLED` | `false` | Skips Firestore vendor/memory mirror |
| `FIRESTORE_SESSIONS_ENABLED` | `false` | Skips Firestore session persistence |
| `PUBSUB_EVENTS_ENABLED` | `false` | Skips Cloud Pub/Sub publishing |
| `CLOUD_TASKS_ENABLED` | `false` | Skips Cloud Tasks scheduling |
| `RUNTIME_TASKS_ENABLED` | `false` | Skips background execution queue |
| `MODEL_ARMOR_ENABLED` | `false` | Uses local regex fallback only |
| `DLP_ENABLED` | `false` | Skips Cloud DLP (off by default) |
| `OTEL_ENABLED` | `false` | Skips OpenTelemetry export |

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/bootstrap` | GET | Get all bootstrap tokens |
| `/api/orchestrator/ingest` | POST | Ingest a supplier event |
| `/api/demo/simulate` | POST | Trigger a demo event |
| `/api/orchestrator/events` | GET | List orchestration events |
| `/api/orchestrator/events/:id/approve` | POST | Approve a remediation plan |
| `/api/orchestrator/events/:id/reject` | POST | Reject a remediation plan |
| `/api/erp/purchase-orders` | GET | List purchase orders |
| `/api/erp/sales-orders` | GET | List sales orders |
| `/api/erp/inventory` | GET | List inventory buffers |
| `/api/memory/vendors` | GET | List vendor profiles |
| `/api/warehouse/transfers` | GET | List transfer orders |
| `/api/freight/requests` | GET | List freight requests |
| `/api/audit/logs` | GET | Query audit logs |
| `/api/audit/stats` | GET | Audit statistics |
| `/api/registry/agents` | GET | List registered agents |
| `/api/armor/scan` | POST | Scan a payload with Model Armor |
| `/health` | GET | Health check |
