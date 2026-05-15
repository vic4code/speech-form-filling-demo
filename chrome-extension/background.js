chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Offscreen document management
let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (contexts.length > 0) {
    offscreenReady = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording audio for voice input'
  });
  offscreenReady = true;
}

// Open a visible popup window to get microphone permission
function openPermissionPopup() {
  return new Promise((resolve) => {
    let resolved = false;

    const listener = (msg) => {
      if (resolved) return;
      if (msg.action === 'permission_granted') {
        resolved = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve(true);
      } else if (msg.action === 'permission_denied') {
        resolved = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve(false);
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.windows.create({
      url: chrome.runtime.getURL('permission-request.html'),
      type: 'popup',
      width: 450,
      height: 350,
      focused: true
    });

    // Timeout after 30s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve(false);
      }
    }, 30000);
  });
}

// Message handler - background only handles its own actions
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted at background
  if (message.target !== 'background') return false;

  const { action } = message;

  if (action === 'ensure_offscreen') {
    ensureOffscreen()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (action === 'request_mic_permission') {
    (async () => {
      try {
        await ensureOffscreen();
        const granted = await openPermissionPopup();
        sendResponse({ success: granted });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});
