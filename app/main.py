from __future__ import annotations

import json
import os
import sqlite3
import asyncio
import base64
import time

from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketDisconnect
from dotenv import load_dotenv
from openai import APIError, AsyncOpenAI
import websockets

from app.guardrails import check_text_local
from app.browser import open_form_page
from app.forms import get_skill, has_skill, list_skills
from app.profile import get_current_profile


load_dotenv()

# ── Realtime model definitions with official pricing (per 1K tokens) ──
# Source: https://platform.openai.com/docs/pricing (March 2025)
REALTIME_MODELS: dict[str, dict] = {
    "gpt-realtime-2": {
        "label": "GPT Realtime 2",
        "text_input_per_1k": 0.004,       # $4.00 / 1M
        "text_output_per_1k": 0.024,      # $24.00 / 1M
        "audio_input_per_1k": 0.032,      # $32.00 / 1M
        "audio_output_per_1k": 0.064,     # $64.00 / 1M
    },
    "gpt-4o-realtime-preview-2024-12-17": {
        "label": "GPT-4o Realtime (2024-12-17)",
        "text_input_per_1k": 0.0055,      # $5.50 / 1M
        "text_output_per_1k": 0.022,       # $22.00 / 1M
        "audio_input_per_1k": 0.044,       # $44.00 / 1M
        "audio_output_per_1k": 0.08,       # $80.00 / 1M
    },
    "gpt-4o-realtime-preview-2024-10-01": {
        "label": "GPT-4o Realtime (2024-10-01)",
        "text_input_per_1k": 0.0055,       # $5.50 / 1M
        "text_output_per_1k": 0.022,       # $22.00 / 1M
        "audio_input_per_1k": 0.11,        # $110.00 / 1M
        "audio_output_per_1k": 0.22,       # $220.00 / 1M
    },
    "gpt-4o-mini-realtime-preview-2024-12-17": {
        "label": "GPT-4o Mini Realtime (2024-12-17)",
        "text_input_per_1k": 0.00066,      # $0.66 / 1M
        "text_output_per_1k": 0.00264,     # $2.64 / 1M
        "audio_input_per_1k": 0.011,       # $11.00 / 1M
        "audio_output_per_1k": 0.022,      # $22.00 / 1M
    },
}

DEFAULT_REALTIME_MODEL = os.getenv(
    "OPENAI_REALTIME_MODEL", "gpt-realtime-2"
)


def _get_model_pricing(model: str) -> dict:
    return REALTIME_MODELS.get(model, REALTIME_MODELS[DEFAULT_REALTIME_MODEL])


def _realtime_url(model: str) -> str:
    """Build the LiteLLM proxy Realtime WebSocket URL for a given model."""
    base = os.getenv("LITELLM_PROXY_URL", "ws://localhost:4000")
    return f"{base}/v1/realtime?model=openai/{model}"


LITELLM_MASTER_KEY = os.getenv("LITELLM_MASTER_KEY", "")


# Derive legacy cost constants from default model for backward compat
_default_pricing = _get_model_pricing(DEFAULT_REALTIME_MODEL)
COST_PER_1K_INPUT = _default_pricing["text_input_per_1k"]
COST_PER_1K_OUTPUT = _default_pricing["text_output_per_1k"]
AUDIO_COST_PER_1K_INPUT = _default_pricing["audio_input_per_1k"]
AUDIO_COST_PER_1K_OUTPUT = _default_pricing["audio_output_per_1k"]


# OpenAI API key is now managed by LiteLLM proxy (config.yaml)
OPENAI_TRANSCRIBE_MODEL = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
OPENAI_BATCH_STRUCTURING_MODEL = os.getenv("OPENAI_BATCH_STRUCTURING_MODEL", "gpt-4.1")

BATCH_TRANSCRIPTION_MODELS = [
    {"id": "whisper-1", "label": "Whisper 1"},
    {"id": "gpt-4o-mini-transcribe", "label": "GPT-4o Mini Transcribe"},
    {"id": "gpt-4o-transcribe", "label": "GPT-4o Transcribe"},
]
BATCH_STRUCTURING_MODELS = [
    {"id": "gpt-4o-mini", "label": "GPT-4o Mini"},
    {"id": "gpt-4o", "label": "GPT-4o"},
    {"id": "gpt-4.1-mini", "label": "GPT-4.1 Mini"},
    {"id": "gpt-4.1", "label": "GPT-4.1"},
]
def normalize_transcribe_lang(raw: str) -> str:
    """Normalize locale-like tags to supported base language codes."""
    value = (raw or "").strip()
    if not value:
        return "zh"
    # Convert tags like zh-TW/zh-Hant to zh, en-US to en, etc.
    return value.split("-")[0].lower()


OPENAI_TRANSCRIBE_LANG = normalize_transcribe_lang(
    os.getenv("OPENAI_TRANSCRIBE_LANG", "zh")
)
OPENAI_TRANSCRIBE_PROMPT = os.getenv("OPENAI_TRANSCRIBE_PROMPT", "").strip()


def _is_prompt_leak(transcript: str) -> bool:
    """Detect if gpt-4o-transcribe echoed the prompt back as a transcript."""
    if not OPENAI_TRANSCRIBE_PROMPT or not transcript:
        return False
    t = transcript.strip().replace(" ", "")
    p = OPENAI_TRANSCRIBE_PROMPT.strip().replace(" ", "")
    if len(t) < 5:
        return False
    # Only exact match (user transcript IS the prompt verbatim)
    return t == p




class TokenUsage(BaseModel):
    input: int = 0
    output: int = 0

    @property
    def total(self) -> int:
        return self.input + self.output


class RequestMeta(BaseModel):
    inputTokens: int | None = None
    outputTokens: int | None = None
    totalTokens: int | None = None
    cost: float | None = None
    audioInputTokens: int | None = None
    audioOutputTokens: int | None = None
    timestamps: dict[str, Any] | None = None


class RequestPayload(BaseModel):
    mode: str = Field(..., pattern="^(stt|conversation)$")
    payload: dict[str, Any]
    meta: RequestMeta | None = None
    connId: str | None = None
    guardrailMode: str | None = None  # "keyword" | None


class RequestRecord(BaseModel):
    id: str
    mode: str
    payload: dict[str, Any]
    tokenUsage: TokenUsage
    cost: float
    processingMs: int
    userDurationMs: int
    audioInputTokens: int
    audioOutputTokens: int
    guardrailMode: str | None = None
    createdAt: str


class ClientError(BaseModel):
    source: str
    message: str
    detail: dict[str, Any] | None = None


class BatchFormPreparePayload(BaseModel):
    form: str
    audioBase64: str
    mimeType: str = "audio/webm"
    guardrailMode: str | None = None
    transcribeModel: str | None = None
    structureModel: str | None = None


class BatchFormPatchPayload(BaseModel):
    form: str
    currentPayload: dict[str, Any]
    audioBase64: str | None = None
    correctionText: str | None = None
    mimeType: str = "audio/webm"
    guardrailMode: str | None = None
    transcribeModel: str | None = None
    structureModel: str | None = None


class BatchFormPrepareResponse(BaseModel):
    transcript: str
    payload: dict[str, Any] | None = None
    reviewText: str | None = None
    ready: bool
    errors: list[str] = Field(default_factory=list)
    meta: RequestMeta | None = None


class BatchFormFillPayload(BaseModel):
    form: str
    payload: dict[str, Any]
    meta: RequestMeta | None = None
    guardrailMode: str | None = None


@dataclass(frozen=True)
class DecodedAudio:
    bytes: bytes
    mime_type: str
    filename: str


def decode_audio_payload(audio_base64: str, mime_type: str) -> DecodedAudio:
    """Decode a browser MediaRecorder payload into bytes for Audio API upload."""
    raw_mime = (mime_type or "audio/webm").split(";")[0].strip() or "audio/webm"
    payload = audio_base64.strip()
    if payload.startswith("data:"):
        header, _, payload = payload.partition(",")
        if ";base64" not in header:
            raise ValueError("錄音資料格式不是 base64 data URL")
        raw_mime = header.removeprefix("data:").split(";")[0] or raw_mime
    try:
        audio_bytes = base64.b64decode(payload, validate=True)
    except ValueError as exc:
        raise ValueError("錄音資料 base64 解碼失敗") from exc
    if not audio_bytes:
        raise ValueError("錄音內容是空的")
    ext_by_mime = {
        "audio/webm": "webm",
        "audio/mp4": "mp4",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/m4a": "m4a",
    }
    ext = ext_by_mime.get(raw_mime, "webm")
    return DecodedAudio(audio_bytes, raw_mime, f"recording.{ext}")


def format_form_review(payload: dict[str, Any]) -> str:
    """Render structured payload as a compact human-readable review block."""
    def render_value(value: Any, indent: int = 0) -> list[str]:
        prefix = "  " * indent
        if isinstance(value, dict):
            lines: list[str] = []
            for key, inner in value.items():
                if isinstance(inner, (dict, list)):
                    lines.append(f"{prefix}{key}:")
                    lines.extend(render_value(inner, indent + 1))
                else:
                    lines.append(f"{prefix}{key}: {inner}")
            return lines
        if isinstance(value, list):
            lines = []
            for item in value:
                if isinstance(item, dict):
                    first = True
                    for key, inner in item.items():
                        marker = "- " if first else "  "
                        if isinstance(inner, (dict, list)):
                            lines.append(f"{prefix}{marker}{key}:")
                            lines.extend(render_value(inner, indent + 2))
                        else:
                            lines.append(f"{prefix}{marker}{key}: {inner}")
                        first = False
                else:
                    lines.append(f"{prefix}- {item}")
            return lines
        return [f"{prefix}{value}"]

    return "\n".join(render_value(payload))


def openai_audio_error_message(exc: Exception) -> str:
    raw = str(getattr(exc, "message", "") or exc)
    lowered = raw.lower()
    if "corrupted or unsupported" in lowered or "unsupported" in lowered:
        return "錄音格式不支援、內容太短，或瀏覽器產生的音檔無法辨識。請錄 2 秒以上後再停止。"
    if "maximum content size" in lowered or "too large" in lowered:
        return "錄音檔太大，請縮短錄音後再試。"
    return f"語音轉譯失敗：{raw}"


def format_validation_errors(exc: Exception, labels: dict[str, str] | None = None) -> list[str]:
    if not hasattr(exc, "errors"):
        return [str(exc)]
    messages: list[str] = []
    for err in exc.errors():
        loc = err.get("loc", ())
        top_field = str(loc[0]) if loc else ""
        label = (labels or {}).get(top_field) or top_field
        err_type = err.get("type", "")
        value = err.get("input")
        if err_type == "missing":
            messages.append(f"請填寫「{label}」")
        elif err_type == "string_too_short" and value == "":
            messages.append(f"請填寫「{label}」")
        elif err_type == "string_too_short":
            messages.append(f"「{label}」說得太簡短，請提供更多細節")
        elif err_type == "list_too_short":
            messages.append(f"「{label}」至少需要一筆資料")
        else:
            messages.append(f"「{label}」格式有誤，請重新說明")
    return messages or [str(exc)]


app = FastAPI(title="Speech Form Filling Demo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

REQUESTS: list[RequestRecord] = []
DB_PATH = Path(os.getenv("REQUESTS_DB_PATH", "app/requests.db"))


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                token_usage_json TEXT NOT NULL,
                cost REAL NOT NULL,
                processing_ms INTEGER NOT NULL,
                user_duration_ms INTEGER NOT NULL,
                audio_input_tokens INTEGER NOT NULL,
                audio_output_tokens INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(requests)").fetchall()
        }
        if "processing_ms" not in columns:
            conn.execute("ALTER TABLE requests ADD COLUMN processing_ms INTEGER NOT NULL DEFAULT 0")
        if "user_duration_ms" not in columns:
            conn.execute("ALTER TABLE requests ADD COLUMN user_duration_ms INTEGER NOT NULL DEFAULT 0")
        if "audio_input_tokens" not in columns:
            conn.execute("ALTER TABLE requests ADD COLUMN audio_input_tokens INTEGER NOT NULL DEFAULT 0")
        if "audio_output_tokens" not in columns:
            conn.execute("ALTER TABLE requests ADD COLUMN audio_output_tokens INTEGER NOT NULL DEFAULT 0")
        if "conn_id" not in columns:
            conn.execute("ALTER TABLE requests ADD COLUMN conn_id TEXT")
        if "guardrail_mode" not in columns:
            conn.execute("ALTER TABLE requests ADD COLUMN guardrail_mode TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_requests_conn ON requests (conn_id)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ws_events (
                id TEXT PRIMARY KEY,
                conn_id TEXT NOT NULL,
                session_id TEXT,
                endpoint TEXT NOT NULL,
                direction TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ws_events_conn ON ws_events (conn_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ws_events_ts ON ws_events (created_at)"
        )


def row_to_record(row: sqlite3.Row) -> RequestRecord:
    return RequestRecord(
        id=row["id"],
        mode=row["mode"],
        payload=json.loads(row["payload_json"]),
        tokenUsage=TokenUsage(**json.loads(row["token_usage_json"])),
        cost=row["cost"],
        processingMs=row["processing_ms"],
        userDurationMs=row["user_duration_ms"],
        audioInputTokens=row["audio_input_tokens"],
        audioOutputTokens=row["audio_output_tokens"],
        createdAt=row["created_at"],
    )


def estimate_tokens(payload: dict[str, Any]) -> TokenUsage:
    serialized = json.dumps(payload, ensure_ascii=False)
    input_tokens = max(1, len(serialized) // 4)
    output_tokens = max(1, input_tokens // 2)
    return TokenUsage(input=input_tokens, output=output_tokens)


def estimate_cost(tokens: TokenUsage) -> float:
    return round(
        (tokens.input / 1000) * COST_PER_1K_INPUT
        + (tokens.output / 1000) * COST_PER_1K_OUTPUT,
        6,
    )


def estimate_audio_cost(audio_input_tokens: int, audio_output_tokens: int) -> float:
    return round(
        (audio_input_tokens / 1000) * AUDIO_COST_PER_1K_INPUT
        + (audio_output_tokens / 1000) * AUDIO_COST_PER_1K_OUTPUT,
        6,
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_STREAM_EVENTS = frozenset({
    "response.audio.delta",
    "response.text.delta",
    "response.output_text.delta",
    "conversation.item.input_audio_transcription.delta",
    "response.audio_transcript.delta",
    "response.function_call_arguments.delta",
})


class RealtimeTurnLogger:
    """State mirror for OpenAI Realtime API events — logs, persists, and summarises."""

    def __init__(self, endpoint: str) -> None:
        self.ep = endpoint
        self.conn_id = str(uuid4())
        self.openai_session_id: str | None = None
        self._speech_start: float | None = None
        self._user_transcript: str = ""
        self._response_id: str | None = None
        self._response_text: str = ""
        self._response_audio_tr: str = ""
        self._response_start: float | None = None

    def _log(self, msg: str) -> None:
        print(f"[{self.ep}] {msg}")

    def log_out(self, payload: dict) -> None:
        """Print outbound event to stdout and persist to DB."""
        t = payload.get("type", "")
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        if t == "input_audio_buffer.append":
            chars = len(payload.get("audio", ""))
            print(f"[{self.ep}] {ts} →OAI  {t}  ({chars} b64 chars)")
            payload_json = None
        else:
            payload_str = json.dumps(payload, ensure_ascii=False, indent=2)
            print(f"[{self.ep}] {ts} →OAI  {payload_str}")
            payload_json = json.dumps(payload, ensure_ascii=False)
        self._persist("out", t, payload_json)

    def log_in(self, event: dict) -> None:
        """Print inbound event to stdout and persist to DB."""
        t = event.get("type", "")
        if t in ("session.created", "session.updated") and not self.openai_session_id:
            self.openai_session_id = (event.get("session") or {}).get("id")
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        if t in _STREAM_EVENTS:
            delta = event.get("delta", "")
            print(f"[{self.ep}] {ts} ←OAI  {t}  ({len(delta)} chars)")
            payload_json = None
        else:
            payload_str = json.dumps(event, ensure_ascii=False, indent=2)
            print(f"[{self.ep}] {ts} ←OAI  {payload_str}")
            payload_json = json.dumps(event, ensure_ascii=False)
        self._persist("in", t, payload_json)

    def _persist(self, direction: str, event_type: str, payload_json: str | None) -> None:
        if payload_json is None:
            return
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO ws_events VALUES (?,?,?,?,?,?,?,?)",
                (
                    str(uuid4()),
                    self.conn_id,
                    self.openai_session_id,
                    self.ep,
                    direction,
                    event_type,
                    payload_json,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )

    def on_event(self, event: dict) -> None:
        t = event.get("type", "")

        if t == "session.created":
            s = event.get("session", {})
            self._log(
                f"SESSION CREATED  id={s.get('id')}  model={s.get('model')}  "
                f"modalities={s.get('modalities')}  vad={s.get('turn_detection', {}).get('type')}"
            )
        elif t == "session.updated":
            s = event.get("session", {})
            self._log(
                f"SESSION UPDATED  tools={len(s.get('tools', []))}  "
                f"transcription_model={s.get('input_audio_transcription', {}).get('model')}"
            )
        elif t == "input_audio_buffer.speech_started":
            self._speech_start = time.monotonic()
            self._log("SPEECH START")
        elif t == "input_audio_buffer.speech_stopped":
            dur = f"  ({time.monotonic() - self._speech_start:.2f}s)" if self._speech_start else ""
            self._log(f"SPEECH STOP{dur}")
        elif t == "input_audio_buffer.committed":
            self._log(f"BUF COMMIT  item_id={event.get('item_id')}")
        elif t == "conversation.item.created":
            item = event.get("item", {})
            self._log(
                f"ITEM CREATED  id={item.get('id')}  role={item.get('role')}  type={item.get('type')}"
            )
        elif t == "conversation.item.input_audio_transcription.delta":
            self._user_transcript += event.get("delta", "")
        elif t == "conversation.item.input_audio_transcription.completed":
            tr = event.get("transcript", "")
            self._user_transcript = ""
            snippet = tr[:100] + ("…" if len(tr) > 100 else "")
            self._log(f'TRANSCRIPT  "{snippet}"')
        elif t == "response.created":
            r = event.get("response", {})
            self._response_id = r.get("id")
            self._response_text = ""
            self._response_audio_tr = ""
            self._response_start = time.monotonic()
            self._log(f"RESPONSE START  id={self._response_id}")
        elif t == "response.output_item.added":
            item = event.get("item", {})
            self._log(f"OUTPUT ITEM  type={item.get('type')}  role={item.get('role')}")
        elif t in ("response.text.delta", "response.output_text.delta"):
            self._response_text += event.get("delta", "")
        elif t == "response.audio_transcript.delta":
            self._response_audio_tr += event.get("delta", "")
        elif t == "response.audio_transcript.done":
            tr = event.get("transcript") or self._response_audio_tr
            self._log(f'AUDIO TRANSCRIPT  "{tr[:100]}{"…" if len(tr) > 100 else ""}"')
        elif t == "response.done":
            r = event.get("response", {})
            usage = r.get("usage") or {}
            dur = f"  {time.monotonic() - self._response_start:.2f}s" if self._response_start else ""
            text = self._response_text
            in_det = usage.get("input_token_details") or {}
            out_det = usage.get("output_token_details") or {}
            self._log(
                f"RESPONSE DONE  id={r.get('id')}  status={r.get('status')}{dur}\n"
                f"  tokens → in={usage.get('input_tokens')}"
                f" (audio={in_det.get('audio_tokens')})"
                f"  out={usage.get('output_tokens')}"
                f" (audio={out_det.get('audio_tokens')})\n"
                f'  text: "{text[:100]}{"…" if len(text) > 100 else ""}"'
            )
            self._response_id = None
            self._response_text = ""
        elif t == "rate_limits.updated":
            limits = {lim["name"]: lim.get("remaining") for lim in event.get("rate_limits", [])}
            self._log(f"RATE LIMITS  {limits}")


async def forward_debug_event(event: dict, safe_send) -> None:
    """Forward a lightweight runtime debug event to the frontend."""
    t = event.get("type", "")
    data: dict = {}
    if t == "conversation.item.input_audio_transcription.completed":
        tr = event.get("transcript", "")
        data = {"text": tr[:60] + ("…" if len(tr) > 60 else "")}
    elif t == "response.created":
        data = {"id": ((event.get("response") or {}).get("id") or "")[-8:]}
    elif t == "response.done":
        r = event.get("response") or {}
        usage = r.get("usage") or {}
        data = {"status": r.get("status", ""), "tokens": usage.get("output_tokens")}
    await safe_send({"type": "debug_event", "event_type": t, "data": data})


async def forward_session_event(
    event: dict, safe_send, endpoint: str, conn_id: str
) -> None:
    """Log session lifecycle events to stdout and forward to frontend."""
    event_type = event.get("type")
    session = event.get("session", {})
    print(
        f"[{endpoint}] {event_type}: id={session.get('id')} "
        f"model={session.get('model')} "
        f"modalities={session.get('modalities')} "
        f"tools={len(session.get('tools', []))} tool(s)"
    )
    await safe_send({
        "type": "session_event",
        "event_type": event_type,
        "conn_id": conn_id,
        "session": {
            "id": session.get("id"),
            "model": session.get("model"),
            "modalities": session.get("modalities"),
            "input_audio_format": session.get("input_audio_format"),
            "turn_detection": session.get("turn_detection"),
            "tools_count": len(session.get("tools", [])),
        },
    })


async def ws_send(ws, payload: dict, logger: RealtimeTurnLogger) -> None:
    """Log and send a client event to OpenAI."""
    logger.log_out(payload)
    await ws.send(json.dumps(payload))


@app.post("/api/requests", response_model=RequestRecord)
def create_request(payload: RequestPayload) -> RequestRecord:
    started_at = datetime.now(timezone.utc)
    if payload.mode == "stt":
        tokens = TokenUsage(input=0, output=0)
        cost = 0.0
    else:
        tokens = estimate_tokens(payload.payload)
        cost = estimate_cost(tokens)
    user_duration_ms = 0
    audio_input_tokens = 0
    audio_output_tokens = 0

    if payload.meta:
        if payload.meta.inputTokens is not None:
            tokens.input = payload.meta.inputTokens
        if payload.meta.outputTokens is not None:
            tokens.output = payload.meta.outputTokens
        if payload.meta.totalTokens is not None:
            tokens = TokenUsage(
                input=payload.meta.totalTokens - tokens.output,
                output=tokens.output,
            )
        if payload.meta.cost is not None:
            cost = payload.meta.cost
        if payload.meta.timestamps and "durationMs" in payload.meta.timestamps:
            try:
                user_duration_ms = int(payload.meta.timestamps["durationMs"])
            except (ValueError, TypeError):
                user_duration_ms = 0
        if payload.meta.audioInputTokens is not None:
            audio_input_tokens = payload.meta.audioInputTokens
        if payload.meta.audioOutputTokens is not None:
            audio_output_tokens = payload.meta.audioOutputTokens

    if audio_input_tokens or audio_output_tokens:
        cost = round(cost + estimate_audio_cost(audio_input_tokens, audio_output_tokens), 6)

    record = RequestRecord(
        id=str(uuid4()),
        mode=payload.mode,
        payload=payload.payload,
        tokenUsage=tokens,
        cost=cost,
        processingMs=int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000),
        userDurationMs=user_duration_ms,
        audioInputTokens=audio_input_tokens,
        audioOutputTokens=audio_output_tokens,
        guardrailMode=payload.guardrailMode,
        createdAt=now_iso(),
    )

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO requests (
                id, mode, payload_json, token_usage_json, cost, processing_ms,
                user_duration_ms, audio_input_tokens, audio_output_tokens, created_at,
                conn_id, guardrail_mode
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.mode,
                json.dumps(record.payload, ensure_ascii=False),
                json.dumps(record.tokenUsage.model_dump()),
                record.cost,
                record.processingMs,
                record.userDurationMs,
                record.audioInputTokens,
                record.audioOutputTokens,
                record.createdAt,
                payload.connId,
                payload.guardrailMode,
            ),
        )
    return record


@app.get("/api/requests", response_model=list[RequestRecord])
def list_requests() -> list[RequestRecord]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM requests ORDER BY created_at DESC"
        ).fetchall()
    return [row_to_record(row) for row in rows]


@app.get("/api/requests/{request_id}", response_model=RequestRecord)
def get_request(request_id: str) -> RequestRecord:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM requests WHERE id = ?",
            (request_id,),
        ).fetchone()
    if row:
        return row_to_record(row)
    raise HTTPException(status_code=404, detail="Request not found")


DEFAULT_FORM_ID = os.getenv("DEFAULT_FORM_ID", "taxi")


@app.get("/api/forms")
def api_list_forms() -> list[dict[str, Any]]:
    return [skill.public_meta() for skill in list_skills()]


def _json_schema_for_batch(skill) -> dict[str, Any]:
    schema = skill.payload_model.model_json_schema()
    schema.pop("title", None)
    return schema


async def transcribe_recording(
    audio: DecodedAudio,
    model: str | None = None,
    form_hint: str | None = None,
) -> str:
    client = AsyncOpenAI()
    prompt_parts: list[str] = []
    if OPENAI_TRANSCRIBE_PROMPT:
        prompt_parts.append(OPENAI_TRANSCRIBE_PROMPT)
    if form_hint:
        prompt_parts.append(form_hint)
    params: dict[str, Any] = {
        "model": model or OPENAI_TRANSCRIBE_MODEL,
        "file": (audio.filename, BytesIO(audio.bytes), audio.mime_type),
        "language": OPENAI_TRANSCRIBE_LANG,
        "response_format": "json",
    }
    if prompt_parts:
        params["prompt"] = " ".join(prompt_parts)
    result = await client.audio.transcriptions.create(**params)
    return (getattr(result, "text", "") or "").strip()


async def structure_transcript_for_form(
    form_id: str,
    transcript: str,
    profile_block: str,
    model: str | None = None,
) -> tuple[dict[str, Any], RequestMeta]:
    skill = get_skill(form_id)
    client = AsyncOpenAI()
    schema = _json_schema_for_batch(skill)
    today = datetime.now().date().isoformat()
    prompt = (
        "你是企業內部表單資料整理器。請把逐字稿整理成指定表單的 JSON payload。\n"
        "規則：\n"
        "1. 只輸出符合 JSON schema 的資料，不要輸出 markdown。\n"
        f"2. 日期若使用者用相對日期，請以今天 {today}（Asia/Taipei）推算為 YYYY-MM-DD。\n"
        "3. 若欄位可由使用者資料補上且逐字稿未指定，使用使用者資料；若使用者明確指定則以逐字稿為準。\n"
        "4. 不要捏造未提及且無法合理預設的必填資訊。\n\n"
        f"{profile_block}\n\n"
        f"表單：{skill.label}\n"
        f"表單說明：{skill.description}\n\n"
        f"表單填寫規則：\n{skill.instructions}\n\n"
        f"逐字稿：\n{transcript}"
    )
    completion = await client.chat.completions.create(
        model=model or OPENAI_BATCH_STRUCTURING_MODEL,
        messages=[
            {
                "role": "system",
                "content": "你會把口語內容轉成可送出表單的嚴格 JSON。",
            },
            {"role": "user", "content": prompt},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": f"{form_id}_payload",
                "schema": schema,
                "strict": False,
            },
        },
    )
    content = completion.choices[0].message.content or "{}"
    payload = json.loads(content)
    usage = completion.usage
    meta = RequestMeta()
    if usage:
        meta.inputTokens = usage.prompt_tokens
        meta.outputTokens = usage.completion_tokens
        meta.totalTokens = usage.total_tokens
    return payload, meta


async def patch_form_with_correction(
    form_id: str,
    current_payload: dict[str, Any],
    correction: str,
    model: str | None = None,
) -> tuple[dict[str, Any], RequestMeta]:
    skill = get_skill(form_id)
    client = AsyncOpenAI()
    schema = _json_schema_for_batch(skill)
    today = datetime.now().date().isoformat()
    prompt = (
        "你是企業內部表單資料整理器。使用者已填寫了表單草稿，現在提供了修改指示。\n"
        "請根據修改指示調整表單資料，其餘欄位保持不變。只輸出符合 JSON schema 的完整資料，不要輸出 markdown。\n\n"
        f"現有表單資料（JSON）：\n{json.dumps(current_payload, ensure_ascii=False, indent=2)}\n\n"
        f"使用者修改指示：\n{correction}\n\n"
        f"今天日期：{today}（Asia/Taipei）"
    )
    completion = await client.chat.completions.create(
        model=model or OPENAI_BATCH_STRUCTURING_MODEL,
        messages=[
            {"role": "system", "content": "你會把修改指示套用到表單草稿上，輸出完整更新後的嚴格 JSON。"},
            {"role": "user", "content": prompt},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": f"{form_id}_payload",
                "schema": schema,
                "strict": False,
            },
        },
    )
    content = completion.choices[0].message.content or "{}"
    payload = json.loads(content)
    usage = completion.usage
    meta = RequestMeta()
    if usage:
        meta.inputTokens = usage.prompt_tokens
        meta.outputTokens = usage.completion_tokens
        meta.totalTokens = usage.total_tokens
    return payload, meta


@app.post("/api/batch-form/prepare", response_model=BatchFormPrepareResponse)
async def prepare_batch_form(payload: BatchFormPreparePayload) -> BatchFormPrepareResponse:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=500, detail="缺少 OPENAI_API_KEY")
    if not has_skill(payload.form):
        raise HTTPException(status_code=404, detail=f"未知的表單代號：{payload.form}")

    started_at = datetime.now(timezone.utc)
    skill = get_skill(payload.form)
    profile = get_current_profile()
    try:
        audio = decode_audio_payload(payload.audioBase64, payload.mimeType)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if len(audio.bytes) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="錄音檔超過 25 MB，請縮短錄音後再試")

    form_hint = f"以下是填寫「{skill.label}」表單的語音內容。{skill.description}"
    try:
        transcript = await transcribe_recording(audio, model=payload.transcribeModel, form_hint=form_hint)
    except APIError as exc:
        raise HTTPException(status_code=400, detail=openai_audio_error_message(exc)) from exc
    if not transcript:
        return BatchFormPrepareResponse(
            transcript="",
            ready=False,
            errors=["沒有辨識到語音內容"],
        )

    if payload.guardrailMode == "keyword":
        passed, reason = check_text_local(transcript)
        if not passed:
            return BatchFormPrepareResponse(
                transcript=transcript,
                ready=False,
                errors=[f"Guardrail 已攔截：{reason}"],
            )

    try:
        raw_form_payload, meta = await structure_transcript_for_form(
            payload.form,
            transcript,
            profile.as_prompt_block(),
            model=payload.structureModel,
        )
    except APIError as exc:
        raise HTTPException(status_code=400, detail=f"表單整理失敗：{exc.message}") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="表單整理失敗：模型回傳不是有效 JSON") from exc
    merged_payload = skill.merge_profile_defaults(raw_form_payload, profile)
    errors: list[str] = []
    ready = True
    try:
        parsed = skill.parse_payload(merged_payload)
        normalized_payload = parsed.model_dump(by_alias=True)
    except Exception as exc:
        ready = False
        normalized_payload = merged_payload
        errors.extend(format_validation_errors(exc, labels=skill.field_labels()))

    duration_ms = int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)
    meta.timestamps = {"durationMs": duration_ms, "submittedAt": now_iso()}
    return BatchFormPrepareResponse(
        transcript=transcript,
        payload=normalized_payload,
        reviewText=format_form_review(normalized_payload),
        ready=ready,
        errors=errors,
        meta=meta,
    )


@app.post("/api/batch-form/patch", response_model=BatchFormPrepareResponse)
async def patch_batch_form(payload: BatchFormPatchPayload) -> BatchFormPrepareResponse:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=500, detail="缺少 OPENAI_API_KEY")
    if not has_skill(payload.form):
        raise HTTPException(status_code=404, detail=f"未知的表單代號：{payload.form}")

    skill = get_skill(payload.form)
    form_hint = f"以下是填寫「{skill.label}」表單的語音修改內容。"
    started_at = datetime.now(timezone.utc)
    transcript = ""
    correction_text = (payload.correctionText or "").strip()

    if payload.audioBase64:
        try:
            audio = decode_audio_payload(payload.audioBase64, payload.mimeType)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if len(audio.bytes) > 25 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="錄音檔超過 25 MB")
        try:
            transcript = await transcribe_recording(audio, model=payload.transcribeModel, form_hint=form_hint)
        except APIError as exc:
            raise HTTPException(status_code=400, detail=openai_audio_error_message(exc)) from exc
        correction_text = transcript

    if not correction_text:
        raise HTTPException(status_code=400, detail="請提供修改指示或錄音")

    if payload.guardrailMode == "keyword":
        passed, reason = check_text_local(correction_text)
        if not passed:
            return BatchFormPrepareResponse(
                transcript=transcript,
                ready=False,
                errors=[f"Guardrail 已攔截：{reason}"],
            )

    try:
        raw_form_payload, meta = await patch_form_with_correction(
            payload.form,
            payload.currentPayload,
            correction_text,
            model=payload.structureModel,
        )
    except APIError as exc:
        raise HTTPException(status_code=400, detail=f"表單修改失敗：{exc.message}") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="表單修改失敗：模型回傳不是有效 JSON") from exc

    profile = get_current_profile()
    merged_payload = skill.merge_profile_defaults(raw_form_payload, profile)
    errors: list[str] = []
    ready = True
    try:
        parsed = skill.parse_payload(merged_payload)
        normalized_payload = parsed.model_dump(by_alias=True)
    except Exception as exc:
        ready = False
        normalized_payload = merged_payload
        errors.extend(format_validation_errors(exc, labels=skill.field_labels()))

    duration_ms = int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)
    meta.timestamps = {"durationMs": duration_ms, "submittedAt": now_iso()}
    return BatchFormPrepareResponse(
        transcript=transcript,
        payload=normalized_payload,
        reviewText=format_form_review(normalized_payload),
        ready=ready,
        errors=errors,
        meta=meta,
    )


@app.post("/api/batch-form/fill")
async def fill_batch_form(payload: BatchFormFillPayload) -> dict[str, Any]:
    if not has_skill(payload.form):
        raise HTTPException(status_code=404, detail=f"未知的表單代號：{payload.form}")
    skill = get_skill(payload.form)
    profile = get_current_profile()
    form_payload = skill.merge_profile_defaults(payload.payload, profile)
    try:
        parsed = skill.parse_payload(form_payload)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="；".join(format_validation_errors(exc, labels=skill.field_labels())),
        ) from exc

    record_payload = RequestPayload(
        mode="stt",
        payload=parsed.model_dump(by_alias=True),
        meta=payload.meta,
        guardrailMode=payload.guardrailMode,
    )
    record = create_request(record_payload)

    page, err = await open_form_page(skill.url, skill.ready_selector)
    if err:
        raise HTTPException(status_code=500, detail=f"自動填表失敗：{err}")
    try:
        await skill.fill(page, parsed)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"填寫發生錯誤：{exc}") from exc
    return {"status": "success", "requestId": record.id}


@app.websocket("/ws/realtime")
async def realtime_proxy(client_ws: WebSocket):
    await client_ws.accept()
    if not LITELLM_MASTER_KEY:
        await client_ws.send_json({"type": "error", "message": "缺少 LITELLM_MASTER_KEY"})
        await client_ws.close()
        return

    # Parse query params
    guardrail_on = client_ws.query_params.get("guardrail") == "keyword"
    selected_model = client_ws.query_params.get("model", DEFAULT_REALTIME_MODEL)
    form_id = client_ws.query_params.get("form") or DEFAULT_FORM_ID
    if not has_skill(form_id):
        await client_ws.send_json({
            "type": "error",
            "message": f"未知的表單代號：{form_id}",
        })
        await client_ws.close()
        return
    skill = get_skill(form_id)
    profile = get_current_profile()
    instructions_with_profile = (
        profile.as_prompt_block() + "\n\n" + skill.instructions
    )

    headers = {"Authorization": f"Bearer {LITELLM_MASTER_KEY}"}

    try:
        async with websockets.connect(
            _realtime_url(selected_model), additional_headers=headers
        ) as openai_ws:
            logger = RealtimeTurnLogger("realtime")

            async def safe_send(payload: dict[str, Any]) -> None:
                if client_ws.client_state.name == "CONNECTED":
                    await client_ws.send_json(payload)

            async def safe_response_create() -> None:
                """Send response.create with lock to prevent duplicates."""
                nonlocal _response_active
                async with _response_lock:
                    if not _response_active:
                        _response_active = True  # Set immediately to prevent race
                        await ws_send(openai_ws, {"type": "response.create"}, logger)

            raw = await openai_ws.recv()
            init_event = json.loads(raw)
            logger.log_in(init_event)
            logger.on_event(init_event)
            if init_event.get("type") in ("session.created", "session.updated"):
                await forward_session_event(init_event, safe_send, "realtime", logger.conn_id)

            session_update = {
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "output_audio_format": "pcm16",
                    "instructions": instructions_with_profile,
                    "input_audio_format": "pcm16",
                    "input_audio_transcription": {
                        "model": OPENAI_TRANSCRIBE_MODEL,
                        "language": OPENAI_TRANSCRIBE_LANG,
                        **({"prompt": OPENAI_TRANSCRIBE_PROMPT} if OPENAI_TRANSCRIBE_PROMPT else {}),
                    },
                    "turn_detection": {
                        "type": "server_vad",
                        # Only disable auto-response when guardrail is on
                        # (need to check transcript before triggering response)
                        "create_response": not guardrail_on,
                        "threshold": 0.85,
                        "prefix_padding_ms": 400,
                        "silence_duration_ms": 1000,
                    },
                    "tools": [skill.tool_schema()],
                    "tool_choice": "auto",
                },
            }
            await ws_send(openai_ws, session_update, logger)

            tool_call_buffers: dict[str, str] = {}
            client_started_at: datetime | None = None
            audio_samples_total = 0
            _response_active = False
            _response_lock = asyncio.Lock()  # Prevent duplicate response.create
            # Accumulate real usage from response.done events
            _total_input_tokens = 0
            _total_output_tokens = 0
            _total_audio_input_tokens = 0
            _total_audio_output_tokens = 0
            # Output guardrail: per-response transcript buffer + blocked flag
            _agent_buffer = ""
            _agent_blocked = False
            _agent_passed_emitted = False
            async def receive_from_client():
                nonlocal client_started_at, audio_samples_total
                try:
                    while True:
                        data = await client_ws.receive_text()
                        message = json.loads(data)
                        if "audio" in message:
                            try:
                                audio_bytes = base64.b64decode(message["audio"])
                                audio_samples_total += len(audio_bytes) // 2
                            except (ValueError, TypeError):
                                pass

                            await ws_send(
                                openai_ws,
                                {"type": "input_audio_buffer.append", "audio": message["audio"]},
                                logger,
                            )
                        elif "meta" in message:
                            started_at = message.get("meta", {}).get("startedAt")
                            if started_at:
                                try:
                                    normalized = started_at.replace("Z", "+00:00")
                                    client_started_at = datetime.fromisoformat(normalized)
                                except ValueError:
                                    client_started_at = None
                        elif "text" in message:
                            # Text input from chat box
                            await ws_send(
                                openai_ws,
                                {
                                    "type": "conversation.item.create",
                                    "item": {
                                        "type": "message",
                                        "role": "user",
                                        "content": [{"type": "input_text", "text": message["text"]}],
                                    },
                                },
                                logger,
                            )
                            await safe_response_create()
                except WebSocketDisconnect:
                    return
                except Exception as exc:
                    await safe_send({"type": "error", "message": str(exc)})

            async def receive_from_openai():
                nonlocal _response_active, _total_input_tokens, _total_output_tokens
                nonlocal _total_audio_input_tokens, _total_audio_output_tokens
                nonlocal _agent_buffer, _agent_blocked, _agent_passed_emitted

                try:
                    async for raw in openai_ws:
                        event = json.loads(raw)
                        event_type = event.get("type")
                        logger.log_in(event)
                        logger.on_event(event)

                        # ── VAD interruption: user started speaking → cancel AI response ──
                        if event_type == "input_audio_buffer.speech_started":
                            if _response_active:
                                await ws_send(openai_ws, {"type": "response.cancel"}, logger)
                            # Tell frontend to stop audio playback immediately
                            await safe_send({"type": "playback_stop"})
                            # Finalize current agent message if any
                            await safe_send({"type": "agent_done"})

                        if event_type == "response.created":
                            _response_active = True
                            # Reset output guardrail state for the new response
                            _agent_buffer = ""
                            _agent_blocked = False
                            _agent_passed_emitted = False
                        elif event_type in ("response.done", "response.cancelled"):
                            _response_active = False

                        # ── Standard event forwarding ──
                        if event_type == "response.audio.delta":
                            # Suppress audio after output guardrail has blocked
                            if not _agent_blocked:
                                await safe_send({
                                    "type": "audio_delta",
                                    "delta": event.get("delta", ""),
                                })
                        elif event_type in ("response.output_text.delta", "response.text.delta", "response.audio_transcript.delta"):
                            delta = event.get("delta", "")
                            # ── Streaming output guardrail ──
                            if guardrail_on and not _agent_blocked:
                                _agent_buffer += delta
                                passed, reason = check_text_local(_agent_buffer)
                                if not passed:
                                    _agent_blocked = True
                                    # Stop the AI mid-stream and silence playback
                                    if _response_active:
                                        await ws_send(openai_ws, {"type": "response.cancel"}, logger)
                                    await safe_send({"type": "playback_stop"})
                                    await safe_send({"type": "agent_done"})
                                    snippet = _agent_buffer[:80] + ("…" if len(_agent_buffer) > 80 else "")
                                    await safe_send({
                                        "type": "guardrail_chat",
                                        "passed": False,
                                        "side": "output",
                                        "snippet": snippet,
                                        "reason": reason,
                                    })
                                    continue  # don't forward this delta
                            if _agent_blocked:
                                continue
                            await safe_send(
                                {"type": "agent_delta", "content": delta}
                            )
                        elif event_type in ("response.output_text.done", "response.done"):
                            await safe_send({"type": "agent_done"})
                            # Emit success chip once per response if output passed
                            if (
                                guardrail_on
                                and not _agent_blocked
                                and not _agent_passed_emitted
                                and _agent_buffer.strip()
                            ):
                                _agent_passed_emitted = True
                                await safe_send({
                                    "type": "guardrail_chat",
                                    "passed": True,
                                    "side": "output",
                                })
                            if event_type == "response.done":
                                # Accumulate real usage from OpenAI
                                r = event.get("response", {})
                                usage = r.get("usage") or {}
                                _total_input_tokens += usage.get("input_tokens", 0)
                                _total_output_tokens += usage.get("output_tokens", 0)
                                in_det = usage.get("input_token_details") or {}
                                out_det = usage.get("output_token_details") or {}
                                _total_audio_input_tokens += in_det.get("audio_tokens", 0)
                                _total_audio_output_tokens += out_det.get("audio_tokens", 0)
                                await forward_debug_event(event, safe_send)
                        elif (
                            event_type
                            == "conversation.item.input_audio_transcription.completed"
                        ):
                            transcript = event.get("transcript", "")
                            is_valid = transcript.strip() and not _is_prompt_leak(transcript)
                            # Always show user text first
                            if is_valid:
                                await safe_send(
                                    {"type": "user_delta", "content": transcript}
                                )
                            await safe_send(
                                {"type": "user_done", "content": transcript}
                            )
                            await forward_debug_event(event, safe_send)

                            # ── Keyword guardrail check (input) ──
                            blocked = False
                            if guardrail_on and is_valid:
                                passed, reason = check_text_local(transcript)
                                if passed:
                                    await safe_send({
                                        "type": "guardrail_chat",
                                        "passed": True,
                                        "side": "input",
                                    })
                                else:
                                    blocked = True
                                    snippet = transcript[:80] + ("…" if len(transcript) > 80 else "")
                                    await safe_send({
                                        "type": "guardrail_chat",
                                        "passed": False,
                                        "side": "input",
                                        "snippet": snippet,
                                        "reason": reason,
                                    })

                            if not blocked and guardrail_on:
                                # Only manually send response.create when guardrail is on
                                # (create_response: false). Without guardrail, OpenAI auto-responds.
                                await safe_response_create()
                        elif event_type == "response.function_call_arguments.delta":
                            call_id = event.get("call_id", "default")
                            tool_call_buffers[call_id] = tool_call_buffers.get(
                                call_id, ""
                            ) + event.get("delta", "")
                        elif event_type == "response.function_call_arguments.done":
                            call_id = event.get("call_id", "default")
                            arguments = event.get("arguments") or tool_call_buffers.get(
                                call_id, ""
                            )
                            tool_call_buffers.pop(call_id, None)
                            try:
                                form_payload = json.loads(arguments)
                                meta = RequestMeta()
                                # Use real token usage from response.done events
                                meta.inputTokens = _total_input_tokens
                                meta.outputTokens = _total_output_tokens
                                meta.audioInputTokens = _total_audio_input_tokens
                                meta.audioOutputTokens = _total_audio_output_tokens
                                # Calculate real cost from model pricing
                                selected_pricing = _get_model_pricing(selected_model)
                                text_cost = (
                                    (_total_input_tokens / 1000) * selected_pricing["text_input_per_1k"]
                                    + (_total_output_tokens / 1000) * selected_pricing["text_output_per_1k"]
                                )
                                audio_cost = (
                                    (_total_audio_input_tokens / 1000) * selected_pricing["audio_input_per_1k"]
                                    + (_total_audio_output_tokens / 1000) * selected_pricing["audio_output_per_1k"]
                                )
                                meta.cost = round(text_cost + audio_cost, 6)
                                if client_started_at:
                                    duration_ms = int(
                                        (datetime.now(timezone.utc) - client_started_at).total_seconds()
                                        * 1000
                                    )
                                    meta.timestamps = {
                                        "startedAt": client_started_at.isoformat(),
                                        "submittedAt": now_iso(),
                                        "durationMs": duration_ms,
                                    }
                                # Notify frontend that form data is ready
                                await safe_send(
                                    {
                                        "type": "form_ready",
                                        "payload": form_payload,
                                        "meta": meta.model_dump() if meta else None,
                                    }
                                )

                                # Merge profile defaults as a backstop (AI values win)
                                form_payload = skill.merge_profile_defaults(form_payload, profile)
                                # Validate payload and fill via the active skill
                                try:
                                    parsed = skill.parse_payload(form_payload)
                                except Exception as ve:
                                    err_msg = f"欄位驗證失敗：{ve}"
                                    await safe_send({"type": "browser_fill_error", "message": err_msg})
                                    tool_output = {"status": "error", "message": err_msg}
                                else:
                                    page, err = await open_form_page(skill.url, skill.ready_selector)
                                    if err:
                                        await safe_send({"type": "browser_fill_error", "message": err})
                                        tool_output = {"status": "error", "message": f"自動填表失敗：{err}"}
                                    else:
                                        try:
                                            await skill.fill(page, parsed)
                                            await safe_send({"type": "browser_fill_done"})
                                            tool_output = {
                                                "status": "success",
                                                "message": "已自動填入瀏覽器表單，請使用者確認後提交。",
                                            }
                                        except Exception as fe:
                                            err_msg = f"填寫發生錯誤：{fe}"
                                            await safe_send({"type": "browser_fill_error", "message": err_msg})
                                            tool_output = {"status": "error", "message": err_msg}

                                await ws_send(
                                    openai_ws,
                                    {
                                        "type": "conversation.item.create",
                                        "item": {
                                            "type": "function_call_output",
                                            "call_id": call_id,
                                            "output": json.dumps(tool_output),
                                        },
                                    },
                                    logger,
                                )
                                # After function call output, trigger AI to confirm
                                _response_active = False
                                await ws_send(openai_ws, {"type": "response.create"}, logger)
                            except Exception as exc:
                                await safe_send({"type": "error", "message": str(exc)})
                        elif event_type in ("session.created", "session.updated"):
                            await forward_session_event(event, safe_send, "realtime", logger.conn_id)
                        elif event_type in (
                            "input_audio_buffer.speech_started",
                            "input_audio_buffer.speech_stopped",
                            "input_audio_buffer.committed",
                            "response.created",
                        ):
                            await forward_debug_event(event, safe_send)
                        elif event_type == "error":
                            err = event.get("error", {})
                            code = err.get("code", "")
                            msg_text = err.get("message", "")
                            if code in ("response_cancel_not_active",):
                                print(f"[litellm] suppressed error: {code}")
                            elif "Missing required parameter" in msg_text and "turn_detection" in msg_text:
                                print(f"[litellm] suppressed turn_detection error (LiteLLM bug)")
                            else:
                                await safe_send({"type": "error", "message": err.get("message", str(event))})
                except Exception as exc:
                    await safe_send({"type": "error", "message": str(exc)})

            await asyncio.gather(receive_from_client(), receive_from_openai())
    except Exception as exc:
        if client_ws.client_state.name == "CONNECTED":
            await client_ws.send_json({"type": "error", "message": str(exc)})
            await client_ws.close()


@app.websocket("/ws/realtime-stt")
async def realtime_stt(client_ws: WebSocket):
    await client_ws.accept()
    if not LITELLM_MASTER_KEY:
        await client_ws.send_json({"type": "error", "message": "缺少 LITELLM_MASTER_KEY"})
        await client_ws.close()
        return

    stt_model = client_ws.query_params.get("model", DEFAULT_REALTIME_MODEL)

    headers = {"Authorization": f"Bearer {LITELLM_MASTER_KEY}"}

    async def safe_send(payload: dict[str, Any]) -> None:
        if client_ws.client_state.name == "CONNECTED":
            await client_ws.send_json(payload)

    try:
        async with websockets.connect(
            _realtime_url(stt_model), additional_headers=headers
        ) as openai_ws:
            logger = RealtimeTurnLogger("realtime-stt")

            # Read session.created BEFORE sending anything so log order matches
            # actual network order: ←OAI session.created → →OAI session.update
            raw = await openai_ws.recv()
            init_event = json.loads(raw)
            logger.log_in(init_event)
            logger.on_event(init_event)
            if init_event.get("type") in ("session.created", "session.updated"):
                await forward_session_event(init_event, safe_send, "realtime-stt", logger.conn_id)

            session_update = {
                "type": "session.update",
                "session": {
                    "input_audio_format": "pcm16",
                    "input_audio_transcription": {
                        "model": OPENAI_TRANSCRIBE_MODEL,
                        "language": OPENAI_TRANSCRIBE_LANG,
                        **({"prompt": OPENAI_TRANSCRIBE_PROMPT} if OPENAI_TRANSCRIBE_PROMPT else {}),
                    },
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.85,
                        "prefix_padding_ms": 400,
                        "silence_duration_ms": 1000,
                    },
                },
            }
            await ws_send(openai_ws, session_update, logger)

            async def receive_from_client():
                try:
                    while True:
                        data = await client_ws.receive_text()
                        message = json.loads(data)
                        if "audio" in message:
                            await ws_send(
                                openai_ws,
                                {"type": "input_audio_buffer.append", "audio": message["audio"]},
                                logger,
                            )
                except WebSocketDisconnect:
                    return
                except Exception as exc:
                    await safe_send({"type": "error", "message": str(exc)})

            async def receive_from_openai():
                try:
                    async for raw in openai_ws:
                        event = json.loads(raw)
                        event_type = event.get("type")
                        logger.log_in(event)
                        logger.on_event(event)
                        if event_type == "conversation.item.input_audio_transcription.delta":
                            await safe_send(
                                {"type": "stt_delta", "content": event.get("delta", "")}
                            )
                        elif event_type == "conversation.item.input_audio_transcription.completed":
                            await safe_send(
                                {
                                    "type": "stt_done",
                                    "content": event.get("transcript", ""),
                                }
                            )
                            await forward_debug_event(event, safe_send)
                        elif event_type in ("session.created", "session.updated"):
                            await forward_session_event(event, safe_send, "realtime-stt", logger.conn_id)
                        elif event_type in (
                            "input_audio_buffer.speech_started",
                            "input_audio_buffer.speech_stopped",
                            "input_audio_buffer.committed",
                        ):
                            await forward_debug_event(event, safe_send)
                        elif event_type == "error":
                            err = event.get("error", {})
                            code = err.get("code", "")
                            msg_text = err.get("message", "")
                            if code in ("response_cancel_not_active",):
                                print(f"[openai] suppressed error: {code}")
                            elif "Missing required parameter" in msg_text and "turn_detection" in msg_text:
                                print(f"[litellm] suppressed turn_detection error (LiteLLM bug)")
                            else:
                                await safe_send({"type": "error", "message": err.get("message", str(event))})
                except Exception as exc:
                    await safe_send({"type": "error", "message": str(exc)})

            await asyncio.gather(receive_from_client(), receive_from_openai())
    except Exception as exc:
        await safe_send({"type": "error", "message": str(exc)})
        await client_ws.close()


@app.delete("/api/requests/{request_id}")
def delete_request(request_id: str) -> dict[str, str]:
    with get_conn() as conn:
        cursor = conn.execute(
            "DELETE FROM requests WHERE id = ?",
            (request_id,),
        )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Request not found")
    return {"status": "ok"}


@app.delete("/api/requests")
def delete_all_requests() -> dict[str, str]:
    with get_conn() as conn:
        conn.execute("DELETE FROM requests")
        conn.execute("DELETE FROM ws_events")
    return {"status": "ok"}


@app.delete("/api/ws-sessions/{conn_id}")
def delete_ws_session(conn_id: str) -> dict[str, str]:
    with get_conn() as conn:
        conn.execute("DELETE FROM ws_events WHERE conn_id = ?", (conn_id,))
        conn.execute("DELETE FROM requests WHERE conn_id = ?", (conn_id,))
    return {"status": "ok"}


@app.get("/api/sessions")
def list_sessions() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                ws.conn_id, ws.session_id, ws.endpoint,
                ws.event_count, ws.started_at, ws.last_event_at,
                req.id              AS req_id,
                req.mode            AS req_mode,
                req.cost            AS req_cost,
                req.token_usage_json,
                req.payload_json    AS req_payload_json,
                req.user_duration_ms,
                req.audio_input_tokens,
                req.audio_output_tokens,
                req.guardrail_mode,
                req.created_at      AS req_created_at
            FROM (
                SELECT conn_id, session_id, endpoint,
                       COUNT(*) AS event_count,
                       MIN(created_at) AS started_at,
                       MAX(created_at) AS last_event_at
                FROM ws_events
                GROUP BY conn_id
            ) ws
            LEFT JOIN requests req ON req.conn_id = ws.conn_id
            ORDER BY ws.started_at DESC
            """
        ).fetchall()
        orphans = conn.execute(
            """
            SELECT id, mode, cost, token_usage_json, payload_json,
                   user_duration_ms, audio_input_tokens, audio_output_tokens,
                   guardrail_mode, created_at
            FROM requests
            WHERE conn_id IS NULL
            ORDER BY created_at DESC
            """
        ).fetchall()

    result = []
    for row in rows:
        d = dict(row)
        d["token_usage"] = json.loads(d.pop("token_usage_json") or "{}")
        d["req_payload"] = json.loads(d.pop("req_payload_json") or "null")
        result.append(d)
    for row in orphans:
        d = dict(row)
        result.append({
            "conn_id": None,
            "session_id": None,
            "endpoint": "—",
            "event_count": 0,
            "started_at": d["created_at"],
            "last_event_at": d["created_at"],
            "req_id": d["id"],
            "req_mode": d["mode"],
            "req_cost": d["cost"],
            "token_usage": json.loads(d.get("token_usage_json") or "{}"),
            "req_payload": json.loads(d.get("payload_json") or "null"),
            "user_duration_ms": d["user_duration_ms"],
            "audio_input_tokens": d.get("audio_input_tokens", 0),
            "audio_output_tokens": d.get("audio_output_tokens", 0),
            "guardrail_mode": d.get("guardrail_mode"),
            "req_created_at": d["created_at"],
        })
    return result


@app.get("/api/ws-sessions")
def list_ws_sessions() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT conn_id, session_id, endpoint,
                   COUNT(*) AS event_count,
                   MIN(created_at) AS started_at,
                   MAX(created_at) AS last_event_at
            FROM ws_events
            GROUP BY conn_id
            ORDER BY started_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/ws-sessions/{conn_id}/events")
def get_ws_session_events(conn_id: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM ws_events WHERE conn_id = ? ORDER BY created_at ASC",
            (conn_id,),
        ).fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="Session not found")
    return [dict(row) for row in rows]


@app.post("/api/client-errors")
def log_client_error(payload: ClientError) -> dict[str, str]:
    print(f"[client-error:{payload.source}] {payload.message} | detail={payload.detail}")
    return {"status": "ok"}


@app.get("/api/guardrail-info")
def guardrail_info() -> dict:
    """Return guardrail endpoint info for frontend display."""
    return {
        "mode": "keyword",
        "description": "本地關鍵字檢查（Prompt injection、暴力、詐騙等）",
        "litellm_proxy": os.getenv("LITELLM_PROXY_URL", "ws://localhost:4000"),
        "transcription_model": OPENAI_TRANSCRIBE_MODEL,
        "batch_structuring_model": OPENAI_BATCH_STRUCTURING_MODEL,
        "realtime_model": DEFAULT_REALTIME_MODEL,
    }


@app.get("/api/models")
def list_models() -> dict:
    """Return available models for all modes."""
    models = []
    for model_id, info in REALTIME_MODELS.items():
        models.append({
            "id": model_id,
            "label": info["label"],
            "pricing": {
                "text_input_per_1m": round(info["text_input_per_1k"] * 1000, 2),
                "text_output_per_1m": round(info["text_output_per_1k"] * 1000, 2),
                "audio_input_per_1m": round(info["audio_input_per_1k"] * 1000, 2),
                "audio_output_per_1m": round(info["audio_output_per_1k"] * 1000, 2),
            },
        })
    return {
        "models": models,
        "default": DEFAULT_REALTIME_MODEL,
        "batch": {
            "transcription": BATCH_TRANSCRIPTION_MODELS,
            "default_transcription": OPENAI_TRANSCRIBE_MODEL,
            "structuring": BATCH_STRUCTURING_MODELS,
            "default_structuring": OPENAI_BATCH_STRUCTURING_MODEL,
        },
    }


init_db()


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse("static/index.html")


@app.get("/logs.html")
def serve_logs() -> FileResponse:
    return FileResponse("static/logs.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
