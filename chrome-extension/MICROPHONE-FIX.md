# 🎤 麥克風權限問題修復指南

## ❌ 錯誤訊息

```
無法啟動麥克風: Permission dismissed
或
無法啟動麥克風: NotAllowedError
```

## 🔍 問題原因

Chrome Extension 需要用戶**明確授權**麥克風權限，可能的原因：

1. ❌ 用戶點擊了「拒絕」
2. ❌ Chrome 瀏覽器設定封鎖了麥克風
3. ❌ macOS/Windows 系統層級封鎖了 Chrome 的麥克風存取
4. ❌ 麥克風被其他程式占用
5. ❌ Side Panel 的 URL scheme 沒有權限

## ✅ 解決方案

### 方法 1: Chrome 瀏覽器設定（最常見）

1. **點擊網址列左側的圖示**
   - 🔒 鎖頭圖示
   - 或 🛡️ 盾牌圖示
   - 或 ℹ️ 資訊圖示

2. **找到「麥克風」設定**
   - 點擊「網站設定」或「權限」
   - 找到「麥克風」

3. **選擇「允許」**
   - 從下拉選單選擇「允許」
   - 或切換開關為「開啟」

4. **重新載入** Side Panel
   - 關閉並重新開啟 Side Panel
   - 或點擊 Extension 圖示重新開啟

### 方法 2: Chrome 全域設定

1. 開啟 Chrome 設定
   ```
   chrome://settings/content/microphone
   ```

2. 確認以下設定：
   - ✅ 「網站可以要求使用您的麥克風」已啟用
   - ✅ 「語音填表助理」不在「不得使用麥克風」清單中

3. 如果在封鎖清單中：
   - 點擊旁邊的垃圾桶圖示移除
   - 重新載入 Extension

### 方法 3: macOS 系統權限

**macOS Ventura (13.x) 及更新版本：**

1. 開啟「系統設定」
2. 點擊「隱私權與安全性」
3. 選擇「麥克風」
4. 確認 **Google Chrome** 或 **Microsoft Edge** 有勾選 ✓
5. 如果沒有勾選，點擊開關啟用
6. 重新啟動 Chrome

**macOS Monterey (12.x) 及更舊版本：**

1. 開啟「系統偏好設定」
2. 點擊「安全性與隱私權」
3. 選擇「隱私權」標籤
4. 左側選擇「麥克風」
5. 右側確認 Chrome/Edge 有勾選
6. 重新啟動 Chrome

### 方法 4: Windows 系統權限

1. 開啟「設定」（Win + I）
2. 選擇「隱私權與安全性」
3. 點擊「麥克風」
4. 確認：
   - ✅ 「麥克風存取權」已開啟
   - ✅ 「讓應用程式存取您的麥克風」已開啟
   - ✅ Google Chrome 或 Microsoft Edge 已開啟
5. 重新啟動 Chrome

### 方法 5: Extension 權限設定

1. 開啟 Extensions 頁面
   ```
   chrome://extensions/
   ```

2. 找到「語音填表助理」

3. 點擊「詳細資料」

4. 檢查「網站存取權」：
   - 確認設定為「在所有網站上」
   - 或至少「點擊時」

5. 如果剛修改過，重新載入 Extension：
   - 點擊「重新載入」按鈕（圓圈箭頭）

### 方法 6: 檢查麥克風硬體

1. **確認麥克風已連接**
   - 外接麥克風：檢查 USB/3.5mm 連接
   - 內建麥克風：應該自動可用

2. **測試麥克風**
   - macOS：開啟「QuickTime Player」→ 新增音訊錄製
   - Windows：開啟「錄音機」App
   - 如果這些也不能用 → 硬體問題

3. **檢查是否被占用**
   - 關閉所有使用麥克風的程式：
     - Zoom, Teams, Skype
     - Discord, Slack
     - 其他錄音軟體

## 🧪 測試工具

我們提供了一個測試頁面來診斷問題：

1. 用 Chrome 開啟測試頁面：
   ```
   file:///path/to/chrome-extension/debug-mic.html
   ```

2. 點擊三個按鈕依序測試：
   - **1. 檢查權限狀態** - 查看目前權限
   - **2. 測試麥克風** - 請求並測試麥克風
   - **3. 列出設備** - 顯示所有音訊設備

3. 根據測試結果的錯誤訊息來修復

## 🐛 常見錯誤碼

| 錯誤名稱 | 原因 | 解決方法 |
|---------|------|---------|
| `NotAllowedError` | 權限被拒絕 | 方法 1, 2, 3 或 4 |
| `NotFoundError` | 找不到麥克風 | 方法 6（硬體檢查） |
| `NotReadableError` | 麥克風被占用 | 方法 6（關閉其他程式） |
| `OverconstrainedError` | 不支援請求的設定 | 更新瀏覽器 |
| `TypeError` | API 不存在 | 確認使用 HTTPS 或 localhost |
| `PermissionDismissedError` | 關閉權限提示 | 重新開啟並點擊「允許」 |

## 📝 除錯步驟

如果以上都不行，按照這個順序檢查：

1. ✅ **系統麥克風權限**（macOS/Windows）
2. ✅ **Chrome 全域麥克風設定**
3. ✅ **網站特定麥克風權限**
4. ✅ **Extension 權限設定**
5. ✅ **硬體檢查**（麥克風是否正常）
6. ✅ **重新載入 Extension**
7. ✅ **重新啟動 Chrome**
8. ✅ **重新啟動電腦**（最後手段）

## 🔧 開發者工具除錯

1. 在 Side Panel 上按**右鍵** → 選擇「檢查」

2. 切換到 **Console** 標籤

3. 點擊麥克風按鈕

4. 查看錯誤訊息：
   ```javascript
   // 找這些錯誤
   DOMException: Permission denied
   DOMException: Requested device not found
   DOMException: Could not start audio source
   ```

5. 把完整錯誤訊息貼給我，我可以幫你診斷

## 💡 預防措施

### 第一次使用時

1. **不要點擊「封鎖」**
   - Chrome 會記住你的選擇
   - 如果點了封鎖，要用「方法 1」來解除

2. **確認麥克風可用**
   - 先用其他程式測試麥克風
   - 確認沒有被占用

3. **使用正確的瀏覽器**
   - 建議：Chrome 或 Edge（Chromium 核心）
   - 不支援：Firefox, Safari（Side Panel API 限制）

### 企業環境

如果你在公司電腦上使用：

1. **確認公司政策**
   - 有些公司會封鎖麥克風
   - 聯絡 IT 部門請求權限

2. **檢查 MDM/GPO 設定**
   - 企業可能透過群組原則封鎖
   - 需要管理員權限解除

## 🆘 還是不行？

如果試過所有方法還是不行：

1. **切換到個人模式 + 錄音轉譯**
   - 個人模式不需要 WebSocket
   - 錄音轉譯更簡單可靠

2. **改用文字輸入**
   - Side Panel 也支援文字輸入
   - 不需要麥克風權限

3. **提供完整錯誤資訊**
   - Console 的完整錯誤訊息
   - Chrome 版本
   - 作業系統版本
   - 測試頁面的結果

## 📚 相關文件

- [Chrome 麥克風權限說明](https://support.google.com/chrome/answer/2693767)
- [macOS 麥克風權限](https://support.apple.com/zh-tw/guide/mac-help/mchla1b1e1fe/mac)
- [Windows 麥克風權限](https://support.microsoft.com/zh-tw/windows/windows-camera-microphone-and-privacy-a83257bc-e990-d54a-d212-b5e41beba857)
