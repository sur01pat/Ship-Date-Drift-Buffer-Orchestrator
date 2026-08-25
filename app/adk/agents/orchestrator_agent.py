"""
ADK Agent – Orchestrator (Root Agent)
========================================
The top-level ADK SequentialAgent that implements the 4-step
end-to-end orchestration workflow specified in §3 of the design doc.

Architecture:
  SequentialAgent (OrchestratorAgent)
    ├── Step 1: Model Armor inline callback (before_model on every sub-agent)
    ├── Step 2: LlmAgent with ERP tools  → BOM impact analysis
    ├── Step 3: ParallelAgent
    │       ├── WarehouseAgent  → WTO creation
    │       └── FreightAgent    → Freight request
    └── Step 4: LlmAgent (this agent) → Remediation staging + human-sign-off summary

Spec reference: §3 – End-to-End Orchestration Workflow
"""

from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent
from config import ORCHESTRATOR_AGENT_ID
from model_factory import get_model_string
from tools.erp_tools import (
    list_purchase_orders,
    list_sales_orders,
    calculate_bom_impact,
    get_inventory_buffers,
    get_bill_of_materials,
)
from tools.memory_tools import (
    get_vendor_profile,
    get_vendor_delivery_history,
)
from tools.armor_tools import scan_with_model_armor
from tools.observability_tools import get_audit_statistics, get_audit_logs
from callbacks.model_armor_callbacks import (
    model_armor_before_model_callback,
    model_armor_after_model_callback,
)
from agents.warehouse_agent import warehouse_agent
from agents.freight_agent import freight_agent


# ── Step 2: ERP Impact Analysis Agent ─────────────────────────────────────────

_ERP_INSTRUCTION = """
You are the ERP Impact Analysis module of the Inbound Ship-Date Drift Orchestrator.

Given a shipment delay event you must:
1. Call get_vendor_profile with the vendor_id to retrieve SLA terms and penalty rate.
2. Call get_vendor_delivery_history to assess whether this delay is within historical norms.
3. Call list_purchase_orders to confirm the delayed PO details (item_code, quantity, costs).
4. Call calculate_bom_impact with the item_code and delay_days to identify all impacted
   Sales Orders and compute total revenue at risk.
5. Call get_inventory_buffers for the item_code to assess buffer adequacy.
6. Produce a structured impact report with:
   - vendor name and applicable SLA penalty clause
   - PO details and confirmed delay
   - list of impacted Sales Orders with revised delivery dates
   - total revenue at risk (sum of impacted SO revenues)
   - inventory buffer status (adequate / breached)

Store your impact report in the session state as 'erp_impact_report'.
"""

erp_impact_agent = LlmAgent(
    name="erp_impact_analysis_agent",
    model=get_model_string(),
    description="Retrieves vendor context from Memory Bank and analyses ERP BOM/SO impact.",
    instruction=_ERP_INSTRUCTION,
    tools=[
        get_vendor_profile,
        get_vendor_delivery_history,
        list_purchase_orders,
        list_sales_orders,
        calculate_bom_impact,
        get_inventory_buffers,
        get_bill_of_materials,
    ],
    before_model_callback=model_armor_before_model_callback,
    after_model_callback=model_armor_after_model_callback,
    output_key="erp_impact_report",
)


# ── Step 3: Parallel Sub-Agent Coordination ────────────────────────────────────

sub_agent_coordinator = ParallelAgent(
    name="sub_agent_coordinator",
    description=(
        "Concurrently dispatches the Warehouse Sub-Agent (WTO) and "
        "Freight Sub-Agent (expedited shipping) via the A2A Gateway."
    ),
    sub_agents=[warehouse_agent, freight_agent],
)


# ── Step 4: Remediation Staging & Human Sign-Off Agent ────────────────────────

_REMEDIATION_INSTRUCTION = """
You are the Remediation Staging module of the Inbound Ship-Date Drift Orchestrator.

Using the results accumulated in session state from prior steps, produce the final
remediation plan and human sign-off package. Specifically:

1. Read 'erp_impact_report' from session state for vendor, PO, and SO impact summary.
2. Calculate the vendor credit/penalty claim:
   - penalty_amount = min(PO_value * penalty_rate * delay_days, PO_value * 0.10)
   - PO_value = quantity * unit_cost
3. Summarise all sub-agent actions (WTO created / freight request created).
4. Produce a structured REMEDIATION PLAN containing:
   a) Vendor: name, SLA clause, penalty clause invoked
   b) PO: po_number, item_code, confirmed delay_days
   c) Impacted Sales Orders: so_number, customer, revised_delivery_date, revenue_at_risk
   d) Inventory Action: WTO number if created, or 'No WTO required'
   e) Freight Action: FR number, mode, cost, approval status
   f) Credit Claim: claim amount and applicable clause
   g) Human Sign-Off: APPROVE / REJECT decision required

5. End with a bold line: "⚠️ AWAITING HUMAN APPROVAL — Please review and approve or reject."

Produce your output as a well-structured markdown document suitable for a Slack/Teams
approval card.
"""

remediation_agent = LlmAgent(
    name="remediation_staging_agent",
    model=get_model_string(),
    description="Stages the full remediation plan and generates the human sign-off document.",
    instruction=_REMEDIATION_INSTRUCTION,
    tools=[get_audit_statistics, get_audit_logs],
    before_model_callback=model_armor_before_model_callback,
    after_model_callback=model_armor_after_model_callback,
    output_key="remediation_plan",
)


# ── Root Orchestrator: SequentialAgent ────────────────────────────────────────

orchestrator_agent = SequentialAgent(
    name="inbound_ship_date_drift_orchestrator_v1",
    description=(
        "Autonomous, event-driven coordinator that monitors supplier communications, "
        "identifies shipment delays, calculates ERP impacts, and executes multi-system "
        "remediation workflows on the Gemini Enterprise Agent Platform."
    ),
    sub_agents=[
        erp_impact_agent,       # Step 2: Context retrieval & ERP impact
        sub_agent_coordinator,  # Step 3: Parallel WTO + Freight
        remediation_agent,      # Step 4: Remediation staging + human sign-off
    ],
)

# Export the root agent as `root_agent` — ADK convention for the entry point
root_agent = orchestrator_agent
