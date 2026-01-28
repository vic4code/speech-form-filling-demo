const logsContainer = document.getElementById("logs");
const logsEmpty = document.getElementById("logs-empty");

const formatDate = (iso) => new Date(iso).toLocaleString();

const renderLogs = (items) => {
  logsContainer.innerHTML = "";
  if (!items.length) {
    logsEmpty.style.display = "block";
    return;
  }
  logsEmpty.style.display = "none";
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "log-item";
    el.innerHTML = `
      <div class="log-actions">
        <strong>Request ${item.id}</strong>
        <span class="badge">${item.mode.toUpperCase()}</span>
      </div>
      <div class="log-meta">
        <span>建立時間: ${formatDate(item.createdAt)}</span>
        <span>Input Tokens: ${item.tokenUsage.input}</span>
        <span>Output Tokens: ${item.tokenUsage.output}</span>
        <span>Total: ${item.tokenUsage.total}</span>
        <span>Cost: $${item.cost}</span>
      </div>
      <details>
        <summary>檢視詳細內容</summary>
        <pre style="white-space: pre-wrap; font-size: 13px">${JSON.stringify(
          item.payload,
          null,
          2
        )}</pre>
      </details>
    `;
    logsContainer.appendChild(el);
  });
};

const loadLogs = async () => {
  try {
    const response = await fetch("/api/requests");
    const data = await response.json();
    renderLogs(data);
  } catch (error) {
    logsContainer.innerHTML = "<div class='empty-state'>無法取得資料</div>";
  }
};

loadLogs();
