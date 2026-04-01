# Speech Form Filling System — Architecture Overview

## System Architecture

```mermaid
graph TB
    subgraph Browser["Browser"]
        UI["HTML / JS UI"]
        AW["AudioWorklet\nPCM16 24kHz"]
    end

    subgraph App["FastAPI :8000"]
        Proxy["WebSocket Proxy"]
        Logic["App Logic\nForm / Tool Calling"]
        LocalGR["Local Keyword\nGuardrail"]
        GemmaStream["Gemma Audio\nStreaming"]
        DB["SQLite\nLogs / Tokens / Cost"]
    end

    subgraph Proxy_LLM["LiteLLM Proxy :4000"]
        Router["Model Router"]
        BedrockHook["Bedrock Guardrail\npre_call hook"]
    end

    subgraph RealtimeAPI["OpenAI Realtime API (single WebSocket)"]
        GPT4o["GPT-4o\nConversation + TTS"]
        VAD["Server VAD\nSpeech Detection"]
        Transcribe["gpt-4o-transcribe\nInput Transcription"]
    end

    subgraph ExternalGR["External Guardrail Services"]
        Bedrock["AWS Bedrock\nText Guardrail\n(optional, fail-open)"]
        Gemma["Gemma\nAudio Guardrail\nWS Server"]
    end

    UI <-->|"WebSocket\naudio + events"| Proxy
    AW -->|"PCM16 base64"| Proxy
    Proxy <-->|"WebSocket"| Router
    GemmaStream -->|"PCM16 16kHz\nreal-time stream"| Gemma

    Router <-->|"single Realtime WS"| GPT4o
    VAD -->|"speech_started\nspeech_stopped"| GPT4o
    VAD -->|"audio segments"| Transcribe
    Transcribe -->|"transcription.delta\ntranscription.completed"| Router

    LocalGR -.->|"Bedrock check\n(if available)"| BedrockHook
    BedrockHook -.->|"ApplyGuardrail API"| Bedrock

    Proxy --> Logic
    Logic --> DB

    style Browser fill:#f0fdf4,stroke:#16a34a,color:#14532d
    style App fill:#eff6ff,stroke:#2563eb,color:#1e3a5f
    style Proxy_LLM fill:#fef3c7,stroke:#d97706,color:#78350f
    style RealtimeAPI fill:#f5f3ff,stroke:#7c3aed,color:#4c1d95
    style ExternalGR fill:#fdf2f8,stroke:#be185d,color:#831843
```

### OpenAI Realtime API — Internal Components

All processing happens within a **single WebSocket connection**. No separate API calls needed.

| Component | Role | Events |
|-----------|------|--------|
| **Server VAD** | Detects speech start/end, segments audio | `speech_started`, `speech_stopped`, `committed` |
| **gpt-4o-transcribe** | Transcribes segmented audio to text | `transcription.delta`, `transcription.completed` |
| **GPT-4o** | Understands context, generates response + TTS | `response.audio.delta`, `response.audio_transcript.delta` |

Configured via `session.update`:
```json
{
  "input_audio_transcription": {
    "model": "gpt-4o-transcribe",
    "language": "zh"
  },
  "turn_detection": {
    "type": "server_vad",
    "create_response": false
  }
}
```

- `input_audio_transcription.model` — which model transcribes user speech (no separate API call)
- `turn_detection.create_response` — `false` when guardrail is on (manually send `response.create` after check); `true` when guardrail is off (auto-respond)

---

## Guardrail Modes

| | Mode 1 `pre_check` | Mode 2 `post_check` | Guardrail OFF |
|---|---|---|---|
| **Input** | Gemma audio (real-time) + Local keyword fallback | Local keywords (instant) + Bedrock (fail-open) | No check |
| **Output** | Bedrock only (no local keywords) | Bedrock only (no local keywords) | No check |
| **create_response** | `false` (manual) | `false` (manual) | `true` (auto) |
| **Input latency** | ~0ms (parallel audio stream) + instant keyword check | ~1ms (local) + ~200-500ms (Bedrock, pre-flight optimized) | 0ms |

> Output guardrail skips local keywords to avoid false-blocking AI refusal messages (e.g. "I cannot help with bombs" contains "bombs").

---

## Sequence Diagram — Mode 1 (Audio Input Guardrail)

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant FastAPI as FastAPI :8000
    participant Gemma as Gemma WS Server
    participant LiteLLM as LiteLLM :4000
    participant OpenAI as OpenAI Realtime

    User ->> Browser: Voice input
    Browser ->> FastAPI: input_audio_buffer.append (PCM16 24kHz)

    par Parallel processing
        FastAPI ->> Gemma: PCM16 16kHz (resampled)
        FastAPI ->> LiteLLM: Forward audio
        LiteLLM ->> OpenAI: Forward audio
    end

    Gemma -->> FastAPI: {"status": "SAFE/UNSAFE"}
    FastAPI -->> Browser: guardrail_chat (Gemma Audio result)

    OpenAI -->> LiteLLM: transcription.completed
    LiteLLM -->> FastAPI: Forward transcript
    FastAPI -->> Browser: user_delta + user_done

    note over FastAPI: Local keyword fallback check (instant)

    FastAPI ->> LiteLLM: response.create
    LiteLLM ->> OpenAI: response.create

    OpenAI -->> LiteLLM: response.audio_transcript.done
    note over FastAPI: Output Bedrock check (background)
    FastAPI -->> Browser: guardrail_chat (output result)
```

---

## Sequence Diagram — Mode 2 (Text Input Guardrail)

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant FastAPI as FastAPI :8000
    participant LiteLLM as LiteLLM :4000
    participant OpenAI as OpenAI Realtime API

    User ->> Browser: Voice input
    Browser ->> FastAPI: input_audio_buffer.append (PCM16 24kHz)
    FastAPI ->> LiteLLM: Forward audio
    LiteLLM ->> OpenAI: Forward audio

    rect rgb(245, 243, 255)
        note over OpenAI: Inside Realtime API (single WS)
        note over OpenAI: Server VAD detects speech end
        note over OpenAI: gpt-4o-transcribe processes audio segment
        OpenAI -->> FastAPI: transcription.delta (partial text)
        note over FastAPI: Pre-flight guardrail fires (≥3 chars)
        OpenAI -->> FastAPI: transcription.completed (full text)
    end

    FastAPI -->> Browser: user_delta + user_done

    rect rgb(254, 243, 199)
        note over FastAPI: Input text guardrail check
        note over FastAPI: Local keywords (instant) + Bedrock (fail-open)
        FastAPI -->> Browser: guardrail_chat: input result
    end

    note over FastAPI: create_response: false → manual trigger
    FastAPI ->> LiteLLM: response.create
    LiteLLM ->> OpenAI: response.create

    rect rgb(245, 243, 255)
        note over OpenAI: GPT-4o generates response + TTS
        OpenAI -->> FastAPI: response.audio.delta (streaming)
        OpenAI -->> FastAPI: response.audio_transcript.done
    end

    note over FastAPI: Output Bedrock check (background)
    FastAPI -->> Browser: guardrail_chat: output result
```

> **Note:** `gpt-4o-transcribe` and `GPT-4o` are **independent models** running inside the same Realtime API WebSocket. The transcript is generated separately from the model's understanding. Even if transcription is inaccurate, GPT-4o still processes the **original audio** directly and may respond correctly.

---

## Sequence Diagram — No Guardrail

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant FastAPI as FastAPI :8000
    participant LiteLLM as LiteLLM :4000
    participant OpenAI as OpenAI Realtime

    User ->> Browser: Voice input
    Browser ->> FastAPI: input_audio_buffer.append
    FastAPI ->> LiteLLM: Forward audio
    LiteLLM ->> OpenAI: Forward audio

    note over OpenAI: VAD detects silence
    note over OpenAI: create_response: true → auto-respond

    OpenAI -->> FastAPI: transcription.completed
    FastAPI -->> Browser: user_delta + user_done

    OpenAI -->> FastAPI: response.audio.delta (streaming)
    FastAPI -->> Browser: audio_delta + agent_delta
```

---

## Sequence Diagram — Function Calling (submit_form)

```mermaid
sequenceDiagram
    participant Browser
    participant FastAPI as FastAPI :8000
    participant OpenAI as OpenAI Realtime

    OpenAI -->> FastAPI: response.function_call_arguments.done
    note over FastAPI: Parse form payload (JSON)

    FastAPI -->> Browser: form_ready (payload + meta)
    note over Browser: Populate form fields with animation

    FastAPI ->> OpenAI: conversation.item.create (function_call_output)
    FastAPI ->> OpenAI: response.create
    OpenAI -->> FastAPI: AI confirms submission
```

---

## Text Guardrail — Two-Layer Check

```
Input text
   │
   ▼
Layer 1: Local keyword patterns (instant, always available)
   ├── Prompt injection (Chinese + English)
   ├── Data exfiltration / PII
   ├── Abuse / profanity (繁體 + 簡體 + English)
   ├── Violence / crime (繁體 + 簡體)
   ├── Expense fraud
   ├── Code injection
   └── Custom keywords (GUARDRAIL_BLOCK_KEYWORDS env)
   │
   ├─ BLOCKED → return immediately
   │
   ▼
Layer 2: Bedrock via LiteLLM (optional, fail-open)
   │
   ├─ BLOCKED → return
   ├─ ERROR → allow (fail-open)
   │
   ▼
PASSED
```

---

## Component Responsibilities

| Component | Type | Responsibilities |
|-----------|------|-----------------|
| **FastAPI** (:8000) | App server | UI, WebSocket proxy, Gemma audio streaming, local keyword guardrail, form logic, logs, `create_response` control |
| **LiteLLM** (:4000) | AI proxy | Model routing, Bedrock guardrail pre_call hook |
| **Gemma WS Server** | External WS | Audio-level safety (multimodal Gemma model) |
| **Bedrock Guardrail** | External API | Text safety — semantic understanding (optional, fail-open) |
| **OpenAI Realtime API** | External service | Speech understanding, AI conversation, TTS |

---

## Key Files

| File | Purpose |
|------|---------|
| `app/main.py` | FastAPI: WebSocket proxy, Gemma streaming, text guardrail orchestration, form, logs |
| `app/guardrails.py` | Local keyword patterns (繁體 + 簡體) + Bedrock integration |
| `audio_guardrail.py` | LiteLLM callback (no-op, kept for config compatibility) |
| `litellm_config.yaml` | LiteLLM: model routing + Bedrock guardrail registration |
| `start_litellm.py` | LiteLLM startup script |
| `static/app.js` | Frontend: audio capture, chat UI, form, guardrail display |
| `.env` | API keys, Bedrock config, Gemma WS URL |

---

## Startup

```bash
# 1. Start LiteLLM Proxy
uv run python start_litellm.py &

# 2. Start FastAPI
uv run uvicorn app.main:app --reload --port 8000
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API key (used by LiteLLM) |
| `LITELLM_PROXY_URL` | LiteLLM proxy URL (default: `ws://localhost:4000`) |
| `LITELLM_MASTER_KEY` | LiteLLM auth key |
| `GUARDRAIL_WS_URL` | Gemma audio guardrail WS URL (Mode 1) |
| `GUARDRAIL_API_KEY` | Gemma audio guardrail API key |
| `GUARDRAIL_BLOCK_KEYWORDS` | Additional comma-separated blocked keywords |
| `BEDROCK_GUARDRAIL_ID` | Bedrock guardrail ID (optional, fail-open) |
| `BEDROCK_GUARDRAIL_VERSION` | Bedrock guardrail version |
| `AWS_*` | AWS credentials (for Bedrock) |

---

## Risk Assessment

See [GUARDRAIL_RISKS.md](GUARDRAIL_RISKS.md) for details.
