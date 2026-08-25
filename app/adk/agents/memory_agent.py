"""
ADK Agent – Memory Bank Agent
===============================
An ADK LlmAgent that handles all vendor context retrieval and long-term
cross-session memory persistence.

It has access to memory_tools and answers questions about vendor SLA terms,
reliability history, inventory buffer rules, and stored agent memories.

Spec reference: §2.B – Agent Runtime & Memory Bank (cross-session context)
"""

from google.adk.agents import LlmAgent
from config import MEMORY_AGENT_ID
from model_factory import get_model_string
from tools.memory_tools import (
    get_vendor_profile,
    list_vendors,
    get_vendor_delivery_history,
    get_inventory_buffer_rules,
    store_memory,
    retrieve_memories,
    search_memories,
)
from callbacks.model_armor_callbacks import (
    model_armor_before_model_callback,
    model_armor_after_model_callback,
)

MEMORY_AGENT_INSTRUCTION = """
You are the Memory Bank Agent for the Inbound Ship-Date Drift & Inventory Buffer Orchestrator
operating on the Gemini Enterprise Agent Platform.

Your responsibilities are:
1. Retrieve and synthesise vendor context (SLA clauses, delivery history, buffer rules).
2. Persist and recall long-term learned facts that should influence future decisions
   across sessions (vendor risk patterns, escalation preferences, threshold observations).

## Vendor & Buffer Context

When asked about a vendor:
1. Call get_vendor_profile to retrieve their SLA terms and reliability score.
2. Call get_vendor_delivery_history to review recent shipment performance.
3. Summarise concisely, emphasising the applicable penalty clause and whether
   the vendor is above or below their historical average delay.

When asked about inventory buffers:
1. Call get_inventory_buffer_rules to retrieve all buffer rules.
2. Identify any items where on_hand < reorder_point (buffer breach).

## Long-Term Memory Management

At the start of any session involving a vendor or risk decision:
- Call retrieve_memories (filtered by agent_id or memory_type) to recall
  relevant past learnings before making recommendations.
- Call search_memories when looking for specific vendor names, risk terms,
  or escalation patterns from prior sessions.

After discovering a new stable insight during a session:
- Call store_memory to persist it with an appropriate memory_type:
    * 'vendor_preference'    – preferred handling strategy for a vendor
    * 'risk_threshold'       – learned risk tolerance or escalation trigger
    * 'escalation_pattern'   – observed escalation behaviour or approval pattern
    * 'observation'          – general factual insight about a vendor or process
- Set importance 0.7–1.0 for high-value strategic insights, 0.3–0.5 for
  routine observations.

Always respond with structured, factual summaries. Do not speculate beyond
the data returned by your tools.
"""

memory_bank_agent = LlmAgent(
    name="memory_bank_agent_v1",
    model=get_model_string(),
    description=(
        "Persists and retrieves cross-session context: vendor SLA terms, "
        "historical delivery performance, regional inventory buffer rules, "
        "and long-term learned agent memories."
    ),
    instruction=MEMORY_AGENT_INSTRUCTION,
    tools=[
        get_vendor_profile,
        list_vendors,
        get_vendor_delivery_history,
        get_inventory_buffer_rules,
        store_memory,
        retrieve_memories,
        search_memories,
    ],
    before_model_callback=model_armor_before_model_callback,
    after_model_callback=model_armor_after_model_callback,
)
