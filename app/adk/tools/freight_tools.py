"""
ADK Tools – Freight Sub-Agent Tools
=====================================
Tools for evaluating and requesting expedited freight options.
"""

from google.adk.tools import FunctionTool
import tool_server_client as client


def _create_freight_request(
    po_id: str,
    item_code: str,
    quantity: int,
    delay_days: int,
    origin: str,
    destination: str,
    session_id: str,
) -> dict:
    """
    Create an expedited freight request for a delayed Purchase Order.
    The freight mode (air / ocean / ground) is selected automatically
    based on delay severity: >=7 days → air, >=3 days → ocean, else ground.

    Args:
        po_id: The internal PO identifier.
        item_code: The delayed item code (e.g. 'ITEM-PCB-200').
        quantity: Number of units to ship.
        delay_days: Number of days the shipment is delayed.
        origin: Shipping origin location description.
        destination: Shipping destination location description.
        session_id: The current orchestration session identifier for traceability.

    Returns:
        Freight request record with fr_number, mode, estimated_cost, and status.
    """
    return client.freight_create_request(
        po_id, item_code, quantity, delay_days, origin, destination, session_id
    )


def _list_freight_requests(status: str = "") -> list:
    """
    List all freight requests.

    Args:
        status: Optional filter: 'pending', 'approved', 'booked'. Leave empty for all.

    Returns:
        List of freight request records.
    """
    return client.freight_list_requests(status or None)


# Wrap as ADK FunctionTools
create_freight_request = FunctionTool(_create_freight_request)
list_freight_requests  = FunctionTool(_list_freight_requests)
