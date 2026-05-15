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
        guardrail_enabled: bool = True
    ):
        self.client_ws = client_ws
        self.user_api_key = user_api_key
        self.litellm_url = litellm_url
        self.guardrail_enabled = guardrail_enabled
        self.backend_ws = None

    async def connect_to_backend(self):
        """Connect to LiteLLM proxy with user's API key"""
        # Add user's API key as Authorization header
        headers = {
            "Authorization": f"Bearer {self.user_api_key}"
        }
        self.backend_ws = await websockets.connect(
            self.litellm_url,
            extra_headers=headers
        )

    async def forward_client_to_backend(self):
        """Forward messages from client to backend with guardrail"""
        try:
            while True:
                message = await self.client_ws.receive_text()
                data = json.loads(message)

                # Apply input guardrail
                if self.guardrail_enabled:
                    if await self._check_input_guardrail(data):
                        # Blocked by guardrail
                        await self.client_ws.send_json({
                            "type": "error",
                            "error": "Input blocked by guardrail"
                        })
                        continue

                # Forward to backend
                await self.backend_ws.send(message)

        except Exception as e:
            print(f"Error in forward_client_to_backend: {e}")

    async def forward_backend_to_client(self):
        """Forward messages from backend to client with guardrail"""
        try:
            while True:
                message = await self.backend_ws.recv()
                data = json.loads(message)

                # Apply output guardrail
                if self.guardrail_enabled:
                    if await self._check_output_guardrail(data):
                        # Blocked by guardrail - cancel response
                        await self.backend_ws.send(json.dumps({
                            "type": "response.cancel"
                        }))
                        await self.client_ws.send_json({
                            "type": "error",
                            "error": "Output blocked by guardrail"
                        })
                        continue

                # Forward to client
                await self.client_ws.send_text(message)

        except Exception as e:
            print(f"Error in forward_backend_to_client: {e}")

    async def _check_input_guardrail(self, data: dict) -> bool:
        """
        Check if input should be blocked
        Returns True if blocked
        """
        # Check user input text
        if data.get("type") == "input_audio_buffer.append":
            # For audio, we can't check until it's transcribed
            return False

        if data.get("type") == "conversation.item.create":
            item = data.get("item", {})
            for content in item.get("content", []):
                if content.get("type") == "input_text":
                    text = content.get("text", "")
                    if check_text_local(text):
                        return True

        return False

    async def _check_output_guardrail(self, data: dict) -> bool:
        """
        Check if output should be blocked
        Returns True if blocked
        """
        # Check assistant output
        if data.get("type") == "response.audio_transcript.delta":
            transcript = data.get("delta", "")
            if check_text_local(transcript):
                return True

        if data.get("type") == "response.text.delta":
            text = data.get("delta", "")
            if check_text_local(text):
                return True

        return False

    async def run(self):
        """Run the proxy"""
        await self.connect_to_backend()

        # Run both directions concurrently
        await asyncio.gather(
            self.forward_client_to_backend(),
            self.forward_backend_to_client()
        )


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
        if request.guardrail_enabled and check_text_local(transcript):
            raise HTTPException(
                status_code=400,
                detail="Transcription blocked by guardrail"
            )

        return {
            "text": transcript,
            "blocked": False
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )
