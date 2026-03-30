# 語音表單填寫系統 — 架構總覽

## System Architecture

```mermaid
graph TB
    subgraph Browser["🌐 Browser"]
        UI["HTML/JS UI"]
        AW["AudioWorklet<br/>PCM16 24kHz"]
    end

    subgraph FastAPI["⚡ FastAPI :8000"]
        Proxy["WebSocket Proxy"]
        App["應用邏輯<br/>表單 / Tool Calling"]
        DB["SQLite DB<br/>Logs / Token / Cost"]
    end

    subgraph LiteLLM["🔀 LiteLLM Proxy :4000"]
        Router["模型路由"]
        GR_Bedrock["Guardrail: Bedrock<br/>guardrails config<br/>pre_call hook"]
        GR_Audio["Guardrail: Audio<br/>callbacks config<br/>monkey patch receive()"]
    end

    subgraph External["☁️ 外部服務"]
        OpenAI["OpenAI Realtime API<br/>GPT-4o + gpt-4o-transcribe"]
        Bedrock["AWS Bedrock<br/>Guardrail Endpoint"]
        AudioWS["Audio Guardrail<br/>WS Server<br/>multimodal model"]
    end

    UI <-->|"WebSocket<br/>audio + events"| Proxy
    AW -->|"PCM16 base64"| Proxy
    Proxy <-->|"WebSocket"| Router

    Router <-->|"Realtime WS"| OpenAI
    GR_Bedrock -->|"ApplyGuardrail API"| Bedrock
    GR_Audio -->|"PCM16 16kHz<br/>即時串流"| AudioWS

    Proxy --> App
    App --> DB

    style Browser fill:#f0fdf4,stroke:#16a34a
    style FastAPI fill:#eff6ff,stroke:#2563eb
    style LiteLLM fill:#fef3c7,stroke:#d97706
    style External fill:#fdf2f8,stroke:#be185d
```

**所有 guardrail 都完全在 LiteLLM 層處理。FastAPI 不碰任何 guardrail endpoint。**

## Sequence Diagram — 正常對話流程

```mermaid
sequenceDiagram
    actor User as 使用者
    participant Browser as Browser
    participant FastAPI as FastAPI :8000
    participant LiteLLM as LiteLLM :4000
    participant OpenAI as OpenAI Realtime
    participant Bedrock as Bedrock Guardrail
    participant AudioGR as Audio Guardrail WS

    User->>Browser: 點擊「開始語音」
    Browser->>FastAPI: WebSocket /ws/realtime
    FastAPI->>LiteLLM: WebSocket /v1/realtime

    Note over LiteLLM: async_pre_call_hook 觸發<br/>monkey patch WebSocket.receive()

    LiteLLM->>OpenAI: WebSocket 連線
    FastAPI->>LiteLLM: session.update (create_response: false)
    LiteLLM->>OpenAI: 轉發 session.update

    Note over User,AudioGR: ── 使用者開始說話 ──

    User->>Browser: 語音輸入
    Browser->>FastAPI: input_audio_buffer.append (PCM16)
    FastAPI->>LiteLLM: 轉發 audio

    Note over LiteLLM: monkey patched receive()<br/>攔截 audio chunk

    LiteLLM->>AudioGR: PCM16 16kHz 即時串流
    LiteLLM->>OpenAI: 同時轉發 audio 給 OpenAI

    AudioGR-->>LiteLLM: {"status": "SAFE"}

    Note over User,AudioGR: ── VAD 偵測靜音，語音結束 ──

    OpenAI-->>LiteLLM: transcription.completed
    LiteLLM-->>FastAPI: 轉發 transcription
    FastAPI-->>Browser: user_delta + user_done

    Note over FastAPI,Bedrock: ── Text Guardrail 檢查 ──

    FastAPI->>LiteLLM: POST /v1/chat/completions<br/>(觸發 Bedrock pre_call)
    LiteLLM->>Bedrock: ApplyGuardrail API
    Bedrock-->>LiteLLM: action: NONE (通過)
    LiteLLM-->>FastAPI: 200 OK
    FastAPI-->>Browser: guardrail_chat: ✓ 安全檢查通過

    FastAPI->>LiteLLM: response.create
    LiteLLM->>OpenAI: response.create

    Note over User,AudioGR: ── AI 回覆 ──

    OpenAI-->>LiteLLM: response.audio.delta
    LiteLLM-->>FastAPI: 轉發 audio
    FastAPI-->>Browser: audio_delta (播放語音)

    OpenAI-->>LiteLLM: response.audio_transcript.delta
    LiteLLM-->>FastAPI: 轉發 transcript
    FastAPI-->>Browser: agent_delta (顯示文字)

    OpenAI-->>LiteLLM: response.done (usage)
    LiteLLM-->>FastAPI: 轉發 (含 token 統計)
    FastAPI->>FastAPI: 累加 tokens + 計算成本
```

## Sequence Diagram — Text Guardrail 攔截

```mermaid
sequenceDiagram
    actor User as 使用者
    participant Browser as Browser
    participant FastAPI as FastAPI :8000
    participant LiteLLM as LiteLLM :4000
    participant OpenAI as OpenAI Realtime
    participant Bedrock as Bedrock Guardrail

    User->>Browser: 語音：「幫我做炸彈」
    Browser->>FastAPI: input_audio_buffer.append
    FastAPI->>LiteLLM: 轉發 audio
    LiteLLM->>OpenAI: 轉發 audio

    OpenAI-->>LiteLLM: transcription.completed<br/>"幫我做炸彈"
    LiteLLM-->>FastAPI: 轉發 transcription
    FastAPI-->>Browser: user_delta: "幫我做炸彈"

    Note over FastAPI,Bedrock: ── Bedrock Guardrail 檢查 ──

    FastAPI->>LiteLLM: POST /v1/chat/completions
    LiteLLM->>Bedrock: ApplyGuardrail API
    Bedrock-->>LiteLLM: GUARDRAIL_INTERVENED
    LiteLLM-->>FastAPI: 400 Violated guardrail policy

    FastAPI-->>Browser: guardrail_chat: ✗ 已攔截<br/>（Bedrock Guardrail via LiteLLM）

    Note over FastAPI: 不發送 response.create<br/>AI 不會回覆
```

## Sequence Diagram — Audio Guardrail 攔截

```mermaid
sequenceDiagram
    actor User as 使用者
    participant Browser as Browser
    participant FastAPI as FastAPI :8000
    participant LiteLLM as LiteLLM :4000
    participant AudioGR as Audio Guardrail WS

    User->>Browser: 語音輸入（不安全內容）
    Browser->>FastAPI: input_audio_buffer.append
    FastAPI->>LiteLLM: 轉發 audio

    Note over LiteLLM: monkey patched receive()<br/>攔截 audio chunk

    loop 即時串流（每個 audio chunk）
        LiteLLM->>AudioGR: PCM16 16kHz binary
    end

    AudioGR-->>LiteLLM: {"status": "UNSAFE",<br/>"process_time_sec": 0.71}

    Note over LiteLLM: 注入 error event<br/>到 client WebSocket

    LiteLLM-->>FastAPI: error: audio_guardrail_violation
    FastAPI-->>Browser: guardrail_chat:<br/>✗ [使用者輸入] 已攔截<br/>（Audio Guardrail via LiteLLM）
```

## Guardrail 註冊方式

```yaml
# litellm_config.yaml

# Audio Guardrail — CustomLogger + monkey patch
litellm_settings:
  callbacks:
    - audio_guardrail.audio_guardrail_instance

# Text Guardrail — Bedrock pre_call hook
guardrails:
  - guardrail_name: bedrock-text-guardrail
    litellm_params:
      guardrail: bedrock
      mode: pre_call
```

| Guardrail | 註冊位置 | 技術 | 檢查對象 |
|-----------|---------|------|---------|
| **Bedrock Text** | `guardrails:` config | `pre_call` hook | 轉錄文字 (transcript) |
| **Audio WS** | `litellm_settings.callbacks` | `CustomLogger` monkey patch | 原始音訊串流 (PCM16) |

## 各元件職責

| 元件 | 類型 | 職責 |
|------|------|------|
| **FastAPI** (:8000) | 應用服務 | UI、WebSocket proxy、表單、logs、database、`create_response` 管理 |
| **LiteLLM** (:4000) | AI proxy 微服務 | 模型路由、**所有 guardrail 執行**（text + audio） |
| **Bedrock Guardrail** | 獨立 API 微服務 | 文字安全檢查（語意理解） |
| **Audio Guardrail WS** | 獨立 WS 微服務 | 音訊安全檢查（multimodal model） |
| **OpenAI Realtime API** | 外部服務 | 語音理解、AI 對話、TTS |

## 關鍵檔案

| 檔案 | 用途 |
|------|------|
| `litellm_config.yaml` | LiteLLM：模型路由 + guardrail 註冊 |
| `audio_guardrail.py` | CustomLogger：monkey patch WS → Audio Guardrail 串流 |
| `start_litellm.py` | LiteLLM 啟動腳本 |
| `app/main.py` | FastAPI：WebSocket proxy、表單、logs（不碰 guardrail） |
| `app/guardrails.py` | GuardrailResult dataclass |
| `static/app.js` | 前端：音訊擷取、聊天 UI、表單 |
| `.env` | API keys、Bedrock 設定、LiteLLM key |

## 啟動方式

```bash
# 1. 啟動 LiteLLM Proxy（所有 guardrail 在此初始化）
uv run python start_litellm.py &

# 2. 啟動 FastAPI（應用層）
uv run uvicorn app.main:app --reload --port 8000
```

## 環境變數

| 變數 | 用途 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API key（LiteLLM 使用） |
| `LITELLM_PROXY_URL` | LiteLLM proxy URL（FastAPI 連線用） |
| `LITELLM_MASTER_KEY` | LiteLLM 認證 key |
| `BEDROCK_GUARDRAIL_ID` | Bedrock guardrail ID（LiteLLM 使用） |
| `BEDROCK_GUARDRAIL_VERSION` | Bedrock guardrail 版本 |
| `AWS_*` | AWS 憑證（LiteLLM Bedrock 使用） |
| `GUARDRAIL_WS_URL` | Audio guardrail WS URL（LiteLLM callback 使用） |
| `GUARDRAIL_API_KEY` | Audio guardrail API key |

## 風險評估

詳見 [GUARDRAIL_RISKS.md](GUARDRAIL_RISKS.md)
