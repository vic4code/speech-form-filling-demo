const chat = document.getElementById("chat");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const conversationStatusDot = document.getElementById("conversation-status-dot");
const conversationStatusText = document.getElementById("conversation-status-text");
const conversationStart = document.getElementById("conversation-start");
const conversationStop = document.getElementById("conversation-stop");
const browserStatusEl = document.getElementById("browser-status");
const browserStatusText = document.getElementById("browser-status-text");

let conversationListening = false;
let conversationMessages = [];
let conversationSocket = null;
let conversationAudioContext = null;
let conversationAudioProcessor = null;
let conversationStream = null;
let conversationCurrentAgent = null;
let conversationCurrentUser = null;
let conversationAgentBuffer = "";
let conversationUserBuffer = "";
let conversationFlushId = null;
let conversationMessageElements = [];
let conversationFormStartAt = null;
let conversationPendingMeta = null;
let sessionDebugLog = [];
let _wsConnId = null;
let conversationAudioPlayCtx = null;
let conversationNextPlayTime = 0;

// Model selector
const modelSelect = document.getElementById("model-select");
(async () => {
  try {
    const resp = await fetch("/api/models");
    const data = await resp.json();
    data.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === data.default) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  } catch (e) {
    const opt = document.createElement("option");
    opt.value = "gpt-4o-realtime-preview-2024-12-17";
    opt.textContent = "GPT-4o Realtime (default)";
    modelSelect.appendChild(opt);
  }
})();

// Guardrail state
const guardrailEnabled = document.getElementById("guardrail-enabled");
const guardrailWarningEl = document.getElementById("guardrail-warning");
const guardrailWarningMsg = document.getElementById("guardrail-warning-msg");
const guardrailInfoEl = document.getElementById("guardrail-info");

const updateGuardrailInfo = () => {
  if (!guardrailEnabled.checked) {
    guardrailInfoEl.style.display = "none";
    return;
  }
  fetch("/api/guardrail-info").then(r => r.json()).then(info => {
    guardrailInfoEl.innerHTML = `<b>Guardrail:</b> ${info.description}`;
    guardrailInfoEl.style.display = "block";
  }).catch(() => { guardrailInfoEl.style.display = "none"; });
};

guardrailEnabled.addEventListener("change", updateGuardrailInfo);

const showGuardrailWarning = (message) => {
  guardrailWarningMsg.textContent = message;
  guardrailWarningEl.classList.remove("hidden");
  setTimeout(() => guardrailWarningEl.classList.add("hidden"), 8000);
};

const setConversationListeningState = (isListening, message) => {
  conversationListening = isListening;
  conversationStatusDot.classList.toggle("active", isListening);
  conversationStatusText.textContent = message;
};

const markConversationFormStart = () => {
  if (!conversationFormStartAt) {
    conversationFormStartAt = new Date();
  }
};

const showBrowserStatus = (text, type = "info") => {
  browserStatusEl.style.display = "flex";
  browserStatusEl.className = `browser-status ${type}`;
  browserStatusText.textContent = text;
};

// ── Audio ──

const arrayBufferToBase64 = (buffer) => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
};

const startConversationAudio = async () => {
  conversationStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 24000,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  conversationAudioContext = new AudioContext({ sampleRate: 24000 });
  await conversationAudioContext.audioWorklet.addModule("/static/audio-processor.js");
  const source = conversationAudioContext.createMediaStreamSource(conversationStream);
  conversationAudioProcessor = new AudioWorkletNode(conversationAudioContext, "pcm-processor");
  conversationAudioProcessor.port.onmessage = (event) => {
    if (!conversationSocket || conversationSocket.readyState !== WebSocket.OPEN) return;
    const pcmBuffer = event.data;
    const base64Audio = arrayBufferToBase64(pcmBuffer);
    conversationSocket.send(JSON.stringify({ audio: base64Audio }));
  };
  source.connect(conversationAudioProcessor);
  conversationAudioProcessor.connect(conversationAudioContext.destination);
};

const stopConversationAudio = () => {
  if (conversationAudioProcessor) {
    conversationAudioProcessor.disconnect();
    conversationAudioProcessor = null;
  }
  if (conversationAudioContext) {
    conversationAudioContext.close();
    conversationAudioContext = null;
  }
  if (conversationStream) {
    conversationStream.getTracks().forEach((track) => track.stop());
    conversationStream = null;
  }
};

const sendConversationText = (text) => {
  if (!conversationSocket || conversationSocket.readyState !== WebSocket.OPEN) return;
  conversationSocket.send(JSON.stringify({ text }));
};

// ── Audio playback ──

const playAudioDelta = async (base64) => {
  if (!conversationAudioPlayCtx) return;
  if (conversationAudioPlayCtx.state === "suspended") {
    await conversationAudioPlayCtx.resume();
  }
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;
  const buffer = conversationAudioPlayCtx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);
  const source = conversationAudioPlayCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(conversationAudioPlayCtx.destination);
  const now = conversationAudioPlayCtx.currentTime;
  if (conversationNextPlayTime < now) conversationNextPlayTime = now + 0.05;
  source.start(conversationNextPlayTime);
  conversationNextPlayTime += buffer.duration;
};

const stopPlayback = () => {
  if (conversationAudioPlayCtx && conversationAudioPlayCtx.state !== "closed") {
    conversationAudioPlayCtx.close();
    conversationAudioPlayCtx = new AudioContext({ sampleRate: 24000 });
    conversationNextPlayTime = conversationAudioPlayCtx.currentTime;
  }
};

// ── Session debug ──

const _DEBUG_LABELS = {
  "input_audio_buffer.speech_started": "SPEECH_START",
  "input_audio_buffer.speech_stopped": "SPEECH_STOP",
  "input_audio_buffer.committed":      "BUF_COMMIT",
  "response.created":                  "RESP_START",
  "response.done":                     "RESP_DONE",
  "conversation.item.input_audio_transcription.completed": "TRANSCRIPT",
};

const _appendDebugRow = (badgeClass, badge, detail) => {
  const panel = document.getElementById("session-debug-panel");
  const list = document.getElementById("session-debug-list");
  if (!panel || !list) return;
  const item = document.createElement("div");
  item.className = "session-debug-item";
  item.innerHTML =
    `<span class="session-debug-badge ${badgeClass}">${badge}</span>` +
    `<span class="session-debug-ts">${new Date().toLocaleTimeString()}</span>` +
    (detail ? `<code>${detail}</code>` : "");
  list.prepend(item);
  panel.removeAttribute("hidden");
};

const appendSessionEvent = (data) => {
  sessionDebugLog.push(data);
  if (data.event_type === "session.created" && data.conn_id) {
    _wsConnId = data.conn_id;
  }
  const badge = data.event_type === "session.created" ? "CREATED" : "UPDATED";
  const s = data.session || {};
  _appendDebugRow(
    "",
    badge,
    `id: ${s.id || "—"} | model: ${s.model || "—"} | modalities: ${(s.modalities || []).join(",")}`
  );
};

const appendDebugEvent = (data) => {
  const label = _DEBUG_LABELS[data.event_type] || data.event_type;
  const d = data.data || {};
  const detail = Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(" | ");
  _appendDebugRow("debug-badge-runtime", label, detail);
};

// ── WebSocket connection ──

const startConversationRealtime = async () => {
  if (conversationSocket && conversationSocket.readyState === WebSocket.OPEN) return;
  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams();
  params.set("model", modelSelect.value);
  if (guardrailEnabled.checked) {
    params.set("guardrail", "keyword");
  }
  conversationSocket = new WebSocket(`${wsProtocol}://${window.location.host}/ws/realtime?${params.toString()}`);
  conversationSocket.onopen = async () => {
    setConversationListeningState(true, "已連線，語音辨識進行中");
    markConversationFormStart();
    conversationMessages = [];
    conversationCurrentAgent = null;
    conversationCurrentUser = null;
    conversationPendingMeta = null;
    conversationMessageElements = [];
    chat.innerHTML = "";
    renderChat();
    conversationSocket.send(
      JSON.stringify({
        meta: { startedAt: conversationFormStartAt.toISOString() },
      })
    );
    await startConversationAudio();
  };
  conversationSocket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "agent_delta") {
      if (!conversationCurrentAgent) {
        conversationCurrentAgent = { role: "agent", content: "" };
        conversationMessages.push(conversationCurrentAgent);
      }
      conversationAgentBuffer += data.content;
    } else if (data.type === "agent_done") {
      if (conversationAgentBuffer && conversationCurrentAgent) {
        conversationCurrentAgent.content += conversationAgentBuffer;
        conversationAgentBuffer = "";
      }
      conversationCurrentAgent = null;
    } else if (data.type === "user_delta") {
      if (!conversationCurrentUser) {
        conversationCurrentUser = { role: "user", content: "" };
        conversationMessages.push(conversationCurrentUser);
      }
      conversationUserBuffer += data.content;
    } else if (data.type === "user_done") {
      if (conversationUserBuffer && conversationCurrentUser) {
        conversationCurrentUser.content += conversationUserBuffer;
        conversationUserBuffer = "";
      }
      conversationCurrentUser = null;
      renderChat();
    } else if (data.type === "form_ready") {
      // AI finished — backend will fill browser form via Playwright
      showBrowserStatus("表單資料已整理完成，正在自動填寫瀏覽器表單…", "info");
      conversationMessages.push({
        role: "agent",
        content: "表單資料已整理完成，正在自動填入瀏覽器…",
      });
      renderChat();
    } else if (data.type === "browser_fill_done") {
      showBrowserStatus("瀏覽器表單已自動填寫完成！", "success");
      stopConversationRealtime();
    } else if (data.type === "browser_fill_error") {
      showBrowserStatus(`填寫失敗：${data.message}`, "error");
    } else if (data.type === "playback_stop") {
      stopPlayback();
    } else if (data.type === "audio_delta") {
      playAudioDelta(data.delta);
    } else if (data.type === "guardrail_chat") {
      const cssRole = data.passed ? "guardrail-pass" : "guardrail";
      conversationMessages.push({ role: cssRole, content: data.message });
      renderChat();
    } else if (data.type === "session_event") {
      appendSessionEvent(data);
    } else if (data.type === "debug_event") {
      appendDebugEvent(data);
    } else if (data.type === "error") {
      setConversationListeningState(false, data.message || "發生錯誤");
    }
    if (!conversationFlushId) {
      conversationFlushId = window.requestAnimationFrame(() => {
        if (conversationCurrentAgent && conversationAgentBuffer) {
          conversationCurrentAgent.content += conversationAgentBuffer;
          conversationAgentBuffer = "";
        }
        if (conversationCurrentUser && conversationUserBuffer) {
          conversationCurrentUser.content += conversationUserBuffer;
          conversationUserBuffer = "";
        }
        renderChat();
        conversationFlushId = null;
      });
    }
  };
  conversationSocket.onerror = () => {
    setConversationListeningState(false, "連線失敗，請稍後重試。");
  };
  conversationSocket.onclose = () => {
    setConversationListeningState(false, "已停止語音");
    stopConversationAudio();
  };
};

const stopConversationRealtime = () => {
  stopConversationAudio();
  if (conversationSocket) {
    conversationSocket.close();
    conversationSocket = null;
  }
  conversationAudioPlayCtx?.close();
  conversationAudioPlayCtx = null;
  conversationNextPlayTime = 0;
  setConversationListeningState(false, "已停止語音");
};

// ── Render ──

const renderChat = () => {
  for (let i = 0; i < conversationMessages.length; i += 1) {
    const message = conversationMessages[i];
    let bubble = conversationMessageElements[i];
    if (!bubble) {
      bubble = document.createElement("div");
      conversationMessageElements[i] = bubble;
      chat.appendChild(bubble);
    }
    const desiredClass = `chat-message ${message.role}`;
    if (bubble.className !== desiredClass) bubble.className = desiredClass;
    if (bubble.textContent !== message.content) bubble.textContent = message.content;
  }
  if (conversationMessageElements.length > conversationMessages.length) {
    for (let i = conversationMessages.length; i < conversationMessageElements.length; i += 1) {
      const bubble = conversationMessageElements[i];
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
    }
    conversationMessageElements = conversationMessageElements.slice(0, conversationMessages.length);
  }
  chat.scrollTop = chat.scrollHeight;
};

// ── Event listeners ──

conversationStart.addEventListener("click", () => {
  if (conversationListening) return;
  if (!conversationAudioPlayCtx) {
    conversationAudioPlayCtx = new AudioContext({ sampleRate: 24000 });
    conversationNextPlayTime = conversationAudioPlayCtx.currentTime;
  } else if (conversationAudioPlayCtx.state === "suspended") {
    conversationAudioPlayCtx.resume();
  }
  startConversationRealtime();
});

conversationStop.addEventListener("click", () => {
  stopConversationRealtime();
});

const handleUserMessage = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  markConversationFormStart();
  conversationMessages.push({ role: "user", content: trimmed });
  chatInput.value = "";
  renderChat();
  sendConversationText(trimmed);
};

chatSend.addEventListener("click", () => handleUserMessage(chatInput.value));
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    chatSend.click();
  }
});

renderChat();
