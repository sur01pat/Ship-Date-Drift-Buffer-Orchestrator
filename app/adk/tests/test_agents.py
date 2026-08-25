"""
ADK Tests – Agent Definitions
================================
Verifies that each ADK agent is correctly constructed:
correct name, model, tool list, and callback hooks.
Does NOT invoke the model — structural / wiring tests only.
"""

import pytest


def test_memory_agent_structure(mock_tool_server):
    from agents.memory_agent import memory_bank_agent
    from model_factory import get_model_string
    assert memory_bank_agent.name == "memory_bank_agent_v1"
    # model is a plain string — ADK resolves it to a Gemini instance at runtime
    assert memory_bank_agent.model == get_model_string()
    assert len(memory_bank_agent.tools) == 7
    # FunctionTool.name is derived from the wrapped function name (underscore-prefixed)
    tool_names = [t.name for t in memory_bank_agent.tools]
    assert any("vendor_profile" in n for n in tool_names)
    assert any("delivery_history" in n for n in tool_names)
    assert any("store_memory" in n for n in tool_names)
    assert any("retrieve_memories" in n for n in tool_names)
    assert any("search_memories" in n for n in tool_names)
    assert memory_bank_agent.before_model_callback is not None
    assert memory_bank_agent.after_model_callback is not None


def test_warehouse_agent_structure(mock_tool_server):
    from agents.warehouse_agent import warehouse_agent
    from model_factory import get_model_string
    assert warehouse_agent.name == "warehouse_sub_agent_v1"
    assert warehouse_agent.model == get_model_string()
    tool_names = [t.name for t in warehouse_agent.tools]
    assert any("transfer_order" in n for n in tool_names)
    assert any("inventory_buffer" in n for n in tool_names)
    assert warehouse_agent.before_model_callback is not None


def test_freight_agent_structure(mock_tool_server):
    from agents.freight_agent import freight_agent
    from model_factory import get_model_string
    assert freight_agent.name == "freight_sub_agent_v1"
    assert freight_agent.model == get_model_string()
    tool_names = [t.name for t in freight_agent.tools]
    assert any("freight_request" in n for n in tool_names)
    assert freight_agent.before_model_callback is not None
    # Verify policy thresholds are embedded in the instruction
    assert "50,000" in freight_agent.instruction or "50000" in freight_agent.instruction
    assert "10" in freight_agent.instruction


def test_orchestrator_agent_structure(mock_tool_server):
    from agents.orchestrator_agent import orchestrator_agent, root_agent
    assert orchestrator_agent.name == "inbound_ship_date_drift_orchestrator_v1"
    assert root_agent is orchestrator_agent
    # SequentialAgent should have 3 sub-agents: erp, parallel coordinator, remediation
    assert len(orchestrator_agent.sub_agents) == 3


def test_orchestrator_step2_is_erp_agent(mock_tool_server):
    from agents.orchestrator_agent import orchestrator_agent
    erp_step = orchestrator_agent.sub_agents[0]
    assert erp_step.name == "erp_impact_analysis_agent"
    tool_names = [t.name for t in erp_step.tools]
    assert any("bom_impact" in n for n in tool_names)
    assert any("vendor_profile" in n for n in tool_names)


def test_orchestrator_step3_is_parallel(mock_tool_server):
    from agents.orchestrator_agent import orchestrator_agent
    from google.adk.agents import ParallelAgent
    parallel_step = orchestrator_agent.sub_agents[1]
    assert isinstance(parallel_step, ParallelAgent)
    sub_names = [a.name for a in parallel_step.sub_agents]
    assert "warehouse_sub_agent_v1" in sub_names
    assert "freight_sub_agent_v1" in sub_names


def test_orchestrator_step4_is_remediation(mock_tool_server):
    from agents.orchestrator_agent import orchestrator_agent
    remediation_step = orchestrator_agent.sub_agents[2]
    assert remediation_step.name == "remediation_staging_agent"
    assert remediation_step.output_key == "remediation_plan"


def test_root_agent_exported_from_agent_module(mock_tool_server):
    import agent as agent_module
    assert hasattr(agent_module, "root_agent")
    assert agent_module.root_agent is not None
