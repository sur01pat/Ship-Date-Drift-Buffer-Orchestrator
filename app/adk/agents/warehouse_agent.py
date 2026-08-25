"""
ADK Agent – Warehouse Sub-Agent
================================
An ADK LlmAgent specialised in warehouse operations.
Creates and manages Warehouse Transfer Orders (WTO) to rebalance
inventory when a delayed PO depletes buffer stock below the reorder point.

Spec reference: §2.D – Agent Gateway / Warehouse Sub-Agent
"""

from google.adk.agents import LlmAgent
from config import WAREHOUSE_AGENT_ID
from model_factory import get_model_string
from tools.warehouse_tools import (
    create_warehouse_transfer_order,
    list_warehouse_transfer_orders,
)
from tools.erp_tools import get_inventory_buffers
from callbacks.model_armor_callbacks import (
    model_armor_before_model_callback,
    model_armor_after_model_callback,
)

WAREHOUSE_AGENT_INSTRUCTION = """
You are the Warehouse Sub-Agent for the Inbound Ship-Date Drift & Inventory Buffer Orchestrator
operating on the Gemini Enterprise Agent Platform.

Your responsibilities:
1. Assess whether a delayed inbound shipment will breach inventory safety stock levels.
2. If the on_hand quantity for the affected item falls below the reorder_point,
   create a Warehouse Transfer Order (WTO) to move stock from the central warehouse
   to the regional distribution centre.
3. Draft the WTO with status 'draft' — it will be staged for human approval.

Decision rules:
- Only create a WTO if on_hand < reorder_point for the affected item.
- Do NOT create a WTO if on_hand >= safety_stock (buffer is adequate).
- Set quantity to the minimum of: (reorder_point - on_hand + safety_stock) and 1000.
- Always use 'Central Warehouse – Chicago' as from_location for NA transfers.
- Always use 'Regional DC – Dallas' as to_location for NA transfers.
- Document your reasoning before calling create_warehouse_transfer_order.

Respond with a concise JSON-compatible summary of your action and reasoning.
"""

warehouse_agent = LlmAgent(
    name="warehouse_sub_agent_v1",
    model=get_model_string(),
    description=(
        "Creates and manages Warehouse Transfer Orders (WTO) to rebalance "
        "inventory across distribution centres when inbound shipments are delayed."
    ),
    instruction=WAREHOUSE_AGENT_INSTRUCTION,
    tools=[
        get_inventory_buffers,
        create_warehouse_transfer_order,
        list_warehouse_transfer_orders,
    ],
    before_model_callback=model_armor_before_model_callback,
    after_model_callback=model_armor_after_model_callback,
)
