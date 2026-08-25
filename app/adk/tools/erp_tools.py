"""
ADK Tools – ERP / SAP Simulator Tools
=======================================
Each function is wrapped as an ADK FunctionTool, which auto-generates
JSON Schema from type hints and docstrings, making these tools available
inside any ADK LlmAgent.
"""

from google.adk.tools import FunctionTool
import tool_server_client as client


def _list_purchase_orders(status: str = "") -> list:
    """
    List all Purchase Orders from the ERP system.

    Args:
        status: Optional filter. One of: 'open', 'delayed', 'closed'. Leave empty for all.

    Returns:
        List of purchase order objects including po_number, item_code, quantity,
        promised_ship_date, delay_days, and status.
    """
    return client.erp_list_pos(status or None)


def _list_sales_orders(status: str = "") -> list:
    """
    List all Sales Orders from the ERP system.

    Args:
        status: Optional filter. One of: 'open', 'at_risk', 'completed'. Leave empty for all.

    Returns:
        List of sales order objects including so_number, customer_name, item_code,
        quantity, promised_delivery_date, updated_delivery_date, revenue, and status.
    """
    return client.erp_list_sos(status or None)


def _calculate_bom_impact(item_code: str, delay_days: int) -> list:
    """
    Calculate which Sales Orders are impacted if a component item is delayed.
    Performs a reverse BOM lookup to identify all finished goods that use this
    component, then finds all open Sales Orders for those finished goods.

    Args:
        item_code: The delayed component item code (e.g. 'ITEM-PCB-200').
        delay_days: Number of days the component is delayed.

    Returns:
        List of impacted sales orders with revised_delivery_date, delay_days,
        revenue_at_risk, and product_code fields added.
    """
    return client.erp_calculate_impact(item_code, delay_days)


def _get_inventory_buffers(item_code: str = "") -> list:
    """
    Query current inventory buffer levels from the ERP system.

    Args:
        item_code: Optional item code to filter results. Leave empty for all items.

    Returns:
        List of inventory buffer records with on_hand, safety_stock, reorder_point,
        on_order, item_code, and region.
    """
    return client.erp_get_inventory(item_code or None)


def _get_bill_of_materials(product_code: str) -> list:
    """
    Retrieve the Bill of Materials for a finished product.

    Args:
        product_code: The finished-goods product code (e.g. 'PROD-CTRL-500').

    Returns:
        List of BOM line items with component_code, component_name,
        quantity_required, and unit.
    """
    return client.erp_get_bom(product_code)


# Wrap as ADK FunctionTools (exported for use in LlmAgent tool lists)
list_purchase_orders  = FunctionTool(_list_purchase_orders)
list_sales_orders     = FunctionTool(_list_sales_orders)
calculate_bom_impact  = FunctionTool(_calculate_bom_impact)
get_inventory_buffers = FunctionTool(_get_inventory_buffers)
get_bill_of_materials = FunctionTool(_get_bill_of_materials)
