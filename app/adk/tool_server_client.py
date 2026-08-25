"""
ADK Tool Server Client
======================
Thin HTTP client that wraps every Node.js REST endpoint so ADK Tool
functions can call them without knowing the transport details.
"""

import os
import requests
from typing import Any, Optional
from config import TOOL_SERVER_URL, TOOL_SERVER_TOKEN


class ToolServerError(Exception):
    """Raised when the tool server returns a non-2xx response."""
    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        super().__init__(f"Tool server error {status}: {body}")


# Module-level mutable token — populated once at first use via _ensure_token().
_runtime_token: str = TOOL_SERVER_TOKEN or os.getenv("TOOL_SERVER_TOKEN", "")


def _ensure_token() -> None:
    """Lazily bootstrap the admin JWT from the tool server if not yet set."""
    global _runtime_token
    if not _runtime_token:
        try:
            r = requests.get(f"{TOOL_SERVER_URL}/api/auth/bootstrap", timeout=10)
            r.raise_for_status()
            _runtime_token = r.json().get("user-admin", "")
        except Exception:
            pass  # fall through — requests without auth may fail, handled upstream


def _headers() -> dict:
    _ensure_token()
    return {
        "Content-Type": "application/json",
        **({"Authorization": f"Bearer {_runtime_token}"} if _runtime_token else {}),
    }


def _get(path: str, params: Optional[dict] = None) -> Any:
    r = requests.get(f"{TOOL_SERVER_URL}{path}", headers=_headers(), params=params, timeout=15)
    if not r.ok:
        raise ToolServerError(r.status_code, r.json() if r.content else r.text)
    return r.json()


def _post(path: str, body: dict) -> Any:
    r = requests.post(f"{TOOL_SERVER_URL}{path}", json=body, headers=_headers(), timeout=15)
    if not r.ok:
        raise ToolServerError(r.status_code, r.json() if r.content else r.text)
    return r.json()


# ── Bootstrapper (kept for back-compat / explicit call) ──────────────────────

def bootstrap_token() -> str:
    """Fetch the admin token from the Node server bootstrap endpoint.

    Called lazily by _ensure_token() before every request.  May also be
    called explicitly at startup to pre-warm the token.
    """
    _ensure_token()
    return _runtime_token


# ── ERP / SAP ─────────────────────────────────────────────────────────────────

def erp_list_pos(status: Optional[str] = None) -> list:
    return _get("/api/erp/purchase-orders", params={"status": status} if status else None)

def erp_get_po_by_number(po_number: str) -> dict:
    return _get(f"/api/erp/purchase-orders", params={"po_number": po_number})

def erp_list_sos(status: Optional[str] = None) -> list:
    return _get("/api/erp/sales-orders", params={"status": status} if status else None)

def erp_calculate_impact(item_code: str, delay_days: int) -> list:
    return _get(f"/api/erp/impact/{item_code}", params={"delay_days": delay_days})

def erp_get_inventory(item_code: Optional[str] = None) -> list:
    return _get("/api/erp/inventory")

def erp_get_bom(product_code: str) -> list:
    return _get(f"/api/erp/bom/{product_code}")


# ── Memory Bank ───────────────────────────────────────────────────────────────

def memory_get_vendor(vendor_id: str) -> dict:
    return _get(f"/api/memory/vendors/{vendor_id}")

def memory_list_vendors() -> list:
    return _get("/api/memory/vendors")

def memory_get_vendor_history(vendor_id: str, limit: int = 10) -> list:
    return _get(f"/api/memory/vendors/{vendor_id}/history", params={"limit": limit})

def memory_list_buffers() -> list:
    return _get("/api/memory/buffers")

def memory_list_memories(agent_id: Optional[str] = None, memory_type: Optional[str] = None, limit: int = 50) -> list:
    params: dict = {"limit": limit}
    if agent_id:
        params["agent_id"] = agent_id
    if memory_type:
        params["memory_type"] = memory_type
    return _get("/api/memory/memories", params=params)

def memory_search_memories(q: str, limit: int = 20) -> list:
    return _get("/api/memory/memories/search", params={"q": q, "limit": limit})

def memory_store_memory(agent_id: str, memory_type: str, content: str,
                        session_id: Optional[str] = None,
                        metadata: Optional[dict] = None,
                        importance: float = 0.5) -> dict:
    body: dict = {
        "agent_id": agent_id,
        "memory_type": memory_type,
        "content": content,
        "importance": importance,
    }
    if session_id:
        body["session_id"] = session_id
    if metadata:
        body["metadata"] = metadata
    return _post("/api/memory/memories", body)

def memory_delete_memory(memory_id: str) -> dict:
    r = requests.delete(
        f"{TOOL_SERVER_URL}/api/memory/memories/{memory_id}",
        headers=_headers(),
        timeout=15,
    )
    if not r.ok:
        raise ToolServerError(r.status_code, r.json() if r.content else r.text)
    return r.json()


# ── Warehouse ─────────────────────────────────────────────────────────────────

def warehouse_create_transfer_order(
    item_code: str, from_location: str, to_location: str, quantity: int, session_id: str
) -> dict:
    return _post("/api/warehouse/transfer", {
        "item_code": item_code,
        "from_location": from_location,
        "to_location": to_location,
        "quantity": quantity,
        "session_id": session_id,
    })

def warehouse_list_transfers(status: Optional[str] = None) -> list:
    return _get("/api/warehouse/transfers", params={"status": status} if status else None)


# ── Freight ───────────────────────────────────────────────────────────────────

def freight_create_request(
    po_id: str, item_code: str, quantity: int, delay_days: int,
    origin: str, destination: str, session_id: str
) -> dict:
    return _post("/api/freight/request", {
        "po_id": po_id,
        "item_code": item_code,
        "quantity": quantity,
        "delay_days": delay_days,
        "origin": origin,
        "destination": destination,
        "session_id": session_id,
    })

def freight_list_requests(status: Optional[str] = None) -> list:
    return _get("/api/freight/requests", params={"status": status} if status else None)


# ── Orchestrator events ───────────────────────────────────────────────────────

def orchestrator_list_events(status: Optional[str] = None, limit: int = 50) -> list:
    params: dict = {"limit": limit}
    if status:
        params["status"] = status
    return _get("/api/orchestrator/events", params=params)

def orchestrator_approve_event(event_id: str) -> dict:
    return _post(f"/api/orchestrator/events/{event_id}/approve", {})

def orchestrator_reject_event(event_id: str, reason: str) -> dict:
    return _post(f"/api/orchestrator/events/{event_id}/reject", {"reason": reason})


# ── Audit / Observability ─────────────────────────────────────────────────────

def audit_get_stats() -> dict:
    return _get("/api/audit/stats")

def audit_get_logs(limit: int = 50, session_id: Optional[str] = None) -> list:
    params: dict = {"limit": limit}
    if session_id:
        params["session_id"] = session_id
    return _get("/api/audit/logs", params=params)


# ── Model Armor ───────────────────────────────────────────────────────────────

def armor_scan(payload: dict) -> dict:
    return _post("/api/armor/scan", payload)
