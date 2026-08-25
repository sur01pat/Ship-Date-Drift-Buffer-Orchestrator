"""
ADK Tests – Tool Server Client
================================
Tests that the tool_server_client module correctly builds requests
and handles success / error responses.
All HTTP calls are intercepted with pytest monkeypatching.
"""

import pytest
import tool_server_client as client


class MockResponse:
    def __init__(self, data, status_code=200):
        self._data = data
        self.status_code = status_code
        self.ok = status_code < 400
        self.content = True

    def json(self):
        return self._data


# ── _get ─────────────────────────────────────────────────────────────────────

def test_get_success(monkeypatch):
    monkeypatch.setattr("requests.get", lambda url, **kw: MockResponse({"result": "ok"}))
    result = client._get("/api/test")
    assert result == {"result": "ok"}


def test_get_raises_on_error(monkeypatch):
    monkeypatch.setattr("requests.get", lambda url, **kw: MockResponse({"error": "not found"}, 404))
    with pytest.raises(client.ToolServerError) as exc_info:
        client._get("/api/test")
    assert exc_info.value.status == 404


# ── _post ─────────────────────────────────────────────────────────────────────

def test_post_success(monkeypatch):
    monkeypatch.setattr("requests.post", lambda url, **kw: MockResponse({"created": True}))
    result = client._post("/api/test", {"key": "value"})
    assert result == {"created": True}


def test_post_raises_on_error(monkeypatch):
    monkeypatch.setattr("requests.post", lambda url, **kw: MockResponse({}, 500))
    with pytest.raises(client.ToolServerError) as exc_info:
        client._post("/api/test", {})
    assert exc_info.value.status == 500


# ── Domain wrappers ───────────────────────────────────────────────────────────

def test_erp_list_pos(mock_tool_server):
    result = client.erp_list_pos()
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0]["po_number"] == "PO-2025-001"


def test_erp_list_pos_with_status(mock_tool_server):
    result = client.erp_list_pos("delayed")
    assert isinstance(result, list)


def test_memory_get_vendor(mock_tool_server):
    result = client.memory_get_vendor("vendor-001")
    assert result["name"] == "Apex Components Ltd."
    assert result["penalty_rate"] == 0.02


def test_erp_calculate_impact(mock_tool_server):
    result = client.erp_calculate_impact("ITEM-MCU-100", 6)
    assert len(result) == 1
    assert result[0]["revenue_at_risk"] == 150000


def test_warehouse_create_transfer_order(mock_tool_server):
    result = client.warehouse_create_transfer_order(
        "ITEM-MCU-100", "Central Warehouse – Chicago", "Regional DC – Dallas", 1000, "sess-001"
    )
    assert result["wto_number"] == "WTO-2025-001"
    assert result["status"] == "draft"


def test_freight_create_request(mock_tool_server):
    result = client.freight_create_request(
        "po-001", "ITEM-MCU-100", 5000, 6, "APAC Hub", "NA Central", "sess-001"
    )
    assert result["mode"] == "air"
    assert result["fr_number"] == "FR-2025-001"


def test_armor_scan_safe(mock_tool_server):
    result = client.armor_scan({"text": "PO-2025-001 delayed 6 days"})
    assert result["safe"] is True
    assert result["threats"] == []


def test_bootstrap_token_handles_failure(monkeypatch):
    # Reset the module-level token so _ensure_token() actually tries the network call
    monkeypatch.setattr(client, "_runtime_token", "")
    monkeypatch.setattr("requests.get", lambda url, **kw: (_ for _ in ()).throw(ConnectionError("refused")))
    token = client.bootstrap_token()
    assert token == ""
