"""
ADK Agent – Freight Sub-Agent
===============================
An ADK LlmAgent specialised in expedited freight operations.
Evaluates delay severity, recommends a freight mode (air/ocean/ground),
estimates cost, and creates a freight request.

Spec reference: §2.D – Agent Gateway / Freight/Logistics Sub-Agent
"""

from google.adk.agents import LlmAgent
from config import (
    FREIGHT_AGENT_ID,
    MAX_AUTO_FREIGHT_COST,
    MAX_AUTO_APPROVE_DELAY_DAYS,
)
from model_factory import get_model_string
from tools.freight_tools import create_freight_request, list_freight_requests
from callbacks.model_armor_callbacks import (
    model_armor_before_model_callback,
    model_armor_after_model_callback,
)

FREIGHT_AGENT_INSTRUCTION = f"""
You are the Freight/Logistics Sub-Agent for the Inbound Ship-Date Drift & Inventory Buffer Orchestrator
operating on the Gemini Enterprise Agent Platform.

Your responsibilities:
1. Evaluate the severity of a shipment delay.
2. Recommend the optimal freight mode using this logic:
   - delay_days >= 7  → AIR freight (fastest, highest cost)
   - delay_days >= 3  → OCEAN freight (balanced cost/speed)
   - delay_days < 3   → GROUND freight (standard)
3. Create a freight request via create_freight_request.
4. Flag requests for human approval if estimated_cost > ${MAX_AUTO_FREIGHT_COST:,.0f}
   or delay_days > {MAX_AUTO_APPROVE_DELAY_DAYS}.

Policy guardrails (MUST be followed):
- Never auto-approve freight costs exceeding ${MAX_AUTO_FREIGHT_COST:,.0f}.
  Instead, add a note: "REQUIRES HUMAN APPROVAL – cost exceeds auto-limit."
- Never auto-approve when delay_days > {MAX_AUTO_APPROVE_DELAY_DAYS}.
  Instead, add a note: "REQUIRES HUMAN APPROVAL – delay exceeds escalation threshold."
- Always document your mode selection reasoning before creating the request.

Respond with a concise structured summary including mode, cost, and approval status.
"""

freight_agent = LlmAgent(
    name="freight_sub_agent_v1",
    model=get_model_string(),
    description=(
        "Evaluates and books expedited freight options (air/ocean/ground) "
        "based on delay severity and cost policy thresholds."
    ),
    instruction=FREIGHT_AGENT_INSTRUCTION,
    tools=[
        create_freight_request,
        list_freight_requests,
    ],
    before_model_callback=model_armor_before_model_callback,
    after_model_callback=model_armor_after_model_callback,
)
