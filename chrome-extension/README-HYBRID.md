# 語音填表助理 Chrome Extension - Hybrid 混合模式

**BYOK (Bring Your Own Key) + 雙模式架構**

## 🎯 混合架構

### 兩種連接模式

#### 1. 企業模式（推薦）✅

```
Chrome Extension (BYOK API Key)
    ↓ WebSocket/HTTPS
FastAPI Backend (:8000)
    ├─ Guardrail 檢查 ✓
    ├─ 日誌記錄 ✓
    └─ 轉發
        ↓
LiteLLM Proxy (:4000)
    └─ 使用用戶的 API Key
        ↓
OpenAI API
```

**特點：**
- ✅ **Guardrail 保護** - 防止敏感資訊洩露、不當內容
- ✅ **日誌記錄** - 完整的審計追蹤
- ✅ **即時對話** - 支援 Realtime API（WebSocket）
- ✅ **錄音轉譯** - 支援 Whisper API
- ✅ **BYOK** - 用戶自己的 API Key，成本透明

#### 2. 個人模式

```
Chrome Extension (BYOK API Key)
    ↓ 直接 HTTPS
OpenAI API (Whisper)
```

**特點：**
- ✅ **無需後端** - 純前端運作
- ✅ **更低延遲** - 直接調用 API
- ✅ **錄音轉譯** - 支援 Whisper API
- ❌ **無 Guardrail** - 沒有內容檢查
- ❌ **不支援即時對話** - 只能錄音轉譯

## 🚀 快速開始

### 企業模式設定

#### 1. 啟動後端服務

```bash
# Terminal 1 - LiteLLM Proxy (port 4000)
uv run python start_litellm.py

# Terminal 2 - FastAPI Backend (port 8000)
uv run uvicorn app.main:app --reload --port 8000
```

#### 2. 載入 Chrome Extension

1. Chrome → `chrome://extensions/`
2. 開啟「開發人員模式」
3. 「載入未封裝項目」→ 選擇 `chrome-extension` 資料夾

#### 3. 設定 Extension

1. 點擊麥克風圖示開啟側邊面板
2. 點擊右上角設定（齒輪）
3. 選擇「企業模式（有 Guardrail）」
4. 後端伺服器: `http://localhost:8000`
5. 輸入你的 OpenAI API Key: `sk-proj-...`
6. 選擇語音模式：
   - **即時對話**：低延遲，邊說邊轉（需 WebSocket）
   - **錄音轉譯**：錄完後一次轉文字
7. 勾選 Guardrail（推薦）
8. 儲存設定

### 個人模式設定

#### 1. 載入 Chrome Extension（同上）

#### 2. 設定 Extension

1. 點擊麥克風圖示開啟側邊面板
2. 點擊右上角設定（齒輪）
3. 選擇「個人模式（純前端）」
4. 輸入你的 OpenAI API Key: `sk-proj-...`
5. 語音模式自動切換為「錄音轉譯」
6. 儲存設定

**不需要啟動任何後端服務！**

## 🔐 BYOK (Bring Your Own Key) 優勢

### 用戶自己管理 API Key

- ✅ **成本透明** - 每個人用自己的 quota
- ✅ **隱私保護** - API Key 只儲存在本地瀏覽器
- ✅ **靈活控制** - 可隨時更換 Key
- ✅ **無共享風險** - 不需要擔心共享 Key 被濫用

### API Key 安全

```javascript
// 儲存在 chrome.storage.local（本地，不同步）
await chrome.storage.local.set({ openai_api_key: key });

// 企業模式：Key 隨請求發送到後端
headers: {
  'Authorization': `Bearer ${userApiKey}`
}

// 個人模式：Key 直接發送到 OpenAI
headers: {
  'Authorization': `Bearer ${userApiKey}`
}
```

**重要提示：**
- ✅ API Key 只儲存在本地瀏覽器
- ✅ 不會同步到 Chrome 帳號
- ✅ 企業模式下，後端不儲存 Key，只轉發請求
- ❌ 請妥善保管你的 API Key
- ❌ 不要與他人分享

## 🎙️ 兩種語音模式

### 即時對話模式（Realtime API）

**需求：** 企業模式 + 後端服務

```
流程：
1. 點擊麥克風開始
2. 即時說話 → 邊說邊轉文字 → AI 即時回應
3. 點擊停止結束
```

**優勢：**
- ⚡ 低延遲（< 1秒）
- 🎯 即時反饋
- 💬 自然對話體驗

**成本：** 較高（音訊 token 計費）

### 錄音轉譯模式（Whisper API）

**需求：** 企業模式或個人模式

```
流程：
1. 點擊麥克風開始錄音
2. 說完後點擊停止
3. 一次性轉文字 → AI 回應
```

**優勢：**
- 💰 成本低（$0.006/分鐘）
- 🌐 支援純前端
- 📝 完整語音轉文字

**劣勢：** 延遲較高（需等錄音完成）

## 🛡️ Guardrail 機制

**僅企業模式可用**

### 檢查類別

| 類別 | 範例觸發詞 |
|------|-----------|
| Prompt injection | `忽略指令`、`jailbreak`、`DAN` |
| 資料外洩 | `API key`、`密碼`、`列出所有使用者` |
| 暴力/犯罪 | `製作炸彈`、`綁架`、`放火` |
| 詐騙/濫用 | `虛報費用`、`灌水金額` |
| 代碼注入 | `DROP TABLE`、`<script>`、`UNION SELECT` |

### 運作方式

```javascript
// 輸入檢查
使用者說話 → 轉文字 → Guardrail 檢查 → 
  ✓ 通過 → 發送給 AI
  ✗ 封鎖 → 顯示警告

// 輸出檢查
AI 回應 → Guardrail 檢查 → 
  ✓ 通過 → 顯示給使用者
  ✗ 封鎖 → 取消回應 + 顯示警告
```

## 💰 成本估算

### 語音轉文字（Whisper）

| 時長 | 成本 |
|------|------|
| 30秒 | $0.003 |
| 1分鐘 | $0.006 |
| 5分鐘 | $0.030 |

### 即時對話（Realtime API）

**gpt-realtime-2** (推薦):
- 文字輸入: $4.00 / 1M tokens
- 文字輸出: $24.00 / 1M tokens
- 音訊輸入: $32.00 / 1M tokens
- 音訊輸出: $64.00 / 1M tokens

**單次對話估算** (30秒語音 + AI 回應):
- ~$0.02 - $0.05

**每月 100 次表單填寫**：
- 企業模式（即時對話）: ~$3-5
- 個人模式（錄音轉譯）: ~$0.60-1

## 📊 模式比較

| 特性 | 企業模式 | 個人模式 |
|------|----------|----------|
| **需要後端** | ✅ 是 | ❌ 否 |
| **Guardrail** | ✅ 有 | ❌ 無 |
| **日誌記錄** | ✅ 有 | ❌ 無 |
| **即時對話** | ✅ 支援 | ❌ 不支援 |
| **錄音轉譯** | ✅ 支援 | ✅ 支援 |
| **延遲** | 低（即時）/ 中（錄音） | 中（錄音） |
| **成本** | 較高（Realtime）/ 低（Whisper） | 低（Whisper） |
| **適用場景** | 企業環境、需合規 | 個人使用 |

## 🔧 技術細節

### 後端 BYOK Endpoints

```python
# WebSocket for Realtime API
@app.websocket("/ws/byok-realtime")
async def byok_realtime_websocket(websocket: WebSocket):
    # 1. 接收用戶 API Key
    # 2. 轉發到 LiteLLM with user's key
    # 3. 應用 guardrail 檢查
    # 4. 雙向代理

# HTTPS for Whisper API
@app.post("/api/byok-transcribe")
async def byok_transcribe(request: WhisperBYOKRequest):
    # 1. 使用用戶的 API Key
    # 2. 調用 Whisper API
    # 3. 應用 guardrail 檢查
    # 4. 返回轉譯結果
```

### 前端模式切換

```javascript
if (config.connectionMode === 'enterprise') {
    // 企業模式：通過後端
    const response = await fetch(`${backendUrl}/api/byok-transcribe`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: userApiKey, // 用戶的 Key
            audio_base64: audio,
            guardrail_enabled: true
        })
    });
} else {
    // 個人模式：直接調用 OpenAI
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        headers: { 'Authorization': `Bearer ${userApiKey}` },
        body: formData
    });
}
```

## 🎓 使用建議

### 企業環境

**推薦配置：**
- ✅ 企業模式
- ✅ 開啟 Guardrail
- ✅ 語音模式：即時對話（重要表單）或錄音轉譯（一般表單）
- ✅ 模型：gpt-realtime-2

**原因：**
- 合規要求（需 guardrail）
- 審計追蹤（需日誌）
- 使用體驗（即時對話）

### 個人使用

**推薦配置：**
- ✅ 個人模式
- ✅ 語音模式：錄音轉譯
- ✅ 模型：whisper-1

**原因：**
- 無需後端，簡單方便
- 成本低
- 滿足基本需求

## 📚 相關文檔

- [Formy](https://github.com/Even-s/Formy) - 靈感來源
- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime)
- [OpenAI Whisper API](https://platform.openai.com/docs/guides/speech-to-text)

## 📄 授權

MIT License
