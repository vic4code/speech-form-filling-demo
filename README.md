# Speech Form Filling Demo

## Overview

A voice-first web application for completing taxi expense reimbursement forms. Users can fill forms via real-time speech-to-text or conversational AI, with optional **Guardrail** safety checks powered by LiteLLM.

The application provides **two voice-driven modes** via tabs:

1. **Real-time STT Form Mode**: Streaming speech-to-text fills form fields in sequence with block-level focus and voice navigation.
2. **Conversation Mode**: A Realtime voice agent guides the user through the form via natural dialogue. The conversation produces structured output that **automatically populates a live form preview** alongside the chat, then submits as a request.

After submission, users are redirected to a **Request Log page** with token usage, cost tracking, and WebSocket event history.

## Architecture

```
┌─────────────┐        WebSocket         ┌──────────────┐       WebSocket        ┌─────────────────┐
│  Browser UI  │ ◄─────────────────────► │  FastAPI      │ ◄──────────────────► │  OpenAI Realtime │
│  (HTML/JS)   │   audio + events        │  Server       │   audio + events      │  API             │
└─────────────┘                          │              │                       └─────────────────┘
                                         │  ┌──────────┐│
                                         │  │Guardrails││       HTTP/WS         ┌─────────────────┐
                                         │  │ Module   ││ ◄──────────────────► │  LiteLLM Proxy   │
                                         │  └──────────┘│                       │  (optional)      │
                                         └──────────────┘                       └─────────────────┘
```

## Features

### Conversation Mode with Live Form Preview

The conversation tab uses a **split layout**:
- **Left panel**: Chat dialogue with the AI agent + structured JSON output
- **Right panel**: Live form preview that auto-populates when the agent completes the form

When the agent calls `submit_form`, the structured output fills both the JSON textarea and the visual form fields (date, ride type, ride rows, total fare, notes), giving the user a clear preview before submission.

### Guardrail Integration

Two guardrail modes protect against unsafe or policy-violating content. Both modes share the **same output text guardrail**; they only differ in how **input** is checked.

#### Mode 1: Input Audio Guardrail + Output Text Guardrail

Input 檢查方式：將 **原始音訊** 送到外部 Guardrail WebSocket 端點 (`GUARDRAIL_WS_URL`) 進行檢查。

```
User Audio ──► buffer per speech turn
                    │
                    ▼  (buffer committed)
              Audio Guardrail WS ◄── ws://guardrail-server/ws/audio/guardrails
                    │
              ┌─────┴─────┐
              │ Pass      │ Block
              ▼           ▼
        Forward to    Cancel response
        Realtime API      │
              │           ▼
              │     Notify user "已攔截"
              ▼
        Agent Output ──► Output Text Guardrail (via LiteLLM)
                              │
                        ┌─────┴─────┐
                        │ Pass      │ Block
                        ▼           ▼
                   Forward     Show blocked msg
```

#### Mode 2: Input Transcript Guardrail + Output Text Guardrail

Input 檢查方式：音訊直接送 Realtime API，拿到 `input_audio_transcription.completed` 的 **transcript 文字** 再過 text guardrail。

```
User Audio ──► Realtime API (直接送)
                    │
                    ▼  (transcription completed)
              Input Text Guardrail (via LiteLLM)
                    │
              ┌─────┴─────┐
              │ Pass      │ Block
              ▼           ▼
         Forward to    Show "[已攔截]"
         chat            in chat
              │
              ▼
        Agent Output ──► Output Text Guardrail (via LiteLLM)  ← 同 Mode 1
                              │
                        ┌─────┴─────┐
                        │ Pass      │ Block
                        ▼           ▼
                   Forward     Show blocked msg
```

#### Output Guardrail（兩個模式共用）

不論 Mode 1 或 Mode 2，Agent 的回應 transcript (`response.audio_transcript.done`) 都會經過 **Output Text Guardrail**（透過 LiteLLM `/v1/chat/completions` + guardrail headers）。

#### Guardrail Fallback

When LiteLLM is not configured, a **local keyword-based guardrail** can be used via the `GUARDRAIL_BLOCK_KEYWORDS` environment variable (comma-separated list).

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
| `OPENAI_REALTIME_URL` | `wss://api.openai.com/v1/realtime?model=gpt-realtime` | Realtime API WebSocket URL |
| `OPENAI_BETA_HEADER` | `realtime=v1` | OpenAI-Beta header value |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | Transcription model |
| `OPENAI_TRANSCRIBE_LANG` | `zh` | Transcription language |
| `OPENAI_TRANSCRIBE_PROMPT` | (empty) | Optional transcription prompt |
| `COST_PER_1K_INPUT` | `0.004` | Text input token cost per 1K |
| `COST_PER_1K_OUTPUT` | `0.016` | Text output token cost per 1K |
| `AUDIO_COST_PER_1K_INPUT` | `0.032` | Audio input token cost per 1K |
| `AUDIO_COST_PER_1K_OUTPUT` | `0.064` | Audio output token cost per 1K |
| `AUDIO_TOKENS_PER_SECOND` | `10` | Audio tokens per second estimate |
| **Guardrail Variables** | | |
| `LITELLM_BASE_URL` | (empty) | LiteLLM proxy base URL (e.g. `http://localhost:4000`) |
| `LITELLM_API_KEY` | (empty) | LiteLLM proxy API key |
| `LITELLM_MASTER_KEY` | (empty) | LiteLLM proxy master key |
| `LITELLM_GUARDRAIL_NAME` | (empty) | Guardrail name(s) to apply (sent as `x-litellm-guardrails` header) |
| `LITELLM_TEXT_MODEL` | `gpt-4o-mini` | Model for text guardrail checks |
| `GUARDRAIL_API_KEY` | (empty) | External audio guardrail service API key |
| `GUARDRAIL_WS_URL` | (empty) | External audio guardrail WebSocket URL |
| `GUARDRAIL_BLOCK_KEYWORDS` | (empty) | Comma-separated keywords for local fallback guardrail |

## Quick Start

> 所有服務都透過 `uv` 管理，不需要另外 `pip install`。

### Step 1: 安裝依賴

```bash
uv sync
```

### Step 2: 設定 `.env`

```env
# 必要
OPENAI_API_KEY=sk-proj-...

# LiteLLM (text guardrail 用)
LITELLM_BASE_URL=http://localhost:4000
LITELLM_MASTER_KEY=sk-master-key-1234
LITELLM_GUARDRAIL_NAME=my-guardrail
LITELLM_TEXT_MODEL=gpt-4o-mini

# 外部 Audio Guardrail WebSocket (Mode 1 用)
GUARDRAIL_API_KEY=your-api-key
GUARDRAIL_WS_URL=ws://your-server:8889/ws/audio/guardrails
```

### Step 3: 啟動服務（需要兩個 Terminal）

**Terminal 1 — LiteLLM Proxy (port 4000)**

```bash
LITELLM_CONFIG_FILE=litellm_config.yaml uv run uvicorn litellm.proxy.proxy_server:app --port 4000 --loop asyncio
```

> 如果看到 `Uvicorn running on http://0.0.0.0:4000` 表示啟動成功。

**Terminal 2 — App (port 8000)**

```bash
uv run uvicorn app.main:app --reload --port 8000
```

### Step 4: 開啟瀏覽器

- 表單頁面: http://localhost:8000/
- 請求紀錄: http://localhost:8000/logs.html

預設會進入 **Conversation 模式**。勾選 Guardrail checkbox 可啟用安全檢查。

### 只跑 App（不需要 Guardrail）

如果不需要 Guardrail 功能，只開一個 Terminal：

```bash
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

不勾選 UI 上的 Guardrail checkbox 即可正常使用。

## LiteLLM Config

專案根目錄的 `litellm_config.yaml` 已預設好：

```yaml
model_list:
  - model_name: gpt-4o-mini
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY

guardrails:
  - guardrail_name: my-guardrail
    litellm_params:
      guardrail: aporia        # 替換為你的 guardrail provider
      mode: [pre_call, post_call]
      default_on: true
```

可根據需求替換 guardrail provider（支援 Aporia、Lakera、Presidio、自訂 Python class 等）。
詳見 [LiteLLM Guardrails 文件](https://docs.litellm.ai/docs/proxy/guardrails)。

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
| `POST` | `/api/client-errors` | Log frontend errors |

## WebSocket Endpoints

| Path | Description |
|---|---|
| `/ws/realtime` | Conversation mode — full duplex audio + text + tools |
| `/ws/realtime?guardrail=pre_check` | Conversation mode with Mode 1 guardrails |
| `/ws/realtime?guardrail=post_check` | Conversation mode with Mode 2 guardrails |
| `/ws/realtime-stt` | STT-only mode — transcription only |
