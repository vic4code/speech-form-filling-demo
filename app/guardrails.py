"""Guardrail integration — all guardrails go through LiteLLM.

Text Guardrail:
  - LiteLLM → litellm_content_filter (realtime_input_transcription hook)
  - LiteLLM → Bedrock Guardrail (pre_call)

Audio Guardrail:
  - LiteLLM → custom AudioGuardrail (audio_guardrail.py)
  - FastAPI manages the streaming session via LiteLLM's guardrail instance

All guardrail endpoints are registered and managed through LiteLLM's
guardrail interface in litellm_config.yaml.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class GuardrailResult:
    passed: bool
    check_type: str  # "input_audio" | "input_text" | "output_text"
    message: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


def get_audio_guardrail():
    """Get the LiteLLM-registered AudioGuardrail instance."""
    try:
        import litellm
        for cb in litellm.logging_callback_manager.callbacks:
            cls_name = type(cb).__name__
            if cls_name == "AudioGuardrail":
                return cb
    except Exception as exc:
        print(f"[guardrail] Failed to get AudioGuardrail from LiteLLM: {exc}")
    return None
