from __future__ import annotations

import json
import os
import sqlite3
import asyncio
import base64
import math
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


load_dotenv()

# Default to gpt-realtime text token pricing (per 1K tokens).
# Input: $4.00 / 1M, Output: $16.00 / 1M
COST_PER_1K_INPUT = float(os.getenv("COST_PER_1K_INPUT", "0.004"))
COST_PER_1K_OUTPUT = float(os.getenv("COST_PER_1K_OUTPUT", "0.016"))
AUDIO_COST_PER_1K_INPUT = float(os.getenv("AUDIO_COST_PER_1K_INPUT", "0.032"))
AUDIO_COST_PER_1K_OUTPUT = float(os.getenv("AUDIO_COST_PER_1K_OUTPUT", "0.064"))
AUDIO_TOKENS_PER_SECOND = float(os.getenv("AUDIO_TOKENS_PER_SECOND", "10"))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_REALTIME_URL = os.getenv(
    "OPENAI_REALTIME_URL",
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
)
OPENAI_BETA_HEADER = os.getenv("OPENAI_BETA_HEADER", "realtime=v1")
OPENAI_TRANSCRIBE_MODEL = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
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
        createdAt=now_iso(),
    )

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO requests (
                id, mode, payload_json, token_usage_json, cost, processing_ms,
                user_duration_ms, audio_input_tokens, audio_output_tokens, created_at,
                conn_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    "description": "當所有欄位完整時，送出計程車費報銷表單。",
    "parameters": {
        "type": "object",
        "properties": {
            "rideDate": {"type": "string", "description": "乘坐日期，YYYY-MM-DD"},
            "rideType": {"type": "string", "description": "乘坐類型"},
            "rideRows": {
                "type": "array",
                "description": "乘坐起迄明細",
                "items": {
                    "type": "object",
                    "properties": {
                        "from": {"type": "string", "description": "乘坐起點"},
                        "to": {"type": "string", "description": "乘坐迄點"},
                        "fee": {"type": "string", "description": "費用"},
                        "reason": {"type": "string", "description": "乘坐事由"},
                    },
                    "required": ["from", "to", "fee", "reason"],
                },
            },
            "totalFare": {"type": "string", "description": "當日車資合計"},
            "notes": {"type": "string", "description": "備註說明"},
        },
        "required": ["rideDate", "rideType", "rideRows", "totalFare", "notes"],
    },
}


@app.websocket("/ws/realtime")
async def realtime_proxy(client_ws: WebSocket):
    await client_ws.accept()
    if not OPENAI_API_KEY:
        await client_ws.send_json({"type": "error", "message": "缺少 OPENAI_API_KEY"})
        await client_ws.close()
        return

    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}
    if OPENAI_BETA_HEADER:
        headers["OpenAI-Beta"] = OPENAI_BETA_HEADER

    try:
        async with websockets.connect(
            OPENAI_REALTIME_URL, additional_headers=headers
        ) as openai_ws:
            logger = RealtimeTurnLogger("realtime")
            session_update = {
                "type": "session.update",
                "session": {
                    "modalities": ["text"],
                    "instructions": (
                        "你是表單助理，請用對話引導使用者完成計程車費報銷表單。"
                        "務必確認所有欄位都有值後，才呼叫 submit_form。"
                        "若使用者資訊不完整，請追問缺少欄位。"
                    ),
                    "input_audio_format": "pcm16",
                    "input_audio_transcription": {
                        "model": OPENAI_TRANSCRIBE_MODEL,
                        "language": OPENAI_TRANSCRIBE_LANG,
                        **({"prompt": OPENAI_TRANSCRIBE_PROMPT} if OPENAI_TRANSCRIBE_PROMPT else {}),
                    },
                    "turn_detection": {"type": "server_vad"},
                    "tools": [SUBMIT_FORM_TOOL],
                    "tool_choice": "auto",
                },
            }
            await ws_send(openai_ws, session_update, logger)

            tool_call_buffers: dict[str, str] = {}
            client_started_at: datetime | None = None
            audio_samples_total = 0

            async def safe_send(payload: dict[str, Any]) -> None:
                if client_ws.client_state.name == "CONNECTED":
                    await client_ws.send_json(payload)

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
                try:
                    async for raw in openai_ws:
                        event = json.loads(raw)
                        event_type = event.get("type")
                        logger.log_in(event)
                        logger.on_event(event)
                        if event_type in ("response.output_text.delta", "response.text.delta"):
                            await safe_send(
                                {"type": "agent_delta", "content": event.get("delta", "")}
                            )
                        elif event_type in ("response.output_text.done", "response.done"):
                            await safe_send({"type": "agent_done"})
                            if event_type == "response.done":
                                await forward_debug_event(event, safe_send)
                        elif event_type == "conversation.item.input_audio_transcription.delta":
                            await safe_send(
                                {"type": "user_delta", "content": event.get("delta", "")}
                            )
                        elif (
                            event_type
                            == "conversation.item.input_audio_transcription.completed"
                        ):
                            await safe_send(
                                {
                                    "type": "user_done",
                                    "content": event.get("transcript", ""),
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
                                meta = None
                                audio_seconds = audio_samples_total / 24000 if audio_samples_total else 0
                                audio_input_tokens = (
                                    math.ceil(audio_seconds * AUDIO_TOKENS_PER_SECOND)
                                    if audio_seconds
                                    else 0
                                )
                                if client_started_at:
                                    duration_ms = int(
                                        (datetime.now(timezone.utc) - client_started_at).total_seconds()
                                        * 1000
                                    )
                                    meta = RequestMeta(
                                        timestamps={
                                            "startedAt": client_started_at.isoformat(),
                                            "submittedAt": now_iso(),
                                            "durationMs": duration_ms,
                                        }
                                    )
                                if audio_input_tokens:
                                    meta = meta or RequestMeta()
                                    meta.audioInputTokens = audio_input_tokens
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
                            await safe_send({"type": "error", "message": str(event)})
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
    if not OPENAI_API_KEY:
        await client_ws.send_json({"type": "error", "message": "缺少 OPENAI_API_KEY"})
        await client_ws.close()
        return

    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}
    if OPENAI_BETA_HEADER:
        headers["OpenAI-Beta"] = OPENAI_BETA_HEADER

    async def safe_send(payload: dict[str, Any]) -> None:
        if client_ws.client_state.name == "CONNECTED":
            await client_ws.send_json(payload)

    try:
        async with websockets.connect(
            OPENAI_REALTIME_URL, additional_headers=headers
        ) as openai_ws:
            logger = RealtimeTurnLogger("realtime-stt")
            session_update = {
                "type": "session.update",
                "session": {
                    "input_audio_format": "pcm16",
                    "input_audio_transcription": {
                        "model": OPENAI_TRANSCRIBE_MODEL,
                        "language": OPENAI_TRANSCRIBE_LANG,
                        **({"prompt": OPENAI_TRANSCRIBE_PROMPT} if OPENAI_TRANSCRIBE_PROMPT else {}),
                    },
                    "turn_detection": {"type": "server_vad"},
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
                            await safe_send({"type": "error", "message": str(event)})
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
                   user_duration_ms, created_at
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


init_db()


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse("static/index.html")


@app.get("/logs.html")
def serve_logs() -> FileResponse:
    return FileResponse("static/logs.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
