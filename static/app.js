const tabButtons = document.querySelectorAll(".tab-button[data-tab]");
const sttTab = document.getElementById("stt-tab");
const conversationTab = document.getElementById("conversation-tab");

const sttStatusDot = document.getElementById("stt-status-dot");
const sttStatusText = document.getElementById("stt-status-text");
const sttActiveField = document.getElementById("stt-active-field");
const sttStart = document.getElementById("stt-start");
const sttStop = document.getElementById("stt-stop");
const sttNext = document.getElementById("stt-next");
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

const rebuildFieldOrder = () => {
  const rideFields = Array.from(rideRowsContainer.querySelectorAll("input")).map((input) => input.id);
  fieldOrder = ["field-date", "field-ride-type", ...rideFields, "field-total", "field-notes"];
  if (activeFieldIndex >= fieldOrder.length) {
    activeFieldIndex = 0;
  }
};

const updateActiveField = () => {
  if (!fieldOrder.length) {
    rebuildFieldOrder();
  }
  const fieldId = fieldOrder[activeFieldIndex] || fieldOrder[0];
  const field = document.getElementById(fieldId);
  if (field) {
    field.focus();
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
  el.addEventListener("focus", markSttFormStart);
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

sttNext.addEventListener("click", goNextField);
sttNextFloating.addEventListener("click", goNextField);

sttReview.addEventListener("click", () => {
  setListeningState(false, "已暫存表單內容");
});

const startSttAudio = async () => {
  sttStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  sttAudioContext = new AudioContext({ sampleRate: 24000 });
  const source = sttAudioContext.createMediaStreamSource(sttStream);
  sttAudioProcessor = sttAudioContext.createScriptProcessor(4096, 1, 1);
  sttAudioProcessor.onaudioprocess = (event) => {
    if (!sttSocket || sttSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    const inputData = event.inputBuffer.getChannelData(0);
    const pcmData = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, inputData[i]));
      pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    sttAudioSamplesTotal += pcmData.length;
    const base64Audio = arrayBufferToBase64(pcmData.buffer);
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
  conversationStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  conversationAudioContext = new AudioContext({ sampleRate: 24000 });
  const source = conversationAudioContext.createMediaStreamSource(conversationStream);
  conversationAudioProcessor = conversationAudioContext.createScriptProcessor(4096, 1, 1);
  conversationAudioProcessor.onaudioprocess = (event) => {
    if (!conversationSocket || conversationSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    const inputData = event.inputBuffer.getChannelData(0);
    const pcmData = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, inputData[i]));
      pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    const base64Audio = arrayBufferToBase64(pcmData.buffer);
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
  conversationSocket = new WebSocket(`${wsProtocol}://${window.location.host}/ws/realtime`);
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
    } else if (data.type === "form_ready") {
      conversationSubmittedPayload = data.payload || null;
      conversationPendingMeta = data.meta || null;
      structuredOutput.value = JSON.stringify(conversationSubmittedPayload || {}, null, 2);
      conversationStatus.textContent = "表單已完成，請確認後送出。";
      stopConversationRealtime();
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

const stopConversationRealtime = () => {
  stopConversationAudio();
  if (conversationSocket) {
    conversationSocket.close();
    conversationSocket = null;
  }
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

const handleTranscript = (text) => {
  const normalized = text.toLowerCase();
  if (normalized.includes("下一個") || normalized.includes("next")) {
    goNextField();
    return;
  }
  if (normalized.includes("上一個") || normalized.includes("previous")) {
    activeFieldIndex = (activeFieldIndex - 1 + fieldOrder.length) % fieldOrder.length;
    updateActiveField();
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
      const numeric = text.replace(/[^\d.]/g, "");
      field.value = numeric || text;
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
  if (conversationListening) {
    return;
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
      body: JSON.stringify({ mode, payload, meta }),
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
  generateStructuredOutput();
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

const initialTab = document.querySelector(".tab-button.active")?.dataset.tab || "stt";
switchTab(initialTab);

renderChat();
rebuildFieldOrder();
updateActiveField();
