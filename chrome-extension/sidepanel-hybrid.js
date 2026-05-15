// ── Chrome Extension: direct OpenAI + local lightweight guardrail ──

// Configuration
const MIN_RECORDING_MS = 500;
const STRUCTURING_MODEL = 'gpt-4.1';
const REALTIME_MODEL = 'gpt-realtime-2';
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const REALTIME_PRICING = {
  'gpt-realtime-2': {
    textInputPer1K: 0.004,
    textOutputPer1K: 0.024,
    audioInputPer1K: 0.032,
    audioOutputPer1K: 0.064
  },
  'gpt-4o-realtime-preview-2024-12-17': {
    textInputPer1K: 0.0055,
    textOutputPer1K: 0.022,
    audioInputPer1K: 0.044,
    audioOutputPer1K: 0.08
  },
  'gpt-4o-realtime-preview-2024-10-01': {
    textInputPer1K: 0.0055,
    textOutputPer1K: 0.022,
    audioInputPer1K: 0.11,
    audioOutputPer1K: 0.22
  },
  'gpt-4o-mini-realtime-preview-2024-12-17': {
    textInputPer1K: 0.00066,
    textOutputPer1K: 0.00264,
    audioInputPer1K: 0.011,
    audioOutputPer1K: 0.022
  }
};
const CHAT_PRICING = {
  'gpt-4.1': { inputPer1K: 0.002, outputPer1K: 0.008 },
  'gpt-4.1-mini': { inputPer1K: 0.0004, outputPer1K: 0.0016 },
  'gpt-4o': { inputPer1K: 0.0025, outputPer1K: 0.01 },
  'gpt-4o-mini': { inputPer1K: 0.00015, outputPer1K: 0.0006 }
};

// State
let config = {
  apiKey: null,
  guardrailEnabled: true
};

let isRecording = false;
let activeAudioMode = null;
let recordingStartedAt = 0;
let conversationHistory = [];
let currentFormFields = null;
let realtimeWs = null;
let realtimeConnected = false;

// DOM refs
const chat = document.getElementById('chat');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const btnRecord = document.getElementById('btn-record');
const btnRealtime = document.getElementById('btn-realtime');
const btnStop = document.getElementById('btn-stop');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const settingsBtn = document.getElementById('settings-btn');
const settingsDrawer = document.getElementById('settings-drawer');
const apiKeyInput = document.getElementById('api-key-input');
const toggleKeyBtn = document.getElementById('toggle-key-btn');
const guardrailEnabled = document.getElementById('guardrail-enabled');
const guardrailToggleRow = document.getElementById('guardrail-toggle-row');
const saveSettingsBtn = document.getElementById('save-settings');
const cancelSettingsBtn = document.getElementById('cancel-settings');
const keyStatusEl = document.getElementById('key-status');
const modeChip = document.getElementById('mode-chip');
const modeChipText = document.getElementById('mode-chip-text');
const apiStatusEl = document.getElementById('api-status');
const apiStatusText = document.getElementById('api-status-text');
const costTotalEl = document.getElementById('cost-total');
const costSubtitleEl = document.getElementById('cost-subtitle');
const costTextTokensEl = document.getElementById('cost-text-tokens');
const costAudioTokensEl = document.getElementById('cost-audio-tokens');
const costHistorySummaryEl = document.getElementById('cost-history-summary');
const costHistoryListEl = document.getElementById('cost-history-list');
const clearCostHistoryBtn = document.getElementById('clear-cost-history');

let costState = {
  id: null,
  startedAt: null,
  mode: '',
  model: '',
  inputTokens: 0,
  outputTokens: 0,
  audioInputTokens: 0,
  audioOutputTokens: 0,
  cost: 0,
  source: '尚未產生 usage'
};
let costHistory = [];

function formatCost(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function renderCostPanel() {
  if (!costTotalEl || !costSubtitleEl || !costTextTokensEl || !costAudioTokensEl) return;
  costTotalEl.textContent = formatCost(costState.cost);
  costSubtitleEl.textContent = costState.source;
  costTextTokensEl.textContent = `${costState.inputTokens || 0} / ${costState.outputTokens || 0}`;
  costAudioTokensEl.textContent = `${costState.audioInputTokens || 0} / ${costState.audioOutputTokens || 0}`;
}

function renderCostHistory() {
  if (!costHistorySummaryEl || !costHistoryListEl) return;
  const total = costHistory.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  costHistorySummaryEl.textContent = costHistory.length
    ? `${costHistory.length} 筆，累計 ${formatCost(total)}`
    : '尚無歷史紀錄';
  if (!costHistory.length) {
    costHistoryListEl.innerHTML = '<div class="sp-history-empty">完成一次對話後會出現在這裡</div>';
    return;
  }
  costHistoryListEl.innerHTML = costHistory.slice(0, 20).map((item) => {
    const when = item.endedAt || item.startedAt || '';
    const timeText = when ? new Date(when).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const textTokens = `${item.inputTokens || 0}/${item.outputTokens || 0}`;
    const audioTokens = `${item.audioInputTokens || 0}/${item.audioOutputTokens || 0}`;
    return `
      <div class="sp-history-item">
        <div class="sp-history-title">${renderMarkdown(item.title || item.model || 'Session')}</div>
        <div class="sp-history-cost">${formatCost(item.cost)}</div>
        <div class="sp-history-meta">${timeText} · 文字 ${textTokens} · 音訊 ${audioTokens}</div>
      </div>`;
  }).join('');
}

async function loadCostHistory() {
  const result = await chrome.storage.local.get(['cost_history']);
  costHistory = Array.isArray(result.cost_history) ? result.cost_history : [];
  renderCostHistory();
}

async function persistCostSnapshot() {
  if (!costState.id || Number(costState.cost || 0) <= 0) return;
  const entry = {
    id: costState.id,
    title: `${costState.mode || 'chat'} · ${costState.model || STRUCTURING_MODEL}`,
    mode: costState.mode || 'chat',
    model: costState.model || STRUCTURING_MODEL,
    startedAt: costState.startedAt,
    endedAt: new Date().toISOString(),
    inputTokens: costState.inputTokens || 0,
    outputTokens: costState.outputTokens || 0,
    audioInputTokens: costState.audioInputTokens || 0,
    audioOutputTokens: costState.audioOutputTokens || 0,
    cost: Number(costState.cost || 0)
  };
  const idx = costHistory.findIndex((item) => item.id === entry.id);
  if (idx >= 0) {
    costHistory[idx] = entry;
  } else {
    costHistory.unshift(entry);
  }
  costHistory = costHistory
    .sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')))
    .slice(0, 30);
  await chrome.storage.local.set({ cost_history: costHistory });
  renderCostHistory();
}

function schedulePersistCostSnapshot() {
  persistCostSnapshot().catch((error) => {
    console.warn('Failed to persist cost history:', error);
  });
}

function resetCostPanel(source = '尚未產生 usage', mode = 'chat', model = STRUCTURING_MODEL) {
  costState = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startedAt: new Date().toISOString(),
    mode,
    model,
    inputTokens: 0,
    outputTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    cost: 0,
    source
  };
  renderCostPanel();
}

function applyCostMeta(meta, source = 'Realtime usage') {
  if (!meta) return;
  costState = {
    ...costState,
    inputTokens: meta.inputTokens || 0,
    outputTokens: meta.outputTokens || 0,
    audioInputTokens: meta.audioInputTokens || 0,
    audioOutputTokens: meta.audioOutputTokens || 0,
    cost: Number(meta.cost || 0),
    source
  };
  renderCostPanel();
  schedulePersistCostSnapshot();
}

function accumulateRealtimeUsage(event) {
  const response = event.response || {};
  const usage = response.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const inDetails = usage.input_token_details || {};
  const outDetails = usage.output_token_details || {};
  const audioInputTokens = inDetails.audio_tokens || 0;
  const audioOutputTokens = outDetails.audio_tokens || 0;
  const pricing = REALTIME_PRICING[REALTIME_MODEL] || REALTIME_PRICING['gpt-realtime-2'];

  costState.inputTokens += inputTokens;
  costState.outputTokens += outputTokens;
  costState.audioInputTokens += audioInputTokens;
  costState.audioOutputTokens += audioOutputTokens;
  costState.cost +=
    (inputTokens / 1000) * pricing.textInputPer1K
    + (outputTokens / 1000) * pricing.textOutputPer1K
    + (audioInputTokens / 1000) * pricing.audioInputPer1K
    + (audioOutputTokens / 1000) * pricing.audioOutputPer1K;
  costState.cost = Number(costState.cost.toFixed(6));
  costState.source = 'Realtime usage';
  renderCostPanel();
  schedulePersistCostSnapshot();
}

function accumulateChatUsage(usage, model = STRUCTURING_MODEL) {
  if (!usage) return;
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  const pricing = CHAT_PRICING[model] || CHAT_PRICING[STRUCTURING_MODEL];
  costState.inputTokens += inputTokens;
  costState.outputTokens += outputTokens;
  costState.cost +=
    (inputTokens / 1000) * pricing.inputPer1K
    + (outputTokens / 1000) * pricing.outputPer1K;
  costState.cost = Number(costState.cost.toFixed(6));
  costState.source = '文字整理 usage（語音轉錄未計入）';
  renderCostPanel();
  schedulePersistCostSnapshot();
}

// ── Settings persistence ──
async function loadSettings() {
  const result = await chrome.storage.local.get([
    'openai_api_key', 'guardrail_enabled'
  ]);

  config.apiKey = result.openai_api_key || null;
  config.guardrailEnabled = result.guardrail_enabled !== false;

  updateModeChip();
  updateStatusBasedOnConfig();
  return config;
}

async function saveSettings() {
  await chrome.storage.local.set({
    openai_api_key: config.apiKey,
    guardrail_enabled: config.guardrailEnabled
  });
}

function updateModeChip() {
  modeChipText.textContent = config.guardrailEnabled ? '本機 Guardrail 已啟用' : 'Chrome Extension';
}

function updateStatusBasedOnConfig() {
  if (!config.apiKey) {
    updateStatus('disconnected', 'No API Key');
    return;
  }
  if (realtimeConnected) {
    updateStatus('ready', 'Realtime Connected');
  } else {
    updateStatus('ready', config.guardrailEnabled ? 'Ready (Local Guardrail)' : 'Ready');
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

function setVoiceControls(activeMode = null) {
  activeAudioMode = activeMode;
  const isActive = !!activeMode;
  btnRecord.style.display = isActive ? 'none' : 'flex';
  btnRealtime.style.display = isActive ? 'none' : 'flex';
  btnStop.style.display = isActive ? 'flex' : 'none';
  btnStop.title = activeMode === 'realtime' ? '停止即時語音' : '停止錄音';
}

// ── Chat UI ──
function addMessage(role, content, msgType) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `sp-message sp-message-${role}`;
  if (msgType) messageDiv.classList.add(`sp-msg-${msgType}`);
  const bubble = document.createElement('div');
  bubble.className = 'sp-bubble';
  if (msgType) bubble.classList.add(`sp-bubble-${msgType}`);
  bubble.innerHTML = renderMarkdown(content);
  messageDiv.appendChild(bubble);
  chat.appendChild(messageDiv);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function addSystemNotice(content) {
  const div = document.createElement('div');
  div.className = 'sp-system-notice';
  div.innerHTML = renderMarkdown(content);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function addErrorNotice(content) {
  const div = document.createElement('div');
  div.className = 'sp-error-notice';
  div.innerHTML = renderMarkdown(content);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function errorDetails(error, context = '') {
  if (!error) return context || 'Unknown error';
  const parts = [];
  if (context) parts.push(context);
  if (typeof error === 'string') {
    parts.push(`message=${error}`);
  } else if (error instanceof Error) {
    if (error.name) parts.push(`name=${error.name}`);
    if (error.message) parts.push(`message=${error.message}`);
    if (error.stack) parts.push(`stack=${error.stack}`);
  } else if (typeof error === 'object') {
    if (error.type) parts.push(`type=${error.type}`);
    if (error.code) parts.push(`code=${error.code}`);
    if (error.param) parts.push(`param=${error.param}`);
    if (error.message) parts.push(`message=${error.message}`);
    if (error.detail) parts.push(`detail=${JSON.stringify(error.detail)}`);
    parts.push(`payload=${JSON.stringify(error)}`);
  }
  return parts.join('\n') || String(error);
}

function reportError(context, error, extra = {}) {
  const detail = `${errorDetails(error, context)}${Object.keys(extra || {}).length ? `\nevent=${JSON.stringify(extra)}` : ''}`;
  console.error(`[${context}]`, error, extra, detail);
  addErrorNotice(`錯誤內容：\n${detail}`);
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
    return `${formContext.schema.instructions}

送表單前的強制規則：
- 只能填入使用者已明確提供的資料；不可自行編造姓名、原因、日期、地點、費用、時間或作業人員。
- 使用者資訊不足時一定要先追問，不可以呼叫 fill_form。
- 只有計算型欄位可以由已知資料推導，例如車資合計可以由每趟費用加總。`;
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
- 只能填入使用者已明確提供的資料，不可自行編造任何欄位值
- 資訊不足時一定要先追問，不可以呼叫 fill_form
- 確認所有必填欄位都有明確值後才呼叫 fill_form`;

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

function getToolParameters(formContext) {
  if (!formContext) return null;
  const tool = getToolSchema(formContext);
  return tool?.function?.parameters || null;
}

function isBlankValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function isVagueValue(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return [
    '未提供', '待補', '不知道', '不清楚', '不確定', '沒有提供',
    'n/a', 'na', 'none', 'unknown', 'tbd',
    '隨便', '任意', '都可以', '你決定', '自動產生', '自行判斷'
  ].some((term) => normalized.includes(term));
}

function validateValueAgainstSchema(value, schema, label, issues) {
  if (!schema) return;
  if (isBlankValue(value)) {
    issues.push(`${label} 缺少內容`);
    return;
  }
  if (isVagueValue(value)) {
    issues.push(`${label} 內容不夠明確`);
    return;
  }
  if (schema.enum && typeof value === 'string' && !schema.enum.includes(value)) {
    issues.push(`${label} 必須是有效選項`);
  }
  if (schema.pattern && typeof value === 'string' && !(new RegExp(schema.pattern).test(value))) {
    issues.push(`${label} 格式不正確`);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push(`${label} 必須是清單`);
      return;
    }
    if (schema.minItems && value.length < schema.minItems) {
      issues.push(`${label} 至少需要 ${schema.minItems} 筆`);
    }
    value.forEach((item, idx) => validateValueAgainstSchema(item, schema.items, `${label} 第 ${idx + 1} 筆`, issues));
  }
  if (schema.type === 'object' && schema.properties && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      validateValueAgainstSchema(value[key], schema.properties[key], `${label}.${key}`, issues);
    }
  }
}

function validateFillPayload(payload, formContext) {
  const params = getToolParameters(formContext);
  const issues = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, issues: ['填表資料格式不正確'] };
  }
  if (!params?.properties) {
    return { ok: false, issues: ['無法確認目前表單欄位'] };
  }
  for (const key of params.required || []) {
    validateValueAgainstSchema(payload[key], params.properties[key], key, issues);
  }
  return { ok: issues.length === 0, issues };
}

function buildMissingInfoMessage(issues) {
  const list = issues.slice(0, 5).map((item) => `- ${item}`).join('\n');
  const suffix = issues.length > 5 ? `\n- 另外還有 ${issues.length - 5} 項需要補齊` : '';
  return `目前資訊還不夠，先不填表。請補充：\n${list}${suffix}`;
}

settingsBtn.addEventListener('click', () => {
  const isHidden = settingsDrawer.hasAttribute('hidden');
  if (isHidden) {
    apiKeyInput.value = config.apiKey || '';
    guardrailEnabled.checked = config.guardrailEnabled;
    guardrailToggleRow.style.display = 'flex';
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

  config.apiKey = newKey;
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

clearCostHistoryBtn?.addEventListener('click', async () => {
  costHistory = [];
  await chrome.storage.local.set({ cost_history: [] });
  renderCostHistory();
});

// ══════════════════════════════════════════════════════════════
// ── WHISPER MODE: Record → Transcribe → Function Call → Fill ──
// ══════════════════════════════════════════════════════════════

let micPermissionGranted = false;

async function startWhisperRecording() {
  try {
    resetCostPanel('錄音轉譯準備中', 'whisper', STRUCTURING_MODEL);
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
    setVoiceControls('record');
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
      addSystemNotice('🎤 錄音時間太短（至少0.5秒），請重試');
      try {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'stop_recording'
        });
      } catch (cleanupError) {
        console.warn('Failed to cleanup short recording:', cleanupError);
      }
      updateStatusBasedOnConfig();
      isRecording = false;
      setVoiceControls(null);
      return;
    }

    isRecording = false;
    setVoiceControls(null);

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop_recording'
    });

    if (!response || !response.success) {
      const err = new Error(response?.error || 'Failed to stop recording');
      if (response?.errorName) err.name = response.errorName;
      if (response?.stack) err.stack = response.stack;
      throw err;
    }

    const audioBlob = base64ToBlob(response.audioData, 'audio/webm;codecs=opus');

    updateStatus('active', 'Transcribing...');
    const transcript = await transcribeAudio(audioBlob);

    if (!transcript) {
      addSystemNotice('🎤 沒有辨識到語音，請重試');
      updateStatusBasedOnConfig();
      return;
    }

    addMessage('user', `${transcript}`);
    await handleUserMessage(transcript);
  } catch (error) {
    console.error('Stop recording error:', error);
    if (error.message && error.message.includes('guardrail')) {
      const reasonMatch = error.message.match(/guardrail:\s*(.+)$/i);
      const reason = reasonMatch ? reasonMatch[1] : '內容不安全';
      addGuardrailChip('input', false, reason);
    } else {
      reportError('錄音處理失敗', error);
    }
    updateStatus('error', 'Error');
    isRecording = false;
    setVoiceControls(null);
  }
}

// ── Transcription ──
async function transcribeAudio(audioBlob) {
  if (!config.apiKey) throw new Error('請先在設定中填入 OpenAI API Key');

  const formData = new FormData();
  formData.append('model', TRANSCRIBE_MODEL);
  const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
  formData.append('file', audioFile);
  formData.append('response_format', 'json');
  formData.append('language', 'zh-TW');
  formData.append('prompt', '以下是臺灣繁體中文語音輸入，請使用繁體中文輸出。');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
    body: formData
  });

  if (!response.ok) throw new Error(`Whisper failed: ${await response.text()}`);
  return (await response.json()).text.trim();
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
    addErrorNotice('請先在設定中填入 OpenAI API Key');
    return;
  }

  // ── Input Guardrail (local browser check) ──
  if (config.guardrailEnabled) {
    const inputCheck = checkGuardrail(text);
    addGuardrailChip('input', inputCheck.passed, inputCheck.reason);

    if (!inputCheck.passed) {
      updateStatusBasedOnConfig();
      return;
    }
  }

  updateStatus('active', 'Thinking...');

  // Detect form context (predefined schema or generic fields)
  const formContext = await detectFormContext();
  if (!formContext) {
    addSystemNotice('⚠️ 目前頁面沒有偵測到表單欄位。請切換到有表單的頁面再試。');
    updateStatusBasedOnConfig();
    return;
  }

  if (formContext.type === 'predefined' && conversationHistory.length === 0) {
    addSystemNotice(`📋 偵測到：**${formContext.schema.label}**`);
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
    accumulateChatUsage(data.usage, STRUCTURING_MODEL);
    const choice = data.choices[0];
    const msg = choice.message;

    // ── Output Guardrail (local browser check) ──
    if (config.guardrailEnabled && msg.content) {
      const outputCheck = checkGuardrail(msg.content);
      addGuardrailChip('output', outputCheck.passed, outputCheck.reason);

      if (!outputCheck.passed) {
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
        const readiness = validateFillPayload(payload, formContext);
        if (!readiness.ok) {
          const prompt = buildMissingInfoMessage(readiness.issues);
          addMessage('assistant', prompt);
          conversationHistory.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ status: 'blocked_insufficient_info', issues: readiness.issues })
          });
          conversationHistory.push({ role: 'assistant', content: prompt });
          updateStatusBasedOnConfig();
          return;
        }
        addMessage('assistant', '✅ 正在填入表單...');
        updateStatus('active', 'Filling form...');

        let result;
        try {
          result = await fillFormOnPage(payload);
        } catch (fillError) {
          // Fill failed - still need to record tool response for conversation continuity
          result = { filled: [], failed: [{ key: '_all', reason: fillError.message }] };
          addErrorNotice(`填表失敗: ${fillError.message}`);
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
      addSystemNotice('⚠️ 對話記錄已重置，請重新描述。');
    } else {
      reportError('對話處理失敗', error);
    }
    updateStatus('error', 'Error');
  }
}

// ══════════════════════════════════════════════════════════════
// ── REALTIME MODE: WebSocket streaming with function calling ──
// ══════════════════════════════════════════════════════════════

let realtimeAudioContext = null;
let realtimeAgentBubble = null;
let realtimeOutputBuffer = '';
let realtimeOutputBlocked = false;
let realtimeFormContext = null;
let realtimeResponseActive = false;
let realtimeResponsePending = false;

async function startRealtimeSession() {
  if (!config.apiKey) {
    addErrorNotice('請先在設定中填入 OpenAI API Key');
    return;
  }

  if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
    addSystemNotice('⚠️ 即時連線已在進行中');
    return;
  }

  resetCostPanel('Realtime 連線中', 'realtime', REALTIME_MODEL);

  // Ensure mic permission
  if (!micPermissionGranted) {
    const permResponse = await chrome.runtime.sendMessage({
      target: 'background',
      action: 'request_mic_permission'
    });
    if (!permResponse || !permResponse.success) {
      addErrorNotice('麥克風權限被拒絕');
      return;
    }
    micPermissionGranted = true;
  }

  // Detect form context
  const formContext = await detectFormContext();
  if (!formContext) {
    addSystemNotice('⚠️ 目前頁面沒有偵測到表單欄位。請切換到有表單的頁面再試。');
    return;
  }

  if (formContext.type === 'predefined') {
    addSystemNotice(`📋 偵測到：**${formContext.schema.label}**`);
  }
  realtimeFormContext = formContext;

  updateStatus('active', 'Connecting to Realtime API...');
  addSystemNotice('🔄 連接即時語音...');

  try {
    await startRealtimePersonal(formContext);
  } catch (error) {
    reportError('即時連線失敗', error);
    updateStatus('error', 'Connection failed');
  }
}

function isGAModel(model) {
  return model.startsWith('gpt-realtime');
}

function buildSessionUpdate(formContext) {
  const systemPrompt = getSystemPrompt(formContext);
  const tool = getToolSchema(formContext);

  const realtimeTool = {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  };

  if (isGAModel(REALTIME_MODEL)) {
    // GA API format (gpt-realtime-2)
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        output_modalities: ['text'],
        instructions: systemPrompt,
        audio: {
          input: {
            format: {
              type: 'audio/pcm',
              rate: 24000
            },
            transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              create_response: !config.guardrailEnabled,
              threshold: 0.85,
              silence_duration_ms: 1000
            }
          }
        },
        tools: [realtimeTool],
        tool_choice: 'auto'
      }
    };
  } else {
    // Beta API format (gpt-4o-realtime-preview)
    return {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemPrompt,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          create_response: !config.guardrailEnabled,
          threshold: 0.85,
          silence_duration_ms: 1000
        },
        tools: [realtimeTool],
        tool_choice: 'auto'
      }
    };
  }
}

async function startRealtimePersonal(formContext) {
  const url = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

  const protocols = [
    'realtime',
    `openai-insecure-api-key.${config.apiKey}`
  ];
  if (!isGAModel(REALTIME_MODEL)) {
    protocols.push('openai-beta.realtime-v1');
  }

  realtimeWs = new WebSocket(url, protocols);

  realtimeWs.onopen = () => {
    realtimeConnected = true;
    realtimeResponseActive = false;
    realtimeResponsePending = false;
    updateStatus('ready', 'Realtime Connected');

    realtimeWs.send(JSON.stringify(buildSessionUpdate(formContext)));

    addSystemNotice('🎙️ 即時語音已連接！開始說話即可。');
    startRealtimeAudioCapture();
  };

  realtimeWs.onmessage = (event) => {
    handleRealtimeEvent(JSON.parse(event.data));
  };

  realtimeWs.onerror = (error) => {
    console.error('WebSocket error:', error);
    addErrorNotice('WebSocket 連線錯誤');
    disconnectRealtime();
  };

  realtimeWs.onclose = () => {
    disconnectRealtime();
  };
}

let realtimeToolCallBuffer = '';

function requestRealtimeResponse() {
  if (!realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) return;
  if (realtimeResponseActive) {
    realtimeResponsePending = true;
    return;
  }
  realtimeResponseActive = true;
  realtimeWs.send(JSON.stringify({ type: 'response.create' }));
}

function flushPendingRealtimeResponse() {
  if (!realtimeResponsePending) return;
  realtimeResponsePending = false;
  setTimeout(() => requestRealtimeResponse(), 0);
}

function handleRealtimeEvent(event) {
  const type = event.type;
  console.log('[Realtime event]', type, type.includes('transcription') ? event : '');

  if (type === 'session.created' || type === 'session.updated') {
    console.log('Realtime session configured');
  } else if (type === 'response.created') {
    realtimeResponseActive = true;
    realtimeOutputBuffer = '';
    realtimeOutputBlocked = false;
  } else if (type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = event.transcript || event.text || '';
    if (transcript.trim()) {
      addMessage('user', `🎤 ${transcript.trim()}`);
    }
    if (config.guardrailEnabled && transcript.trim()) {
      const inputCheck = checkGuardrail(transcript);
      addGuardrailChip('input', inputCheck.passed, inputCheck.reason);
      if (!inputCheck.passed) {
        updateStatusBasedOnConfig();
        return;
      }
      requestRealtimeResponse();
    }
  } else if (type === 'conversation.item.input_audio_transcription.failed') {
    console.warn('Transcription failed:', event.error);
    reportError('語音轉錄失敗', event.error || event);
  } else if (type === 'input_audio_buffer.speech_started') {
    updateStatus('recording', 'Speaking...');
  } else if (type === 'input_audio_buffer.speech_stopped') {
    updateStatus('active', 'Processing...');
  } else if (type === 'response.audio_transcript.delta' || type === 'response.text.delta' || type === 'response.output_text.delta') {
    const delta = event.delta || '';
    if (config.guardrailEnabled && !realtimeOutputBlocked) {
      realtimeOutputBuffer += delta;
      const outputCheck = checkGuardrail(realtimeOutputBuffer);
      if (!outputCheck.passed) {
        realtimeOutputBlocked = true;
        addGuardrailChip('output', false, outputCheck.reason);
        if (realtimeWs?.readyState === WebSocket.OPEN) {
          realtimeWs.send(JSON.stringify({ type: 'response.cancel' }));
        }
        realtimeAgentBubble = null;
        updateStatusBasedOnConfig();
        return;
      }
    }
    if (realtimeOutputBlocked) return;
    // Streaming AI response
    if (!realtimeAgentBubble) {
      realtimeAgentBubble = addMessage('assistant', '');
    }
    realtimeAgentBubble.innerHTML += renderMarkdown(delta);
    chat.scrollTop = chat.scrollHeight;
  } else if (type === 'response.done') {
    realtimeResponseActive = false;
    accumulateRealtimeUsage(event);
    if (config.guardrailEnabled && realtimeOutputBuffer.trim() && !realtimeOutputBlocked) {
      addGuardrailChip('output', true, '');
    }
    realtimeAgentBubble = null;
    flushPendingRealtimeResponse();
  } else if (type === 'response.output_text.done') {
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
    const errMsg = event.error?.message || event.message || event.error || 'Unknown error';
    if (event.error?.code === 'conversation_already_has_active_response') {
      realtimeResponseActive = true;
      realtimeResponsePending = true;
      console.warn('Realtime response already active; queued next response.create');
      return;
    }
    reportError('Realtime error', event.error || new Error(errMsg), event);
    disconnectRealtime();
  } else if (type === 'guardrail_chat') {
    addGuardrailChip(event.side || 'input', !!event.passed, event.reason || '');
    if (!event.passed && event.side === 'input') {
      updateStatusBasedOnConfig();
    }
  }
}

async function handleRealtimeToolCall(argsStr, callId) {
  try {
    const payload = JSON.parse(argsStr);
    const readiness = validateFillPayload(payload, realtimeFormContext || await detectFormContext());
    if (!readiness.ok) {
      const prompt = buildMissingInfoMessage(readiness.issues);
      addMessage('assistant', prompt);
      if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
        realtimeWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({ status: 'blocked_insufficient_info', issues: readiness.issues })
          }
        }));
        requestRealtimeResponse();
      }
      updateStatusBasedOnConfig();
      return;
    }
    addSystemNotice('✅ AI 判斷資訊完整，正在填入表單...');
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
      requestRealtimeResponse();
    }

    updateStatusBasedOnConfig();
  } catch (error) {
    reportError('填表失敗', error);
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      realtimeWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ status: 'error', message: error.message })
        }
      }));
      requestRealtimeResponse();
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
    addErrorNotice(`填表失敗: ${error.message}`);
  }
}

// ── Realtime Audio Capture (PCM16 streaming) ──

async function startRealtimeAudioCapture() {
  try {
    const startResp = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start_pcm_stream'
    });

    if (!startResp || !startResp.success) {
      const err = new Error(startResp?.error || 'Cannot start audio capture');
      if (startResp?.errorName) err.name = startResp.errorName;
      if (startResp?.stack) err.stack = startResp.stack;
      throw err;
    }

    isRecording = true;
    setVoiceControls('realtime');
    updateStatus('recording', 'Listening...');
  } catch (error) {
    console.error('Audio capture error:', error);
    reportError('音訊擷取失敗', error);
  }
}

// Listen for PCM audio data from offscreen document
chrome.runtime.onMessage.addListener((message) => {
  if (message.target === 'sidepanel' && message.action === 'pcm_audio_data') {
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      realtimeWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: message.audioData
      }));
    }
  }
});

function disconnectRealtime() {
  realtimeConnected = false;
  realtimeFormContext = null;
  realtimeResponseActive = false;
  realtimeResponsePending = false;
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop_pcm_stream' }).catch(() => {});
  if (realtimeWs) {
    if (realtimeWs.readyState === WebSocket.OPEN || realtimeWs.readyState === WebSocket.CONNECTING) {
      realtimeWs.close();
    }
    realtimeWs = null;
  }
  isRecording = false;
  setVoiceControls(null);
  updateStatusBasedOnConfig();
}

function stopRealtimeSession() {
  disconnectRealtime();
  addSystemNotice('🔌 即時語音已斷開');
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

  addErrorNotice(errorMessage);
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
btnRecord.addEventListener('click', () => {
  if (isRecording || realtimeConnected) return;
  startWhisperRecording();
});

btnRealtime.addEventListener('click', () => {
  if (realtimeConnected) {
    stopRealtimeSession();
    return;
  }
  if (isRecording) return;
  startRealtimeSession();
});

btnStop.addEventListener('click', () => {
  if (activeAudioMode === 'realtime' || realtimeConnected) {
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
  await loadCostHistory();
  renderCostPanel();

  if (!config.apiKey) {
    addMessage('assistant', '歡迎使用語音填表助理。\n\n請先點擊右上角設定按鈕，輸入 OpenAI API Key。底部麥克風是錄音轉文字，波形按鈕是即時語音對話。');
  } else {
    addMessage('assistant', '準備好了。請切換到有表單的頁面，輸入文字、按麥克風錄音，或按波形開始即時語音。');
  }
})();
