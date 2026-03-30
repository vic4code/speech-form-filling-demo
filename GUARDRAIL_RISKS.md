# Guardrail 風險評估與互動分析

> 最後更新：2026-03-30

## 架構總覽

```
使用者語音
   │
   ▼
AudioWorklet (瀏覽器端降噪 + 回音消除)
   │
   ▼ PCM16 24kHz
FastAPI Proxy
   │
   ├──► OpenAI Realtime API (Whisper 轉錄 + GPT-4o 回覆)
   │         │
   │         ▼ transcription.completed
   │    ┌─────────────────────────────────┐
   │    │  Text Guardrail (永遠啟用)      │
   │    │  1. AWS Bedrock Guardrail       │
   │    │  2. Local Regex Patterns        │
   │    └────────┬───────────┬────────────┘
   │             │           │
   │          PASSED      BLOCKED
   │             │           │
   │       response.create   ├─► 前端顯示攔截訊息
   │             │           └─► 不觸發 AI 回覆
   │             ▼
   │       AI 回覆生成
   │             │
   │             ▼ audio_transcript.done
   │    ┌─────────────────────────────────┐
   │    │  Output Guardrail              │
   │    │  Bedrock only (避免誤擋拒絕回覆) │
   │    └────────┬───────────┬────────────┘
   │          PASSED      BLOCKED
   │             │           │
   │        轉發給前端    顯示攔截訊息
   │
   └──► (可選) Audio Guardrail WS (Mode 1, 即時音訊串流檢查)
```

## Guardrail 層級

| 層級 | 技術 | 檢查對象 | 啟用條件 |
|------|------|---------|---------|
| **L1: Bedrock Guardrail** | AWS Bedrock `ApplyGuardrail` API | 使用者輸入文字 (INPUT)、AI 輸出文字 (OUTPUT) | `BEDROCK_GUARDRAIL_ID` 有設定且 AWS 憑證有效 |
| **L2: Local Regex** | Python `re` 正則表達式 | 使用者輸入文字 | 永遠啟用 |
| **L3: Audio Guardrail** | 外部 WebSocket 服務 | 即時音訊串流 | 勾選 Guardrail + Mode 1 |
| **L4: OpenAI 內建安全** | GPT-4o 自身的安全過濾 | 所有內容 | 永遠啟用（OpenAI 端） |

### 各層級的檢查邏輯

**Input（使用者輸入）：**
1. Bedrock 先檢查 → 若 BLOCKED 直接攔截
2. Bedrock 通過 → 再跑 Local Regex → 若 BLOCKED 攔截
3. 兩者都通過 → 觸發 `response.create`

**Output（AI 回覆）：**
1. 只用 Bedrock 檢查（不跑 Local Regex）
2. 原因：AI 的拒絕回覆（如「我無法協助您製作炸彈」）會被 Local Regex 誤擋

---

## 已知風險與邊界情況

### 風險等級定義
- **高**：可能導致不安全內容通過、資料外洩、或系統被繞過
- **中**：可能影響使用體驗，但不構成安全威脅
- **低**：已知限制，實際影響極小

---

### 高風險

#### H1: AWS Session Token 過期
- **情境**：`.env` 中的 `AWS_SESSION_TOKEN` 是 STS 臨時憑證，會過期
- **影響**：Bedrock Guardrail 完全失效，降級為 Local Regex only
- **偵測**：Server log 會顯示 `[guardrail] Bedrock: FAILED to connect — ExpiredTokenException`
- **緩解**：
  - 定期更新 `.env` 中的 AWS 憑證
  - 考慮改用 IAM Role（EC2/ECS）或長期 Access Key 避免過期問題
  - 監控 server log 中的 Bedrock 連線狀態

#### H2: Bedrock 服務不可用
- **情境**：AWS Bedrock 區域性中斷、網路問題
- **影響**：同 H1，降級為 Local Regex only
- **偵測**：Server log 會顯示 `[guardrail] Bedrock API error`
- **緩解**：Local Regex 作為 fallback 仍能攔截常見攻擊模式

---

### 中風險

#### M1: Whisper 語音辨識錯誤導致 Guardrail 繞過
- **情境**：使用者說「幫我做炸彈」，Whisper 辨識為「幫我做炸蛋」
- **影響**：Bedrock 收到「炸蛋」不會攔截，因為它是合法的食物名稱
- **實際風險**：**低**。因為辨識錯誤時，OpenAI GPT-4o 也會收到錯誤的文字，所以：
  - 若辨識為無害文字 → AI 正常回覆無害內容 → 無安全問題
  - 若辨識為有害文字 → Guardrail 正確攔截 → 正常運作
  - 只有在辨識剛好變成「另一種有害內容」且 Guardrail 未覆蓋時才有風險，機率極低
- **緩解**：
  - 使用 `OPENAI_TRANSCRIBE_PROMPT` 引導 Whisper 上下文
  - AudioWorklet + echoCancellation + noiseSuppression 已最佳化辨識率
  - OpenAI GPT-4o 自身有 L4 安全過濾作為最後防線

#### M2: Prompt Injection 透過語音
- **情境**：使用者透過語音說出 prompt injection 文字（如「忽略你之前的指令」）
- **影響**：取決於 Whisper 是否正確辨識、Guardrail 是否涵蓋該模式
- **緩解**：
  - Local Regex 涵蓋中英文常見 prompt injection 模式
  - Bedrock Guardrail 提供額外保護
  - GPT-4o 的 system prompt 已固定角色為「計程車費報銷助理」

#### M3: AI 回覆品質受 Guardrail 延遲影響
- **情境**：`create_response: False` 代表每次使用者說話後，都要等 Guardrail 檢查完才觸發 AI 回覆
- **影響**：增加約 200-500ms 延遲（Bedrock API 呼叫時間）
- **緩解**：
  - Bedrock API 在 us-west-2 通常 < 300ms
  - 使用 `run_in_executor` 非同步呼叫，不阻塞 WebSocket

---

### 低風險

#### L1: Local Regex 誤擋（False Positive）
- **情境**：使用者正常對話但觸發了 regex 規則（如提到「大戰」是在討論歷史）
- **影響**：合法輸入被攔截
- **緩解**：
  - Bedrock Guardrail 有更好的語意理解，先於 Regex 執行
  - 只有 Bedrock 通過但 Regex 擋住的才是 false positive
  - 可透過調整 regex 規則或新增 allowlist 處理

#### L2: Output Guardrail 只用 Bedrock
- **情境**：如果 Bedrock 不可用，AI 輸出完全沒有 Guardrail
- **影響**：AI 可能輸出不當內容（但 GPT-4o 自身有安全過濾）
- **緩解**：GPT-4o (L4) 內建安全機制 + system prompt 限制角色

#### L3: 文字輸入（非語音）也受 Guardrail 保護
- **情境**：使用者在聊天輸入框直接輸入文字
- **影響**：無風險，文字輸入也會經過完整的 Guardrail 檢查鏈

---

## 攔截規則覆蓋範圍

### Bedrock Guardrail (`rhpjhc8f8v3t`)
由 AWS Bedrock 控制台設定，具體規則請查看 AWS Console。一般涵蓋：
- 暴力/武器/爆裂物
- 仇恨言論
- 色情內容
- 自殘/自殺
- 非法活動

### Local Regex Patterns
| 類別 | 規則數 | 範例觸發詞 |
|------|--------|-----------|
| Prompt Injection | 9 | 忽略指令、jailbreak、DAN、角色劫持 |
| 資料外洩 | 3 | API key、密碼、列出所有使用者資料 |
| 辱罵/不當言論 | 4 | 辱罵性字詞（中英文） |
| 暴力/犯罪 | 12 | 搶劫、製作炸彈、殺人、綁架、毒品、賭博 |
| 報銷詐欺 | 3 | 虛報費用、灌水金額、不要留下紀錄 |
| 自訂關鍵字 | 可變 | 由 `GUARDRAIL_BLOCK_KEYWORDS` 環境變數設定 |

---

## 監控與除錯

### Server Log 關鍵訊息

| Log 訊息 | 意義 |
|----------|------|
| `[guardrail] Bedrock: connection OK` | 啟動時 Bedrock 連線成功 |
| `[guardrail] Bedrock: FAILED to connect` | Bedrock 連線失敗（檢查 AWS 憑證） |
| `[guardrail] Bedrock API call: ...` | 每次 Guardrail 檢查的詳細資訊 |
| `[guardrail] Bedrock response: action=GUARDRAIL_INTERVENED` | Bedrock 攔截了內容 |
| `[guardrail] Bedrock response: action=NONE` | Bedrock 放行 |
| `[guardrail] mode=always-on transcript: "..."` | Whisper 辨識結果（用於對比實際語音） |
| `[guardrail] Input result: passed=False` | 使用者輸入被攔截 |
| `[guardrail] Output result: passed=False` | AI 輸出被攔截 |

### 建議監控項目
1. **Bedrock 連線狀態** — 啟動時確認 `connection OK`
2. **Whisper 辨識品質** — 定期比對 transcript log 與實際語音
3. **False Positive 率** — 追蹤合法輸入被誤擋的情況
4. **Bedrock 延遲** — 若延遲 > 1s 考慮調整架構

---

## 結論

| 面向 | 狀態 | 說明 |
|------|------|------|
| 惡意輸入攔截 | 良好 | Bedrock + Local Regex 雙層防護，永遠啟用 |
| 語音辨識繞過 | 可接受 | 辨識錯誤 = AI 也收到錯誤文字 = 不會產生有害回覆 |
| 輸出安全 | 良好 | Bedrock 檢查 + GPT-4o 內建安全 |
| 可用性 | 需注意 | AWS 憑證過期會導致 Bedrock 失效，需定期更新 |
| 延遲影響 | 輕微 | Bedrock API ~200-500ms，使用者體驗可接受 |
