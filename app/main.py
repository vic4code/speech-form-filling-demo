from __future__ import annotations

import json
import os
import sqlite3
import asyncio
import base64
import time
from datetime import datetime, timezone
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
import websockets

import httpx

from app.guardrails import GuardrailResult, get_audio_guardrail


load_dotenv()

# ── Realtime model definitions with official pricing (per 1K tokens) ──
# Source: https://platform.openai.com/docs/pricing (March 2025)
REALTIME_MODELS: dict[str, dict] = {
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
    "OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview-2024-12-17"
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
OPENAI_TRANSCRIBE_MODEL = os.getenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1")
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
    # Check if transcript is mostly the prompt (>60% overlap)
    if len(t) < 5:
        return False
    return t in p or p in t or (len(set(t) & set(p)) / len(set(t)) > 0.8 and len(t) > 20)


async def _check_text_via_litellm(text: str) -> tuple[bool, str]:
    """Check text via LiteLLM → Bedrock guardrail (pre_call).

    Calls LiteLLM's /chat/completions with a dummy request.
    If Bedrock guardrail blocks, LiteLLM returns 400.
    Returns (passed, reason).
    """
    litellm_url = os.getenv("LITELLM_PROXY_URL", "ws://localhost:4000").replace("ws://", "http://").replace("wss://", "https://")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{litellm_url}/v1/chat/completions",
                headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
                json={
                    "model": "openai/gpt-4o-mini",
                    "messages": [{"role": "user", "content": text}],
                    "max_tokens": 1,
                },
            )
            if resp.status_code == 200:
                return True, ""
            # Guardrail blocked
            err = resp.json().get("error", {})
            return False, err.get("message", "違反安全規範")
    except Exception as exc:
        print(f"[guardrail] LiteLLM check failed: {exc}")
        # Fail open — allow if LiteLLM is down
        return True, ""


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
    guardrailMode: str | None = None  # "pre_check" | "post_check" | None


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


SUBMIT_FORM_TOOL = {
    "type": "function",
    "name": "submit_form",
    "description": "當所有欄位完整時，送出計程車費報銷表單。rideDate 和 rideType 為必填，不可為空。",
    "parameters": {
        "type": "object",
        "properties": {
            "rideDate": {
                "type": "string",
                "description": "乘坐日期，格式必須為 YYYY-MM-DD，例如 2026-03-27。若使用者未提供，請先詢問。",
            },
            "rideType": {
                "type": "string",
                "enum": ["01_單日單趟", "02_單日來回", "03_單日多趟(請於備註說明)"],
                "description": "乘坐類型，必須為以下三選一：01_單日單趟、02_單日來回、03_單日多趟(請於備註說明)。根據使用者描述的趟數判斷。",
            },
            "rideRows": {
                "type": "array",
                "description": "乘坐起迄明細，至少一筆",
                "items": {
                    "type": "object",
                    "properties": {
                        "from": {"type": "string", "description": "乘坐起點"},
                        "to": {"type": "string", "description": "乘坐迄點"},
                        "fee": {"type": "string", "description": "費用（數字）"},
                        "reason": {"type": "string", "description": "乘坐事由"},
                    },
                    "required": ["from", "to", "fee", "reason"],
                },
            },
            "totalFare": {"type": "string", "description": "當日車資合計（數字）"},
            "notes": {"type": "string", "description": "備註說明，可為空字串"},
        },
        "required": ["rideDate", "rideType", "rideRows", "totalFare", "notes"],
    },
}


@app.websocket("/ws/realtime")
async def realtime_proxy(client_ws: WebSocket):
    await client_ws.accept()
    if not LITELLM_MASTER_KEY:
        await client_ws.send_json({"type": "error", "message": "缺少 LITELLM_MASTER_KEY"})
        await client_ws.close()
        return

    # Parse query params
    guardrail_mode = client_ws.query_params.get("guardrail")
    selected_model = client_ws.query_params.get("model", DEFAULT_REALTIME_MODEL)

    headers = {"Authorization": f"Bearer {LITELLM_MASTER_KEY}"}

    try:
        async with websockets.connect(
            _realtime_url(selected_model), additional_headers=headers
        ) as openai_ws:
            logger = RealtimeTurnLogger("realtime")

            async def safe_send(payload: dict[str, Any]) -> None:
                if client_ws.client_state.name == "CONNECTED":
                    await client_ws.send_json(payload)

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
                    "instructions": (
                        "你是計程車費報銷表單助理。請用繁體中文對話引導使用者完成表單。\n"
                        "回覆請簡短扼要，每次回覆不超過兩句話。\n\n"
                        "必填欄位（缺一不可，全部確認才能送出）：\n"
                        "1. 乘坐日期（格式 YYYY-MM-DD，必須問清楚具體日期）\n"
                        "2. 乘坐類型（單趟=01_單日單趟，來回=02_單日來回，多趟=03_單日多趟）\n"
                        "3. 每趟的起點、迄點、費用、事由（全部都要有值）\n"
                        "4. 車資合計\n\n"
                        "重要規則：\n"
                        "- 絕對不可以在資訊不完整時呼叫 submit_form\n"
                        "- 逐一確認每個欄位，缺少的欄位務必追問\n"
                        "- 若使用者沒提到日期，追問「請問是哪一天搭乘的？」\n"
                        "- 若使用者沒提到費用，追問「這趟費用是多少？」\n"
                        "- 若使用者沒提到事由，追問「搭乘的事由是什麼？」\n"
                        "- 所有欄位都確認完畢、使用者也同意後，才呼叫 submit_form\n"
                        "- 日期格式必須是 YYYY-MM-DD\n"
                        "- rideType 必須是 01_單日單趟、02_單日來回、03_單日多趟(請於備註說明) 三選一"
                    ),
                    "input_audio_format": "pcm16",
                    "input_audio_transcription": {
                        "model": OPENAI_TRANSCRIBE_MODEL,
                        "language": OPENAI_TRANSCRIBE_LANG,
                        **({"prompt": OPENAI_TRANSCRIBE_PROMPT} if OPENAI_TRANSCRIBE_PROMPT else {}),
                    },
                    "turn_detection": {
                        "type": "server_vad",
                        # Always disable auto-response so we can run text guardrail
                        # on user transcript before triggering response.create
                        "create_response": False,
                        "threshold": 0.85,
                        "prefix_padding_ms": 400,
                        "silence_duration_ms": 1000,
                    },
                    "tools": [SUBMIT_FORM_TOOL],
                    "tool_choice": "auto",
                },
            }
            await ws_send(openai_ws, session_update, logger)

            tool_call_buffers: dict[str, str] = {}
            client_started_at: datetime | None = None
            audio_samples_total = 0
            _response_active = False
            _audio_gr_input_shown = False
            # Accumulate real usage from response.done events
            _total_input_tokens = 0
            _total_output_tokens = 0
            _total_audio_input_tokens = 0
            _total_audio_output_tokens = 0

            # ── Audio guardrail via LiteLLM (Mode 1 only) ──
            audio_gr_session = None
            if guardrail_mode == "pre_check":
                audio_gr = get_audio_guardrail()
                if audio_gr:
                    audio_gr_session = await audio_gr.connect_session()
                    if audio_gr_session:
                        print("[guardrail] Audio guardrail WS connected (via LiteLLM)")
                    else:
                        print("[guardrail] Audio guardrail WS failed")
                else:
                    print("[guardrail] AudioGuardrail not registered in LiteLLM")

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

                            # Mode 1: stream audio to guardrail server in real-time
                            if audio_gr_session and audio_gr:
                                await audio_gr.send_audio(audio_gr_session, message["audio"])
                                # Check for new results
                                latest = audio_gr.get_latest_result(audio_gr_session)
                                if latest and latest.get("status") == "UNSAFE" and not audio_gr_session.get("_notified_unsafe"):
                                    audio_gr_session["_notified_unsafe"] = True
                                    process_time = latest.get("process_time_sec", 0)
                                    await safe_send({
                                        "type": "guardrail_chat",
                                        "passed": False,
                                        "message": f"✗ [使用者輸入] 已攔截（Audio Guardrail via LiteLLM）\n　原因：輸入音訊不安全 (偵測耗時 {process_time:.2f}s)",
                                    })
                                elif latest and latest.get("status") == "SAFE" and not _audio_gr_input_shown:
                                    _audio_gr_input_shown = True
                                    await safe_send({
                                        "type": "guardrail_chat",
                                        "passed": True,
                                        "message": "✓ [使用者輸入] 音訊安全檢查通過（Audio Guardrail via LiteLLM）",
                                    })

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
                            # Text input — LiteLLM handles guardrail check
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
                            await ws_send(openai_ws, {"type": "response.create"}, logger)
                except WebSocketDisconnect:
                    return
                except Exception as exc:
                    await safe_send({"type": "error", "message": str(exc)})

            async def receive_from_openai():
                nonlocal _response_active, _total_input_tokens, _total_output_tokens
                nonlocal _total_audio_input_tokens, _total_audio_output_tokens
                try:
                    async for raw in openai_ws:
                        event = json.loads(raw)
                        event_type = event.get("type")
                        logger.log_in(event)
                        logger.on_event(event)

                        # ── VAD interruption: user started speaking → cancel AI response ──
                        if event_type == "input_audio_buffer.speech_started":
                            _audio_gr_input_shown = False
                            if _response_active:
                                await ws_send(openai_ws, {"type": "response.cancel"}, logger)
                            # Tell frontend to stop audio playback immediately
                            await safe_send({"type": "playback_stop"})
                            # Finalize current agent message if any
                            await safe_send({"type": "agent_done"})

                        if event_type == "response.created":
                            _response_active = True
                        elif event_type in ("response.done", "response.cancelled"):
                            _response_active = False

                        # ── Text guardrail: call Bedrock via LiteLLM on transcript ──
                        # FastAPI manages create_response: false flow.
                        # On transcription.completed, call LiteLLM → Bedrock pre_call.
                        if event_type == "conversation.item.input_audio_transcription.completed":
                            transcript = event.get("transcript", "")
                            if transcript.strip() and not _is_prompt_leak(transcript):
                                passed, reason = await _check_text_via_litellm(transcript)
                                if passed:
                                    await safe_send({
                                        "type": "guardrail_chat",
                                        "passed": True,
                                        "message": "✓ [使用者輸入] 安全檢查通過（LiteLLM → Bedrock）",
                                    })
                                else:
                                    snippet = transcript[:50] + ("…" if len(transcript) > 50 else "")
                                    await safe_send({
                                        "type": "guardrail_chat",
                                        "passed": False,
                                        "message": (
                                            f"✗ [使用者輸入] 已攔截（LiteLLM → Bedrock）\n"
                                            f"　內容：「{snippet}」\n"
                                            f"　原因：{reason}"
                                        ),
                                    })
                                    continue  # Skip response.create
                            await ws_send(openai_ws, {"type": "response.create"}, logger)

                        # ── Standard event forwarding ──
                        if event_type == "response.audio.delta":
                            await safe_send({
                                "type": "audio_delta",
                                "delta": event.get("delta", ""),
                            })
                        elif event_type in ("response.output_text.delta", "response.text.delta", "response.audio_transcript.delta"):
                            await safe_send(
                                {"type": "agent_delta", "content": event.get("delta", "")}
                            )
                        elif event_type in ("response.output_text.done", "response.done"):
                            await safe_send({"type": "agent_done"})
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
                        elif event_type == "conversation.item.input_audio_transcription.delta":
                            # Don't stream user deltas — wait for completed to avoid
                            # showing agent text before user text is finished
                            pass
                        elif (
                            event_type
                            == "conversation.item.input_audio_transcription.completed"
                        ):
                            transcript = event.get("transcript", "")
                            # Show full user text at once (no streaming delay)
                            # Skip prompt-leak transcripts
                            if transcript.strip() and not _is_prompt_leak(transcript):
                                await safe_send(
                                    {"type": "user_delta", "content": transcript}
                                )
                            await safe_send(
                                {
                                    "type": "user_done",
                                    "content": transcript,
                                }
                            )
                            await forward_debug_event(event, safe_send)
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
                                await safe_send(
                                    {
                                        "type": "form_ready",
                                        "payload": form_payload,
                                        "meta": meta.model_dump() if meta else None,
                                    }
                                )
                                await ws_send(
                                    openai_ws,
                                    {
                                        "type": "conversation.item.create",
                                        "item": {
                                            "type": "function_call_output",
                                            "call_id": call_id,
                                            "output": json.dumps({
                                                "status": "pending_user_confirmation",
                                                "message": "已整理表單，等待使用者確認送出。",
                                            }),
                                        },
                                    },
                                    logger,
                                )
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
                            error_type = err.get("type", "")
                            msg_text = err.get("message", "")
                            if code in ("response_cancel_not_active",):
                                print(f"[litellm] suppressed error: {code}")
                            elif "Missing required parameter" in msg_text and "turn_detection" in msg_text:
                                # LiteLLM injects incomplete session.update — harmless, suppress
                                print(f"[litellm] suppressed turn_detection error (LiteLLM bug)")
                            elif error_type in ("guardrail_violation", "guardrail_error") or code == "content_policy_violation":
                                # LiteLLM Bedrock guardrail blocked the input
                                msg = err.get("message", "違反安全規範")
                                print(f"[litellm] guardrail violation: {msg}")
                                await safe_send({
                                    "type": "guardrail_chat",
                                    "passed": False,
                                    "message": f"✗ [使用者輸入] 已攔截（LiteLLM Bedrock Guardrail）\n　原因：{msg}",
                                })
                            else:
                                await safe_send({"type": "error", "message": err.get("message", str(event))})
                except Exception as exc:
                    await safe_send({"type": "error", "message": str(exc)})

            try:
                await asyncio.gather(receive_from_client(), receive_from_openai())
            finally:
                if audio_gr_session and audio_gr:
                    await audio_gr.close_session(audio_gr_session)
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
    bedrock_id = os.getenv("BEDROCK_GUARDRAIL_ID", "")
    return {
        "audio_ws": os.getenv("GUARDRAIL_WS_URL", ""),
        "text_mode": f"LiteLLM → Bedrock Guardrail ({bedrock_id})" if bedrock_id else "未設定",
        "litellm_proxy": os.getenv("LITELLM_PROXY_URL", "ws://localhost:4000"),
        "bedrock_guardrail_id": bedrock_id,
        "bedrock_region": os.getenv("AWS_DEFAULT_REGION", "us-west-2") if bedrock_id else "",
        "transcription_model": OPENAI_TRANSCRIBE_MODEL,
        "realtime_model": DEFAULT_REALTIME_MODEL,
    }


@app.get("/api/models")
def list_models() -> dict:
    """Return available Realtime models with pricing for frontend display."""
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
    return {"models": models, "default": DEFAULT_REALTIME_MODEL}


init_db()


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse("static/index.html")


@app.get("/logs.html")
def serve_logs() -> FileResponse:
    return FileResponse("static/logs.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
