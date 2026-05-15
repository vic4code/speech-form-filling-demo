// ── State ──
let serverUrl = "http://localhost:8000";
let wsHost = "localhost:8000";

let listening = false;
let messages = [];
let socket = null;
let audioCtx = null;
let audioProcessor = null;
let stream = null;
let currentAgent = null;
let currentUser = null;
let agentBuffer = "";
let userBuffer = "";
let flushId = null;
let msgEls = [];
let formStartAt = null;
let pendingMeta = null;
let audioPlayCtx = null;
let nextPlayTime = 0;
let batchRecorder = null;
let batchStream = null;
let batchChunks = [];
let batchPending = null;
let fillPage = true;

// ── DOM refs ──
const chat = document.getElementById("chat");
const chatInput = document.getElementById("chat-input");
const btnSend = document.getElementById("btn-send");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const browserStatusEl = document.getElementById("browser-status");
const browserStatusText = document.getElementById("browser-status-text");
const modeSelect = document.getElementById("mode-select");
const modelSelect = document.getElementById("model-select");
const transcribeModelSelect = document.getElementById("transcribe-model-select");
const structureModelSelect = document.getElementById("structure-model-select");
const formSelect = document.getElementById("form-select");
const formLink = document.getElementById("form-link");
const formChipLabel = document.getElementById("form-chip-label");
const guardrailEnabled = document.getElementById("guardrail-enabled");
const guardrailWarningEl = document.getElementById("guardrail-warning");
const guardrailWarningMsg = document.getElementById("guardrail-warning-msg");
const settingsBtn = document.getElementById("settings-btn");
const settingsDrawer = document.getElementById("settings-drawer");
const serverUrlInput = document.getElementById("server-url");
const saveSettingsBtn = document.getElementById("save-settings");
const fillPageEnabled = document.getElementById("fill-page-enabled");
const realtimeModelGroup = document.getElementById("realtime-model-group");
const transcribeModelGroup = document.getElementById("transcribe-model-group");
const structureModelGroup = document.getElementById("structure-model-group");

// ── Settings persistence ──
const loadSettings = async () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["serverUrl", "formId", "mode", "model", "guardrail", "fillPage"],
      (data) => resolve(data)
    );
  });
};

const saveSettings = () => {
  chrome.storage.local.set({
    serverUrl: serverUrlInput.value || "http://localhost:8000",
    formId: formSelect.value,
    mode: modeSelect.value,
    model: modelSelect.value,
    guardrail: guardrailEnabled.checked,
    fillPage: fillPageEnabled.checked,
  });
};

const applyServerUrl = (url) => {
  serverUrl = (url || "http://localhost:8000").replace(/\/$/, "");
  try {
    const u = new URL(serverUrl);
    wsHost = u.host;
  } catch {
    wsHost = "localhost:8000";
  }
};

// ── Init ──
(async () => {
  const data = await loadSettings();
  applyServerUrl(data.serverUrl);
  serverUrlInput.value = serverUrl;
  if (data.guardrail) guardrailEnabled.checked = true;
  if (data.fillPage !== undefined) fillPageEnabled.checked = data.fillPage;
  fillPage = fillPageEnabled.checked;

  // Load models from backend
  try {
    const resp = await fetch(`${serverUrl}/api/models`);
    const json = await resp.json();

    json.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === json.default || (!data.model && m.id === json.default)) opt.selected = true;
      if (data.model && m.id === data.model) opt.selected = true;
      modelSelect.appendChild(opt);
    });

    const batchInfo = json.batch || {};
    const txModels = batchInfo.transcription || [{ id: "whisper-1", label: "Whisper 1" }];
    const stModels = batchInfo.structuring || [{ id: "gpt-4.1", label: "GPT-4.1" }];
    const defTx = batchInfo.default_transcription || "gpt-4o-transcribe";
    const defSt = batchInfo.default_structuring || "gpt-4.1";

    txModels.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === defTx) opt.selected = true;
      transcribeModelSelect.appendChild(opt);
    });
    stModels.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === defSt) opt.selected = true;
      structureModelSelect.appendChild(opt);
    });
  } catch {
    const opt = document.createElement("option");
    opt.value = "gpt-realtime-2";
    opt.textContent = "GPT Realtime 2";
    modelSelect.appendChild(opt);
  }

  // Load forms
  try {
    const resp = await fetch(`${serverUrl}/api/forms`);
    const forms = await resp.json();
    forms.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.label;
      opt.dataset.url = f.url || "";
      if (data.formId && f.id === data.formId) opt.selected = true;
      formSelect.appendChild(opt);
    });
  } catch {
    const opt = document.createElement("option");
    opt.value = "taxi";
    opt.textContent = "計程車費請領單";
    formSelect.appendChild(opt);
  }

  if (data.mode) modeSelect.value = data.mode;
  updateFormChip();
  updateModelVisibility();
})();

// ── Settings drawer toggle ──
settingsBtn.addEventListener("click", () => {
  settingsDrawer.hidden = !settingsDrawer.hidden;
});

saveSettingsBtn.addEventListener("click", () => {
  applyServerUrl(serverUrlInput.value);
  fillPage = fillPageEnabled.checked;
  saveSettings();
  settingsDrawer.hidden = true;
  updateFormChip();
});

// ── Form chip ──
const updateFormChip = () => {
  const opt = formSelect.selectedOptions[0];
  if (opt) {
    formChipLabel.textContent = opt.textContent;
    if (opt.dataset.url) {
      formLink.href = opt.dataset.url;
      formLink.style.display = "";
    } else {
      formLink.style.display = "none";
    }
  }
};
formSelect.addEventListener("change", updateFormChip);

// ── Model visibility ──
const updateModelVisibility = () => {
  const isBatch = modeSelect.value === "batch";
  realtimeModelGroup.style.display = isBatch ? "none" : "";
  transcribeModelGroup.style.display = isBatch ? "" : "none";
  structureModelGroup.style.display = isBatch ? "" : "none";
};
modeSelect.addEventListener("change", () => {
  updateModelVisibility();
  setListening(false, modeSelect.value === "batch" ? "錄音整理模式" : "尚未連線");
});

// ── Browser / page fill status ──
const showBrowserStatus = (text, type = "info") => {
  browserStatusEl.style.display = "flex";
  browserStatusEl.className = `sp-status-chip ${type}`;
  browserStatusText.textContent = text;
};

// ── Page fill via content script ──
const fillCurrentPage = async (payload) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { ok: false, reason: "no active tab" };
    const result = await chrome.tabs.sendMessage(tab.id, { action: "fill_form", payload });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
};

// ── Listening state ──
const setListening = (active, msg) => {
  listening = active;
  statusDot.classList.toggle("active", active);
  statusText.textContent = msg;
  btnStart.style.display = active ? "none" : "flex";
  btnStop.style.display = active ? "flex" : "none";
};

const markStart = () => {
  if (!formStartAt) formStartAt = new Date();
};

// ── Audio capture ──
const arrayBufferToBase64 = (buffer) => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const startAudio = async () => {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: 24000, echoCancellation: true, noiseSuppression: true },
  });
  audioCtx = new AudioContext({ sampleRate: 24000 });
  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("audio-processor.js"));
  const source = audioCtx.createMediaStreamSource(stream);
  audioProcessor = new AudioWorkletNode(audioCtx, "pcm-processor");
  audioProcessor.port.onmessage = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ audio: arrayBufferToBase64(event.data) }));
  };
  source.connect(audioProcessor);
  audioProcessor.connect(audioCtx.destination);
};

const stopAudio = () => {
  audioProcessor?.disconnect();
  audioProcessor = null;
  audioCtx?.close();
  audioCtx = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
};

// ── Audio playback ──
const playAudioDelta = async (base64) => {
  if (!audioPlayCtx) return;
  if (audioPlayCtx.state === "suspended") await audioPlayCtx.resume();
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;
  const buf = audioPlayCtx.createBuffer(1, float32.length, 24000);
  buf.getChannelData(0).set(float32);
  const src = audioPlayCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioPlayCtx.destination);
  const now = audioPlayCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.05;
  src.start(nextPlayTime);
  nextPlayTime += buf.duration;
};

const stopPlayback = () => {
  if (audioPlayCtx && audioPlayCtx.state !== "closed") {
    audioPlayCtx.close();
    audioPlayCtx = new AudioContext({ sampleRate: 24000 });
    nextPlayTime = audioPlayCtx.currentTime;
  }
};

// ── Realtime WebSocket ──
const startRealtime = async () => {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  const proto = serverUrl.startsWith("https") ? "wss" : "ws";
  const params = new URLSearchParams();
  params.set("model", modelSelect.value);
  if (formSelect.value) params.set("form", formSelect.value);
  if (guardrailEnabled.checked) params.set("guardrail", "keyword");

  socket = new WebSocket(`${proto}://${wsHost}/ws/realtime?${params}`);
  socket.onopen = async () => {
    setListening(true, "已連線，語音辨識進行中");
    markStart();
    messages = []; currentAgent = null; currentUser = null; msgEls = [];
    chat.innerHTML = "";
    renderChat();
    socket.send(JSON.stringify({ meta: { startedAt: formStartAt.toISOString() } }));
    await startAudio();
  };
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const t = data.type;
    if (t === "agent_delta") {
      if (!currentAgent) { currentAgent = { role: "agent", content: "" }; messages.push(currentAgent); }
      agentBuffer += data.content;
    } else if (t === "agent_done") {
      if (agentBuffer && currentAgent) { currentAgent.content += agentBuffer; agentBuffer = ""; }
      currentAgent = null;
    } else if (t === "user_delta") {
      if (!currentUser) { currentUser = { role: "user", content: "" }; messages.push(currentUser); }
      userBuffer += data.content;
    } else if (t === "user_done") {
      if (userBuffer && currentUser) { currentUser.content += userBuffer; userBuffer = ""; }
      currentUser = null;
      renderChat();
    } else if (t === "form_ready") {
      showBrowserStatus("表單資料整理完成，正在填入…", "info");
      messages.push({ role: "agent", content: "表單資料整理完成，正在填入表單…" });
      renderChat();
      // Also fill the current page via content script
      if (fillPage && data.payload) {
        fillCurrentPage(data.payload).then((r) => {
          if (r.ok) showBrowserStatus(`頁面填入完成（${r.result?.filled?.length ?? 0} 個欄位）`, "success");
        });
      }
    } else if (t === "browser_fill_done") {
      showBrowserStatus("瀏覽器表單填寫完成！", "success");
      stopRealtime();
    } else if (t === "browser_fill_error") {
      showBrowserStatus(`填寫失敗：${data.message}`, "error");
    } else if (t === "playback_stop") {
      stopPlayback();
    } else if (t === "audio_delta") {
      playAudioDelta(data.delta);
    } else if (t === "guardrail_chat") {
      messages.push({ role: "guardrail-chip", passed: !!data.passed, side: data.side || "input", snippet: data.snippet || "", reason: data.reason || "" });
      renderChat();
    } else if (t === "error") {
      setListening(false, data.message || "發生錯誤");
    }
    if (!flushId) {
      flushId = requestAnimationFrame(() => {
        if (currentAgent && agentBuffer) { currentAgent.content += agentBuffer; agentBuffer = ""; }
        if (currentUser && userBuffer) { currentUser.content += userBuffer; userBuffer = ""; }
        renderChat();
        flushId = null;
      });
    }
  };
  socket.onerror = () => setListening(false, "連線失敗，請確認伺服器是否啟動");
  socket.onclose = () => { setListening(false, "已停止語音"); stopAudio(); };
};

const stopRealtime = () => {
  stopAudio();
  socket?.close();
  socket = null;
  audioPlayCtx?.close();
  audioPlayCtx = null;
  nextPlayTime = 0;
  setListening(false, "已停止語音");
};

const sendText = (text) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ text }));
};

// ── Batch recording ──
const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

const parseError = async (resp) => {
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const d = await resp.json();
    return d.detail || d.message || JSON.stringify(d);
  }
  return (await resp.text()) || `HTTP ${resp.status}`;
};

const stopBatchStream = () => {
  batchStream?.getTracks().forEach((t) => t.stop());
  batchStream = null;
};

const startBatchRecording = async () => {
  if (batchRecorder?.state === "recording") return;
  batchChunks = [];
  batchPending = null;
  batchStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  batchRecorder = new MediaRecorder(batchStream, { mimeType: mime });
  batchRecorder.ondataavailable = (e) => { if (e.data?.size) batchChunks.push(e.data); };
  batchRecorder.onstop = async () => {
    stopBatchStream();
    const blob = new Blob(batchChunks, { type: batchRecorder.mimeType || "audio/webm" });
    batchRecorder = null;
    if (!blob.size) { setListening(false, "沒有錄到聲音"); return; }
    await submitBatch(blob);
  };
  messages.push({ role: "agent", content: "正在錄音，講完後按停止，我會整理成表單讓你確認。" });
  renderChat();
  batchRecorder.start();
  setListening(true, "錄音中");
  markStart();
};

const stopBatchRecording = () => {
  if (batchRecorder?.state === "recording") {
    setListening(false, "正在整理錄音…");
    batchRecorder.stop();
  }
};

const submitBatch = async (blob) => {
  try {
    setListening(false, "正在轉譯並整理表單…");
    const audioBase64 = await blobToDataUrl(blob);
    const resp = await fetch(`${serverUrl}/api/batch-form/prepare`, {
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
    if (!resp.ok) throw new Error(await parseError(resp));
    const data = await resp.json();
    if (data.transcript) messages.push({ role: "user", content: data.transcript });
    if (data.reviewText || data.payload) {
      messages.push({ role: "batch-review", content: data.reviewText || JSON.stringify(data.payload, null, 2), payload: data.payload, meta: data.meta || null, ready: !!data.ready, errors: data.errors || [] });
    }
    if (!data.ready) {
      messages.push({ role: "agent", content: `已整理成草稿，但以下資訊還不夠，請再說一遍：${(data.errors || []).join("、") || "部分必填欄位"}` });
    } else {
      batchPending = data;
    }
    renderChat();
    setListening(false, data.ready ? "請確認整理後的表單" : "需要補充資訊");
  } catch (e) {
    messages.push({ role: "agent", content: `錄音整理失敗：${e.message}` });
    renderChat();
    setListening(false, "錄音整理失敗");
  }
};

const confirmBatchFill = async () => {
  if (!batchPending?.payload) return;
  showBrowserStatus("已確認，正在填寫表單…", "info");

  // Fill current page directly if enabled
  if (fillPage) {
    const r = await fillCurrentPage(batchPending.payload);
    if (r.ok) {
      showBrowserStatus(`頁面填入完成（${r.result?.filled?.length ?? 0} 個欄位）`, "success");
      messages.push({ role: "agent", content: `已填入當前頁面，共 ${r.result?.filled?.length ?? 0} 個欄位。請確認後送出。` });
      batchPending = null;
      renderChat();
      return;
    }
  }

  // Fallback: server-side Playwright fill
  try {
    const resp = await fetch(`${serverUrl}/api/batch-form/fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form: formSelect.value, payload: batchPending.payload, meta: batchPending.meta, guardrailMode: guardrailEnabled.checked ? "keyword" : null }),
    });
    if (!resp.ok) throw new Error(await parseError(resp));
    showBrowserStatus("表單已自動填寫完成！", "success");
    messages.push({ role: "agent", content: "已填入瀏覽器表單，請在送出前再次確認。" });
    batchPending = null;
  } catch (e) {
    showBrowserStatus(`填寫失敗：${e.message}`, "error");
    messages.push({ role: "agent", content: `填寫失敗：${e.message}` });
  }
  renderChat();
};

const startBatchPatch = async () => {
  if (!batchPending || batchRecorder?.state === "recording") return;
  batchChunks = [];
  batchStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  batchRecorder = new MediaRecorder(batchStream, { mimeType: mime });
  batchRecorder.ondataavailable = (e) => { if (e.data?.size) batchChunks.push(e.data); };
  batchRecorder.onstop = async () => {
    stopBatchStream();
    const blob = new Blob(batchChunks, { type: batchRecorder.mimeType || "audio/webm" });
    batchRecorder = null;
    if (!blob.size) { setListening(false, "沒有錄到聲音"); return; }
    await submitPatch(blob, null);
  };
  batchRecorder.start();
  setListening(true, "語音修改錄音中，講完後按停止");
};

const submitPatch = async (blob, correctionText) => {
  if (!batchPending) return;
  try {
    setListening(false, "正在修改表單…");
    const body = {
      form: formSelect.value,
      currentPayload: batchPending.payload,
      guardrailMode: guardrailEnabled.checked ? "keyword" : null,
      transcribeModel: transcribeModelSelect.value || undefined,
      structureModel: structureModelSelect.value || undefined,
      previousErrors: batchPending.errors?.length ? batchPending.errors : undefined,
    };
    if (blob) { body.audioBase64 = await blobToDataUrl(blob); body.mimeType = blob.type || "audio/webm"; }
    if (correctionText) body.correctionText = correctionText;
    const resp = await fetch(`${serverUrl}/api/batch-form/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await parseError(resp));
    const data = await resp.json();
    if (data.transcript) messages.push({ role: "user", content: data.transcript });
    const idx = messages.reduce((last, m, i) => m.role === "batch-review" ? i : last, -1);
    const reviewMsg = { role: "batch-review", content: data.reviewText || JSON.stringify(data.payload, null, 2), payload: data.payload, meta: data.meta || null, ready: !!data.ready, errors: data.errors || [] };
    if (idx >= 0) { messages[idx] = reviewMsg; if (msgEls[idx]) msgEls[idx]._lastHtml = null; }
    else messages.push(reviewMsg);
    if (data.payload) batchPending = data;
    if (!data.ready && data.errors?.length) messages.push({ role: "agent", content: `修改後仍有缺漏，請補充：${data.errors.join("、")}` });
    renderChat();
    setListening(false, data.ready ? "請確認修改後的表單" : "需要補充資訊");
  } catch (e) {
    messages.push({ role: "agent", content: `修改失敗：${e.message}` });
    renderChat();
    setListening(false, "修改失敗");
  }
};

// ── Render ──
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ICON_CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_BLOCK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const SIDE_LABELS = { input: "使用者輸入", output: "模型輸出" };

const renderGuardrailChip = (m) => {
  const icon = m.passed ? ICON_CHECK : ICON_BLOCK;
  let html = `<div class="sp-gr-header">${icon}<span class="sp-gr-meta">Guardrail · 關鍵字</span><span class="sp-gr-side">${esc(SIDE_LABELS[m.side] || m.side)}</span><span class="sp-gr-status">${m.passed ? "通過" : "已攔截"}</span></div>`;
  if (!m.passed && (m.snippet || m.reason)) {
    html += `<div class="sp-gr-body">${m.snippet ? `<div class="sp-gr-snippet">「${esc(m.snippet)}」</div>` : ""}${m.reason ? `<div class="sp-gr-reason">${esc(m.reason)}</div>` : ""}</div>`;
  }
  return html;
};

const renderBatchReview = (m) => {
  const title = m.ready ? "模型整理後的表單" : "表單草稿";
  const errors = m.errors?.length ? `<div class="sp-batch-errors">${m.errors.map((e) => `<div>${esc(e)}</div>`).join("")}</div>` : "";
  const btn = m.ready ? '<div class="sp-batch-actions"><button type="button" class="sp-batch-confirm" data-action="batch-confirm">確認填入表單</button></div>' : "";
  return `<div class="sp-batch-head">${title}</div><pre class="sp-batch-body">${esc(m.content || "")}</pre>${errors}${btn}`;
};

const renderChat = () => {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let el = msgEls[i];
    if (!el) { el = document.createElement("div"); msgEls[i] = el; chat.appendChild(el); }

    if (m.role === "guardrail-chip") {
      const cls = `sp-gr-chip ${m.passed ? "pass" : "block"}`;
      if (el.className !== cls) el.className = cls;
      const html = renderGuardrailChip(m);
      if (el._lastHtml !== html) { el.innerHTML = html; el._lastHtml = html; }
      continue;
    }
    if (m.role === "batch-review") {
      const cls = "sp-batch-card";
      if (el.className !== cls) el.className = cls;
      const html = renderBatchReview(m);
      if (el._lastHtml !== html) { el.innerHTML = html; el._lastHtml = html; }
      continue;
    }
    const cls = `sp-msg ${m.role}`;
    if (el.className !== cls) el.className = cls;
    if (el.textContent !== m.content) el.textContent = m.content;
  }
  // Remove stale elements
  for (let i = messages.length; i < msgEls.length; i++) {
    msgEls[i]?.parentNode?.removeChild(msgEls[i]);
  }
  msgEls = msgEls.slice(0, messages.length);

  const wrapper = document.querySelector(".sp-chat-wrapper");
  if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
};

// ── Event listeners ──
btnStart.addEventListener("click", () => {
  if (listening) return;
  if (modeSelect.value === "batch") {
    batchPending ? startBatchPatch() : startBatchRecording();
    return;
  }
  if (!audioPlayCtx) {
    audioPlayCtx = new AudioContext({ sampleRate: 24000 });
    nextPlayTime = audioPlayCtx.currentTime;
  } else if (audioPlayCtx.state === "suspended") {
    audioPlayCtx.resume();
  }
  startRealtime();
});

btnStop.addEventListener("click", () => {
  modeSelect.value === "batch" ? stopBatchRecording() : stopRealtime();
});

chat.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  if (t.dataset.action === "batch-confirm") confirmBatchFill();
});

const handleUserMsg = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  markStart();
  chatInput.value = "";
  if (modeSelect.value === "batch" && batchPending) {
    messages.push({ role: "user", content: trimmed });
    renderChat();
    submitPatch(null, trimmed);
    return;
  }
  messages.push({ role: "user", content: trimmed });
  renderChat();
  sendText(trimmed);
};

btnSend.addEventListener("click", () => handleUserMsg(chatInput.value));
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); btnSend.click(); }
});

renderChat();
