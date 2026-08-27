"""
ADK Configuration
=================
Central place for all environment-driven settings used by the ADK layer.
All values can be overridden via environment variables or a .env file.

Model backend selection
-----------------------
Set ONE of the following in your environment (or .env file):

  Gemini API (Google AI Studio):
    GEMINI_BACKEND=gemini_api
    GOOGLE_API_KEY=<your-ai-studio-key>     # set in .env — never commit to source

  Vertex AI:
    GEMINI_BACKEND=vertex_ai
    GOOGLE_CLOUD_PROJECT=<your-gcp-project-id>
    GOOGLE_CLOUD_LOCATION=us-central1       (optional, defaults to us-central1)
    GOOGLE_GENAI_USE_VERTEXAI=1             (read by google-genai SDK automatically)

If neither GOOGLE_API_KEY nor GOOGLE_GENAI_USE_VERTEXAI is set, the app
defaults to Gemini API mode and relies on Application Default Credentials or
a GOOGLE_API_KEY set in the environment by other means.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ── Gemini model ──────────────────────────────────────────────────────────────
# Default: gemini-3.7-flash — fully available on both free and paid API tiers.
# gemini-3.7-flash was released August 2026. Override via GEMINI_MODEL env var
# (e.g. GEMINI_MODEL=gemini-3.7-pro) once your API key has access.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.7-flash")

# ── Backend selection ─────────────────────────────────────────────────────────
# "gemini_api"  → google-genai Client uses GOOGLE_API_KEY  (Google AI Studio)
# "vertex_ai"   → google-genai Client uses Vertex AI       (GOOGLE_GENAI_USE_VERTEXAI=1)
# Auto-detected: if GOOGLE_API_KEY is set → gemini_api; else → vertex_ai.
def _detect_backend() -> str:
    explicit = os.getenv("GEMINI_BACKEND", "").strip().lower()
    if explicit in ("gemini_api", "vertex_ai"):
        return explicit
    # Auto-detect: Gemini API key present → use Gemini API
    if os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY"):
        return "gemini_api"
    return "vertex_ai"

GEMINI_BACKEND: str = _detect_backend()   # "gemini_api" | "vertex_ai"

# ── Google Cloud (Vertex AI path) ─────────────────────────────────────────────
GOOGLE_CLOUD_PROJECT   = os.getenv("GOOGLE_CLOUD_PROJECT", "your-gcp-project-id")
GOOGLE_CLOUD_LOCATION  = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
VERTEX_STAGING_BUCKET  = os.getenv("VERTEX_STAGING_BUCKET", f"gs://{GOOGLE_CLOUD_PROJECT}-adk-staging")

# ── Gemini API key (Gemini API path) ──────────────────────────────────────────
# Accept either GOOGLE_API_KEY (google-genai SDK standard) or the alias GEMINI_API_KEY.
GOOGLE_API_KEY: str = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or ""

# Agent Engine resource name (set after first deploy)
AGENT_ENGINE_RESOURCE  = os.getenv(
    "AGENT_ENGINE_RESOURCE",
    f"projects/{GOOGLE_CLOUD_PROJECT}/locations/{GOOGLE_CLOUD_LOCATION}/reasoningEngines/orchestrator-v1"
)

# ── Node.js tool-server base URL ──────────────────────────────────────────────
# The existing Node/Express backend serves as the "tool server" —
# each ADK Tool makes HTTP calls to it.
# Default points to the Cloud Run deployment; override via TOOL_SERVER_URL env var
# for local development (e.g. TOOL_SERVER_URL=http://localhost:4000).
TOOL_SERVER_URL = os.getenv(
    "TOOL_SERVER_URL",
    "https://orchestrator-backend-icnkyenovq-uc.a.run.app",
)
TOOL_SERVER_TOKEN = os.getenv("TOOL_SERVER_TOKEN", "")   # admin JWT; bootstrapped at startup

# ── Agent identity ────────────────────────────────────────────────────────────
ORCHESTRATOR_AGENT_ID = "agent-orchestrator-v1"
WAREHOUSE_AGENT_ID    = "agent-warehouse-v1"
FREIGHT_AGENT_ID      = "agent-freight-v1"
MEMORY_AGENT_ID       = "agent-memory-v1"

# ── Policy thresholds (mirror gateway constants) ──────────────────────────────
MAX_AUTO_FREIGHT_COST      = float(os.getenv("MAX_AUTO_FREIGHT_COST", "50000"))
MAX_AUTO_APPROVE_DELAY_DAYS = int(os.getenv("MAX_AUTO_APPROVE_DELAY_DAYS", "10"))
MAX_AUTO_WTO_QUANTITY       = int(os.getenv("MAX_AUTO_WTO_QUANTITY", "10000"))
