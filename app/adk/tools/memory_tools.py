"""
ADK Tools – Memory Bank Tools
==============================
Tools for the MemoryBankAgent: vendor SLA retrieval, delivery history,
inventory buffer rules, and long-term cross-session agent memories.
"""

from typing import Optional
from google.adk.tools import FunctionTool
import tool_server_client as client


# ── Vendor / buffer context ───────────────────────────────────────────────────

def _get_vendor_profile(vendor_id: str) -> dict:
    """
    Retrieve a vendor's full profile from the Memory Bank, including
    SLA clause, penalty rate, reliability score, and discount tiers.

    Args:
        vendor_id: The vendor identifier (e.g. 'vendor-001').

    Returns:
        Vendor profile dict with name, region, reliability_score,
        avg_delay_days, sla_clause, penalty_rate, and discount_tiers.
        Returns empty dict if not found.
    """
    try:
        return client.memory_get_vendor(vendor_id)
    except Exception:
        return {}


def _list_vendors() -> list:
    """
    List all vendor profiles stored in the Memory Bank.

    Returns:
        List of vendor profile objects.
    """
    return client.memory_list_vendors()


def _get_vendor_delivery_history(vendor_id: str, limit: int = 10) -> list:
    """
    Retrieve historical delivery records for a vendor to assess reliability.

    Args:
        vendor_id: The vendor identifier.
        limit: Maximum number of records to return (default 10).

    Returns:
        List of delivery history records with po_number, promised_date,
        actual_date, delay_days, and status ('on_time' or 'delivered_late').
    """
    return client.memory_get_vendor_history(vendor_id, limit)


def _get_inventory_buffer_rules() -> list:
    """
    Retrieve all regional inventory buffer rules (safety stock levels,
    reorder points) from the Memory Bank.

    Returns:
        List of buffer rule objects with item_code, region, safety_stock,
        reorder_point, on_hand, and on_order.
    """
    return client.memory_list_buffers()


# ── Long-term cross-session memories ─────────────────────────────────────────

def _store_memory(
    agent_id: str,
    memory_type: str,
    content: str,
    session_id: Optional[str] = None,
    vendor_id: Optional[str] = None,
    importance: float = 0.5,
) -> dict:
    """
    Persist a learned fact as a long-term agent memory for future sessions.

    Use this whenever the agent discovers a stable insight about a vendor,
    a risk pattern, an escalation behaviour, or an operational preference
    that should influence future decisions — even in different sessions.

    Args:
        agent_id:     ID of the agent storing the memory (e.g. 'agent-orchestrator-v1').
        memory_type:  Category: 'vendor_preference' | 'risk_threshold' |
                      'escalation_pattern' | 'observation'.
        content:      The learned fact in plain English.
        session_id:   (Optional) session in which this was observed.
        vendor_id:    (Optional) vendor this memory relates to.
        importance:   Float 0.0–1.0 indicating how strongly this should
                      influence future decisions (default 0.5).

    Returns:
        Created memory record with id, agent_id, memory_type, content, importance.
    """
    metadata = {}
    if vendor_id:
        metadata["vendor_id"] = vendor_id
    try:
        return client.memory_store_memory(
            agent_id=agent_id,
            memory_type=memory_type,
            content=content,
            session_id=session_id,
            metadata=metadata if metadata else None,
            importance=importance,
        )
    except Exception as exc:
        return {"error": str(exc)}


def _retrieve_memories(
    agent_id: Optional[str] = None,
    memory_type: Optional[str] = None,
    limit: int = 20,
) -> list:
    """
    Retrieve stored long-term memories, optionally filtered by agent or type.

    Call this at the start of a session to recall relevant past learnings
    before making decisions about a vendor or risk threshold.

    Args:
        agent_id:     (Optional) filter to memories from a specific agent.
        memory_type:  (Optional) filter by category:
                      'vendor_preference' | 'risk_threshold' |
                      'escalation_pattern' | 'observation'.
        limit:        Maximum records to return (default 20).

    Returns:
        List of memory records ordered by importance then recency.
    """
    try:
        return client.memory_list_memories(
            agent_id=agent_id, memory_type=memory_type, limit=limit
        )
    except Exception:
        return []


def _search_memories(query: str, limit: int = 10) -> list:
    """
    Full-text search over all stored agent memories.

    Use this to find memories relevant to a specific vendor, scenario, or
    concept before reasoning about a new inbound event.

    Args:
        query: Search terms (searches content and metadata fields).
        limit: Maximum results to return (default 10).

    Returns:
        List of matching memory records ordered by importance then recency.
    """
    try:
        return client.memory_search_memories(q=query, limit=limit)
    except Exception:
        return []


# ── Wrap as ADK FunctionTools ─────────────────────────────────────────────────

get_vendor_profile          = FunctionTool(_get_vendor_profile)
list_vendors                = FunctionTool(_list_vendors)
get_vendor_delivery_history = FunctionTool(_get_vendor_delivery_history)
get_inventory_buffer_rules  = FunctionTool(_get_inventory_buffer_rules)
store_memory                = FunctionTool(_store_memory)
retrieve_memories           = FunctionTool(_retrieve_memories)
search_memories             = FunctionTool(_search_memories)
