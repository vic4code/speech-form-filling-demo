"""Guardrail service — audio streaming + text pattern checks.

Based on: https://github.com/DScathay/voice-guardrails (realtime + asr branches)

Mode 1 (pre_check):
  - Input:  Streaming audio → external guardrail WS (raw PCM16 binary, 16kHz)
  - Output: Text pattern check on agent transcript

Mode 2 (post_check):
  - Input:  Text pattern check on user transcript
  - Output: Text pattern check on agent transcript

Audio guardrail WS protocol (from voice-guardrails/realtime branch):
  → send: raw PCM16 binary bytes (16kHz mono)
  ← recv: {"event": "guardrail_result", "status": "SAFE"|"UNSAFE", "process_time_sec": ...}
"""

from __future__ import annotations

import base64
import json
import os
import re
import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

import numpy as np
import websockets


# ── Lazy env readers ──────────────────────────────────────────────────────────

def _env(key: str, default: str = "") -> str:
    return os.getenv(key, default)


@dataclass
class GuardrailResult:
    passed: bool
    check_type: str  # "input_audio" | "input_text" | "output_text"
    message: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


def is_configured() -> bool:
    return bool(_env("GUARDRAIL_WS_URL") or _env("GUARDRAIL_BLOCK_KEYWORDS"))


# ── Audio guardrail: persistent streaming session ─────────────────────────────

SRC_RATE = 24000  # OpenAI Realtime native sample rate
TGT_RATE = 16000  # Guardrail server expected sample rate


def resample_pcm16(pcm16_bytes: bytes, src_rate: int = SRC_RATE, tgt_rate: int = TGT_RATE) -> bytes:
    """Resample PCM16 audio from src_rate to tgt_rate via linear interpolation."""
    audio = np.frombuffer(pcm16_bytes, dtype=np.int16)
    if len(audio) == 0:
        return b""
    num_samples = int(len(audio) * tgt_rate / src_rate)
    resampled = np.interp(
        np.linspace(0, len(audio), num_samples, endpoint=False),
        np.arange(len(audio)),
        audio,
    ).astype(np.int16)
    return resampled.tobytes()


class AudioGuardrailSession:
    """Manages a persistent WS connection to the guardrail server for streaming audio.

    Usage:
        session = AudioGuardrailSession(on_result=callback)
        await session.connect()
        # For each audio chunk from client:
        await session.send_audio(pcm16_base64, direction="input")
        # When done:
        await session.close()
    """

    def __init__(
        self,
        on_result: Callable[[GuardrailResult], Awaitable[None]] | None = None,
    ):
        self.on_result = on_result
        self._input_ws: websockets.WebSocketClientProtocol | None = None
        self._output_ws: websockets.WebSocketClientProtocol | None = None
        self._listen_tasks: list[asyncio.Task] = []
        self._closed = False

    async def connect(self) -> bool:
        """Connect to the guardrail WS server (dual streams for input + output)."""
        ws_url = _env("GUARDRAIL_WS_URL")
        api_key = _env("GUARDRAIL_API_KEY")
        if not ws_url:
            return False

        # Add API key as query param (voice-guardrails convention)
        separator = "&" if "?" in ws_url else "?"
        url_with_key = f"{ws_url}{separator}api_key={api_key}" if api_key else ws_url

        try:
            self._input_ws = await websockets.connect(url_with_key, open_timeout=10)
            self._output_ws = await websockets.connect(url_with_key, open_timeout=10)

            self._listen_tasks.append(
                asyncio.create_task(self._listen(self._input_ws, "input"))
            )
            self._listen_tasks.append(
                asyncio.create_task(self._listen(self._output_ws, "output"))
            )
            return True
        except Exception as exc:
            print(f"[guardrail] WS connect failed: {exc}")
            return False

    async def send_audio(self, pcm16_base64: str, direction: str = "input") -> None:
        """Send a chunk of PCM16 audio (base64, 24kHz) to the guardrail server."""
        ws = self._input_ws if direction == "input" else self._output_ws
        if not ws or self._closed:
            return
        try:
            raw_bytes = base64.b64decode(pcm16_base64)
            resampled = resample_pcm16(raw_bytes)
            await ws.send(resampled)  # Send as binary
        except Exception:
            pass  # Don't block audio pipeline on guardrail errors

    async def close(self) -> None:
        self._closed = True
        for task in self._listen_tasks:
            task.cancel()
        for ws in (self._input_ws, self._output_ws):
            if ws:
                try:
                    await ws.close()
                except Exception:
                    pass

    async def _listen(self, ws, direction: str) -> None:
        """Listen for guardrail results from the server."""
        check_type = f"{direction}_audio"
        try:
            async for msg in ws:
                try:
                    text = msg.decode("utf-8") if isinstance(msg, bytes) else msg
                    data = json.loads(text)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue

                if data.get("event") == "guardrail_result":
                    status = data.get("status", "SAFE")
                    process_time = data.get("process_time_sec", 0)
                    dir_label = "輸入" if direction == "input" else "輸出"

                    if status == "UNSAFE":
                        result = GuardrailResult(
                            passed=False,
                            check_type=check_type,
                            message=f"{dir_label}音訊不安全 (偵測耗時 {process_time:.2f}s)",
                            detail=data,
                        )
                    else:
                        result = GuardrailResult(
                            passed=True,
                            check_type=check_type,
                            message=f"{dir_label}音訊安全 ({process_time:.2f}s)",
                            detail=data,
                        )

                    if self.on_result:
                        await self.on_result(result)

        except (websockets.ConnectionClosed, asyncio.CancelledError):
            pass
        except Exception as exc:
            print(f"[guardrail] listen error ({direction}): {exc}")


# ── Text guardrail: pattern-based check ───────────────────────────────────────

async def check_text(
    text: str,
    direction: str = "input",
) -> GuardrailResult:
    """Run text guardrail (local pattern check, always available)."""
    check_type = f"{direction}_text"

    if not text or not text.strip():
        return GuardrailResult(passed=True, check_type=check_type, message="空白內容，跳過")

    return _check_text_patterns(text, check_type)


# ── Prompt injection patterns ─────────────────────────────────────────────────

_INJECTION_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts|rules)", re.I),
     "Prompt injection: ignore previous instructions"),
    (re.compile(r"(disregard|forget|override)\s+(your|the|all)\s+(instructions|rules|prompt|system)", re.I),
     "Prompt injection: override system prompt"),
    (re.compile(r"you\s+are\s+now\s+(a|an|the)\s+", re.I),
     "Prompt injection: role reassignment"),
    (re.compile(r"(pretend|act\s+as\s+if)\s+you\s+(are|were|have)", re.I),
     "Prompt injection: persona hijack"),
    (re.compile(r"(system\s*prompt|系統\s*提示|系統\s*指令)", re.I),
     "Prompt injection: 嘗試取得系統提示"),
    (re.compile(r"忽略.{0,10}(指令|規則|提示|設定)", re.I),
     "Prompt injection: 忽略指令"),
    (re.compile(r"(不要|別|不用).{0,6}(遵守|遵從|按照).{0,6}(規則|指令|設定)", re.I),
     "Prompt injection: 要求不遵守規則"),
    (re.compile(r"(假裝|扮演|你現在是).{0,10}(不是|另一個|新的|不受限|無限制)", re.I),
     "Prompt injection: 角色劫持"),
    (re.compile(r"(不受限|無限制|DAN|jailbreak|越獄)", re.I),
     "Prompt injection: 越獄嘗試"),
]

_EXFIL_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(api.?key|密鑰|金鑰|secret|token|password|密碼)", re.I),
     "資料外洩: 嘗試取得 API key / 密碼"),
    (re.compile(r"(其他|別人|所有).{0,6}(使用者|用戶|員工).{0,6}(資料|資訊|表單)", re.I),
     "資料外洩: 嘗試取得他人資料"),
    (re.compile(r"(列出|顯示|告訴我).{0,10}(所有|全部).{0,6}(資料|紀錄|記錄)", re.I),
     "資料外洩: 嘗試批量取得資料"),
]

_ABUSE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(幹你|操你|去死|白癡|智障|廢物)", re.I),
     "不當言論: 辱罵性內容"),
    (re.compile(r"(fuck\s*you|shit|damn\s*you|kill\s*yourself)", re.I),
     "Abuse: profanity / threats"),
    (re.compile(r"(how\s+to\s+)?(hack|exploit|crack|inject|attack)", re.I),
     "安全威脅: 嘗試攻擊性操作"),
    (re.compile(r"(SQL|XSS|CSRF|<script|DROP\s+TABLE|1=1|UNION\s+SELECT)", re.I),
     "安全威脅: 程式碼注入攻擊"),
]

_FRAUD_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(虛報|假的|捏造|偽造).{0,6}(費用|金額|車資|發票|收據)", re.I),
     "報銷詐欺: 嘗試虛報費用"),
    (re.compile(r"(幫我|可以).{0,6}(多報|灌水|加大|增加).{0,6}(金額|費用|車資)", re.I),
     "報銷詐欺: 嘗試灌水金額"),
    (re.compile(r"(不要|別).{0,6}(留下|記錄|紀錄).{0,6}(痕跡|紀錄|記錄|證據)", re.I),
     "報銷詐欺: 嘗試隱匿紀錄"),
]


def _check_text_patterns(text: str, check_type: str) -> GuardrailResult:
    """Pattern-based text guardrail (no external service needed)."""
    all_patterns = _INJECTION_PATTERNS + _EXFIL_PATTERNS + _ABUSE_PATTERNS + _FRAUD_PATTERNS
    for pattern, reason in all_patterns:
        if pattern.search(text):
            return GuardrailResult(
                passed=False, check_type=check_type,
                message=f"[BLOCKED] {reason}",
            )

    # Custom keyword blocklist
    raw = _env("GUARDRAIL_BLOCK_KEYWORDS")
    if raw:
        keywords = [kw.strip() for kw in raw.split(",") if kw.strip()]
        text_lower = text.lower()
        for kw in keywords:
            if kw.lower() in text_lower:
                return GuardrailResult(
                    passed=False, check_type=check_type,
                    message=f"[BLOCKED] 包含敏感關鍵字: {kw}",
                )

    return GuardrailResult(passed=True, check_type=check_type, message="文字檢查通過")
