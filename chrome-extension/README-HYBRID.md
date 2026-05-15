# 語音填表助理 Chrome Extension

目前版本已簡化為單一路徑：

```
Chrome Extension
  ├─ OpenAI API Key stored in chrome.storage.local
  ├─ Local lightweight Guardrail
  ├─ Recording transcription -> OpenAI Audio Transcriptions
  └─ Realtime voice chat -> OpenAI Realtime API
```

不需要 LiteLLM，不需要額外 Guardrail 服務，也不需要選擇個人/企業模式。

## 快速開始

1. Chrome 開啟 `chrome://extensions/`
2. 開啟「開發人員模式」
3. 「載入未封裝項目」選擇 `chrome-extension` 資料夾
4. 開啟側邊面板，點右上角設定
5. 輸入 OpenAI API Key
6. 視需要開關 Guardrail

## 使用方式

- 文字輸入：直接在底部輸入欄描述表單內容。
- 錄音轉文字：按麥克風 icon，說完後按停止。
- 即時語音對話：按黑色波形 icon，開始和模型即時對話；再按停止結束。

模型選擇已移除，extension 使用固定預設：

- 文字整理：`gpt-4.1`
- 錄音轉文字：`gpt-4o-transcribe`
- 即時語音：`gpt-realtime-2`

## Guardrail

Guardrail 在 extension 本地執行，不依賴後端服務。它會檢查：

- 使用者文字輸入
- 錄音轉文字結果
- 即時語音 transcript
- 模型輸出文字

## 填表安全

送出 `fill_form` 前，extension 會用表單 schema 做本地檢查：

- 必填欄位不能空白
- 陣列欄位不能沒有項目
- enum 欄位必須是有效選項
- 日期等格式欄位必須符合 schema
- 「未提供、待補、隨便、你決定」這類模糊值會被擋下

如果資訊不足，extension 會先追問，不會直接填表。

## 成本

側邊面板會顯示本次成本與 token usage。設定頁保留成本歷史，可以查看最近紀錄或清除。

## API Key

API Key 只儲存在 `chrome.storage.local`，請勿提交到 Git 或貼到對話紀錄。若 Key 外洩，請立刻到 OpenAI dashboard revoke 後更換。
