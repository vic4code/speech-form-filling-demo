"""Guardrail types — all guardrails are fully managed by LiteLLM.

Text Guardrail: LiteLLM → Bedrock Guardrail (pre_call hook in guardrails config)
Audio Guardrail: LiteLLM → AudioGuardrailHook (monkey patch via callbacks config)

FastAPI does not interact with any guardrail endpoint directly.
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
