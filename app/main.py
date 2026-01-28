from __future__ import annotations

import json
import os
import sqlite3
import asyncio
import base64
import math
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
OPENAI_TRANSCRIBE_LANG = os.getenv("OPENAI_TRANSCRIBE_LANG", "zh")


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


@app.post("/api/requests", response_model=RequestRecord)
def create_request(payload: RequestPayload) -> RequestRecord:
    started_at = datetime.now(timezone.utc)
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
                user_duration_ms, audio_input_tokens, audio_output_tokens, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    },
                    "turn_detection": {"type": "server_vad"},
                    "tools": [SUBMIT_FORM_TOOL],
                    "tool_choice": "auto",
                },
            }
            await openai_ws.send(json.dumps(session_update))

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
                            await openai_ws.send(
                                json.dumps(
                                    {
                                        "type": "input_audio_buffer.append",
                                        "audio": message["audio"],
                                    }
                                )
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
                            await openai_ws.send(
                                json.dumps(
                                    {
                                        "type": "conversation.item.create",
                                        "item": {
                                            "type": "message",
                                            "role": "user",
                                            "content": [
                                                {"type": "input_text", "text": message["text"]}
                                            ],
                                        },
                                    }
                                )
                            )
                            await openai_ws.send(json.dumps({"type": "response.create"}))
                except WebSocketDisconnect:
                    return
                except Exception as exc:
                    await safe_send({"type": "error", "message": str(exc)})

            async def receive_from_openai():
                try:
                    async for raw in openai_ws:
                        event = json.loads(raw)
                        event_type = event.get("type")
                        if event_type in ("response.output_text.delta", "response.text.delta"):
                            await safe_send(
                                {"type": "agent_delta", "content": event.get("delta", "")}
                            )
                        elif event_type in ("response.output_text.done", "response.done"):
                            await safe_send({"type": "agent_done"})
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
                                await openai_ws.send(
                                    json.dumps(
                                        {
                                            "type": "conversation.item.create",
                                            "item": {
                                                "type": "function_call_output",
                                                "call_id": call_id,
                                                "output": json.dumps(
                                                    {
                                                        "status": "pending_user_confirmation",
                                                        "message": "已整理表單，等待使用者確認送出。",
                                                    }
                                                ),
                                            },
                                        }
                                    )
                                )
                            except Exception as exc:
                                await safe_send({"type": "error", "message": str(exc)})
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
            session_update = {
                "type": "session.update",
                "session": {
                    "type": "transcription",
                    "audio": {
                        "input": {
                            "format": {"type": "audio/pcm", "rate": 24000},
                            "transcription": {
                                "model": OPENAI_TRANSCRIBE_MODEL,
                                "language": OPENAI_TRANSCRIBE_LANG,
                            },
                            "turn_detection": {"type": "server_vad"},
                        }
                    },
                },
            }
            await openai_ws.send(json.dumps(session_update))

            async def receive_from_client():
                try:
                    while True:
                        data = await client_ws.receive_text()
                        message = json.loads(data)
                        if "audio" in message:
                            await openai_ws.send(
                                json.dumps(
                                    {
                                        "type": "input_audio_buffer.append",
                                        "audio": message["audio"],
                                    }
                                )
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
                        elif event_type == "error":
                            print(f"[realtime-stt] OpenAI error: {event}")
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
