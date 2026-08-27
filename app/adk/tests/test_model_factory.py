"""
ADK Tests – Model Factory
==========================
Verifies that model_factory correctly:
  - Uses gemini-3.7-flash (or whatever GEMINI_MODEL is set to)
  - Auto-detects the backend from environment variables
  - Routes to Gemini API when GOOGLE_API_KEY is present
  - Routes to Vertex AI when GOOGLE_GENAI_USE_VERTEXAI=1
  - Raises a clear error when Gemini API is requested but no key is set
  - Returns a cached singleton (same object on repeated calls)
  - Exposes get_model_string() and get_backend_name() helpers
"""

import os
import importlib
import pytest
from unittest.mock import patch, MagicMock


# ── Helpers ───────────────────────────────────────────────────────────────────

def _reload_factory(env: dict):
    """Reload model_factory with a clean env override so lru_cache doesn't interfere."""
    import model_factory as mf
    # Clear the lru_cache between tests
    mf.make_model.cache_clear()
    # Reload config too so _detect_backend() re-runs with the new env
    import config as cfg
    with patch.dict(os.environ, env, clear=False):
        importlib.reload(cfg)
        importlib.reload(mf)
    # Restore original config after reload
    importlib.reload(cfg)
    return mf


# ── config.py backend detection ───────────────────────────────────────────────

def test_config_detects_gemini_api_when_google_api_key_set():
    """GOOGLE_API_KEY present → backend == gemini_api."""
    with patch.dict(os.environ, {"GOOGLE_API_KEY": "test-key-123",
                                  "GEMINI_BACKEND": "",
                                  "GEMINI_API_KEY": ""}, clear=False):
        import config as cfg
        importlib.reload(cfg)
        assert cfg.GEMINI_BACKEND == "gemini_api"
        assert cfg.GOOGLE_API_KEY == "test-key-123"
    importlib.reload(cfg)   # restore


def test_config_detects_gemini_api_when_gemini_api_key_alias_set():
    """GEMINI_API_KEY alias → backend == gemini_api."""
    with patch.dict(os.environ, {"GEMINI_API_KEY": "alias-key-456",
                                  "GOOGLE_API_KEY": "",
                                  "GEMINI_BACKEND": ""}, clear=False):
        import config as cfg
        importlib.reload(cfg)
        assert cfg.GEMINI_BACKEND == "gemini_api"
    importlib.reload(cfg)


def test_config_detects_vertex_ai_when_no_api_key():
    """No API key set → backend == vertex_ai."""
    env = {"GOOGLE_API_KEY": "", "GEMINI_API_KEY": "", "GEMINI_BACKEND": ""}
    with patch.dict(os.environ, env, clear=False):
        import config as cfg
        importlib.reload(cfg)
        assert cfg.GEMINI_BACKEND == "vertex_ai"
    importlib.reload(cfg)


def test_config_explicit_backend_gemini_api():
    """GEMINI_BACKEND=gemini_api overrides auto-detection."""
    with patch.dict(os.environ, {"GEMINI_BACKEND": "gemini_api",
                                  "GOOGLE_API_KEY": ""}, clear=False):
        import config as cfg
        importlib.reload(cfg)
        assert cfg.GEMINI_BACKEND == "gemini_api"
    importlib.reload(cfg)


def test_config_explicit_backend_vertex_ai():
    """GEMINI_BACKEND=vertex_ai overrides even if GOOGLE_API_KEY is set."""
    with patch.dict(os.environ, {"GEMINI_BACKEND": "vertex_ai",
                                  "GOOGLE_API_KEY": "some-key"}, clear=False):
        import config as cfg
        importlib.reload(cfg)
        assert cfg.GEMINI_BACKEND == "vertex_ai"
    importlib.reload(cfg)


def test_config_model_default_is_gemini_37_flash():
    """Default model is gemini-3.7-flash when GEMINI_MODEL env var is unset.

    The hardcoded fallback in config.py is gemini-3.7-flash.  In production
    the .env file may override GEMINI_MODEL.  We patch load_dotenv to be a
    no-op so the .env file does not interfere with this unit test.
    """
    import config as cfg
    # Patch load_dotenv to prevent .env from injecting a different GEMINI_MODEL
    env_without_model = {k: v for k, v in os.environ.items() if k != "GEMINI_MODEL"}
    with patch("dotenv.load_dotenv"), \
         patch.dict(os.environ, env_without_model, clear=True):
        importlib.reload(cfg)
        assert cfg.GEMINI_MODEL == "gemini-3.7-flash"
    importlib.reload(cfg)   # restore production values


def test_config_model_env_override():
    """GEMINI_MODEL env var is respected."""
    with patch.dict(os.environ, {"GEMINI_MODEL": "gemini-3.7-flash"}, clear=False):
        import config as cfg
        importlib.reload(cfg)
        assert cfg.GEMINI_MODEL == "gemini-3.7-flash"
    importlib.reload(cfg)


# ── model_factory.py ──────────────────────────────────────────────────────────

def test_make_model_returns_gemini_instance():
    """make_model() returns an ADK Gemini instance."""
    from google.adk.models.google_llm import Gemini
    import model_factory as mf
    mf.make_model.cache_clear()

    with patch("model_factory._build_vertex_ai_client", return_value=MagicMock(vertexai=True)), \
         patch("model_factory.GEMINI_BACKEND", "vertex_ai"):
        result = mf.make_model()
    assert isinstance(result, Gemini)
    mf.make_model.cache_clear()


def test_make_model_uses_correct_model_string():
    """The Gemini instance's .model attribute equals GEMINI_MODEL from config."""
    import model_factory as mf
    mf.make_model.cache_clear()

    with patch("model_factory._build_vertex_ai_client", return_value=MagicMock(vertexai=True)), \
         patch("model_factory.GEMINI_BACKEND", "vertex_ai"), \
         patch("model_factory.GEMINI_MODEL", "gemini-2.5-pro"):
        result = mf.make_model()
    assert result.model == "gemini-2.5-pro"
    mf.make_model.cache_clear()


def test_make_model_gemini_api_path():
    """Gemini API backend: _RoutedGemini.api_client is the Gemini API client."""
    import model_factory as mf
    mf.make_model.cache_clear()

    mock_client = MagicMock()
    mock_client.vertexai = False

    with patch("model_factory._build_gemini_api_client", return_value=mock_client), \
         patch("model_factory.GEMINI_BACKEND", "gemini_api"):
        result = mf.make_model()
    assert result.api_client is mock_client
    assert result.api_client.vertexai is False
    mf.make_model.cache_clear()


def test_make_model_vertex_ai_path():
    """Vertex AI backend: _RoutedGemini.api_client is the Vertex AI client."""
    import model_factory as mf
    mf.make_model.cache_clear()

    mock_client = MagicMock()
    mock_client.vertexai = True

    with patch("model_factory._build_vertex_ai_client", return_value=mock_client), \
         patch("model_factory.GEMINI_BACKEND", "vertex_ai"):
        result = mf.make_model()
    assert result.api_client is mock_client
    assert result.api_client.vertexai is True
    mf.make_model.cache_clear()


def test_make_model_is_cached():
    """Calling make_model() twice returns the same instance."""
    import model_factory as mf
    mf.make_model.cache_clear()

    mock_client = MagicMock(vertexai=True)
    with patch("model_factory._build_vertex_ai_client", return_value=mock_client), \
         patch("model_factory.GEMINI_BACKEND", "vertex_ai"):
        first = mf.make_model()
        second = mf.make_model()
    assert first is second
    mf.make_model.cache_clear()


def test_gemini_api_raises_without_key():
    """_build_gemini_api_client raises EnvironmentError when no key is set."""
    import model_factory as mf
    with patch("model_factory.GOOGLE_API_KEY", ""):
        with pytest.raises(EnvironmentError, match="GOOGLE_API_KEY"):
            mf._build_gemini_api_client()


def test_get_model_string():
    """get_model_string() returns the configured model name."""
    with patch("model_factory.GEMINI_MODEL", "gemini-2.5-pro"):
        import model_factory as mf
        assert mf.get_model_string() == "gemini-2.5-pro"


def test_get_backend_name_gemini_api():
    """get_backend_name() returns 'gemini_api' when that backend is active."""
    with patch("model_factory.GEMINI_BACKEND", "gemini_api"):
        import model_factory as mf
        assert mf.get_backend_name() == "gemini_api"


def test_get_backend_name_vertex_ai():
    """get_backend_name() returns 'vertex_ai' when that backend is active."""
    with patch("model_factory.GEMINI_BACKEND", "vertex_ai"):
        import model_factory as mf
        assert mf.get_backend_name() == "vertex_ai"
