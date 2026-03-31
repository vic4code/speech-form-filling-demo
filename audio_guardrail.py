"""LiteLLM Custom Logger: Audio Guardrail via WebSocket monkey patching.

Based on: https://github.com/DScathay/voice-guardrails (realtime branch)

Intercepts LiteLLM's internal WebSocket to stream user input audio
to an external guardrail WS server (multimodal model) in real-time.

Technique: async_pre_call_hook receives the WebSocket object from LiteLLM,
then monkey-patches receive() to intercept input_audio_buffer.append events.
On UNSAFE result, injects an error event to the frontend.

Protocol:
  → send: raw PCM16 binary bytes (16kHz mono)
  ← recv: {"event": "guardrail_result", "status": "SAFE"|"UNSAFE", "process_time_sec": ...}
"""

import os
import sys
import json
import asyncio
import base64
import logging

import numpy as np
import websockets
from litellm.integrations.custom_logger import CustomLogger

logger = logging.getLogger("AudioGuardrail")
logger.setLevel(logging.DEBUG)
if not logger.handlers:
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(logging.Formatter("[AudioGuardrail] %(message)s"))
    logger.addHandler(h)


SRC_RATE = 24000  # OpenAI native sample rate
TGT_RATE = 16000  # Guardrail server expected sample rate


def _resample(pcm16_bytes: bytes) -> bytes:
    audio = np.frombuffer(pcm16_bytes, dtype=np.int16)
    if len(audio) == 0:
        return b""
    num_samples = int(len(audio) * TGT_RATE / SRC_RATE)
    return np.interp(
        np.linspace(0, len(audio), num_samples, endpoint=False),
        np.arange(len(audio)),
        audio,
    ).astype(np.int16).tobytes()


class AudioGuardrailHook(CustomLogger):
    """Monkey-patches LiteLLM's realtime WebSocket to stream audio to guardrail server."""

    def __init__(self):
        API_KEY = os.getenv("GUARDRAIL_API_KEY", "")
        BASE_WS_URL = os.getenv("GUARDRAIL_WS_URL", "")

        if not BASE_WS_URL:
            logger.info(" WARNING: GUARDRAIL_WS_URL not set, audio guardrail disabled")
            self.guardrail_ws_url = ""
        else:
            separator = "&" if "?" in BASE_WS_URL else "?"
            self.guardrail_ws_url = f"{BASE_WS_URL}{separator}api_key={API_KEY}" if API_KEY else BASE_WS_URL

        logger.info(f" initialized, input-stream guardrail ready")

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, **kwargs):
        """No-op: audio guardrail streaming is now handled by FastAPI directly.

        Kept registered in litellm_config.yaml for compatibility but does nothing.
        FastAPI's receive_from_client() handles Gemma WS streaming.
        """
        return

    async def _do_pre_call(self, data):
        if not self.guardrail_ws_url:
            logger.info("no guardrail_ws_url, skipping")
            return

        client_ws = data.get("websocket")
        if not client_ws:
            logger.info("no websocket in data, skipping")
            return

        logger.info("WebSocket intercepted, injecting input audio listener")

        original_receive = client_ws.receive
        g_ws = None

        async def listen_results(ws):
            """Listen for guardrail results and inject error events on UNSAFE."""
            try:
                while True:
                    response = await ws.recv()
                    result = json.loads(
                        response.decode("utf-8") if isinstance(response, bytes) else response
                    )
                    if result.get("event") == "guardrail_result":
                        status = result.get("status")
                        process_time = result.get("process_time_sec", 0)
                        if status == "UNSAFE":
                            logger.info(f" UNSAFE detected ({process_time:.2f}s)")
                            try:
                                await client_ws.send_text(json.dumps({
                                    "type": "error",
                                    "error": {
                                        "type": "guardrail_violation",
                                        "code": "audio_guardrail_violation",
                                        "message": f"Audio input unsafe ({process_time:.2f}s)",
                                    },
                                }))
                            except Exception:
                                pass
                        else:
                            logger.info(f" SAFE ({process_time:.2f}s)")
                            try:
                                await client_ws.send_text(json.dumps({
                                    "type": "error",
                                    "error": {
                                        "type": "guardrail_pass",
                                        "code": "audio_guardrail_safe",
                                        "message": f"Audio input safe ({process_time:.2f}s)",
                                    },
                                }))
                            except Exception:
                                pass
            except Exception as e:
                logger.info(f" listener stopped: {e}")

        async def patched_receive():
            nonlocal g_ws
            msg = await original_receive()

            try:
                if msg.get("type") == "websocket.receive" and msg.get("text"):
                    payload = json.loads(msg["text"])
                    if payload.get("type") == "input_audio_buffer.append":
                        audio_b64 = payload.get("audio")
                        if audio_b64:
                            resampled = _resample(base64.b64decode(audio_b64))

                            # Connect to guardrail WS if needed
                            is_open = False
                            if g_ws:
                                is_open = not getattr(g_ws, "closed", True)
                            if g_ws is None or not is_open:
                                g_ws = await websockets.connect(self.guardrail_ws_url)
                                asyncio.create_task(listen_results(g_ws))
                                logger.info(" WS connected")

                            await g_ws.send(resampled)
            except Exception as e:
                logger.info(f" intercept error: {e}")

            return msg

        client_ws.receive = patched_receive
        logger.info(" monkey patch applied")


# LiteLLM loads this instance via callbacks config
audio_guardrail_instance = AudioGuardrailHook()
