from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


COST_PER_1K_INPUT = float(os.getenv("COST_PER_1K_INPUT", "0.001"))
COST_PER_1K_OUTPUT = float(os.getenv("COST_PER_1K_OUTPUT", "0.002"))


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
    createdAt: str


app = FastAPI(title="Speech Form Filling Demo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

REQUESTS: list[RequestRecord] = []


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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.post("/api/requests", response_model=RequestRecord)
def create_request(payload: RequestPayload) -> RequestRecord:
    tokens = estimate_tokens(payload.payload)
    cost = estimate_cost(tokens)

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

    record = RequestRecord(
        id=str(uuid4()),
        mode=payload.mode,
        payload=payload.payload,
        tokenUsage=tokens,
        cost=cost,
        createdAt=now_iso(),
    )
    REQUESTS.insert(0, record)
    return record


@app.get("/api/requests", response_model=list[RequestRecord])
def list_requests() -> list[RequestRecord]:
    return REQUESTS


@app.get("/api/requests/{request_id}", response_model=RequestRecord)
def get_request(request_id: str) -> RequestRecord:
    for record in REQUESTS:
        if record.id == request_id:
            return record
    raise HTTPException(status_code=404, detail="Request not found")


app.mount("/", StaticFiles(directory="static", html=True), name="static")
