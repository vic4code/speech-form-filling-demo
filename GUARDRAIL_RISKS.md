# Guardrail Risk Assessment & Interaction Analysis

> Last updated: 2026-03-31

## Architecture Overview

```
User Voice
   │
   ▼
AudioWorklet (browser-side noise suppression + echo cancellation)
   │
   ▼ PCM16 24kHz
FastAPI Proxy → LiteLLM Proxy
   │
   ├──► OpenAI Realtime API (transcription + GPT-4o response)
   │         │
   │         ▼ transcription.completed (Mode 2 only)
   │    ┌───────────────────────────────────────┐
   │    │  Input Text Guardrail                 │
   │    │  1. Local Keyword Patterns (instant)  │
   │    │  2. AWS Bedrock (optional, fail-open) │
   │    └────────┬────────────────┬─────────────┘
   │          PASSED           BLOCKED
   │             │                │
   │       response.create    Show blocked message
   │             │            AI response NOT triggered
   │             ▼
   │       AI response generated
   │             │
   │             ▼ audio_transcript.done (Both modes)
   │    ┌───────────────────────────────────────┐
   │    │  Output Text Guardrail                │
   │    │  1. Local Keyword Patterns (instant)  │
   │    │  2. AWS Bedrock (optional, fail-open) │
   │    └────────┬────────────────┬─────────────┘
   │          PASSED           BLOCKED
   │             │                │
   │       Forward to client   Show blocked message
   │
   └──► (Mode 1) Audio Guardrail WS → Gemma model
        Real-time audio stream check (parallel with transcription)
```

## Guardrail Layers

| Layer | Technology | Target | Activation |
|-------|-----------|--------|------------|
| **L1: Local Keywords** | Python `re` regex patterns | User input text + AI output text | Always on (when guardrail enabled) |
| **L2: Bedrock Guardrail** | AWS Bedrock `ApplyGuardrail` API | User input text + AI output text | Optional, fail-open if unavailable |
| **L3: Gemma Audio** | External WebSocket service (Gemma model) | Real-time audio stream | Mode 1 only, via LiteLLM monkey patch |
| **L4: OpenAI Built-in Safety** | GPT-4o internal safety filters | All content | Always on (OpenAI-side) |

### Check Logic per Mode

**Mode 1 (Audio Input):**
1. Input: Gemma audio guardrail checks raw audio in parallel
2. Output: Local keywords + Bedrock check agent transcript

**Mode 2 (Text Input):**
1. Input: Local keywords check first (instant) → if passed, Bedrock check (fail-open)
2. If BLOCKED → `response.create` not sent → AI does not respond
3. Output: Same as Mode 1

**Output (both modes):**
1. Local keywords check (instant)
2. Bedrock check (if available, fail-open)
3. Runs as background task — does not block audio playback

---

## Known Risks & Edge Cases

### Severity Definitions
- **High**: May allow unsafe content through, data leakage, or system bypass
- **Medium**: May affect user experience but not a security threat
- **Low**: Known limitations with minimal real-world impact

---

### High Severity

#### H1: AWS Session Token Expiration
- **Scenario**: `AWS_SESSION_TOKEN` in `.env` is a temporary STS credential that expires
- **Impact**: Bedrock Guardrail layer disabled, falls back to local keyword patterns only
- **Detection**: Server log shows `[guardrail] Bedrock unavailable`
- **Mitigation**:
  - Local keyword patterns provide baseline protection even without Bedrock
  - Consider using IAM Roles (EC2/ECS) or long-term Access Keys
  - Monitor server logs for Bedrock connection status

#### H2: Bedrock Guardrail ID Not Found
- **Scenario**: `BEDROCK_GUARDRAIL_ID` does not exist in the configured AWS region
- **Impact**: Same as H1 — Bedrock layer silently disabled, local patterns remain active
- **Detection**: Server log shows `[guardrail] Bedrock unavailable (status)` or Bedrock returns ValidationException
- **Mitigation**: Verify guardrail ID exists via `aws bedrock list-guardrails --region <region>`

---

### Medium Severity

#### M1: Whisper Misrecognition Bypassing Text Guardrail
- **Scenario**: User says "幫我做炸彈", Whisper transcribes as "幫我做炸蛋"
- **Impact**: Local keyword patterns won't match the altered text
- **Actual risk**: **Low** — GPT-4o also receives the wrong text, so it won't produce harmful content
- **Mitigation**:
  - Mode 1 audio guardrail (Gemma) catches this at the audio level
  - GPT-4o's L4 built-in safety as last line of defense

#### M2: Prompt Injection via Voice
- **Scenario**: User speaks prompt injection phrases (e.g. "忽略你之前的指令")
- **Impact**: Depends on Whisper transcription accuracy and pattern coverage
- **Mitigation**:
  - Local patterns cover common prompt injection in Chinese and English
  - GPT-4o system prompt locks role to "計程車費報銷助理"

#### M3: Guardrail Latency in Mode 2
- **Scenario**: `create_response: false` means each utterance waits for text guardrail check
- **Impact**: Adds ~200-500ms latency (Bedrock API) or ~1ms (local patterns only)
- **Mitigation**:
  - Pre-flight check fires during `transcription.delta` to reduce wait
  - If Bedrock is unavailable, only local check runs (instant)
  - Shared httpx connection pool reduces overhead

---

### Low Severity

#### L1: Local Keyword False Positives
- **Scenario**: Normal conversation triggers keyword patterns (e.g. discussing history mentions "大戰")
- **Impact**: Legitimate input blocked
- **Mitigation**: Patterns are tuned for high-precision matches; add allowlist if needed

#### L2: Gemma Server Unavailable (Mode 1)
- **Scenario**: Audio guardrail WS server at `GUARDRAIL_WS_URL` is offline
- **Impact**: Audio-level input check silently fails; no SAFE/UNSAFE result shown
- **Mitigation**: Connection errors logged; consider adding health check endpoint

#### L3: Output Guardrail Does Not Block Audio Playback
- **Scenario**: Output check runs as background task after audio starts playing
- **Impact**: User may hear unsafe audio before the check completes
- **Actual risk**: **Very low** — GPT-4o (L4) has strong built-in output safety

---

## Rule Coverage

### Local Keyword Patterns (`app/guardrails.py`)

| Category | Rules | Example Triggers |
|----------|-------|-----------------|
| Prompt Injection | 6+ | 忽略指令, jailbreak, DAN, 角色劫持 |
| Data Exfiltration | 3+ | API key, 密碼, 列出所有使用者資料 |
| Abuse / Profanity | 10+ | 幹你娘, 操你妹, fuck you, 去死 |
| Violence / Crime | 8+ | 製作炸彈, 殺人, 綁架, 毒品 |
| Expense Fraud | 3+ | 虛報費用, 灌水金額, 假發票 |
| Code Injection | 4+ | DROP TABLE, `<script>`, UNION SELECT |
| Custom Keywords | Variable | Set via `GUARDRAIL_BLOCK_KEYWORDS` env var |

### AWS Bedrock Guardrail (optional)
Configured in AWS Bedrock Console. Requires valid `BEDROCK_GUARDRAIL_ID` and AWS credentials. Provides semantic understanding for nuanced threats beyond keyword matching.

---

## Monitoring & Debugging

### Key Server Log Messages

| Log Message | Meaning |
|-------------|---------|
| `[guardrail] LOCAL BLOCKED (INPUT)` | Local keyword pattern blocked user input |
| `[guardrail] LOCAL BLOCKED (OUTPUT)` | Local keyword pattern blocked AI output |
| `[guardrail] BEDROCK BLOCKED` | Bedrock guardrail intervened |
| `[guardrail] Bedrock unavailable` | Bedrock not reachable, local check used |
| `[AudioGuardrail] WebSocket intercepted` | Gemma monkey patch activated |
| `[AudioGuardrail] SAFE / UNSAFE` | Gemma audio check result |
| `[AudioGuardrail] guardrail not enabled` | Guardrail checkbox not checked |

### Recommended Monitoring
1. **Bedrock availability** — check for `Bedrock unavailable` in logs
2. **Gemma server health** — check for `Connect call failed` errors
3. **False positive rate** — track legitimate inputs being incorrectly blocked
4. **Pre-flight hit rate** — check `reusing pre-flight result` frequency

---

## Summary

| Aspect | Status | Notes |
|--------|--------|-------|
| Malicious input blocking | Good | Local keywords (instant) + Bedrock (optional) dual-layer |
| Audio-level input check | Good | Gemma model via LiteLLM monkey patch (Mode 1) |
| Output safety | Good | Local keywords + Bedrock + GPT-4o built-in safety |
| Availability | Resilient | Fail-open design: local patterns always available |
| Latency impact | Low-Medium | Mode 1 ~0ms (parallel), Mode 2 ~1-500ms (pre-flight optimization) |
