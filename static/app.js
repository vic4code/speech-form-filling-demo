const tabButtons = document.querySelectorAll(".tab-button[data-tab]");
const sttTab = document.getElementById("stt-tab");
const conversationTab = document.getElementById("conversation-tab");

const sttStatusDot = document.getElementById("stt-status-dot");
const sttStatusText = document.getElementById("stt-status-text");
const sttActiveField = document.getElementById("stt-active-field");
const sttStart = document.getElementById("stt-start");
const sttStop = document.getElementById("stt-stop");
const sttNext = document.getElementById("stt-next");
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

const fieldOrder = ["field-date", "field-ride-type", "ride-from-0", "ride-to-0", "field-total", "field-notes"];

let activeFieldIndex = 0;
let recognition = null;
let listening = false;
let conversationMessages = [];

const updateActiveField = () => {
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
    <button type="button" class="icon-button danger" aria-label="移除">🗑</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  rideRowsContainer.appendChild(row);
};

addRideRow();

addRideButton.addEventListener("click", () => addRideRow());

sttNext.addEventListener("click", () => {
  activeFieldIndex = (activeFieldIndex + 1) % fieldOrder.length;
  updateActiveField();
});

sttReview.addEventListener("click", () => {
  setListeningState(false, "已暫存表單內容");
});

const initSpeechRecognition = () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setListeningState(false, "此瀏覽器不支援語音辨識，請改用手動輸入。");
    return null;
  }
  const recognizer = new SpeechRecognition();
  recognizer.lang = "zh-TW";
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join("");
    handleTranscript(transcript);
  };
  recognizer.onerror = () => {
    setListeningState(false, "語音辨識發生錯誤，請稍後重試。");
  };
  recognizer.onend = () => {
    if (listening) {
      recognizer.start();
    }
  };
  return recognizer;
};

const handleTranscript = (text) => {
  const normalized = text.toLowerCase();
  if (normalized.includes("下一個") || normalized.includes("next")) {
    activeFieldIndex = (activeFieldIndex + 1) % fieldOrder.length;
    updateActiveField();
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
    field.value = text;
  }
};

sttStart.addEventListener("click", () => {
  if (!recognition) {
    recognition = initSpeechRecognition();
  }
  if (!recognition) {
    return;
  }
  recognition.start();
  setListeningState(true, "語音辨識進行中");
  updateActiveField();
});

sttStop.addEventListener("click", () => {
  if (recognition) {
    recognition.stop();
  }
  setListeningState(false, "已停止語音");
});

const collectRideRows = () =>
  Array.from(rideRowsContainer.querySelectorAll(".ride-row")).map((row) => {
    const inputs = row.querySelectorAll("input");
    return {
      from: inputs[0].value,
      to: inputs[1].value,
    };
  });

const buildSttPayload = () => ({
  rideDate: document.getElementById("field-date").value,
  rideType: document.getElementById("field-ride-type").value,
  rideRows: collectRideRows(),
  totalFare: document.getElementById("field-total").value,
  notes: document.getElementById("field-notes").value,
});

const submitRequest = async (mode, payload, statusEl) => {
  statusEl.textContent = "送出中...";
  try {
    const response = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, payload }),
    });
    if (!response.ok) {
      throw new Error("提交失敗");
    }
    const data = await response.json();
    statusEl.textContent = `已送出，Request ID: ${data.id}`;
  } catch (error) {
    statusEl.textContent = "送出失敗，請稍後再試。";
  }
};

sttSubmit.addEventListener("click", async () => {
  const payload = buildSttPayload();
  await submitRequest("stt", payload, sttSubmitStatus);
});

const renderChat = () => {
  chat.innerHTML = "";
  conversationMessages.forEach((message) => {
    const bubble = document.createElement("div");
    bubble.className = `chat-message ${message.role}`;
    bubble.textContent = message.content;
    chat.appendChild(bubble);
  });
  chat.scrollTop = chat.scrollHeight;
};

const generateStructuredOutput = () => {
  const summary = {
    requester: conversationMessages[0]?.content || "",
    intent: conversationMessages.slice(-1)[0]?.content || "",
    mode: "conversation",
    notes: "此為 demo 產生的結構化輸出，可依實際 schema 調整。",
  };
  structuredOutput.textContent = JSON.stringify(summary, null, 2);
  return summary;
};

chatSend.addEventListener("click", () => {
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }
  conversationMessages.push({ role: "user", content: text });
  conversationMessages.push({ role: "agent", content: "已收到，我會整理成結構化資料。" });
  chatInput.value = "";
  renderChat();
  generateStructuredOutput();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    chatSend.click();
  }
});

generateStructure.addEventListener("click", () => {
  generateStructuredOutput();
});

conversationSubmit.addEventListener("click", async () => {
  const payload = generateStructuredOutput();
  await submitRequest("conversation", payload, conversationStatus);
});

const switchTab = (target) => {
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === target);
  });
  sttTab.style.display = target === "stt" ? "block" : "none";
  conversationTab.style.display = target === "conversation" ? "block" : "none";
};

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

renderChat();
updateActiveField();
