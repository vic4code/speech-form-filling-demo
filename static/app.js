const tabButtons = document.querySelectorAll(".tab-button[data-tab]");
const sttTab = document.getElementById("stt-tab");
const conversationTab = document.getElementById("conversation-tab");
const mainContainer = document.querySelector(".container.narrow");

const sttStatusDot = document.getElementById("stt-status-dot");
const sttStatusText = document.getElementById("stt-status-text");
const sttActiveField = document.getElementById("stt-active-field");
const sttStart = document.getElementById("stt-start");
const sttStop = document.getElementById("stt-stop");
const sttPrev = document.getElementById("stt-prev");
const sttNext = document.getElementById("stt-next");
const sttPrevFloating = document.getElementById("stt-prev-floating");
const sttNextFloating = document.getElementById("stt-next-floating");
const sttSubmit = document.getElementById("stt-submit");
const sttReview = document.getElementById("stt-review");
const sttSubmitStatus = document.getElementById("stt-submit-status");

const rideRowsContainer = document.getElementById("ride-rows");
const addRideButton = document.getElementById("add-ride");

const chat = document.getElementById("chat");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const structuredOutput = document.getElementById("structured-output");
const generateStructure = document.getElementById("generate-structure");
const conversationSubmit = document.getElementById("conversation-submit");
const conversationStatus = document.getElementById("conversation-status");
const conversationStatusDot = document.getElementById("conversation-status-dot");
const conversationStatusText = document.getElementById("conversation-status-text");
const conversationStart = document.getElementById("conversation-start");
const conversationStop = document.getElementById("conversation-stop");

let fieldOrder = [];

let activeFieldIndex = 0;
let recognition = null;
let listening = false;
let conversationListening = false;
let conversationMessages = [];
let conversationSocket = null;
let conversationAudioContext = null;
let conversationAudioProcessor = null;
let conversationStream = null;
let conversationCurrentAgent = null;
let conversationCurrentUser = null;
let conversationSubmittedPayload = null;
let conversationAgentBuffer = "";
let conversationUserBuffer = "";
let conversationFlushId = null;
let conversationMessageElements = [];
let conversationPendingMeta = null;
let sttFormStartAt = null;
let conversationFormStartAt = null;
let sttSocket = null;
let sttAudioContext = null;
let sttAudioProcessor = null;
let sttStream = null;
let sttAudioSamplesTotal = 0;
const AUDIO_TOKENS_PER_SECOND = 10;
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
const guardrailStatusEl = document.getElementById("guardrail-status");
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

guardrailEnabled.addEventListener("change", () => {
  guardrailStatusEl.className = "guardrail-status";
  guardrailStatusEl.textContent = "";
  updateGuardrailInfo();
});

const showGuardrailWarning = (message) => {
  // Popup banner (auto-dismiss 8s)
  guardrailWarningMsg.textContent = message;
  guardrailWarningEl.classList.remove("hidden");
  setTimeout(() => guardrailWarningEl.classList.add("hidden"), 8000);
};

const addGuardrailChatMessage = (message) => {
  // Add orange message to chat
  conversationMessages.push({ role: "guardrail", content: message });
  renderChat();
};

const showGuardrailStatus = (state, message) => {
  guardrailStatusEl.style.display = "flex";
  guardrailStatusEl.className = `guardrail-status ${state}`;
  guardrailStatusEl.textContent = message;
};

// Smart date parser for conversation form (handles various AI output formats)
const parseConvDate = (raw) => {
  if (!raw) return "";
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // Try parseDateInput (handles 年月日, slashes, etc.)
  const parsed = parseDateInput(raw);
  if (parsed) return parsed;
  // Try native Date parse as last resort
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return raw;
};

// Smart ride type matcher (fuzzy match AI output to select options)
const matchConvRideType = (raw) => {
  if (!raw) return "";
  const options = ["01_單日單趟", "02_單日來回", "03_單日多趟(請於備註說明)"];
  // Exact match
  if (options.includes(raw)) return raw;
  // Fuzzy match by keyword
  const normalized = raw.replace(/\s+/g, "");
  if (normalized.includes("來回")) return "02_單日來回";
  if (normalized.includes("多趟")) return "03_單日多趟(請於備註說明)";
  if (normalized.includes("單趟") || normalized.includes("單程")) return "01_單日單趟";
  // Match by prefix number
  if (normalized.startsWith("01") || normalized.startsWith("1")) return "01_單日單趟";
  if (normalized.startsWith("02") || normalized.startsWith("2")) return "02_單日來回";
  if (normalized.startsWith("03") || normalized.startsWith("3")) return "03_單日多趟(請於備註說明)";
  // Default: guess from ride count in payload context (handled by caller)
  return "";
};

// Conversation form population — fills the always-visible form
const populateConversationForm = (payload) => {
  if (!payload) return;

  // Date — smart parse
  const dateEl = document.getElementById("conv-field-date");
  const parsedDate = parseConvDate(payload.rideDate);
  if (parsedDate) dateEl.value = parsedDate;

  // Ride type — fuzzy match
  const typeEl = document.getElementById("conv-field-ride-type");
  let matchedType = matchConvRideType(payload.rideType);
  // Auto-detect from ride rows if no match
  if (!matchedType && payload.rideRows) {
    const count = payload.rideRows.length;
    if (count === 1) matchedType = "01_單日單趟";
    else if (count === 2) matchedType = "02_單日來回";
    else if (count > 2) matchedType = "03_單日多趟(請於備註說明)";
  }
  if (matchedType) typeEl.value = matchedType;

  // Ride rows
  const rowsContainer = document.getElementById("conv-ride-rows");
  rowsContainer.innerHTML = "";
  if (payload.rideRows && payload.rideRows.length) {
    payload.rideRows.forEach((row, idx) => addConvRideRow(row, idx));
  }

  // Total
  const totalEl = document.getElementById("conv-field-total");
  if (payload.totalFare) totalEl.value = String(payload.totalFare).replace(/[^\d.]/g, "");

  // Notes
  const notesEl = document.getElementById("conv-field-notes");
  if (payload.notes) notesEl.value = payload.notes;

  // Approval
  const approvalEl = document.getElementById("conv-approval-status");
  if (approvalEl) approvalEl.textContent = "待確認";

  // Highlight filled fields
  setTimeout(() => {
    document.querySelectorAll(".conversation-form-panel input, .conversation-form-panel select, .conversation-form-panel textarea").forEach((el) => {
      if (el.value && el.value !== "請選擇") {
        el.classList.add("field-filled");
        setTimeout(() => el.classList.remove("field-filled"), 1500);
      }
    });
  }, 50);
};

const rebuildFieldOrder = () => {
  const rideFields = Array.from(rideRowsContainer.querySelectorAll("input")).map((input) => input.id);
  fieldOrder = ["field-date", "field-ride-type", ...rideFields, "field-total", "field-notes"];
  if (activeFieldIndex >= fieldOrder.length) {
    activeFieldIndex = 0;
  }
};

const updateActiveField = (shouldFocus = true) => {
  if (!fieldOrder.length) {
    rebuildFieldOrder();
  }
  const fieldId = fieldOrder[activeFieldIndex] || fieldOrder[0];
  const field = document.getElementById(fieldId);
  if (field) {
    if (shouldFocus) {
      field.focus();
    }
    const label = field.closest(".field")?.querySelector("label")?.textContent;
    sttActiveField.textContent = `欄位：${label || ""}`;
  }
};

const setListeningState = (isListening, message) => {
  listening = isListening;
  sttStatusDot.classList.toggle("active", isListening);
  sttStatusText.textContent = message;
};

const setConversationListeningState = (isListening, message) => {
  conversationListening = isListening;
  conversationStatusDot.classList.toggle("active", isListening);
  conversationStatusText.textContent = message;
};

const markSttFormStart = () => {
  if (!sttFormStartAt) {
    sttFormStartAt = new Date();
  }
};

const markConversationFormStart = () => {
  if (!conversationFormStartAt) {
    conversationFormStartAt = new Date();
  }
};

const addRideRow = (data = {}, index = null) => {
  const row = document.createElement("div");
  row.className = "ride-row";
  const rowIndex = index ?? rideRowsContainer.children.length;
  row.innerHTML = `
    <div class="field">
      <label>乘坐起點</label>
      <input id="ride-from-${rowIndex}" placeholder="請輸入" value="${data.from || ""}" />
    </div>
    <div class="field">
      <label>乘坐迄點</label>
      <input id="ride-to-${rowIndex}" placeholder="請輸入" value="${data.to || ""}" />
    </div>
    <div class="field">
      <label>費用</label>
      <input id="ride-fee-${rowIndex}" type="number" placeholder="請輸入" value="${data.fee || ""}" />
    </div>
    <div class="field">
      <label>乘坐事由</label>
      <input id="ride-reason-${rowIndex}" placeholder="請輸入" value="${data.reason || ""}" />
    </div>
    <button type="button" class="icon-button danger" aria-label="移除">🗑</button>
  `;
  row.querySelector("button").addEventListener("click", () => {
    row.remove();
    rebuildFieldOrder();
  });
  rideRowsContainer.appendChild(row);
  rebuildFieldOrder();
};

addRideRow();

addRideButton.addEventListener("click", () => addRideRow());

document.querySelectorAll("#stt-tab input, #stt-tab select, #stt-tab textarea").forEach((el) => {
  el.addEventListener("focus", () => {
    markSttFormStart();
    const index = fieldOrder.indexOf(el.id);
    if (index >= 0) {
      activeFieldIndex = index;
      updateActiveField(false);
    }
  });
  el.addEventListener("input", markSttFormStart);
  el.addEventListener("change", markSttFormStart);
});

const goNextField = () => {
  if (!fieldOrder.length) {
    return;
  }
  activeFieldIndex = (activeFieldIndex + 1) % fieldOrder.length;
  updateActiveField();
};

const goPrevField = () => {
  if (!fieldOrder.length) {
    return;
  }
  activeFieldIndex = (activeFieldIndex - 1 + fieldOrder.length) % fieldOrder.length;
  updateActiveField();
};

sttPrev.addEventListener("click", goPrevField);
sttNext.addEventListener("click", goNextField);
sttPrevFloating.addEventListener("click", goPrevField);
sttNextFloating.addEventListener("click", goNextField);

sttReview.addEventListener("click", () => {
  setListeningState(false, "已暫存表單內容");
});

const startSttAudio = async () => {
  sttStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 24000,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  sttAudioContext = new AudioContext({ sampleRate: 24000 });
  await sttAudioContext.audioWorklet.addModule("/static/audio-processor.js");
  const source = sttAudioContext.createMediaStreamSource(sttStream);
  sttAudioProcessor = new AudioWorkletNode(sttAudioContext, "pcm-processor");
  sttAudioProcessor.port.onmessage = (event) => {
    if (!sttSocket || sttSocket.readyState !== WebSocket.OPEN) return;
    const pcmBuffer = event.data;
    sttAudioSamplesTotal += pcmBuffer.byteLength / 2;
    const base64Audio = arrayBufferToBase64(pcmBuffer);
    sttSocket.send(JSON.stringify({ audio: base64Audio }));
  };
  source.connect(sttAudioProcessor);
  sttAudioProcessor.connect(sttAudioContext.destination);
};

const stopSttAudio = () => {
  if (sttAudioProcessor) {
    sttAudioProcessor.disconnect();
    sttAudioProcessor = null;
  }
  if (sttAudioContext) {
    sttAudioContext.close();
    sttAudioContext = null;
  }
  if (sttStream) {
    sttStream.getTracks().forEach((track) => track.stop());
    sttStream = null;
  }
};

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
    `id: ${s.id || "—"} | model: ${s.model || "—"} | modalities: ${(s.modalities || []).join(",")} | tools: ${s.tools_count ?? 0}`
  );
};

const appendDebugEvent = (data) => {
  const label = _DEBUG_LABELS[data.event_type] || data.event_type;
  const d = data.data || {};
  const detail = Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(" | ");
  _appendDebugRow("debug-badge-runtime", label, detail);
};

const startSttRealtime = async () => {
  if (sttSocket && sttSocket.readyState === WebSocket.OPEN) {
    return;
  }
  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  sttSocket = new WebSocket(`${wsProtocol}://${window.location.host}/ws/realtime-stt`);
  sttSocket.onopen = async () => {
    setListeningState(true, "語音辨識進行中");
    sttAudioSamplesTotal = 0;
    await startSttAudio();
  };
  sttSocket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "stt_delta") {
      sttStatusText.textContent = `辨識中：${data.content}`;
    } else if (data.type === "stt_done") {
      handleTranscript(data.content || "");
      sttStatusText.textContent = "語音辨識進行中";
    } else if (data.type === "session_event") {
      appendSessionEvent(data);
    } else if (data.type === "debug_event") {
      appendDebugEvent(data);
    } else if (data.type === "error") {
      setListeningState(false, data.message || "語音辨識發生錯誤，請稍後重試。");
      fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "stt-realtime",
          message: "Realtime STT error",
          detail: data,
        }),
      }).catch(() => {});
    }
  };
  sttSocket.onerror = () => {
    setListeningState(false, "Realtime STT 連線失敗，請稍後重試。");
  };
  sttSocket.onclose = () => {
    stopSttAudio();
    setListeningState(false, "已停止語音");
  };
};

const stopSttRealtime = () => {
  stopSttAudio();
  if (sttSocket) {
    sttSocket.close();
    sttSocket = null;
  }
  setListeningState(false, "已停止語音");
};

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
  if (!conversationSocket || conversationSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  conversationSocket.send(JSON.stringify({ text }));
};

const startConversationRealtime = async () => {
  if (conversationSocket && conversationSocket.readyState === WebSocket.OPEN) {
    return;
  }
  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams();
  params.set("model", modelSelect.value);
  if (guardrailEnabled.checked) {
    params.set("guardrail", "keyword");
  }
  let wsUrl = `${wsProtocol}://${window.location.host}/ws/realtime?${params.toString()}`;
  conversationSocket = new WebSocket(wsUrl);
  conversationSocket.onopen = async () => {
    setConversationListeningState(true, "已連線，語音辨識進行中");
    markConversationFormStart();
    conversationMessages = [];
    conversationCurrentAgent = null;
    conversationCurrentUser = null;
    conversationSubmittedPayload = null;
    conversationPendingMeta = null;
    conversationMessageElements = [];
    chat.innerHTML = "";
    structuredOutput.value = "";
    conversationStatus.textContent = "";
    renderChat();
    conversationSocket.send(
      JSON.stringify({
        meta: {
          startedAt: conversationFormStartAt.toISOString(),
        },
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
      conversationSubmittedPayload = data.payload || null;
      conversationPendingMeta = data.meta || null;
      structuredOutput.value = JSON.stringify(conversationSubmittedPayload || {}, null, 2);
      // structuredOutput is always visible now
      conversationStatus.textContent = "表單已完成，請確認後送出。";
      populateConversationForm(conversationSubmittedPayload);
      stopConversationRealtime();
    } else if (data.type === "playback_stop") {
      // Server says user interrupted — stop audio immediately
      stopPlayback();
    } else if (data.type === "audio_delta") {
      console.log("[audio] ← audio_delta received, base64 length:", data.delta?.length, "ctx state:", conversationAudioPlayCtx?.state);
      playAudioDelta(data.delta);
    } else if (data.type === "guardrail_chat") {
      // Show guardrail result directly in the conversation area
      const cssRole = data.passed ? "guardrail-pass" : "guardrail";
      conversationMessages.push({ role: cssRole, content: data.message });
      renderChat();
    } else if (data.type === "guardrail_result") {
      // Only handle blocked results (passed results are shown via guardrail_chat)
      if (!data.passed) {
        const dirLabel = data.direction === "output" ? "輸出" : "輸入";
        const blockMsg = data.message || "此內容違反安全規範";
        showGuardrailWarning(`${dirLabel}安全防護：${blockMsg}`);
      }
    } else if (data.type === "guardrail_checking") {
      // No top-bar display; checking status is shown in chat via guardrail_chat
    } else if (data.type === "session_event") {
      appendSessionEvent(data);
    } else if (data.type === "debug_event") {
      appendDebugEvent(data);
    } else if (data.type === "error") {
      setConversationListeningState(false, data.message || "語音辨識發生錯誤，請稍後重試。");
      fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "conversation-realtime",
          message: "Realtime error",
          detail: data,
        }),
      }).catch(() => {});
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
    setConversationListeningState(false, "Realtime 連線失敗，請稍後重試。");
  };
  conversationSocket.onclose = () => {
    setConversationListeningState(false, "已停止語音");
    stopConversationAudio();
  };
};

const playAudioDelta = async (base64) => {
  if (!conversationAudioPlayCtx) {
    console.warn("[audio] playAudioDelta: no AudioContext!");
    return;
  }
  if (conversationAudioPlayCtx.state === "suspended") {
    console.log("[audio] context suspended, resuming…");
    await conversationAudioPlayCtx.resume();
    console.log("[audio] resumed, state now:", conversationAudioPlayCtx.state);
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
  console.log(`[audio] scheduling chunk: samples=${float32.length}, dur=${buffer.duration.toFixed(3)}s, schedAt=${conversationNextPlayTime.toFixed(3)}, ctxNow=${now.toFixed(3)}`);
  source.start(conversationNextPlayTime);
  conversationNextPlayTime += buffer.duration;
};

const stopPlayback = () => {
  // Stop audio playback without closing the WebSocket connection
  if (conversationAudioPlayCtx && conversationAudioPlayCtx.state !== "closed") {
    conversationAudioPlayCtx.close();
    conversationAudioPlayCtx = new AudioContext({ sampleRate: 24000 });
    conversationNextPlayTime = conversationAudioPlayCtx.currentTime;
  }
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

const normalizeText = (text) => text.replace(/\s+/g, "").toLowerCase();

const parseRideType = (text) => {
  const normalized = normalizeText(text);
  if (normalized.includes("單日單趟") || normalized.includes("01")) {
    return "01_單日單趟";
  }
  if (normalized.includes("單日來回") || normalized.includes("02")) {
    return "02_單日來回";
  }
  if (normalized.includes("單日多趟") || normalized.includes("03")) {
    return "03_單日多趟(請於備註說明)";
  }
  return null;
};

const parseDateInput = (text) => {
  const normalized = text.replace(/年|月/g, "-").replace(/日/g, "");
  const match = normalized.match(/(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/);
  if (!match) {
    return null;
  }
  const year = match[1];
  const month = match[2].padStart(2, "0");
  const day = match[3].padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseChineseInteger = (text) => {
  if (!text) {
    return null;
  }
  const digitMap = {
    零: 0,
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const unitMap = {
    十: 10,
    百: 100,
    千: 1000,
    萬: 10000,
  };
  let total = 0;
  let section = 0;
  let number = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (digitMap[char] !== undefined) {
      number = digitMap[char];
      continue;
    }
    const unit = unitMap[char];
    if (unit) {
      if (unit === 10000) {
        section = (section + (number || 0)) * unit;
        total += section;
        section = 0;
        number = 0;
      } else {
        section += (number || 1) * unit;
        number = 0;
      }
    }
  }
  return total + section + number;
};

const parseChineseNumber = (text) => {
  const match = text.match(/[零一二三四五六七八九兩十百千萬點]+/);
  if (!match) {
    return null;
  }
  const token = match[0];
  const digitMap = {
    零: 0,
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const colloquialMatch = token.match(/^([一二兩三四五六七八九])萬([一二兩三四五六七八九])$/);
  if (colloquialMatch) {
    return digitMap[colloquialMatch[1]] * 10000 + digitMap[colloquialMatch[2]] * 1000;
  }
  const thousandMatch = token.match(/^([一二兩三四五六七八九])千([一二兩三四五六七八九])$/);
  if (thousandMatch) {
    return digitMap[thousandMatch[1]] * 1000 + digitMap[thousandMatch[2]] * 100;
  }
  const hundredMatch = token.match(/^([一二兩三四五六七八九])百([一二兩三四五六七八九])$/);
  if (hundredMatch) {
    return digitMap[hundredMatch[1]] * 100 + digitMap[hundredMatch[2]] * 10;
  }
  const [intPart, decPart] = token.split("點");
  const integerValue = parseChineseInteger(intPart) ?? 0;
  if (!decPart) {
    return integerValue;
  }
  let decimalDigits = "";
  for (let i = 0; i < decPart.length; i += 1) {
    const digit = digitMap[decPart[i]];
    if (digit === undefined) {
      continue;
    }
    decimalDigits += String(digit);
  }
  if (!decimalDigits) {
    return integerValue;
  }
  return Number(`${integerValue}.${decimalDigits}`);
};

const parseNumericInput = (text) => {
  const numeric = text.replace(/[^\d.]/g, "");
  if (numeric && /^\d+(\.\d+)?$/.test(numeric)) {
    return numeric;
  }
  const chineseParsed = parseChineseNumber(text);
  if (chineseParsed === null || Number.isNaN(chineseParsed)) {
    return "";
  }
  return String(chineseParsed);
};

const handleTranscript = (text) => {
  const normalized = text.toLowerCase();
  if (normalized.includes("下一個") || normalized.includes("next")) {
    goNextField();
    return;
  }
  if (normalized.includes("上一個") || normalized.includes("previous")) {
    goPrevField();
    return;
  }
  const fieldId = fieldOrder[activeFieldIndex];
  const field = document.getElementById(fieldId);
  if (field) {
    if (field.tagName === "SELECT") {
      const parsed = parseRideType(text);
      if (parsed) {
        field.value = parsed;
        return;
      }
    }
    if (field.type === "date") {
      const parsedDate = parseDateInput(text);
      if (parsedDate) {
        field.value = parsedDate;
        return;
      }
    }
    if (field.type === "number") {
      const numeric = parseNumericInput(text);
      if (numeric) {
        field.value = numeric;
      }
      return;
    }
    if (field.tagName === "TEXTAREA") {
      const separator = field.value ? " " : "";
      field.value = `${field.value}${separator}${text}`;
      return;
    }
    if (field.type === "text" || field.tagName === "INPUT") {
      const separator = field.value ? " " : "";
      field.value = `${field.value}${separator}${text}`;
      return;
    }
    field.value = text;
  }
};

sttStart.addEventListener("click", () => {
  if (listening) {
    return;
  }
  markSttFormStart();
  startSttRealtime();
  updateActiveField();
});

sttStop.addEventListener("click", () => {
  stopSttRealtime();
});

conversationStart.addEventListener("click", () => {
  if (conversationListening) return;
  // Create playback AudioContext synchronously inside user gesture to satisfy autoplay policy
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

const collectRideRows = () =>
  Array.from(rideRowsContainer.querySelectorAll(".ride-row")).map((row) => {
    const inputs = row.querySelectorAll("input");
    return {
      from: inputs[0].value,
      to: inputs[1].value,
      fee: inputs[2].value,
      reason: inputs[3].value,
    };
  });

const buildSttPayload = () => ({
  rideDate: document.getElementById("field-date").value,
  rideType: document.getElementById("field-ride-type").value,
  rideRows: collectRideRows(),
  totalFare: document.getElementById("field-total").value,
  notes: document.getElementById("field-notes").value,
});

const buildConversationPayload = () => {
  if (conversationSubmittedPayload) {
    return conversationSubmittedPayload;
  }
  const transcript = conversationMessages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  return {
    rideDate: "",
    rideType: "",
    rideRows: [],
    totalFare: "",
    notes: transcript,
  };
};

const parseStructuredOutput = () => {
  try {
    return JSON.parse(structuredOutput.value);
  } catch (error) {
    return null;
  }
};

const buildMeta = (mode) => {
  if (mode === "conversation" && conversationPendingMeta) {
    const startedAtIso = conversationPendingMeta.timestamps?.startedAt;
    const startedAt = startedAtIso ? new Date(startedAtIso) : conversationFormStartAt;
    if (!startedAt) {
      return conversationPendingMeta;
    }
    const submittedAt = new Date();
    return {
      ...conversationPendingMeta,
      timestamps: {
        startedAt: startedAt.toISOString(),
        submittedAt: submittedAt.toISOString(),
        durationMs: submittedAt.getTime() - startedAt.getTime(),
      },
    };
  }
  const startedAt = mode === "stt" ? sttFormStartAt : conversationFormStartAt;
  if (!startedAt) {
    return null;
  }
  const submittedAt = new Date();
  const meta = {
    timestamps: {
      startedAt: startedAt.toISOString(),
      submittedAt: submittedAt.toISOString(),
      durationMs: submittedAt.getTime() - startedAt.getTime(),
    },
  };
  if (mode === "stt" && sttAudioSamplesTotal) {
    const audioSeconds = sttAudioSamplesTotal / 24000;
    meta.audioInputTokens = Math.ceil(audioSeconds * AUDIO_TOKENS_PER_SECOND);
  }
  return meta;
};

const submitRequest = async (mode, payload, statusEl) => {
  statusEl.textContent = "送出中...";
  try {
    const meta = buildMeta(mode);
    const response = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        payload,
        meta,
        connId: _wsConnId,
        guardrailMode: guardrailEnabled.checked ? "keyword" : null,
      }),
    });
    if (!response.ok) {
      throw new Error("提交失敗");
    }
    const data = await response.json();
    statusEl.textContent = `已送出，Request ID: ${data.id}`;
    setTimeout(() => {
      window.location.href = "/logs.html";
    }, 500);
  } catch (error) {
    statusEl.textContent = "送出失敗，請稍後再試。";
  }
};

sttSubmit.addEventListener("click", async () => {
  const payload = buildSttPayload();
  await submitRequest("stt", payload, sttSubmitStatus);
});

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
    if (bubble.className !== desiredClass) {
      bubble.className = desiredClass;
    }
    if (bubble.textContent !== message.content) {
      bubble.textContent = message.content;
    }
  }
  if (conversationMessageElements.length > conversationMessages.length) {
    for (let i = conversationMessages.length; i < conversationMessageElements.length; i += 1) {
      const bubble = conversationMessageElements[i];
      if (bubble && bubble.parentNode) {
        bubble.parentNode.removeChild(bubble);
      }
    }
    conversationMessageElements = conversationMessageElements.slice(0, conversationMessages.length);
  }
  chat.scrollTop = chat.scrollHeight;
};

const generateStructuredOutput = () => {
  const payload = buildConversationPayload();
  structuredOutput.value = JSON.stringify(payload, null, 2);
  return payload;
};

const handleUserMessage = (text) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  markConversationFormStart();
  conversationMessages.push({ role: "user", content: trimmed });
  chatInput.value = "";
  renderChat();
  sendConversationText(trimmed);
};

chatSend.addEventListener("click", () => {
  handleUserMessage(chatInput.value);
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    chatSend.click();
  }
});

generateStructure.addEventListener("click", () => {
  const payload = generateStructuredOutput();
  populateConversationForm(payload);
});

conversationSubmit.addEventListener("click", async () => {
  const payload = parseStructuredOutput();
  if (!payload) {
    conversationStatus.textContent = "JSON 格式不正確，請確認後再送出。";
    return;
  }
  await submitRequest("conversation", payload, conversationStatus);
});

const switchTab = (target) => {
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === target);
  });
  sttTab.style.display = target === "stt" ? "block" : "none";
  conversationTab.style.display = target === "conversation" ? "block" : "none";
  sttPrevFloating.style.display = target === "stt" ? "inline-flex" : "none";
  sttNextFloating.style.display = target === "stt" ? "inline-flex" : "none";
  if (target !== "stt" && listening) {
    stopSttRealtime();
  }
  if (target !== "conversation" && conversationListening) {
    stopConversationRealtime();
  }
};

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

const initialTab = document.querySelector(".tab-button.active")?.dataset.tab || "conversation";
switchTab(initialTab);

renderChat();
rebuildFieldOrder();
updateActiveField();

// Initialize default empty ride row in conversation form
const addConvRideRow = (data = {}, idx = 0) => {
  const convRows = document.getElementById("conv-ride-rows");
  const row = document.createElement("div");
  row.className = "conv-ride-row";
  row.innerHTML = `
    <div class="field"><label class="mobile-only">起點</label><input placeholder="請輸入" value="${data.from || ""}" /></div>
    <div class="field"><label class="mobile-only">迄點</label><input placeholder="請輸入" value="${data.to || ""}" /></div>
    <div class="field"><label class="mobile-only">費用</label><input type="number" placeholder="請輸入" value="${data.fee || ""}" /></div>
    <div class="field"><label class="mobile-only">事由</label><input placeholder="請輸入" value="${data.reason || ""}" /></div>
  `;
  convRows.appendChild(row);
};
addConvRideRow();
