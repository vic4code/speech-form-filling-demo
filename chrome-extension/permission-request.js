const statusEl = document.getElementById('status');

(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());

    statusEl.textContent = '✅ 麥克風已授權！視窗將自動關閉...';
    statusEl.className = 'status granted';

    chrome.runtime.sendMessage({ action: 'permission_granted' });

    setTimeout(() => window.close(), 1000);
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      statusEl.textContent = '❌ 權限被拒絕。請重新載入擴充功能後再試。';
    } else {
      statusEl.textContent = `❌ 錯誤: ${error.message}`;
    }
    statusEl.className = 'status denied';

    chrome.runtime.sendMessage({ action: 'permission_denied', error: error.message });
  }
})();
