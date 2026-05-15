# 語音填表助理 Chrome Extension v2.0

**純前端 AI 表單填寫助理** - 無需後端伺服器，直接使用 OpenAI API

## 🎯 核心改進

### v2.0 vs v1.0

| 特性 | v1.0 (舊版) | v2.0 (新版) |
|------|-------------|-------------|
| **架構** | 需要 FastAPI + LiteLLM 後端 | ✅ 純前端，無需後端 |
| **API Key** | 儲存在後端 `.env` | ✅ 儲存在瀏覽器本地 (chrome.storage) |
| **模型** | OpenAI Realtime API | ✅ GPT-5.5 Responses API + Whisper |
| **安全性** | API key 在伺服器 | ✅ API key 不離開瀏覽器 |
| **部署** | 需要部署兩個服務 | ✅ 載入擴充功能即可使用 |
| **靈活性** | 固定模型配置 | ✅ 可選擇 GPT-5.5 / GPT-4o / GPT-4o Mini |

## ✨ 功能特點

✅ **ChatKit 風格 UI** - 使用 OpenAI ChatKit 設計風格的側邊面板  
✅ **語音輸入** - 使用 Whisper 進行語音轉文字  
✅ **智能填表** - GPT-5.5 Responses API 推理引擎，自動理解和填寫表單  
✅ **工具調用** - 支援讀取表單結構、填寫欄位等工具  
✅ **本地儲存** - API Key 安全儲存在瀏覽器本地  
✅ **多模型支援** - 可選擇不同的推理模型  

## 🚀 快速開始

### 1. 安裝擴充功能

1. 開啟 Chrome 瀏覽器
2. 進入 `chrome://extensions/`
3. 開啟右上角的「開發人員模式」
4. 點擊「載入未封裝項目」
5. 選擇 `chrome-extension` 資料夾
6. 完成！你會在 Chrome 工具列看到麥克風圖示

### 2. 設定 API Key

1. 點擊 Chrome 工具列的麥克風圖示，開啟側邊面板
2. 點擊右上角的設定圖示（齒輪）
3. 輸入你的 OpenAI API Key (格式: `sk-proj-...`)
4. 選擇推理模型（推薦 GPT-5.5）
5. 點擊「儲存設定」

### 3. 開始使用

1. 開啟你要填寫的表單頁面
2. 在側邊面板：
   - **語音模式**：點擊麥克風按鈕，說出你要填寫的內容
   - **文字模式**：直接輸入文字，按送出

範例對話：
```
使用者: 幫我讀取這個表單
AI: [自動讀取表單結構並顯示欄位]

使用者: 填寫姓名為張三，email 是 zhang@example.com
AI: [自動填寫表單欄位]
```

## 📋 使用模型

### 語音轉文字
- **Whisper** - OpenAI 的語音辨識模型
- 支援繁體中文
- 高準確度

### 推理模型

| 模型 | 速度 | 能力 | 成本 | 推薦場景 |
|------|------|------|------|----------|
| **GPT-5.5** | ⚡️⚡️⚡️ | 🧠🧠🧠🧠🧠 | 💰💰💰 | 複雜表單、多步驟推理 |
| **GPT-4o** | ⚡️⚡️ | 🧠🧠🧠🧠 | 💰💰 | 一般表單 |
| **GPT-4o Mini** | ⚡️⚡️⚡️⚡️ | 🧠🧠🧠 | 💰 | 簡單表單、測試 |

## 🏗️ 架構說明

### 純前端架構

```
Chrome Extension (前端)
    ↓ 直接 HTTPS 調用
OpenAI API
    ├─ Whisper API (語音轉文字)
    └─ Responses API (推理 + 工具調用)
```

### 檔案結構

```
chrome-extension/
├── manifest.json           # Extension 配置 (v2.0)
├── sidepanel-v2.html       # 主 UI (ChatKit 風格)
├── sidepanel-v2.js         # 核心邏輯 (OpenAI API 調用)
├── sidepanel-v2.css        # 樣式 (ChatKit 風格)
├── content.js              # 注入頁面的腳本 (填表邏輯)
├── background.js           # Service worker
└── icons/                  # Extension 圖示
```

### 關鍵技術

#### 1. API Key 儲存
```javascript
// 儲存
await chrome.storage.local.set({ openai_api_key: key });

// 讀取
const result = await chrome.storage.local.get(['openai_api_key']);
const apiKey = result.openai_api_key;
```

#### 2. Whisper API 調用
```javascript
const formData = new FormData();
formData.append('model', 'whisper-1');
formData.append('file', audioBlob, 'voice-recording.webm');

const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${apiKey}` },
  body: formData
});
```

#### 3. GPT-5.5 Responses API 調用
```javascript
const response = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    model: 'gpt-5.5',
    input: [{ role: 'user', content: userMessage }],
    tools: [...], // 工具定義
    tool_choice: 'auto',
    reasoning: { effort: 'low' }
  })
});
```

#### 4. 工具執行
```javascript
// 讀取表單欄位
case 'get_form_fields': {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.tabs.sendMessage(tab.id, {
    action: 'get_form_fields'
  });
  return { fields: result.fields };
}

// 填寫表單
case 'fill_form': {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.tabs.sendMessage(tab.id, {
    action: 'fill_form',
    payload: args.payload
  });
  return result;
}
```

## 🔒 安全性

### API Key 保護
- ✅ 儲存在 `chrome.storage.local`，不同步到雲端
- ✅ 只在本地瀏覽器中使用
- ✅ 不會發送到任何第三方伺服器
- ✅ Content Security Policy 限制只能連接 `https://api.openai.com`

### Content Security Policy
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' https://api.openai.com;"
}
```

## 💰 成本估算

基於 OpenAI 官方定價 (2026年5月)：

### Whisper (語音轉文字)
- **$0.006 / 分鐘**
- 30秒錄音 ≈ $0.003

### GPT-5.5 Responses API
- **輸入**: ~$4.00 / 1M tokens
- **輸出**: ~$24.00 / 1M tokens
- **推理**: 根據 effort level 額外計費

### 使用場景成本估算

| 場景 | 語音 (30秒) | AI 推理 (1 回合) | 工具調用 | 總計 |
|------|-------------|------------------|----------|------|
| 簡單填表 | $0.003 | ~$0.01 | ~$0.005 | ~$0.018 |
| 複雜表單 | $0.003 | ~$0.03 | ~$0.015 | ~$0.048 |

**每月 100 次表單填寫** ≈ $2-5 USD

## 🛠️ 開發

### 本地開發

1. 修改代碼
2. 到 `chrome://extensions/` 點擊「重新載入」按鈕
3. 測試功能

### 除錯

- **Side Panel logs**: 在側邊面板上按右鍵 → 檢查
- **Content script logs**: 在表單頁面按 F12 開啟開發者工具
- **Background logs**: 到 `chrome://extensions/` → 點擊 extension 的「Service Worker」連結

### 常見問題

**Q: API Key 會同步到其他裝置嗎？**  
A: 不會。使用 `chrome.storage.local` 儲存，只在本地裝置。

**Q: 為什麼用 GPT-5.5 而不是 GPT-4o？**  
A: GPT-5.5 Responses API 有更強的推理能力和工具調用準確度，適合複雜表單填寫。

**Q: 可以離線使用嗎？**  
A: 不行，需要網路連接 OpenAI API。

**Q: 支援哪些瀏覽器？**  
A: 只支援 Chrome/Edge (Manifest V3)。

## 📝 更新日誌

### v2.0.0 (2026-05-14)
- 🎉 重構為純前端架構
- ✨ 移除後端伺服器依賴
- 🔐 API Key 本地儲存
- 🚀 使用 GPT-5.5 Responses API
- 🎨 ChatKit 風格 UI 優化
- 📦 簡化部署流程

### v1.0.0
- 初始版本（需要後端）
- 使用 OpenAI Realtime API
- FastAPI + LiteLLM 架構

## 🤝 參考專案

- [Formy](https://github.com/Even-s/Formy) - 國泰 iForm AI 填表助手
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [ChatKit](https://chatkit.anthropic.com/) - UI 設計靈感

## 📄 授權

MIT License
