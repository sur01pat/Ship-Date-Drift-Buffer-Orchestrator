"""
Gemini Enterprise Agent Platform – Deployment Script
======================================================
Deploys the Inbound Ship-Date Drift Orchestrator to Vertex AI Agent Engine
(the Gemini Enterprise Agent Platform runtime).

Usage:
    python deployment/deploy_agent_engine.py [--project PROJECT] [--location LOCATION]

This script:
1. Authenticates using Application Default Credentials (ADC).
2. Packages the ADK agent (root_agent) into a Vertex AI ReasoningEngine.
3. Creates or updates the Agent Engine resource.
4. Outputs the resource name for use in CI/CD or env configuration.

Prerequisites:
    gcloud auth application-default login
    pip install google-cloud-aiplatform google-adk
"""

import sys
import os
import glob as _glob
import shutil
import tempfile
import argparse

# Allow running from deployment/ subdirectory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import vertexai
from vertexai.preview import reasoning_engines
from config import (
    GOOGLE_CLOUD_PROJECT,
    GOOGLE_CLOUD_LOCATION,
    VERTEX_STAGING_BUCKET,
    GEMINI_MODEL,
)


def build_agent_app(agent_engine_id: str = None):
    """
    Wrap the root ADK agent in a Vertex AI AdkApp for deployment.
    AdkApp is the Vertex AI SDK adapter that hosts an ADK agent on Agent Engine.

    Vertex AI Memory Bank is wired via VertexAiMemoryBankService so that:
    - Session facts are automatically stored after each stream_query call.
    - Cross-session context (vendor SLAs, history) is surfaced by the agent.
    - The GCP console 'Memory count' metric becomes non-zero.

    VertexAiMemoryBankService requires agent_engine_id, which is only known
    after the first deployment. Pass --engine-id to enable it on redeploy.
    """
    from agents.orchestrator_agent import root_agent

    # ── Vertex AI Memory Bank ──────────────────────────────────────────────
    # VertexAiMemoryBankService stores and retrieves agent memories using
    # the Vertex AI Memory Bank service (agentplatform.googleapis.com).
    # agent_engine_id is the numeric ID portion of the resource name.
    memory_service_builder = None
    if agent_engine_id:
        try:
            from google.adk.memory import VertexAiMemoryBankService
            # AdkApp expects a builder callable (factory), not a service instance.
            # The builder is called at runtime with no arguments to create the service.
            def _memory_builder():
                return VertexAiMemoryBankService(
                    project=GOOGLE_CLOUD_PROJECT,
                    location=GOOGLE_CLOUD_LOCATION,
                    agent_engine_id=agent_engine_id,
                )
            memory_service_builder = _memory_builder
            print(f"  Memory Bank: VertexAiMemoryBankService builder configured (engine={agent_engine_id})")
        except Exception as e:
            print(f"  Memory Bank: VertexAiMemoryBankService unavailable ({e}), skipping")
    else:
        print("  Memory Bank: skipped on first deploy (re-run with --engine-id to enable)")

    app_kwargs = dict(
        agent=root_agent,
        enable_tracing=True,   # Emit OpenTelemetry traces to Cloud Trace
    )
    if memory_service_builder is not None:
        app_kwargs["memory_service_builder"] = memory_service_builder

    app = reasoning_engines.AdkApp(**app_kwargs)
    return app


def get_extra_packages() -> list:
    """
    Return the list of local source items to include in dependencies.tar.gz.

    The Agent Engine container extracts dependencies.tar.gz with:
        tar -xvf user_code/dependencies.tar.gz
    from /code as CWD. Extracted files then land directly at:
        /code/tools/__init__.py, /code/agents/…, etc.
    so `import tools` works at runtime.

    Requirement: paths MUST be relative (no leading /, no '..'), which means
    we must chdir to the adk/ root before the SDK calls tarfile.add().
    """
    adk_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    # Change CWD to adk/ root so all relative paths resolve correctly
    os.chdir(adk_root)
    packages = []
    for item in ["tools", "agents", "callbacks", "config.py",
                 "model_factory.py", "tool_server_client.py", "agent.py"]:
        if os.path.exists(item):
            packages.append(item)
        else:
            print(f"  WARNING: {item} not found, skipping from extra_packages")
    return packages


def deploy(project: str, location: str, staging_bucket: str, display_name: str, engine_id: str = None):
    """
    Deploy the agent app to Vertex AI Agent Engine.
    Creates a new ReasoningEngine resource (or updates if name already exists).

    engine_id: numeric engine ID for second-pass deploy with Memory Bank wired.
    """
    vertexai.init(project=project, location=location, staging_bucket=staging_bucket)

    print(f"  Project:  {project}")
    print(f"  Location: {location}")
    print(f"  Bucket:   {staging_bucket}")
    print(f"  Model:    {GEMINI_MODEL}")
    print(f"  Name:     {display_name}")
    if engine_id:
        print(f"  Engine ID:{engine_id}")
    print()

    app = build_agent_app(agent_engine_id=engine_id)

    extra = get_extra_packages()
    print(f"  Packages: {', '.join(extra)}")

    print("Deploying to Vertex AI Agent Engine…")
    engine = reasoning_engines.ReasoningEngine.create(
        app,
        display_name=display_name,
        description=(
            "Inbound Ship-Date Drift & Inventory Buffer Orchestrator v1.0.0-FINAL. "
            "Autonomous event-driven supply-chain coordinator on the Gemini Enterprise Agent Platform."
        ),
        # requirements: third-party pip packages installed in the Agent Engine container.
        # Pin google-adk to match the local version used to serialise the pkl.
        requirements=[
            "google-adk==2.6.3",
            "google-cloud-aiplatform[agent_engines,reasoningengine]>=1.60.0",
            "cloudpickle>=3.0.0",
            "requests>=2.32.0",
            "python-dotenv>=1.0.0",
            "pydantic>=2.7.0",
        ],
        # extra_packages: our local source files/packages.
        # The container extracts dependencies.tar.gz to /code so these land at:
        #   /code/tools/, /code/agents/, /code/callbacks/, /code/config.py, etc.
        # This makes `import tools` work when cloudpickle.loads() is called.
        extra_packages=extra,
    )

    print()
    print("Deployment complete.")
    print(f"  Resource name: {engine.resource_name}")
    print()
    print("Set this in your environment:")
    print(f"  export AGENT_ENGINE_RESOURCE={engine.resource_name}")
    return engine.resource_name


def main():
    parser = argparse.ArgumentParser(description="Deploy Orchestrator to Vertex AI Agent Engine")
    parser.add_argument("--project", default=GOOGLE_CLOUD_PROJECT)
    parser.add_argument("--location", default=GOOGLE_CLOUD_LOCATION)
    parser.add_argument("--bucket", default=VERTEX_STAGING_BUCKET)
    parser.add_argument("--name", default="ship-date-drift-orchestrator-v1")
    parser.add_argument(
        "--engine-id",
        default=None,
        help="Numeric Engine ID for second-pass deploy with VertexAiMemoryBankService wired. "
             "Get this from the resource name after first deploy: "
             "projects/.../reasoningEngines/<ENGINE_ID>",
    )
    args = parser.parse_args()

    resource_name = deploy(args.project, args.location, args.bucket, args.name, engine_id=args.engine_id)
    print(resource_name)


if __name__ == "__main__":
    main()
