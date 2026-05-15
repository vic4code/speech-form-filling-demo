# 語音填表助理 Chrome Extension

這是一個 Chrome 擴充功能，讓你可以透過語音對話來自動填寫網頁表單。

## 功能特點

✅ **ChatKit 風格 UI** - 使用 OpenAI ChatKit 設計風格的側邊面板  
✅ **語音對話** - 即時語音對話模式，AI 會詢問表單必填欄位  
✅ **錄音整理** - 錄音後批次轉譯和整理，可在填表前預覽確認  
✅ **智能填表** - 支援多種表單類型（計程車費用、IT 申請、筆電申請等）  
✅ **Guardrail 保護** - 可選的關鍵字檢查，防止不當輸入輸出  
✅ **多模型選擇** - 支援多個 OpenAI Realtime 模型  

## 安裝步驟

### 1. 確認後端服務已啟動

在專案根目錄執行：

```bash
# Terminal 1 - 啟動 LiteLLM Proxy (port 4000)
uv run python start_litellm.py

# Terminal 2 - 啟動 FastAPI (port 8000)
uv run uvicorn app.main:app --reload --port 8000
```

### 2. 載入 Chrome Extension

1. 開啟 Chrome 瀏覽器
2. 進入 `chrome://extensions/`
3. 開啟右上角的「開發人員模式」
4. 點擊「載入未封裝項目」
5. 選擇這個 `chrome-extension` 資料夾
6. 完成！你會在 Chrome 工具列看到麥克風圖示

## 使用方法

### 首次設定

1. 點擊 Chrome 工具列的麥克風圖示，開啟側邊面板
2. 點擊右上角的設定圖示（齒輪）
3. 確認後端伺服器設定為 `http://localhost:8000`
4. 選擇要填寫的表單類型
5. 選擇語音模式（即時對話 or 錄音整理）
6. 選擇 AI 模型
7. 點擊「儲存設定」

### 即時對話模式

1. 開啟你要填寫的表單頁面（例如：計程車費用申請單）
2. 在側邊面板點擊「開始語音」按鈕（麥克風）
3. 開始說話，AI 會自動詢問表單欄位
4. 回答 AI 的問題
5. 確認所有資料後，AI 會自動填入表單
6. **重要**：請手動檢查並點擊表單的「送出」按鈕

### 錄音整理模式

1. 開啟你要填寫的表單頁面
2. 在設定中選擇「錄音整理」模式
3. 點擊麥克風按鈕開始錄音
4. 完整說明你的申請內容（一次說完）
5. 點擊停止按鈕
6. AI 會轉譯和整理你的錄音
7. 確認顯示的表單內容
8. 點擊確認，AI 會自動填入表單
9. 手動檢查並送出表單

## 支援的表單

目前支援：

- 🚕 **計程車費請領單** - 出差交通費用申請
- 💻 **資訊作業申請** - IT 相關申請
- 🖥️ **筆電申請單** - 金控筆電設備申請

## 技術架構

```
Chrome Extension (前端)
    ↓ WebSocket
FastAPI Backend (port 8000)
    ↓ WebSocket  
LiteLLM Proxy (port 4000)
    ↓ Realtime WebSocket
OpenAI Realtime API
```

### 檔案說明

- `manifest.json` - Chrome extension 配置
- `sidepanel.html/js/css` - 主 UI（ChatKit 風格）
- `background.js` - Service worker
- `content.js` - 注入頁面的腳本，負責實際填表
- `audio-processor.js` - AudioWorklet，處理音訊串流
- `icons/` - Extension 圖示

## 開發與除錯

### 查看 Console Logs

- **Side Panel logs**: 在側邊面板上按右鍵 → 檢查
- **Background logs**: 到 `chrome://extensions/` → 點擊 extension 的「Service Worker」連結
- **Content script logs**: 在表單頁面按 F12 開啟開發者工具

### 常見問題

**Q: 側邊面板連不上後端？**  
A: 確認 FastAPI 服務在 port 8000 運行：`curl http://localhost:8000/api/forms`

**Q: 語音沒反應？**  
A: 確認瀏覽器已授權麥克風權限，並檢查設定中的模型選擇

**Q: 表單沒有自動填入？**  
A: 確認「填入當前頁面」選項已勾選，並且當前頁面是支援的表單

**Q: 如何更新 extension？**  
A: 到 `chrome://extensions/` 點擊 extension 旁的重新載入按鈕

## 相關專案

這個 Chrome Extension 參考了 [Formy](https://github.com/Even-s/Formy) 的架構設計。

## 授權

MIT License
