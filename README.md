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

## Running Tests

```bash
cd app/backend && npm test
```

Tests cover: Model Armor, Agent Gateway policy engine, ERP simulator, and full REST API integration.

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
