// ── Hybrid Mode: Enterprise (with guardrail) + Personal (pure frontend) ──

// Configuration
const DEFAULT_BACKEND_URL = 'http://localhost:8000';
const MIN_RECORDING_MS = 500;
const STRUCTURING_MODEL = 'gpt-4.1';

// State
let config = {
  connectionMode: 'personal',
  backendUrl: DEFAULT_BACKEND_URL,
  apiKey: null,
  voiceMode: 'whisper',
  realtimeModel: 'gpt-4o-realtime-preview-2024-12-17',
  whisperModel: 'gpt-4o-transcribe',
  guardrailEnabled: true
};

let isRecording = false;
let recordingStartedAt = 0;
let conversationHistory = [];
let currentFormFields = null;
let realtimeWs = null;
let realtimeConnected = false;

// DOM refs
const chat = document.getElementById('chat');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const settingsBtn = document.getElementById('settings-btn');
const settingsDrawer = document.getElementById('settings-drawer');
const connectionModeSelect = document.getElementById('connection-mode');
const backendUrlInput = document.getElementById('backend-url');
const backendUrlGroup = document.getElementById('backend-url-group');
const apiKeyInput = document.getElementById('api-key-input');
const toggleKeyBtn = document.getElementById('toggle-key-btn');
const voiceModeSelect = document.getElementById('voice-mode');
const voiceModeHint = document.getElementById('voice-mode-hint');
const realtimeModelSelect = document.getElementById('realtime-model-select');
const whisperModelSelect = document.getElementById('whisper-model-select');
const realtimeModelGroup = document.getElementById('realtime-model-group');
const whisperModelGroup = document.getElementById('whisper-model-group');
const guardrailEnabled = document.getElementById('guardrail-enabled');
const guardrailToggleRow = document.getElementById('guardrail-toggle-row');
const saveSettingsBtn = document.getElementById('save-settings');
const cancelSettingsBtn = document.getElementById('cancel-settings');
const modeDescription = document.getElementById('mode-description');
const keyStatusEl = document.getElementById('key-status');
const modeChip = document.getElementById('mode-chip');
const modeChipText = document.getElementById('mode-chip-text');
const apiStatusEl = document.getElementById('api-status');
const apiStatusText = document.getElementById('api-status-text');

// ── Settings persistence ──
async function loadSettings() {
  const result = await chrome.storage.local.get([
    'connection_mode', 'backend_url', 'openai_api_key',
    'voice_mode', 'realtime_model', 'whisper_model', 'guardrail_enabled'
  ]);

  config.connectionMode = result.connection_mode || 'personal';
  config.backendUrl = result.backend_url || DEFAULT_BACKEND_URL;
  config.apiKey = result.openai_api_key || null;
  config.voiceMode = result.voice_mode || 'whisper';
  config.realtimeModel = result.realtime_model || 'gpt-4o-realtime-preview-2024-12-17';
  config.whisperModel = result.whisper_model || 'gpt-4o-transcribe';
  config.guardrailEnabled = result.guardrail_enabled !== false;

  updateModeChip();
  updateStatusBasedOnConfig();
  return config;
}

async function saveSettings() {
  await chrome.storage.local.set({
    connection_mode: config.connectionMode,
    backend_url: config.backendUrl,
    openai_api_key: config.apiKey,
    voice_mode: config.voiceMode,
    realtime_model: config.realtimeModel,
    whisper_model: config.whisperModel,
    guardrail_enabled: config.guardrailEnabled
  });
}

function updateModeChip() {
  if (config.connectionMode === 'enterprise') {
    modeChipText.textContent = config.guardrailEnabled ? '企業模式 + Guardrail' : '企業模式';
  } else {
    modeChipText.textContent = '個人模式（純前端）';
  }
}

function updateStatusBasedOnConfig() {
  if (!config.apiKey) {
    updateStatus('disconnected', 'No API Key');
    return;
  }
  if (config.voiceMode === 'realtime' && realtimeConnected) {
    updateStatus('ready', 'Realtime Connected');
  } else {
    updateStatus('ready', config.connectionMode === 'enterprise' ? 'Ready (Enterprise)' : 'Ready (Personal)');
  }
}

function updateStatus(status, text) {
  statusDot.className = `sp-dot sp-dot-${status}`;
  statusText.textContent = text;
}

function showApiStatus(message, isError = false) {
  apiStatusEl.style.display = 'block';
  apiStatusText.textContent = message;
  apiStatusEl.className = `sp-status-chip ${isError ? 'sp-status-error' : 'sp-status-success'}`;
  setTimeout(() => { apiStatusEl.style.display = 'none'; }, 3000);
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
  return bubble;
}

function renderMarkdown(text) {
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
  return html;
}

// ── Form Detection & Schema Resolution ──
let activeFormSchema = null; // The matched predefined schema (or null for generic)

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function getActiveTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || '';
}

async function detectFormContext() {
  const tabId = await getActiveTabId();
  if (!tabId) return null;

  const url = await getActiveTabUrl();

  // Try to match a predefined schema by URL
  activeFormSchema = matchFormSchema(url);
  if (activeFormSchema) {
    console.log(`Matched predefined form: ${activeFormSchema.label}`);
    return { type: 'predefined', schema: activeFormSchema };
  }

  // Fallback: detect fields from the page
  try {
    await ensureContentScript(tabId);
    const response = await chrome.tabs.sendMessage(tabId, { action: 'get_form_fields' });
    if (response && response.fields && response.fields.length > 0) {
      currentFormFields = response.fields;
      return { type: response.type || 'generic', fields: response.fields };
    }
  } catch (e) {
    console.warn('Cannot detect form fields:', e.message);
  }
  return null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch {
    // Content script not injected yet - inject it now
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    // Wait for it to initialize
    await new Promise(r => setTimeout(r, 200));
  }
}

async function fillFormOnPage(payload) {
  const tabId = await getActiveTabId();
  if (!tabId) throw new Error('No active tab');

  await ensureContentScript(tabId);

  const response = await chrome.tabs.sendMessage(tabId, {
    action: 'fill_form',
    payload
  });

  return response;
}

// ── Build tool schema for generic (unknown) forms ──
function buildGenericToolSchema(fields) {
  const properties = {};
  const requiredSet = new Set();

  for (const field of fields) {
    const key = field.name || field.id || field.label;
    if (!key || requiredSet.has(key)) continue;

    const prop = { type: 'string' };
    if (field.label) prop.description = field.label;
    if (field.options) {
      prop.description = (prop.description || '') + ` [選項: ${field.options.slice(0, 5).join(', ')}]`;
    }
    if (field.placeholder) prop.description = (prop.description || '') + ` (例: ${field.placeholder})`;

    properties[key] = prop;
    requiredSet.add(key);
  }

  return {
    type: 'function',
    function: {
      name: 'fill_form',
      description: '當使用者提供了足夠的資訊，填入網頁表單欄位。只有在所有必填欄位都有值時才能呼叫。',
      parameters: {
        type: 'object',
        properties,
        required: [...requiredSet]
      }
    }
  };
}

function getToolSchema(formContext) {
  if (formContext.type === 'predefined') {
    return formContext.schema.toolSchema;
  }
  return buildGenericToolSchema(formContext.fields);
}

function getSystemPrompt(formContext) {
  if (formContext.type === 'predefined') {
    return formContext.schema.instructions;
  }

  // Generic prompt for unknown forms
  let prompt = `你是語音填表助理。使用者會用語音或文字告訴你要填寫什麼內容。
你的任務是：
1. 理解使用者的意圖
2. 從對話中提取所有表單欄位需要的值
3. 當所有必填欄位都有值時，呼叫 fill_form 填入表單
4. 如果資訊不完整，用繁體中文簡短追問缺少的欄位

回覆規則：
- 用繁體中文回覆
- 每次回覆不超過兩句話
- 確認完所有欄位後直接呼叫 fill_form`;

  if (formContext.fields && formContext.fields.length > 0) {
    prompt += '\n\n目前頁面的表單欄位：\n';
    for (const f of formContext.fields) {
      const label = f.label || f.name || f.id;
      prompt += `- ${label} (${f.tag})`;
      if (f.options) prompt += ` [選項: ${f.options.slice(0, 5).join(', ')}]`;
      if (f.placeholder) prompt += ` [提示: ${f.placeholder}]`;
      prompt += '\n';
    }
  }

  return prompt;
}

// ── Settings UI handlers ──
connectionModeSelect.addEventListener('change', () => {
  const mode = connectionModeSelect.value;
  if (mode === 'enterprise') {
    modeDescription.textContent = '企業模式：所有請求經過後端檢查';
    backendUrlGroup.style.display = 'flex';
    guardrailToggleRow.style.display = 'flex';
    const realtimeOption = voiceModeSelect.querySelector('option[value="realtime"]');
    if (realtimeOption) realtimeOption.disabled = false;
  } else {
    modeDescription.textContent = '個人模式：直接調用 OpenAI API，支援即時與錄音';
    backendUrlGroup.style.display = 'none';
    guardrailToggleRow.style.display = 'none';
    const realtimeOption = voiceModeSelect.querySelector('option[value="realtime"]');
    if (realtimeOption) realtimeOption.disabled = false;
  }
});

voiceModeSelect.addEventListener('change', () => {
  const mode = voiceModeSelect.value;
  if (mode === 'realtime') {
    voiceModeHint.textContent = '即時對話：低延遲串流，AI 即時回應';
    realtimeModelGroup.style.display = 'flex';
    whisperModelGroup.style.display = 'none';
  } else {
    voiceModeHint.textContent = '錄音轉譯：錄完後一次轉文字再處理';
    realtimeModelGroup.style.display = 'none';
    whisperModelGroup.style.display = 'flex';
  }
});

settingsBtn.addEventListener('click', () => {
  const isHidden = settingsDrawer.hasAttribute('hidden');
  if (isHidden) {
    connectionModeSelect.value = config.connectionMode;
    backendUrlInput.value = config.backendUrl;
    apiKeyInput.value = config.apiKey || '';
    voiceModeSelect.value = config.voiceMode;
    realtimeModelSelect.value = config.realtimeModel;
    whisperModelSelect.value = config.whisperModel;
    guardrailEnabled.checked = config.guardrailEnabled;
    connectionModeSelect.dispatchEvent(new Event('change'));
    voiceModeSelect.dispatchEvent(new Event('change'));
    settingsDrawer.removeAttribute('hidden');
  } else {
    settingsDrawer.setAttribute('hidden', '');
  }
});

toggleKeyBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
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

  config.connectionMode = connectionModeSelect.value;
  config.backendUrl = backendUrlInput.value.trim() || DEFAULT_BACKEND_URL;
  config.apiKey = newKey;
  config.voiceMode = voiceModeSelect.value;
  config.realtimeModel = realtimeModelSelect.value;
  config.whisperModel = whisperModelSelect.value;
  config.guardrailEnabled = guardrailEnabled.checked;

  await saveSettings();

  keyStatusEl.textContent = '✓ 設定已儲存';
  keyStatusEl.className = 'sp-status-msg sp-status-success';
  updateModeChip();
  updateStatusBasedOnConfig();

  setTimeout(() => {
    settingsDrawer.setAttribute('hidden', '');
    showApiStatus('設定已更新', false);
  }, 1000);
});

cancelSettingsBtn.addEventListener('click', () => {
  settingsDrawer.setAttribute('hidden', '');
});

// ══════════════════════════════════════════════════════════════
// ── WHISPER MODE: Record → Transcribe → Function Call → Fill ──
// ══════════════════════════════════════════════════════════════

let micPermissionGranted = false;

async function startWhisperRecording() {
  try {
    if (!micPermissionGranted) {
      updateStatus('active', 'Requesting microphone permission...');
      const permResponse = await chrome.runtime.sendMessage({
        target: 'background',
        action: 'request_mic_permission'
      });
      if (!permResponse || !permResponse.success) {
        throw new Error('NotAllowedError: Microphone permission denied');
      }
      micPermissionGranted = true;
    }

    updateStatus('active', 'Starting microphone...');
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_recording'
    });

    if (!response || !response.success) {
      if (response?.errorName === 'NotAllowedError') {
        micPermissionGranted = false;
      }
      throw new Error(response?.error || 'Failed to start recording');
    }

    recordingStartedAt = Date.now();
    isRecording = true;
    btnStart.style.display = 'none';
    btnStop.style.display = 'block';
    updateStatus('recording', 'Recording...');
  } catch (error) {
    console.error('Failed to start recording:', error);
    handleRecordingError(error);
  }
}

async function stopWhisperRecording() {
  if (!isRecording) return;

  try {
    updateStatus('active', 'Processing...');
    const duration = Date.now() - recordingStartedAt;

    if (duration < MIN_RECORDING_MS) {
      addMessage('assistant', '🎤 錄音時間太短（至少0.5秒），請重試');
      updateStatusBasedOnConfig();
      isRecording = false;
      btnStart.style.display = 'block';
      btnStop.style.display = 'none';
      return;
    }

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_recording'
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to stop recording');
    }

    isRecording = false;
    btnStart.style.display = 'block';
    btnStop.style.display = 'none';

    const audioBlob = base64ToBlob(response.audioData, 'audio/webm');

    updateStatus('active', 'Transcribing...');
    const transcript = await transcribeAudio(audioBlob);

    if (!transcript) {
      addMessage('assistant', '🎤 沒有辨識到語音，請重試');
      updateStatusBasedOnConfig();
      return;
    }

    addMessage('user', `🎤 ${transcript}`);
    await handleUserMessage(transcript);
  } catch (error) {
    console.error('Stop recording error:', error);
    addMessage('assistant', `❌ 錄音處理失敗: ${error.message}`);
    updateStatus('error', 'Error');
    isRecording = false;
    btnStart.style.display = 'block';
    btnStop.style.display = 'none';
  }
}

// ── Transcription ──
async function transcribeAudio(audioBlob) {
  if (!config.apiKey) throw new Error('請先在設定中填入 OpenAI API Key');

  if (config.connectionMode === 'enterprise') {
    const audioBase64 = await blobToBase64(audioBlob);
    const response = await fetch(`${config.backendUrl}/api/byok-transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.apiKey,
        audio_base64: audioBase64.split(',')[1],
        model: config.whisperModel,
        language: 'zh',
        guardrail_enabled: config.guardrailEnabled
      })
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Transcription failed');
    }
    return (await response.json()).text;
  } else {
    const formData = new FormData();
    formData.append('model', config.whisperModel);
    formData.append('file', audioBlob, 'recording.webm');
    formData.append('response_format', 'json');
    formData.append('language', 'zh');
    if (config.whisperModel === 'whisper-1') {
      formData.append('prompt', '以下是繁體中文語音輸入，用於填寫表單。');
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: formData
    });

    if (!response.ok) throw new Error(`Whisper failed: ${await response.text()}`);
    return (await response.json()).text.trim();
  }
}

// ── Guardrail UI helper ──
function addGuardrailChip(side, passed, reason) {
  const chip = document.createElement('div');
  chip.className = `sp-message sp-message-system`;
  const inner = document.createElement('div');
  inner.className = 'sp-guardrail-chip';

  if (passed) {
    inner.innerHTML = `<span class="sp-guard-pass">✓ ${side === 'input' ? 'Input' : 'Output'} 安全檢查通過</span>`;
  } else {
    inner.innerHTML = `<span class="sp-guard-block">✗ ${side === 'input' ? 'Input' : 'Output'} 被阻攔 — ${reason}</span>`;
  }

  chip.appendChild(inner);
  chat.appendChild(chip);
  chat.scrollTop = chat.scrollHeight;
}

// ── Chat Completions with Function Calling (Whisper mode) ──
async function handleUserMessage(text) {
  if (!text.trim()) return;
  if (!config.apiKey) {
    addMessage('assistant', '❌ 請先在設定中填入 OpenAI API Key');
    return;
  }

  // ── Input Guardrail ──
  if (config.guardrailEnabled) {
    const inputCheck = checkGuardrail(text);
    addGuardrailChip('input', inputCheck.passed, inputCheck.reason);

    if (!inputCheck.passed) {
      addMessage('assistant', `🚫 輸入被安全機制阻攔\n\n類別：**${inputCheck.reason}**\n偵測到：「${inputCheck.matched}」\n\n此內容無法處理，請重新描述您的需求。`);
      updateStatusBasedOnConfig();
      return;
    }
  }

  updateStatus('active', 'Thinking...');

  // Detect form context (predefined schema or generic fields)
  const formContext = await detectFormContext();
  if (!formContext) {
    addMessage('assistant', '⚠️ 目前頁面沒有偵測到表單欄位。請切換到有表單的頁面再試。');
    updateStatusBasedOnConfig();
    return;
  }

  if (formContext.type === 'predefined' && conversationHistory.length === 0) {
    addMessage('assistant', `📋 偵測到：**${formContext.schema.label}**`);
  }

  // Build conversation
  conversationHistory.push({ role: 'user', content: text });

  const systemPrompt = getSystemPrompt(formContext);
  const tools = [getToolSchema(formContext)];

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: STRUCTURING_MODEL,
        messages,
        tools,
        tool_choice: 'auto'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API error: ${errText}`);
    }

    const data = await response.json();
    const choice = data.choices[0];
    const msg = choice.message;

    // ── Output Guardrail ──
    if (config.guardrailEnabled && msg.content) {
      const outputCheck = checkGuardrail(msg.content);
      addGuardrailChip('output', outputCheck.passed, outputCheck.reason);

      if (!outputCheck.passed) {
        addMessage('assistant', `🚫 AI 回應被安全機制阻攔\n\n類別：**${outputCheck.reason}**`);
        conversationHistory.push({ role: 'assistant', content: '[blocked by guardrail]' });
        updateStatusBasedOnConfig();
        return;
      }
    }

    // Add assistant response to history
    conversationHistory.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCall = msg.tool_calls[0];
      if (toolCall.function.name === 'fill_form') {
        const payload = JSON.parse(toolCall.function.arguments);
        addMessage('assistant', '✅ 正在填入表單...');
        updateStatus('active', 'Filling form...');

        let result;
        try {
          result = await fillFormOnPage(payload);
        } catch (fillError) {
          // Fill failed - still need to record tool response for conversation continuity
          result = { filled: [], failed: [{ key: '_all', reason: fillError.message }] };
          addMessage('assistant', `❌ 填表失敗: ${fillError.message}\n\n可能需要重新整理表單頁面。`);
        }

        if (result.filled && result.filled.length > 0 && (!result.failed || result.failed.length === 0)) {
          addMessage('assistant', `✅ 表單已填入完成！請確認內容無誤後送出。`);
        } else if (result.filled && result.filled.length > 0 && result.failed?.length > 0) {
          addMessage('assistant', `⚠️ 部分欄位填入成功，但有 ${result.failed.length} 個欄位需要手動處理。`);
        }

        // ALWAYS add tool response to keep conversation valid
        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });

        updateStatusBasedOnConfig();
      }
    } else if (msg.content) {
      addMessage('assistant', msg.content);
      updateStatusBasedOnConfig();
    }
  } catch (error) {
    console.error('Error:', error);
    // If API error due to broken conversation, reset history
    if (error.message.includes('tool_call_id') || error.message.includes('tool_calls')) {
      conversationHistory = [];
      addMessage('assistant', `⚠️ 對話記錄已重置。請重新描述您要填寫的內容。`);
    } else {
      addMessage('assistant', `❌ 錯誤: ${error.message}`);
    }
    updateStatus('error', 'Error');
  }
}

// ══════════════════════════════════════════════════════════════
// ── REALTIME MODE: WebSocket streaming with function calling ──
// ══════════════════════════════════════════════════════════════

let realtimeAudioContext = null;
let realtimeAgentBubble = null;

async function startRealtimeSession() {
  if (!config.apiKey) {
    addMessage('assistant', '❌ 請先在設定中填入 OpenAI API Key');
    return;
  }

  if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
    addMessage('assistant', '⚠️ 即時連線已在進行中');
    return;
  }

  // Ensure mic permission
  if (!micPermissionGranted) {
    const permResponse = await chrome.runtime.sendMessage({
      target: 'background',
      action: 'request_mic_permission'
    });
    if (!permResponse || !permResponse.success) {
      addMessage('assistant', '❌ 麥克風權限被拒絕');
      return;
    }
    micPermissionGranted = true;
  }

  // Detect form context
  const formContext = await detectFormContext();
  if (!formContext) {
    addMessage('assistant', '⚠️ 目前頁面沒有偵測到表單欄位。請切換到有表單的頁面再試。');
    return;
  }

  if (formContext.type === 'predefined') {
    addMessage('assistant', `📋 偵測到：**${formContext.schema.label}**`);
  }

  updateStatus('active', 'Connecting to Realtime API...');
  addMessage('assistant', '🔄 連接即時語音...');

  try {
    if (config.connectionMode === 'enterprise') {
      await startRealtimeEnterprise(formContext);
    } else {
      await startRealtimePersonal(formContext);
    }
  } catch (error) {
    console.error('Realtime connection error:', error);
    addMessage('assistant', `❌ 即時連線失敗: ${error.message}`);
    updateStatus('error', 'Connection failed');
  }
}

async function startRealtimePersonal(formContext) {
  const url = `wss://api.openai.com/v1/realtime?model=${config.realtimeModel}`;

  realtimeWs = new WebSocket(url, [
    'realtime',
    `openai-insecure-api-key.${config.apiKey}`,
    'openai-beta.realtime-v1'
  ]);

  realtimeWs.onopen = () => {
    realtimeConnected = true;
    updateStatus('ready', 'Realtime Connected');

    const systemPrompt = getSystemPrompt(formContext);
    const tool = getToolSchema(formContext);

    // Realtime API tool format is slightly different from Chat Completions
    const realtimeTool = {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    };

    realtimeWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemPrompt,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.85,
          silence_duration_ms: 1000
        },
        tools: [realtimeTool],
        tool_choice: 'auto'
      }
    }));

    addMessage('assistant', '🎙️ 即時語音已連接！開始說話即可，AI 會即時回應並在資訊完整時自動填表。');
    startRealtimeAudioCapture();
  };

  realtimeWs.onmessage = (event) => {
    handleRealtimeEvent(JSON.parse(event.data));
  };

  realtimeWs.onerror = (error) => {
    console.error('WebSocket error:', error);
    addMessage('assistant', '❌ WebSocket 連線錯誤');
    disconnectRealtime();
  };

  realtimeWs.onclose = () => {
    disconnectRealtime();
  };
}

async function startRealtimeEnterprise(formContext) {
  const wsUrl = config.backendUrl.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    model: config.realtimeModel,
    guardrail: config.guardrailEnabled ? 'keyword' : 'none'
  });

  // If we matched a predefined form, pass its ID
  if (formContext.type === 'predefined') {
    params.set('form', formContext.schema.id);
  }

  realtimeWs = new WebSocket(`${wsUrl}/ws/byok-realtime?${params}`);

  realtimeWs.onopen = () => {
    realtimeConnected = true;
    updateStatus('ready', 'Realtime Connected (Enterprise)');

    realtimeWs.send(JSON.stringify({
      type: 'init',
      api_key: config.apiKey,
      form_id: formContext.type === 'predefined' ? formContext.schema.id : null
    }));

    addMessage('assistant', '🎙️ 即時語音已連接（企業模式）！開始說話即可。');
    startRealtimeAudioCapture();
  };

  realtimeWs.onmessage = (event) => {
    handleRealtimeEvent(JSON.parse(event.data));
  };

  realtimeWs.onerror = () => {
    addMessage('assistant', '❌ 企業模式 WebSocket 連線錯誤');
    disconnectRealtime();
  };

  realtimeWs.onclose = () => {
    disconnectRealtime();
  };
}

let realtimeToolCallBuffer = '';

function handleRealtimeEvent(event) {
  const type = event.type;

  if (type === 'session.created' || type === 'session.updated') {
    console.log('Realtime session configured');
  } else if (type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = event.transcript;
    if (transcript && transcript.trim()) {
      addMessage('user', `🎤 ${transcript}`);
    }
  } else if (type === 'response.audio_transcript.delta' || type === 'response.text.delta') {
    // Streaming AI response
    if (!realtimeAgentBubble) {
      realtimeAgentBubble = addMessage('assistant', '');
    }
    realtimeAgentBubble.innerHTML += renderMarkdown(event.delta || '');
    chat.scrollTop = chat.scrollHeight;
  } else if (type === 'response.done' || type === 'response.output_text.done') {
    realtimeAgentBubble = null;
  } else if (type === 'response.function_call_arguments.delta') {
    realtimeToolCallBuffer += event.delta || '';
  } else if (type === 'response.function_call_arguments.done') {
    const args = event.arguments || realtimeToolCallBuffer;
    realtimeToolCallBuffer = '';
    handleRealtimeToolCall(args, event.call_id);
  } else if (type === 'audio_delta') {
    // Play audio (optional - requires AudioContext)
    // For now, text response is shown
  } else if (type === 'error') {
    const errMsg = event.error?.message || event.message || 'Unknown error';
    addMessage('assistant', `❌ Realtime error: ${errMsg}`);
  } else if (type === 'form_ready') {
    // Enterprise mode: backend already parsed form
    handleRealtimeFormFill(event.payload);
  } else if (type === 'browser_fill_done') {
    addMessage('assistant', '✅ 表單已由後端自動填入！');
  }
}

async function handleRealtimeToolCall(argsStr, callId) {
  try {
    const payload = JSON.parse(argsStr);
    addMessage('assistant', '✅ AI 判斷資訊完整，正在填入表單...');
    updateStatus('active', 'Filling form...');

    const result = await fillFormOnPage(payload);

    let resultMsg = '';
    if (result.filled && result.filled.length > 0) {
      resultMsg += `✅ 已填入 ${result.filled.length} 個欄位`;
    }
    if (result.failed && result.failed.length > 0) {
      resultMsg += `\n⚠️ ${result.failed.length} 個欄位失敗`;
    }
    addMessage('assistant', resultMsg || '✅ 表單已填入！');

    // Send tool output back to realtime API
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      realtimeWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ status: 'success', ...result })
        }
      }));
      realtimeWs.send(JSON.stringify({ type: 'response.create' }));
    }

    updateStatusBasedOnConfig();
  } catch (error) {
    addMessage('assistant', `❌ 填表失敗: ${error.message}`);
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      realtimeWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ status: 'error', message: error.message })
        }
      }));
      realtimeWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }
}

async function handleRealtimeFormFill(payload) {
  try {
    const result = await fillFormOnPage(payload);
    let msg = '';
    if (result.filled?.length > 0) msg += `✅ 已填入 ${result.filled.length} 個欄位`;
    if (result.failed?.length > 0) msg += `\n⚠️ ${result.failed.length} 個欄位失敗`;
    addMessage('assistant', msg || '✅ 表單已填入！');
  } catch (error) {
    addMessage('assistant', `❌ 填表失敗: ${error.message}`);
  }
}

// ── Realtime Audio Capture ──
let audioStream = null;
let audioProcessor = null;

async function startRealtimeAudioCapture() {
  try {
    // Start recording via offscreen document for raw PCM
    const startResp = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_recording'
    });

    if (!startResp || !startResp.success) {
      // Fallback: Use direct getUserMedia if in permission-granted popup window
      throw new Error(startResp?.error || 'Cannot start audio capture');
    }

    isRecording = true;
    btnStart.style.display = 'none';
    btnStop.style.display = 'block';
    updateStatus('recording', 'Listening...');
  } catch (error) {
    console.error('Audio capture error:', error);
    addMessage('assistant', `⚠️ 音訊擷取失敗: ${error.message}\n\n嘗試使用錄音模式作為備選。`);
  }
}

function disconnectRealtime() {
  realtimeConnected = false;
  if (realtimeWs) {
    if (realtimeWs.readyState === WebSocket.OPEN) {
      realtimeWs.close();
    }
    realtimeWs = null;
  }
  isRecording = false;
  btnStart.style.display = 'block';
  btnStop.style.display = 'none';
  updateStatusBasedOnConfig();
}

function stopRealtimeSession() {
  if (realtimeWs) {
    // Stop sending audio
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop_recording' }).catch(() => {});
    disconnectRealtime();
    addMessage('assistant', '🔌 即時語音已斷開');
  }
}

// ══════════════════════════════════════════════════════════════
// ── Common utilities ──
// ══════════════════════════════════════════════════════════════

function handleRecordingError(error) {
  let errorMessage = '無法啟動麥克風';

  if (error.message && error.message.includes('NotAllowedError')) {
    errorMessage = `麥克風權限被拒絕。請到 chrome://settings/content/microphone 允許此擴充功能。`;
  } else if (error.message && error.message.includes('NotFoundError')) {
    errorMessage = `找不到麥克風設備。請確認麥克風已連接。`;
  } else if (error.message && error.message.includes('NotReadableError')) {
    errorMessage = `麥克風被占用。請關閉其他使用麥克風的程式。`;
  } else {
    errorMessage = `麥克風錯誤：${error.message}`;
  }

  addMessage('assistant', `❌ ${errorMessage}`);
  updateStatusBasedOnConfig();
}

function base64ToBlob(base64, mimeType) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Event handlers ──
btnStart.addEventListener('click', () => {
  if (config.voiceMode === 'realtime') {
    if (realtimeConnected) {
      // Already connected, do nothing (listening is automatic)
      return;
    }
    startRealtimeSession();
  } else {
    startWhisperRecording();
  }
});

btnStop.addEventListener('click', () => {
  if (config.voiceMode === 'realtime') {
    stopRealtimeSession();
  } else {
    stopWhisperRecording();
  }
});

btnSend.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (text) {
    addMessage('user', text);
    handleUserMessage(text);
    chatInput.value = '';
  }
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    btnSend.click();
  }
});

// ── Init ──
(async () => {
  await loadSettings();

  if (!config.apiKey) {
    addMessage('assistant', '👋 歡迎使用語音填表助理！\n\n請先點擊右上角 ⚙️ 設定按鈕，輸入你的 OpenAI API Key。\n\n支援兩種模式：\n• **即時對話** - AI 即時聽取語音並自動填表\n• **錄音轉譯** - 錄完後轉文字，再由 AI 判斷填表');
  } else {
    const modeText = config.voiceMode === 'realtime' ? '即時對話' : '錄音轉譯';
    addMessage('assistant', `👋 準備好了！模式：${modeText}\n\n請切換到有表單的頁面，然後按麥克風按鈕開始語音填表。`);
  }
})();
