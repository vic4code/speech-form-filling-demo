"""Custom LiteLLM Guardrail: Audio Guardrail WS streaming.

Wraps the external audio guardrail WebSocket service as a LiteLLM guardrail.
Registered in litellm_config.yaml and managed through LiteLLM's guardrail interface.

The audio guardrail streams raw PCM16 audio to an external WS service
that runs a multimodal model to detect unsafe audio content.

Protocol:
  → send: raw PCM16 binary bytes (16kHz mono)
  ← recv: {"event": "guardrail_result", "status": "SAFE"|"UNSAFE", "process_time_sec": ...}
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any, Optional

import numpy as np
import websockets
from litellm.integrations.custom_guardrail import CustomGuardrail
from litellm.types.guardrails import GuardrailEventHooks


SRC_RATE = 24000
TGT_RATE = 16000


def _resample_pcm16(pcm16_bytes: bytes) -> bytes:
    audio = np.frombuffer(pcm16_bytes, dtype=np.int16)
    if len(audio) == 0:
        return b""
    num_samples = int(len(audio) * TGT_RATE / SRC_RATE)
    resampled = np.interp(
        np.linspace(0, len(audio), num_samples, endpoint=False),
        np.arange(len(audio)),
        audio,
    ).astype(np.int16)
    return resampled.tobytes()


class AudioGuardrail(CustomGuardrail):
    """LiteLLM custom guardrail that streams audio to an external WS guardrail service."""

    supported_event_hooks = [
        GuardrailEventHooks.pre_call,
        GuardrailEventHooks.during_call,
    ]

    def __init__(self, ws_url: str = "", api_key: str = "", **kwargs):
        self.ws_url = ws_url or os.getenv("GUARDRAIL_WS_URL", "")
        self.api_key = api_key or os.getenv("GUARDRAIL_API_KEY", "")
        # Active sessions keyed by some session identifier
        self._sessions: dict[str, dict] = {}
        super().__init__(**kwargs)
        print(f"[AudioGuardrail] initialized, ws_url={self.ws_url}")

    def _build_url(self) -> str:
        if not self.ws_url:
            return ""
        separator = "&" if "?" in self.ws_url else "?"
        return f"{self.ws_url}{separator}api_key={self.api_key}" if self.api_key else self.ws_url

    async def connect_session(self) -> Optional[dict]:
        """Create a new audio guardrail streaming session."""
        url = self._build_url()
        if not url:
            print("[AudioGuardrail] no WS URL configured, skipping")
            return None
        try:
            ws = await websockets.connect(url, open_timeout=10)
            session = {
                "ws": ws,
                "closed": False,
                "results": [],
                "listen_task": None,
            }
            session["listen_task"] = asyncio.create_task(self._listen(session))
            print("[AudioGuardrail] WS connected")
            return session
        except Exception as exc:
            print(f"[AudioGuardrail] WS connect failed: {exc}")
            return None

    async def send_audio(self, session: dict, pcm16_base64: str) -> None:
        """Send audio chunk to the guardrail WS."""
        ws = session.get("ws")
        if not ws or session.get("closed"):
            return
        try:
            raw = base64.b64decode(pcm16_base64)
            resampled = _resample_pcm16(raw)
            await ws.send(resampled)
        except Exception:
            pass

    async def close_session(self, session: dict) -> None:
        """Close a streaming session."""
        session["closed"] = True
        if session.get("listen_task"):
            session["listen_task"].cancel()
        ws = session.get("ws")
        if ws:
            try:
                await ws.close()
            except Exception:
                pass

    def get_latest_result(self, session: dict) -> Optional[dict]:
        """Get the most recent guardrail result from the session."""
        results = session.get("results", [])
        return results[-1] if results else None

    async def _listen(self, session: dict) -> None:
        ws = session["ws"]
        try:
            async for msg in ws:
                try:
                    text = msg.decode("utf-8") if isinstance(msg, bytes) else msg
                    data = json.loads(text)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue

                if data.get("event") == "guardrail_result":
                    session["results"].append(data)

        except (websockets.ConnectionClosed, asyncio.CancelledError):
            pass
        except Exception as exc:
            print(f"[AudioGuardrail] listen error: {exc}")
