// ── Configuration ──
const STT_MODEL = 'whisper-1';
const DEFAULT_REASONING_MODEL = 'gpt-5.5';
const MIN_RECORDING_MS = 500;
const MAX_TOOL_ROUNDS = 10;

// ── State ──
let apiKey = null;
let reasoningModel = DEFAULT_REASONING_MODEL;
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartedAt = 0;

// ── DOM refs ──
const chat = document.getElementById('chat');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const settingsBtn = document.getElementById('settings-btn');
const settingsDrawer = document.getElementById('settings-drawer');
const apiKeyInput = document.getElementById('api-key-input');
const toggleKeyBtn = document.getElementById('toggle-key-btn');
const saveSettingsBtn = document.getElementById('save-settings');
const cancelSettingsBtn = document.getElementById('cancel-settings');
const reasoningModelSelect = document.getElementById('reasoning-model-select');
const keyStatusEl = document.getElementById('key-status');
const apiStatusEl = document.getElementById('api-status');
const apiStatusText = document.getElementById('api-status-text');

// ── Settings persistence ──
async function loadSettings() {
  const result = await chrome.storage.local.get(['openai_api_key', 'reasoning_model']);
  apiKey = result.openai_api_key || null;
  reasoningModel = result.reasoning_model || DEFAULT_REASONING_MODEL;

  if (apiKey) {
    updateStatus('ready', 'Ready');
    showApiStatus('API Key configured', false);
  } else {
    updateStatus('disconnected', 'No API Key');
    showApiStatus('Please configure API Key', true);
  }

  return { apiKey, reasoningModel };
}

async function saveSettings() {
  await chrome.storage.local.set({
    openai_api_key: apiKey,
    reasoning_model: reasoningModel
  });
}

function showApiStatus(message, isError = false) {
  apiStatusEl.style.display = 'block';
  apiStatusText.textContent = message;
  apiStatusEl.className = `sp-status-chip ${isError ? 'sp-status-error' : 'sp-status-success'}`;
  setTimeout(() => {
    apiStatusEl.style.display = 'none';
  }, 3000);
}

function updateStatus(status, text) {
  statusDot.className = `sp-dot sp-dot-${status}`;
  statusText.textContent = text;
}

// ── Chat UI ──
function addMessage(role, content) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `sp-message sp-message-${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'sp-bubble';
  bubble.innerHTML = renderMarkdown(content);

  messageDiv.appendChild(bubble);
  chat.appendChild(messageDiv);
  chat.scrollTop = chat.scrollHeight;
}

function renderMarkdown(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Headers
  html = html.split('\n').map(line => {
    if (/^#{1,6}\s+/.test(line)) {
      const level = line.match(/^(#{1,6})/)[1].length;
      const content = line.replace(/^#{1,6}\s+/, '');
      return `<h${level}>${content}</h${level}>`;
    }
    return line;
  }).join('\n');

  // Bold, italic, code
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');

  return html;
}

// ── OpenAI API calls ──
async function fetchOpenAIJson(path, body) {
  if (!apiKey) {
    throw new Error('請先設定 OpenAI API Key');
  }

  const response = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

async function transcribeAudio(audioBlob) {
  if (!apiKey) {
    throw new Error('請先設定 OpenAI API Key');
  }

  const formData = new FormData();
  formData.append('model', STT_MODEL);
  formData.append('file', audioBlob, 'voice-recording.webm');
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper STT failed ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}

async function callResponsesAPI(userMessage) {
  const requestBody = {
    model: reasoningModel,
    input: [
      {
        role: 'user',
        content: userMessage
      }
    ],
    instructions: `你是一個智能表單填寫助理。你可以幫助使用者：
1. 讀取當前頁面的表單結構
2. 根據使用者的需求填寫表單欄位

請用繁體中文回應，並且簡潔明確。當使用者提供表單資料時，直接幫他們填寫。`,
    tools: [
      {
        type: 'function',
        name: 'get_form_fields',
        description: '讀取目前頁面的表單欄位結構',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        type: 'function',
        name: 'fill_form',
        description: '填寫表單欄位',
        parameters: {
          type: 'object',
          properties: {
            payload: {
              type: 'object',
              description: '要填寫的表單資料，key 是欄位名稱，value 是要填入的值'
            }
          },
          required: ['payload']
        }
      }
    ],
    tool_choice: 'auto',
    reasoning: { effort: 'low' }
  };

  return fetchOpenAIJson('responses', requestBody);
}

function extractAssistantText(response) {
  const chunks = [];
  for (const item of response.output || []) {
    if (item.type === 'message') {
      for (const content of item.content || []) {
        if (content.type === 'output_text' && content.text) {
          chunks.push(content.text);
        } else if (content.type === 'text' && content.text) {
          chunks.push(content.text);
        }
      }
    }
  }
  return chunks.join('\n').trim();
}

function extractFunctionCalls(response) {
  return (response.output || []).filter((item) => item.type === 'function_call');
}

// ── Tool execution ──
async function executeToolCall(toolCall) {
  const { name, arguments: args } = toolCall;

  switch (name) {
    case 'get_form_fields': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.tabs.sendMessage(tab.id, { action: 'get_form_fields' });
      return { fields: result.fields };
    }

    case 'fill_form': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.tabs.sendMessage(tab.id, {
        action: 'fill_form',
        payload: args.payload
      });
      return result;
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Main conversation flow ──
async function handleUserMessage(text) {
  if (!text.trim()) return;

  addMessage('user', text);
  updateStatus('active', 'Processing...');

  try {
    const response = await callResponsesAPI(text);

    // Extract assistant text
    const assistantText = extractAssistantText(response);
    if (assistantText) {
      addMessage('assistant', assistantText);
    }

    // Execute tool calls
    const functionCalls = extractFunctionCalls(response);
    for (const toolCall of functionCalls) {
      const result = await executeToolCall(toolCall);
      addMessage('assistant', `✓ ${toolCall.name}: ${JSON.stringify(result, null, 2)}`);
    }

    updateStatus('ready', 'Ready');
  } catch (error) {
    console.error('Error:', error);
    addMessage('assistant', `❌ 錯誤: ${error.message}`);
    updateStatus('error', 'Error');
  }
}

// ── Voice recording ──
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const duration = Date.now() - recordingStartedAt;

      if (duration < MIN_RECORDING_MS) {
        addMessage('assistant', '🎤 錄音時間太短，請重試');
        updateStatus('ready', 'Ready');
        return;
      }

      const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });

      try {
        updateStatus('active', 'Transcribing...');
        const transcript = await transcribeAudio(audioBlob);

        if (!transcript) {
          addMessage('assistant', '🎤 Whisper 沒有辨識到語音，請重試');
          updateStatus('ready', 'Ready');
          return;
        }

        addMessage('user', `🎤 ${transcript}`);
        await handleUserMessage(transcript);
      } catch (error) {
        console.error('Transcription error:', error);
        addMessage('assistant', `❌ 語音處理失敗: ${error.message}`);
        updateStatus('error', 'Error');
      }

      stream.getTracks().forEach(track => track.stop());
    };

    recordingStartedAt = Date.now();
    mediaRecorder.start();
    isRecording = true;

    btnStart.style.display = 'none';
    btnStop.style.display = 'block';
    updateStatus('recording', 'Recording...');
  } catch (error) {
    console.error('Failed to start recording:', error);
    addMessage('assistant', `❌ 無法啟動麥克風: ${error.message}`);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    isRecording = false;
    btnStart.style.display = 'block';
    btnStop.style.display = 'none';
  }
}

// ── Event handlers ──
settingsBtn.addEventListener('click', () => {
  const isHidden = settingsDrawer.hasAttribute('hidden');
  if (isHidden) {
    apiKeyInput.value = apiKey || '';
    reasoningModelSelect.value = reasoningModel;
    settingsDrawer.removeAttribute('hidden');
  } else {
    settingsDrawer.setAttribute('hidden', '');
  }
});

toggleKeyBtn.addEventListener('click', () => {
  const type = apiKeyInput.type;
  apiKeyInput.type = type === 'password' ? 'text' : 'password';
});

saveSettingsBtn.addEventListener('click', async () => {
  const newKey = apiKeyInput.value.trim();

  if (!newKey) {
    keyStatusEl.textContent = '請輸入 API Key';
    keyStatusEl.className = 'sp-status-msg sp-status-error';
    return;
  }

  if (!newKey.startsWith('sk-')) {
    keyStatusEl.textContent = 'API Key 格式錯誤（應以 sk- 開頭）';
    keyStatusEl.className = 'sp-status-msg sp-status-error';
    return;
  }

  apiKey = newKey;
  reasoningModel = reasoningModelSelect.value;

  await saveSettings();

  keyStatusEl.textContent = '✓ 設定已儲存';
  keyStatusEl.className = 'sp-status-msg sp-status-success';

  setTimeout(() => {
    settingsDrawer.setAttribute('hidden', '');
    updateStatus('ready', 'Ready');
    showApiStatus('API Key configured', false);
  }, 1000);
});

cancelSettingsBtn.addEventListener('click', () => {
  settingsDrawer.setAttribute('hidden', '');
});

btnStart.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopRecording);

btnSend.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (text) {
    handleUserMessage(text);
    chatInput.value = '';
  }
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    btnSend.click();
  }
});

// ── Init ──
(async () => {
  await loadSettings();

  if (!apiKey) {
    addMessage('assistant', '👋 歡迎使用語音填表助理！\n\n請先點擊右上角設定按鈕，輸入你的 OpenAI API Key。');
  } else {
    addMessage('assistant', '👋 準備好了！你可以用語音或文字告訴我要填寫什麼表單。');
  }
})();
