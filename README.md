# Speech Form Filling Demo

## Overview

A voice-first web application for completing taxi expense reimbursement forms. Users can fill forms via real-time speech-to-text or conversational AI, with optional **Guardrail** safety checks.

Two voice-driven modes are available:

1. **Real-time STT Form Mode** — Streaming speech-to-text fills form fields in sequence with block-level focus and voice navigation.
2. **Conversation Mode** — A Realtime voice agent guides the user through the form via natural dialogue. Structured output **automatically populates a live form preview** alongside the chat.

After submission, users are redirected to a **Request Log page** with token usage, cost tracking, and WebSocket event history.

## Architecture

```mermaid
graph LR
    Browser["🌐 Browser<br/>AudioWorklet"]
    FastAPI["⚡ FastAPI :8000<br/>應用邏輯 / 表單 / Logs"]
    LiteLLM["🔀 LiteLLM :4000<br/>AI Proxy + Guardrails"]
    OpenAI["☁️ OpenAI<br/>Realtime API"]
    Bedrock["🛡️ Bedrock<br/>Text Guardrail"]
    AudioGR["🎙️ Audio GR<br/>WS Server"]

    Browser <-->|"WebSocket<br/>audio + events"| FastAPI
    FastAPI <-->|"WebSocket"| LiteLLM
    LiteLLM <-->|"Realtime WS"| OpenAI
    LiteLLM -->|"pre_call"| Bedrock
    FastAPI -->|"PCM16 stream"| AudioGR

    style Browser fill:#f0fdf4,stroke:#16a34a
    style FastAPI fill:#eff6ff,stroke:#2563eb
    style LiteLLM fill:#fef3c7,stroke:#d97706
    style Bedrock fill:#fdf2f8,stroke:#be185d
    style AudioGR fill:#fdf2f8,stroke:#be185d
    style OpenAI fill:#f5f3ff,stroke:#7c3aed
```

> 詳細架構圖、Sequence Diagram 請參考 [ARCHITECTURE.md](ARCHITECTURE.md)

## Features

### Conversation Mode with Live Form Preview

The conversation tab uses a **form-centric layout**:
- **Left (60%)** — Full form (identical structure to STT mode) that auto-populates when AI completes filling
- **Right (40%)** — Sticky chat sidebar showing conversation with the AI agent

When the agent calls `submit_form`, the structured output fills the visual form fields (date, ride type, ride rows, total fare, notes) with a highlight animation, giving the user a clear preview before submission.

### Guardrail Integration

Two guardrail modes protect against unsafe or policy-violating content. Both modes share the **same output text guardrail**; they differ only in how **input** is checked.

#### Mode 1: Input Audio Guardrail + Output Text Guardrail

Streams raw audio to an external guardrail WebSocket endpoint (`GUARDRAIL_WS_URL`) for real-time audio-level safety checks.

```
User Audio ──► Realtime API + stream to Audio Guardrail WS (PCM16, 16kHz)
                    │                          │
                    │                    ┌─────┴─────┐
                    │                    │ SAFE      │ UNSAFE
                    │                    ▼           ▼
                    │               Continue    Show warning popup
                    │                              + stop conversation
                    ▼
              Agent Output ──► Output Text Guardrail (pattern check)
                                    │
                              ┌─────┴─────┐
                              │ Pass      │ Block
                              ▼           ▼
                         Forward     Show blocked msg
```

- Dual-stream: both user input audio and AI output audio are sent to the guardrail server
- Audio is resampled from 24kHz to 16kHz (numpy linear interpolation) per guardrail server requirements
- Protocol: binary PCM16 frames sent over WebSocket; server returns `{"event": "guardrail_result", "status": "SAFE"|"UNSAFE"}`
- Based on [DScathay/voice-guardrails](https://github.com/DScathay/voice-guardrails) realtime branch

#### Mode 2: Input Transcript Guardrail + Output Text Guardrail

Audio goes directly to Realtime API. The `input_audio_transcription.completed` transcript text is checked via local pattern-based guardrail before triggering AI response.

```
User Audio ──► Realtime API (create_response: false)
                    │
                    ▼  (transcription completed)
              Input Text Guardrail (pattern check)
                    │
              ┌─────┴─────┐
              │ Pass      │ Block
              ▼           ▼
        response.create   Show warning popup
              │              + stop conversation
              ▼
        Agent Output ──► Output Text Guardrail (pattern check)
                              │
                        ┌─────┴─────┐
                        │ Pass      │ Block
                        ▼           ▼
                   Forward     Show blocked msg
```

- `create_response: false` in `turn_detection` prevents AI from responding before guardrail check completes
- After guardrail passes, `response.create` is sent manually
- Based on [DScathay/voice-guardrails](https://github.com/DScathay/voice-guardrails) asr branch and [vic4code/realtime-litellm-guardrail](https://github.com/vic4code/realtime-litellm-guardrail)

#### Always-On Text Guardrail

Text guardrail runs on **every** user input and AI output, regardless of the Guardrail checkbox. The checkbox only controls Mode 1/2 specific features (audio streaming guardrail).

**Input checking flow:** Bedrock Guardrail → Local Regex Patterns (dual layer)
**Output checking flow:** Bedrock Guardrail only (to avoid false positives on AI refusal messages)

#### AWS Bedrock Guardrail

Primary text guardrail using AWS Bedrock `ApplyGuardrail` API. Requires `BEDROCK_GUARDRAIL_ID` and valid AWS credentials in `.env`. Falls back to local patterns if unavailable.

#### Local Pattern-Based Guardrail

The built-in text guardrail detects the following categories without any external service:

| Category | Example triggers |
|---|---|
| Prompt injection | "ignore previous instructions", "忽略你的指令", "jailbreak", "DAN" |
| PII / data exfiltration | "API key", "密碼", "列出所有使用者資料" |
| Abuse / profanity | "幹你娘", "fuck you", "kill yourself" |
| Violence / crime | "搶劫", "製作炸彈", "殺人", "綁架", "毒品", "賭博" |
| Code injection | `DROP TABLE`, `<script>`, `UNION SELECT`, `1=1` |
| Expense fraud | "幫我多報金額", "虛報費用", "不要留下紀錄" |

When triggered, the conversation shows an inline guardrail message and an orange warning popup (auto-dismiss after 8 seconds).

> For a detailed risk assessment and edge case analysis, see [GUARDRAIL_RISKS.md](GUARDRAIL_RISKS.md).

### Real-time STT Form Mode

- Live transcription populates the **active field**
- Smart parsing: Chinese numerals, dates, ride type keywords
- Voice commands: "下一個" (next), "上一個" (previous)
- Block-based field navigation with floating mobile buttons

### Request Logs

- Session-level unified view with WebSocket event history
- Per-request: token usage, cost breakdown, audio token accounting
- Expandable payload and event timeline views

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | (required) | OpenAI API key |
| `OPENAI_REALTIME_MODEL` | `gpt-4o-realtime-preview-2024-12-17` | Default Realtime API model |
| `OPENAI_BETA_HEADER` | `realtime=v1` | OpenAI-Beta header value |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1` | Transcription model (Realtime API native) |
| `OPENAI_TRANSCRIBE_LANG` | `zh` | Transcription language |
| `OPENAI_TRANSCRIBE_PROMPT` | (empty) | Whisper prompt for domain-specific terms |
| **Guardrail** | | |
| `BEDROCK_GUARDRAIL_ID` | (empty) | AWS Bedrock Guardrail ID (primary text guardrail) |
| `BEDROCK_GUARDRAIL_VERSION` | `DRAFT` | Bedrock Guardrail version |
| `AWS_DEFAULT_REGION` | `us-west-2` | AWS region for Bedrock |
| `AWS_ACCESS_KEY_ID` | (empty) | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | (empty) | AWS credentials |
| `AWS_SESSION_TOKEN` | (empty) | AWS STS session token (temporary credentials) |
| `GUARDRAIL_WS_URL` | (empty) | Audio guardrail WebSocket URL (Mode 1) |
| `GUARDRAIL_API_KEY` | (empty) | Audio guardrail service API key |
| `GUARDRAIL_BLOCK_KEYWORDS` | (empty) | Additional comma-separated blocked keywords |

## Available Realtime Models

Pricing sourced from OpenAI (via LiteLLM model registry, March 2025):

| Model | Text In/Out (per 1M) | Audio In/Out (per 1M) |
|---|---|---|
| `gpt-4o-realtime-preview-2024-12-17` | $5.50 / $22.00 | $44.00 / $80.00 |
| `gpt-4o-realtime-preview-2024-10-01` | $5.50 / $22.00 | $110.00 / $220.00 |
| `gpt-4o-mini-realtime-preview-2024-12-17` | $0.66 / $2.64 | $11.00 / $22.00 |

The model can be selected from the dropdown in the UI before starting a session.

## Quick Start

### Step 1: Install dependencies

```bash
uv sync
```

### Step 2: Configure `.env`

```env
# Required
OPENAI_API_KEY=sk-proj-...

# Audio Guardrail (Mode 1)
GUARDRAIL_API_KEY=your-api-key
GUARDRAIL_WS_URL=ws://your-server:8889/ws/audio/guardrails
```

### Step 3: Start LiteLLM Proxy

```bash
uv run python start_litellm.py &
```

### Step 4: Start FastAPI

```bash
uv run uvicorn app.main:app --reload --port 8000
```

### Step 5: Open browser

- Form page: http://localhost:8000/
- Request logs: http://localhost:8000/logs.html

Text guardrail runs through LiteLLM → Bedrock. Check the **Guardrail** checkbox for additional audio guardrail features.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/requests` | Submit form (STT or Conversation mode) |
| `GET` | `/api/requests` | List all submitted requests |
| `GET` | `/api/requests/:id` | Get single request detail |
| `DELETE` | `/api/requests/:id` | Delete a request |
| `GET` | `/api/sessions` | List unified sessions (WS + requests) |
| `GET` | `/api/ws-sessions` | List WebSocket sessions |
| `GET` | `/api/ws-sessions/:conn_id/events` | Get events for a WS session |
| `GET` | `/api/models` | List available Realtime models with pricing |
| `GET` | `/api/guardrail-info` | Get guardrail endpoint configuration |
| `POST` | `/api/client-errors` | Log frontend errors |

## WebSocket Endpoints

| Path | Description |
|---|---|
| `/ws/realtime` | Conversation mode — full duplex audio + text + tools |
| `/ws/realtime?guardrail=pre_check` | Conversation + Mode 1 (audio input guardrail) |
| `/ws/realtime?guardrail=post_check` | Conversation + Mode 2 (transcript input guardrail) |
| `/ws/realtime?model=<model_id>` | Conversation with specific Realtime model |
| `/ws/realtime-stt` | STT-only mode — transcription only |
