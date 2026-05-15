"""
BYOK (Bring Your Own Key) support for Chrome Extension

This module handles user-provided API keys and proxies requests through
LiteLLM with guardrail checking.
"""
from __future__ import annotations

import json
import asyncio
from typing import Any

import websockets
from fastapi import WebSocket, HTTPException
from pydantic import BaseModel

from app.guardrails import check_text_local


class BYOKWebSocketProxy:
    """
    Proxy WebSocket connection that:
    1. Accepts user's API key from Chrome Extension
    2. Applies guardrail checks on input/output
    3. Forwards to LiteLLM with user's key
    4. Logs all activity
    """

    def __init__(
        self,
        client_ws: WebSocket,
        user_api_key: str,
        litellm_url: str,
        guardrail_enabled: bool = True,
        pricing: dict[str, float] | None = None,
    ):
        self.client_ws = client_ws
        self.user_api_key = user_api_key
        self.litellm_url = litellm_url
        self.guardrail_enabled = guardrail_enabled
        self.backend_ws = None
        self._response_active = False
        self._manual_response_mode = False
        self._output_buffer = ""
        self._output_blocked = False
        self._pricing = pricing or {}
        self._total_input_tokens = 0
        self._total_output_tokens = 0
        self._total_audio_input_tokens = 0
        self._total_audio_output_tokens = 0

    async def connect_to_backend(self):
        """Connect to LiteLLM proxy with user's API key"""
        # Add user's API key as Authorization header
        headers = {
            "Authorization": f"Bearer {self.user_api_key}"
        }
        self.backend_ws = await websockets.connect(
            self.litellm_url,
            additional_headers=headers,
        )

    async def forward_client_to_backend(self):
        """Forward messages from client to backend with guardrail"""
        try:
            while True:
                message = await self.client_ws.receive_text()
                data = json.loads(message)

                if self.guardrail_enabled:
                    self._force_manual_response_after_guardrail(data)

                # Apply input guardrail for text messages.
                if self.guardrail_enabled:
                    blocked, reason, snippet = await self._check_input_guardrail(data)
                    if blocked:
                        print(f"[BYOK guardrail] INPUT BLOCKED: {reason} text={snippet!r}")
                        await self.client_ws.send_json({
                            "type": "guardrail_chat",
                            "passed": False,
                            "side": "input",
                            "snippet": snippet,
                            "reason": reason,
                        })
                        continue

                # Forward to backend
                await self.backend_ws.send(message)

        except Exception as e:
            print(f"Error in forward_client_to_backend: {e}")
            await self._close_backend()

    async def forward_backend_to_client(self):
        """Forward messages from backend to client with guardrail"""
        try:
            while True:
                message = await self.backend_ws.recv()
                data = json.loads(message)
                event_type = data.get("type", "")

                if event_type == "response.created":
                    self._response_active = True
                    self._output_buffer = ""
                    self._output_blocked = False
                elif event_type in ("response.done", "response.cancelled"):
                    self._response_active = False
                elif self._output_blocked and event_type.startswith("response."):
                    continue

                if event_type == "response.done":
                    await self._emit_cost_update(data)

                if self.guardrail_enabled:
                    blocked, reason, snippet = await self._check_backend_guardrail(data)
                    if blocked:
                        print(f"[BYOK guardrail] BLOCKED: {reason} text={snippet!r}")
                        if self._response_active:
                            await self.backend_ws.send(json.dumps({"type": "response.cancel"}))
                        await self.client_ws.send_json({"type": "playback_stop"})
                        await self.client_ws.send_json({
                            "type": "guardrail_chat",
                            "passed": False,
                            "side": "output" if event_type.startswith("response.") else "input",
                            "snippet": snippet,
                            "reason": reason,
                        })
                        continue
                    if (
                        event_type == "conversation.item.input_audio_transcription.completed"
                        and self._manual_response_mode
                    ):
                        await self.client_ws.send_json({
                            "type": "guardrail_chat",
                            "passed": True,
                            "side": "input",
                        })
                        await self.backend_ws.send(json.dumps({"type": "response.create"}))

                # Forward to client
                await self.client_ws.send_text(message)

        except Exception as e:
            print(f"Error in forward_backend_to_client: {e}")
            await self._close_backend()

    def _force_manual_response_after_guardrail(self, data: dict) -> None:
        """Disable Realtime auto-response so audio transcripts can be checked first."""
        if data.get("type") != "session.update":
            return
        session = data.setdefault("session", {})
        # The current GA Realtime schema rejects top-level session.voice.
        # Strip it defensively; GA clients should use audio.output.voice instead.
        session.pop("voice", None)
        manual_mode = False

        turn_detection = session.get("turn_detection")
        if isinstance(turn_detection, dict) and turn_detection.get("type") == "server_vad":
            turn_detection["create_response"] = False
            manual_mode = True

        audio_input = ((session.get("audio") or {}).get("input") or {})
        nested_turn_detection = audio_input.get("turn_detection")
        if (
            isinstance(nested_turn_detection, dict)
            and nested_turn_detection.get("type") == "server_vad"
        ):
            nested_turn_detection["create_response"] = False
            manual_mode = True

        if manual_mode:
            self._manual_response_mode = True

    async def _check_input_guardrail(self, data: dict) -> tuple[bool, str, str]:
        """
        Check if input should be blocked
        Returns True if blocked
        """
        # Check user input text
        if data.get("type") == "input_audio_buffer.append":
            # For audio, we can't check until it's transcribed
            return False, "", ""

        if data.get("type") == "conversation.item.create":
            item = data.get("item", {})
            for content in item.get("content", []):
                if content.get("type") == "input_text":
                    text = content.get("text", "")
                    passed, reason = check_text_local(text)
                    if not passed:
                        return True, reason, text[:160]

        return False, "", ""

    def _current_meta(self) -> dict[str, Any]:
        text_cost = (
            (self._total_input_tokens / 1000) * self._pricing.get("text_input_per_1k", 0)
            + (self._total_output_tokens / 1000) * self._pricing.get("text_output_per_1k", 0)
        )
        audio_cost = (
            (self._total_audio_input_tokens / 1000) * self._pricing.get("audio_input_per_1k", 0)
            + (self._total_audio_output_tokens / 1000) * self._pricing.get("audio_output_per_1k", 0)
        )
        return {
            "inputTokens": self._total_input_tokens,
            "outputTokens": self._total_output_tokens,
            "totalTokens": self._total_input_tokens + self._total_output_tokens,
            "audioInputTokens": self._total_audio_input_tokens,
            "audioOutputTokens": self._total_audio_output_tokens,
            "cost": round(text_cost + audio_cost, 6),
        }

    async def _emit_cost_update(self, data: dict) -> None:
        response = data.get("response") or {}
        usage = response.get("usage") or {}
        self._total_input_tokens += usage.get("input_tokens", 0) or 0
        self._total_output_tokens += usage.get("output_tokens", 0) or 0
        in_det = usage.get("input_token_details") or {}
        out_det = usage.get("output_token_details") or {}
        self._total_audio_input_tokens += in_det.get("audio_tokens", 0) or 0
        self._total_audio_output_tokens += out_det.get("audio_tokens", 0) or 0
        await self.client_ws.send_json({
            "type": "cost_update",
            "meta": self._current_meta(),
        })

    async def _check_backend_guardrail(self, data: dict) -> tuple[bool, str, str]:
        """
        Check if output should be blocked
        Returns True if blocked
        """
        event_type = data.get("type", "")

        if event_type == "conversation.item.input_audio_transcription.completed":
            transcript = data.get("transcript") or data.get("text") or ""
            passed, reason = check_text_local(transcript)
            if not passed:
                return True, reason, transcript[:160]

        if event_type in (
            "response.audio_transcript.delta",
            "response.text.delta",
            "response.output_text.delta",
        ):
            self._output_buffer += data.get("delta", "")
            passed, reason = check_text_local(self._output_buffer)
            if not passed:
                self._output_blocked = True
                return True, reason, self._output_buffer[:160]

        return False, "", ""

    async def run(self):
        """Run the proxy"""
        await self.connect_to_backend()

        tasks = [
            asyncio.create_task(self.forward_client_to_backend()),
            asyncio.create_task(self.forward_backend_to_client()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            task.result()
        await self._close_backend()

    async def _close_backend(self) -> None:
        if self.backend_ws:
            try:
                await self.backend_ws.close()
            except Exception:
                pass


class WhisperBYOKRequest(BaseModel):
    """Request model for Whisper API with BYOK"""
    api_key: str
    audio_base64: str
    model: str = "whisper-1"
    language: str = "zh"
    guardrail_enabled: bool = True


async def transcribe_with_byok(request: WhisperBYOKRequest) -> dict[str, Any]:
    """
    Transcribe audio using user's API key with guardrail
    """
    import base64
    from openai import AsyncOpenAI

    # Create OpenAI client with user's key
    client = AsyncOpenAI(api_key=request.api_key)

    # Decode audio
    audio_bytes = base64.b64decode(request.audio_base64)

    try:
        # Call Whisper API
        response = await client.audio.transcriptions.create(
            model=request.model,
            file=("audio.webm", audio_bytes, "audio/webm"),
            language=request.language,
            response_format="json"
        )

        transcript = response.text.strip()

        # Apply guardrail
        if request.guardrail_enabled:
            passed, reason = check_text_local(transcript)
            if not passed:
                raise HTTPException(
                    status_code=400,
                    detail=f"Transcription blocked by guardrail: {reason}"
                )

        return {
            "text": transcript,
            "blocked": False
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )
