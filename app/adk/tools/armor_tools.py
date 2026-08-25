"""
ADK Tools – Model Armor Scanning Tool
=======================================
Exposes the Model Armor firewall as an ADK FunctionTool.
"""

from google.adk.tools import FunctionTool
import tool_server_client as client


def _scan_with_model_armor(payload: dict) -> dict:
    """
    Submit a payload to the Model Armor firewall for security screening.
    Detects prompt injection, jailbreak attempts, tool-poisoning patterns,
    and masks PII (emails, phone numbers, SSNs, credit cards).

    Args:
        payload: The raw incoming payload dict to scan.

    Returns:
        Scan result with 'safe' (bool), 'threats' (list), 'piiMasked' (bool),
        'sanitized' (cleaned payload), and 'scanId'.
    """
    return client.armor_scan(payload)


scan_with_model_armor = FunctionTool(_scan_with_model_armor)
