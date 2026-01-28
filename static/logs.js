const logsContainer = document.getElementById("logs");
const logsEmpty = document.getElementById("logs-empty");
const summaryCount = document.getElementById("summary-count");
const summaryCost = document.getElementById("summary-cost");
const summaryAvgTime = document.getElementById("summary-avg-time");
const logSearch = document.getElementById("log-search");
const logMode = document.getElementById("log-mode");
const logRefresh = document.getElementById("log-refresh");

let allLogs = [];

const formatDate = (iso) => new Date(iso).toLocaleString();
const formatCost = (value) => `$${Number(value).toFixed(4)}`;
const formatDurationSeconds = (value) => {
  if (!value) {
    return "--";
  }
  return `${(Number(value) / 1000).toFixed(1)} s`;
};

const updateSummary = (items) => {
  summaryCount.textContent = items.length.toString();
  const totalCost = items.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  summaryCost.textContent = formatCost(totalCost);
  const totalTime = items.reduce((sum, item) => sum + Number(item.userDurationMs || 0), 0);
  if (!items.length || totalTime === 0) {
    summaryAvgTime.textContent = "--";
  } else {
    summaryAvgTime.textContent = formatDurationSeconds(Math.round(totalTime / items.length));
  }
};

const getFilteredLogs = () => {
  const term = logSearch.value.trim().toLowerCase();
  const mode = logMode.value;
  return allLogs.filter((item) => {
    if (mode !== "all" && item.mode !== mode) {
      return false;
    }
    if (!term) {
      return true;
    }
    const payloadText = JSON.stringify(item.payload || {}).toLowerCase();
    return (
      item.id.toLowerCase().includes(term)
      || item.mode.toLowerCase().includes(term)
      || payloadText.includes(term)
    );
  });
};

const renderLogs = (items, emptyMessage = "尚無符合條件的紀錄") => {
  logsContainer.innerHTML = "";
  if (!items.length) {
    logsEmpty.textContent = emptyMessage;
    logsEmpty.style.display = "block";
    return;
  }
  logsEmpty.style.display = "none";
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "log-item";
    el.innerHTML = `
      <div class="log-header">
        <div class="log-id">Request ${item.id}</div>
        <span class="log-time">${formatDate(item.createdAt)}</span>
      </div>
      <div class="log-actions">
        <span class="badge">${item.mode.toUpperCase()}</span>
        <div class="log-actions-buttons">
          <button class="button secondary log-delete" data-id="${item.id}">刪除</button>
        </div>
      </div>
      <div class="log-meta">
        <span class="log-metric">Input: ${item.tokenUsage.input}</span>
        <span class="log-metric">Output: ${item.tokenUsage.output}</span>
        <span class="log-metric total">Total: ${item.tokenUsage.total}</span>
        <span class="log-metric cost">Cost: ${formatCost(item.cost)}</span>
        <span class="log-metric time">Time: ${formatDurationSeconds(item.userDurationMs)}</span>
      </div>
      <details>
        <summary>檢視填單內容</summary>
        <pre>${JSON.stringify(item.payload, null, 2)}</pre>
      </details>
    `;
    logsContainer.appendChild(el);
  });
};

const loadLogs = async () => {
  try {
    const response = await fetch("/api/requests");
    const data = await response.json();
    allLogs = Array.isArray(data) ? data : [];
    const filtered = getFilteredLogs();
    updateSummary(filtered);
    renderLogs(
      filtered,
      allLogs.length === 0 ? "尚無送出紀錄" : "尚無符合條件的紀錄"
    );
  } catch (error) {
    logsContainer.innerHTML = "<div class='empty-state'>無法取得資料</div>";
  }
};

const refreshView = () => {
  const filtered = getFilteredLogs();
  updateSummary(filtered);
  renderLogs(
    filtered,
    allLogs.length === 0 ? "尚無送出紀錄" : "尚無符合條件的紀錄"
  );
};

logSearch.addEventListener("input", refreshView);
logMode.addEventListener("change", refreshView);
logRefresh.addEventListener("click", loadLogs);

logsContainer.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (!target.classList.contains("log-delete")) {
    return;
  }
  const requestId = target.dataset.id;
  if (!requestId) {
    return;
  }
  if (!window.confirm("確定要刪除這筆紀錄嗎？")) {
    return;
  }
  try {
    const response = await fetch(`/api/requests/${requestId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error("delete failed");
    }
    await loadLogs();
  } catch (error) {
    alert("刪除失敗，請稍後再試。");
  }
});

loadLogs();
