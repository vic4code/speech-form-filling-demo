const chat = document.getElementById("chat");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const conversationStatusDot = document.getElementById("conversation-status-dot");
const conversationStatusText = document.getElementById("conversation-status-text");
const conversationStart = document.getElementById("conversation-start");
const conversationStop = document.getElementById("conversation-stop");
const browserStatusEl = document.getElementById("browser-status");
const browserStatusText = document.getElementById("browser-status-text");
const modeSelect = document.getElementById("mode-select");
const apiBase = window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
const wsHost = window.location.protocol === "file:" ? "127.0.0.1:8000" : window.location.host;

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
let batchRecorder = null;
let batchStream = null;
let batchChunks = [];
let batchPending = null;

// Model selectors
const modelSelect = document.getElementById("model-select");
const transcribeModelSelect = document.getElementById("transcribe-model-select");
const structureModelSelect = document.getElementById("structure-model-select");

(async () => {
  try {
    const resp = await fetch(`${apiBase}/api/models`);
    const data = await resp.json();
    data.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === data.default) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    const batchInfo = data.batch || {};
    const transcriptionModels = batchInfo.transcription || [
      { id: "whisper-1", label: "Whisper 1" },
      { id: "gpt-4o-mini-transcribe", label: "GPT-4o Mini Transcribe" },
      { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe" },
    ];
    const structuringModels = batchInfo.structuring || [
      { id: "gpt-4o-mini", label: "GPT-4o Mini" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
      { id: "gpt-4.1", label: "GPT-4.1" },
    ];
    const defaultTranscription = batchInfo.default_transcription || "gpt-4o-transcribe";
    const defaultStructuring = batchInfo.default_structuring || "gpt-4.1";
    transcriptionModels.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === defaultTranscription) opt.selected = true;
      transcribeModelSelect.appendChild(opt);
    });
    structuringModels.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === defaultStructuring) opt.selected = true;
      structureModelSelect.appendChild(opt);
    });
  } catch (e) {
    const opt = document.createElement("option");
    opt.value = "gpt-realtime-2";
    opt.textContent = "GPT Realtime 2 (default)";
    modelSelect.appendChild(opt);
  }
})();

const updateModelSelectVisibility = () => {
  const isBatch = modeSelect.value === "batch";
  modelSelect.style.display = isBatch ? "none" : "";
  transcribeModelSelect.style.display = isBatch ? "" : "none";
  structureModelSelect.style.display = isBatch ? "" : "none";
};

// Form selector
const formSelect = document.getElementById("form-select");
const formLink = document.getElementById("form-link");
const updateFormLink = () => {
  const opt = formSelect.selectedOptions[0];
  if (opt && opt.dataset.url) {
    formLink.href = opt.dataset.url;
    formLink.style.display = "";
  } else {
    formLink.style.display = "none";
  }
};
(async () => {
  try {
    const resp = await fetch(`${apiBase}/api/forms`);
    const forms = await resp.json();
    if (!Array.isArray(forms) || forms.length === 0) {
      throw new Error("no forms");
    }
    forms.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.label;
      opt.title = f.description || "";
      opt.dataset.url = f.url || "";
      formSelect.appendChild(opt);
    });
    updateFormLink();
  } catch (e) {
    const opt = document.createElement("option");
    opt.value = "taxi";
    opt.textContent = "計程車費請領單";
    formSelect.appendChild(opt);
    updateFormLink();
  }
})();
formSelect.addEventListener("change", updateFormLink);

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
  fetch(`${apiBase}/api/guardrail-info`).then(r => r.json()).then(info => {
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

// ── Batch recording ──

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("讀取錄音失敗"));
  reader.readAsDataURL(blob);
});

const parseJsonOrTextError = async (resp) => {
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await resp.json();
    return data.detail || data.message || JSON.stringify(data);
  }
  const text = await resp.text();
  return text || `HTTP ${resp.status}`;
};

const stopBatchStream = () => {
  if (batchStream) {
    batchStream.getTracks().forEach((track) => track.stop());
    batchStream = null;
  }
};

const startBatchRecording = async () => {
  if (batchRecorder && batchRecorder.state === "recording") return;
  batchChunks = [];
  batchPending = null;
  batchStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  batchRecorder = new MediaRecorder(batchStream, { mimeType });
  batchRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size) batchChunks.push(event.data);
  };
  batchRecorder.onstop = async () => {
    stopBatchStream();
    const blob = new Blob(batchChunks, { type: batchRecorder.mimeType || "audio/webm" });
    batchRecorder = null;
    if (!blob.size) {
      setConversationListeningState(false, "沒有錄到聲音");
      return;
    }
    await submitBatchRecording(blob);
  };
  conversationMessages.push({ role: "agent", content: "正在錄音，講完後按停止，我會整理成表單讓你確認。" });
  renderChat();
  batchRecorder.start();
  setConversationListeningState(true, "錄音中");
  markConversationFormStart();
};

const stopBatchRecording = () => {
  if (batchRecorder && batchRecorder.state === "recording") {
    setConversationListeningState(false, "正在整理錄音…");
    batchRecorder.stop();
  }
};

const submitBatchRecording = async (blob) => {
  try {
    setConversationListeningState(false, "正在轉譯並整理表單…");
    const audioBase64 = await blobToDataUrl(blob);
    const resp = await fetch(`${apiBase}/api/batch-form/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        form: formSelect.value,
        audioBase64,
        mimeType: blob.type || "audio/webm",
        guardrailMode: guardrailEnabled.checked ? "keyword" : null,
        transcribeModel: transcribeModelSelect.value || undefined,
        structureModel: structureModelSelect.value || undefined,
      }),
    });
    if (!resp.ok) {
      throw new Error(await parseJsonOrTextError(resp));
    }
    const data = await resp.json();
    if (data.transcript) {
      conversationMessages.push({ role: "user", content: data.transcript });
    }
    if (data.reviewText || data.payload) {
      conversationMessages.push({
        role: "batch-review",
        content: data.reviewText || JSON.stringify(data.payload, null, 2),
        payload: data.payload,
        meta: data.meta || null,
        ready: !!data.ready,
        errors: data.errors || [],
      });
    }
    if (!data.ready) {
      conversationMessages.push({
        role: "agent",
        content: `已整理成草稿，但以下資訊還不夠，請再說一遍：${(data.errors || []).join("、") || "部分必填欄位"}`,
      });
    } else {
      batchPending = data;
    }
    renderChat();
    setConversationListeningState(false, data.ready ? "請確認整理後的表單" : "需要補充資訊");
  } catch (error) {
    conversationMessages.push({ role: "agent", content: `錄音整理失敗：${error.message}` });
    renderChat();
    setConversationListeningState(false, "錄音整理失敗");
  }
};

const confirmBatchFill = async () => {
  if (!batchPending || !batchPending.payload) return;
  showBrowserStatus("已確認，正在自動填寫瀏覽器表單…", "info");
  try {
    const resp = await fetch(`${apiBase}/api/batch-form/fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        form: formSelect.value,
        payload: batchPending.payload,
        meta: batchPending.meta || null,
        guardrailMode: guardrailEnabled.checked ? "keyword" : null,
      }),
    });
    if (!resp.ok) {
      throw new Error(await parseJsonOrTextError(resp));
    }
    const data = await resp.json();
    showBrowserStatus("瀏覽器表單已自動填寫完成！", "success");
    conversationMessages.push({ role: "agent", content: "已填入瀏覽器表單，請在送出前再次確認。" });
    batchPending = null;
  } catch (error) {
    showBrowserStatus(`填寫失敗：${error.message}`, "error");
    conversationMessages.push({ role: "agent", content: `填寫失敗：${error.message}` });
  }
  renderChat();
};

const startBatchPatch = async () => {
  if (!batchPending) return;
  if (batchRecorder && batchRecorder.state === "recording") return;
  batchChunks = [];
  batchStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  batchRecorder = new MediaRecorder(batchStream, { mimeType });
  batchRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size) batchChunks.push(event.data);
  };
  batchRecorder.onstop = async () => {
    stopBatchStream();
    const blob = new Blob(batchChunks, { type: batchRecorder.mimeType || "audio/webm" });
    batchRecorder = null;
    if (!blob.size) {
      setConversationListeningState(false, "沒有錄到聲音");
      return;
    }
    await submitBatchPatch(blob, null);
  };
  batchRecorder.start();
  setConversationListeningState(true, "語音修改錄音中，講完後按停止");
};

const submitBatchPatch = async (blob, correctionText) => {
  if (!batchPending) return;
  try {
    setConversationListeningState(false, "正在修改表單…");
    const body = {
      form: formSelect.value,
      currentPayload: batchPending.payload,
      guardrailMode: guardrailEnabled.checked ? "keyword" : null,
      transcribeModel: transcribeModelSelect.value || undefined,
      structureModel: structureModelSelect.value || undefined,
      previousErrors: batchPending.errors && batchPending.errors.length ? batchPending.errors : undefined,
    };
    if (blob) {
      body.audioBase64 = await blobToDataUrl(blob);
      body.mimeType = blob.type || "audio/webm";
    }
    if (correctionText) {
      body.correctionText = correctionText;
    }
    const resp = await fetch(`${apiBase}/api/batch-form/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(await parseJsonOrTextError(resp));
    }
    const data = await resp.json();
    if (data.transcript) {
      conversationMessages.push({ role: "user", content: data.transcript });
    }
    // Replace last batch-review in place
    const reviewIdx = conversationMessages.reduce((last, m, i) => m.role === "batch-review" ? i : last, -1);
    const reviewMsg = {
      role: "batch-review",
      content: data.reviewText || JSON.stringify(data.payload, null, 2),
      payload: data.payload,
      meta: data.meta || null,
      ready: !!data.ready,
      errors: data.errors || [],
    };
    if (reviewIdx >= 0) {
      conversationMessages[reviewIdx] = reviewMsg;
      if (conversationMessageElements[reviewIdx]) {
        conversationMessageElements[reviewIdx]._lastHtml = null;
      }
    } else {
      conversationMessages.push(reviewMsg);
    }
    if (data.payload) {
      batchPending = data;
    }
    if (!data.ready && data.errors && data.errors.length) {
      conversationMessages.push({
        role: "agent",
        content: `修改後仍有缺漏，請補充：${data.errors.join("、")}`,
      });
    }
    renderChat();
    setConversationListeningState(false, data.ready ? "請確認修改後的表單" : "需要補充資訊");
  } catch (error) {
    conversationMessages.push({ role: "agent", content: `修改失敗：${error.message}` });
    renderChat();
    setConversationListeningState(false, "修改失敗");
  }
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
  if (formSelect.value) {
    params.set("form", formSelect.value);
  }
  if (guardrailEnabled.checked) {
    params.set("guardrail", "keyword");
  }
  conversationSocket = new WebSocket(`${wsProtocol}://${wsHost}/ws/realtime?${params.toString()}`);
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
      conversationMessages.push({
        role: "guardrail-chip",
        passed: !!data.passed,
        side: data.side || "input",
        snippet: data.snippet || "",
        reason: data.reason || "",
        legacy: data.message || "",
      });
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

const escapeHtml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_BLOCK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const SIDE_LABELS = { input: "使用者輸入", output: "模型輸出" };

const renderGuardrailChip = (m) => {
  const status = m.passed ? "通過" : "已攔截";
  const sideLabel = SIDE_LABELS[m.side] || m.side;
  const icon = m.passed ? ICON_CHECK : ICON_BLOCK;
  const headerHtml = `
    <div class="ck-gr-header">
      <span class="ck-gr-icon">${icon}</span>
      <span class="ck-gr-meta">Guardrail · 關鍵字</span>
      <span class="ck-gr-side">${escapeHtml(sideLabel)}</span>
      <span class="ck-gr-status">${escapeHtml(status)}</span>
    </div>`;
  let bodyHtml = "";
  if (!m.passed && (m.snippet || m.reason)) {
    bodyHtml = `
      <div class="ck-gr-body">
        ${m.snippet ? `<div class="ck-gr-snippet">「${escapeHtml(m.snippet)}」</div>` : ""}
        ${m.reason ? `<div class="ck-gr-reason">${escapeHtml(m.reason)}</div>` : ""}
      </div>`;
  }
  return headerHtml + bodyHtml;
};

const renderBatchReview = (m) => {
  const content = escapeHtml(m.content || "");
  const title = m.ready ? "模型整理後的表單" : "模型整理的表單草稿";
  const errors = Array.isArray(m.errors) && m.errors.length
    ? `<div class="ck-batch-errors">${m.errors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>`
    : "";
  const confirmBtn = m.ready
    ? '<button type="button" class="ck-batch-confirm" data-action="batch-confirm">確認填入瀏覽器表單</button>'
    : "";
  return `
    <div class="ck-batch-review-head">${title}</div>
    <pre class="ck-batch-review-body">${content}</pre>
    ${errors}
    ${confirmBtn ? `<div class="ck-batch-actions">${confirmBtn}</div>` : ""}
  `;
};

const renderChat = () => {
  for (let i = 0; i < conversationMessages.length; i += 1) {
    const message = conversationMessages[i];
    let bubble = conversationMessageElements[i];
    if (!bubble) {
      bubble = document.createElement("div");
      conversationMessageElements[i] = bubble;
      chat.appendChild(bubble);
    }
    if (message.role === "guardrail-chip") {
      const desiredClass = `ck-gr-chip ${message.passed ? "ck-gr-pass" : "ck-gr-block"}`;
      if (bubble.className !== desiredClass) bubble.className = desiredClass;
      const html = renderGuardrailChip(message);
      if (bubble._lastHtml !== html) {
        bubble.innerHTML = html;
        bubble._lastHtml = html;
      }
      continue;
    }
    if (message.role === "batch-review") {
      const desiredClass = "chat-message agent ck-batch-review";
      if (bubble.className !== desiredClass) bubble.className = desiredClass;
      const html = renderBatchReview(message);
      if (bubble._lastHtml !== html) {
        bubble.innerHTML = html;
        bubble._lastHtml = html;
      }
      continue;
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
  // ChatKit layout: the page is the scroll container, not .chat.
  // Stick to bottom only when the user is already near it, so scrolling up
  // to re-read history isn't yanked back down.
  const scroller = document.scrollingElement || document.documentElement;
  const distFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (distFromBottom < 240) {
    scroller.scrollTop = scroller.scrollHeight;
  }
};

// ── Event listeners ──

conversationStart.addEventListener("click", () => {
  if (conversationListening) return;
  if (modeSelect.value === "batch") {
    if (batchPending) {
      startBatchPatch();
    } else {
      startBatchRecording();
    }
    return;
  }
  if (!conversationAudioPlayCtx) {
    conversationAudioPlayCtx = new AudioContext({ sampleRate: 24000 });
    conversationNextPlayTime = conversationAudioPlayCtx.currentTime;
  } else if (conversationAudioPlayCtx.state === "suspended") {
    conversationAudioPlayCtx.resume();
  }
  startConversationRealtime();
});

conversationStop.addEventListener("click", () => {
  if (modeSelect.value === "batch") {
    stopBatchRecording();
  } else {
    stopConversationRealtime();
  }
});

chat.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "batch-confirm") {
    confirmBatchFill();
  }
});

modeSelect.addEventListener("change", () => {
  if (conversationListening) {
    if (modeSelect.value === "batch") {
      stopConversationRealtime();
    } else {
      stopBatchRecording();
    }
  }
  updateModelSelectVisibility();
  setConversationListeningState(false, modeSelect.value === "batch" ? "錄音整理模式" : "尚未連線");
});

const handleUserMessage = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  markConversationFormStart();
  chatInput.value = "";
  if (modeSelect.value === "batch" && batchPending) {
    conversationMessages.push({ role: "user", content: trimmed });
    renderChat();
    submitBatchPatch(null, trimmed);
    return;
  }
  conversationMessages.push({ role: "user", content: trimmed });
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
