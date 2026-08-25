"""
ADK Model Factory
=================
Creates the correct ``google.adk.models.Gemini`` instance for each backend.

ADK's ``Gemini`` class wraps ``google.genai.Client``.  The client
auto-selects its backend based on how it is constructed:

  Gemini API  → Client(api_key="…")
  Vertex AI   → Client(vertexai=True, project="…", location="…")

This module reads ``GEMINI_BACKEND`` (set by config.py) and returns a
ready-to-use ``Gemini`` instance that every LlmAgent in the project uses
as its ``model`` argument.

Usage
-----
    from model_factory import make_model

    agent = LlmAgent(model=make_model(), ...)
"""

import os
from functools import lru_cache

from google.adk.models.google_llm import Gemini
from google.genai import Client

from config import (
    GEMINI_BACKEND,
    GEMINI_MODEL,
    GOOGLE_API_KEY,
    GOOGLE_CLOUD_PROJECT,
    GOOGLE_CLOUD_LOCATION,
)


def _build_gemini_api_client() -> Client:
    """
    Build a google.genai.Client that calls the Gemini API (AI Studio).
    Requires GOOGLE_API_KEY (or GEMINI_API_KEY) to be set.
    """
    key = GOOGLE_API_KEY
    if not key:
        raise EnvironmentError(
            "GEMINI_BACKEND=gemini_api but no GOOGLE_API_KEY or GEMINI_API_KEY "
            "is set. Export your AI Studio API key:\n"
            "  export GOOGLE_API_KEY=<your-key>"
        )
    return Client(api_key=key)


def _build_vertex_ai_client() -> Client:
    """
    Build a google.genai.Client that calls Vertex AI.
    Requires GOOGLE_CLOUD_PROJECT to be a real project ID.
    Authentication is via Application Default Credentials (ADC):
      gcloud auth application-default login
    """
    # Set the env var the google-genai SDK reads for Vertex AI mode.
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "1")
    return Client(
        vertexai=True,
        project=GOOGLE_CLOUD_PROJECT,
        location=GOOGLE_CLOUD_LOCATION,
    )


@lru_cache(maxsize=1)
def make_model() -> Gemini:
    """
    Return a cached ``Gemini`` instance wired to the active backend.

    The result is cached so the same Client object is reused across all
    agents in the process (avoids re-authenticating on every agent call).

    Backend resolution:
      GEMINI_BACKEND=gemini_api  →  Gemini API (GOOGLE_API_KEY)
      GEMINI_BACKEND=vertex_ai   →  Vertex AI   (ADC / Workload Identity)
    """
    if GEMINI_BACKEND == "gemini_api":
        client = _build_gemini_api_client()
    else:
        client = _build_vertex_ai_client()

    # Subclass Gemini to inject our pre-built Client so ADK does not
    # construct its own (which would lose our api_key / vertexai=True).
    class _RoutedGemini(Gemini):
        @property
        def api_client(self) -> Client:  # type: ignore[override]
            return client

    instance = _RoutedGemini(model=GEMINI_MODEL)
    return instance


def get_model_string() -> str:
    """Return the active model string (e.g. 'gemini-2.5-pro')."""
    return GEMINI_MODEL


def get_backend_name() -> str:
    """Return the active backend name ('gemini_api' or 'vertex_ai')."""
    return GEMINI_BACKEND
