# 🎤 Offscreen Document 音訊錄製說明

## 為什麼需要 Offscreen Document？

Chrome Extension 的 **Side Panel 無法直接使用 `getUserMedia()`** 來存取麥克風，因為：

1. Side Panel 使用 `chrome-extension://` 協議
2. Chrome 不會為 extension 頁面彈出權限提示
3. Manifest V3 的安全限制

## 解決方案：Offscreen Document

```
Side Panel (UI)
    ↓ chrome.runtime.sendMessage()
Background Service Worker
    ↓ 創建 Offscreen Document
Offscreen Document (offscreen.html)
    ↓ navigator.mediaDevices.getUserMedia() ✓ 可以彈出權限提示
    ↓ 錄音完成
    ↓ 回傳 base64 音訊
Side Panel
    ↓ 轉譯 / 處理
```

## 檔案結構

### 1. manifest.json
```json
{
  "permissions": ["offscreen", ...],
  ...
}
```

### 2. background.js
- 管理 offscreen document 生命週期
- 轉發訊息給 offscreen document

### 3. offscreen.html + offscreen.js
- **真正的**麥克風存取發生在這裡
- 錄音、停止、返回 base64

### 4. sidepanel-hybrid.js
- 通過 `chrome.runtime.sendMessage()` 與 background 溝通
- 接收 base64 音訊並處理

## 訊息流程

### 開始錄音

```javascript
// sidepanel-hybrid.js
const response = await chrome.runtime.sendMessage({
  target: 'offscreen',
  action: 'start_recording'
});

// background.js 轉發
// offscreen.js 執行
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
// ✓ 這裡 Chrome 會彈出權限提示！
```

### 停止錄音

```javascript
// sidepanel-hybrid.js
const response = await chrome.runtime.sendMessage({
  target: 'offscreen',
  action: 'stop_recording'
});

// offscreen.js 返回
return { success: true, audioData: base64String };

// sidepanel-hybrid.js 收到
const audioBlob = base64ToBlob(response.audioData, 'audio/webm');
```

## 為什麼這樣可以？

1. **Offscreen Document 是一個隱藏的 HTML 頁面**
   - 不會顯示給用戶
   - 但有完整的 DOM API
   - 包括 `navigator.mediaDevices`

2. **Chrome 信任 Offscreen Document**
   - 可以彈出權限提示
   - 用戶點擊「允許」後，權限會記住

3. **Permission 是 persistent 的**
   - 一旦授權，下次就不用再問
   - 除非用戶手動撤銷

## 第一次使用流程

用戶第一次點擊麥克風按鈕：

1. Side Panel 發送 `start_recording` 訊息
2. Background 創建 Offscreen Document
3. Offscreen Document 調用 `getUserMedia()`
4. **Chrome 彈出權限提示**（🎉 這裡！）
5. 用戶點擊「允許」
6. 錄音開始
7. 權限被記住，下次不用再問

## 測試步驟

### 1. 重新載入 Extension

```
chrome://extensions/
→ 找到「語音填表助理」
→ 點擊「重新載入」按鈕
```

### 2. 開啟 Side Panel

點擊 Chrome 工具列的麥克風圖示

### 3. 點擊麥克風按鈕

第一次會看到：
```
Status: Starting microphone...
```

然後 **Chrome 會彈出權限提示**：
```
語音填表助理 想要使用您的麥克風
[封鎖] [允許]
```

### 4. 點擊「允許」

然後就可以正常錄音了！

### 5. 後續使用

之後每次點擊麥克風，**不會再彈出提示**，直接開始錄音。

## 除錯

### 查看 Offscreen Document

1. 開啟 `chrome://extensions/`
2. 找到「語音填表助理」
3. 點擊「檢查檢視」→「offscreen.html」
4. 可以看到 Console log

### 查看 Background Service Worker

1. `chrome://extensions/`
2. 點擊「Service Worker」連結
3. 可以看到 Console log

### 查看 Side Panel

1. Side Panel 上按右鍵
2. 選擇「檢查」
3. Console 標籤

## 常見問題

### Q: 為什麼還是沒有彈出權限提示？

A: 可能原因：
1. **之前已經拒絕過** - 到 `chrome://settings/content/microphone` 移除封鎖
2. **Offscreen Document 沒有創建成功** - 檢查 Background Service Worker Console
3. **Extension 沒有重新載入** - 必須重新載入才能套用新的 manifest

### Q: 彈出的是哪個頁面在請求權限？

A: 權限提示會顯示 **Extension 的名稱**（「語音填表助理」），而不是特定頁面。

### Q: 權限會記住多久？

A: 永久記住，除非：
- 用戶手動撤銷
- 重新安裝 Extension
- 清除 Chrome 資料

### Q: 可以在 Side Panel 直接用 getUserMedia 嗎？

A: **不行**。Side Panel 的 URL 是 `chrome-extension://xxx/sidepanel.html`，Chrome 不會為它彈出權限提示。這是 Manifest V3 的限制。

### Q: Formy 是怎麼做的？

A: Formy 也用同樣的方式：
- 有 offscreen document
- 通過 message passing 來錄音
- 這是目前唯一的標準做法

## 參考文件

- [Chrome Offscreen Documents API](https://developer.chrome.com/docs/extensions/reference/offscreen/)
- [Using getUserMedia in Extensions](https://developer.chrome.com/docs/extensions/mv3/user_privacy/)
