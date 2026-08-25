"""
ADK Tools – Warehouse Sub-Agent Tools
=======================================
Tools for creating and querying Warehouse Transfer Orders (WTO).
"""

from google.adk.tools import FunctionTool
import tool_server_client as client


def _create_warehouse_transfer_order(
    item_code: str,
    from_location: str,
    to_location: str,
    quantity: int,
    session_id: str,
) -> dict:
    """
    Create a draft Warehouse Transfer Order (WTO) to rebalance inventory
    between two distribution centres. The WTO is staged as 'draft' and
    requires human approval before execution.

    Args:
        item_code: The item to transfer (e.g. 'ITEM-MCU-100').
        from_location: The source warehouse/DC (e.g. 'Central Warehouse – Chicago').
        to_location: The destination warehouse/DC (e.g. 'Regional DC – Dallas').
        quantity: Number of units to transfer.
        session_id: The current orchestration session identifier for traceability.

    Returns:
        WTO record with wto_number, status ('draft'), and all input fields.
    """
    return client.warehouse_create_transfer_order(
        item_code, from_location, to_location, quantity, session_id
    )


def _list_warehouse_transfer_orders(status: str = "") -> list:
    """
    List Warehouse Transfer Orders from the WMS system.

    Args:
        status: Optional filter: 'draft', 'approved', 'in_transit'. Leave empty for all.

    Returns:
        List of WTO records.
    """
    return client.warehouse_list_transfers(status or None)


# Wrap as ADK FunctionTools
create_warehouse_transfer_order = FunctionTool(_create_warehouse_transfer_order)
list_warehouse_transfer_orders  = FunctionTool(_list_warehouse_transfer_orders)
