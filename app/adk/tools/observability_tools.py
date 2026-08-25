"""
ADK Tools – Observability & Audit Tools
=========================================
Tools that expose the audit ledger to ADK agents for self-inspection.
"""

from google.adk.tools import FunctionTool
import tool_server_client as client


def _get_audit_statistics() -> dict:
    """
    Retrieve aggregate statistics from the Agent Observability audit ledger:
    total event count, breakdown by event type, and breakdown by severity.

    Returns:
        Dict with 'total', 'byType' (list), and 'bySeverity' (list) keys.
    """
    return client.audit_get_stats()


def _get_audit_logs(limit: int = 50, session_id: str = "") -> list:
    """
    Query the append-only audit log for reasoning traces and agent actions.

    Args:
        limit: Maximum number of log entries to return (default 50).
        session_id: Optional session ID to filter to a single orchestration run.

    Returns:
        List of audit log entries with event_type, agent_id, session_id,
        reasoning_chain, outcome, severity, and created_at.
    """
    return client.audit_get_logs(limit, session_id or None)


get_audit_statistics = FunctionTool(_get_audit_statistics)
get_audit_logs       = FunctionTool(_get_audit_logs)
