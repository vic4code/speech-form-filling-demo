const logsContainer = document.getElementById("logs");
const logsEmpty = document.getElementById("logs-empty");
const summaryCount = document.getElementById("summary-count");
const summaryCost = document.getElementById("summary-cost");
const summaryAvgTime = document.getElementById("summary-avg-time");
const logSearch = document.getElementById("log-search");
const logMode = document.getElementById("log-mode");
const logRefresh = document.getElementById("log-refresh");

let allSessions = [];

const formatDate = (iso) => new Date(iso).toLocaleString();
const formatCost = (value) => `USD $${Number(value).toFixed(4)}`;
const formatDuration = (ms) => (ms ? `${(Number(ms) / 1000).toFixed(1)} s` : "--");

const updateSummary = (items) => {
  summaryCount.textContent = items.length.toString();
  const totalCost = items.reduce((sum, s) => sum + Number(s.req_cost || 0), 0);
  summaryCost.textContent = formatCost(totalCost);
  const withTime = items.filter((s) => s.user_duration_ms);
  if (!withTime.length) {
    summaryAvgTime.textContent = "--";
  } else {
    const avg = withTime.reduce((sum, s) => sum + Number(s.user_duration_ms), 0) / withTime.length;
    summaryAvgTime.textContent = formatDuration(Math.round(avg));
  }
};

const logGuardrail = document.getElementById("log-guardrail");

const getFiltered = () => {
  const term = logSearch.value.trim().toLowerCase();
  const mode = logMode.value;
  const grFilter = logGuardrail.value;
  return allSessions.filter((s) => {
    if (mode !== "all" && s.req_mode !== mode) return false;
    if (grFilter !== "all") {
      if (grFilter === "off" && s.guardrail_mode) return false;
      if (grFilter !== "off" && s.guardrail_mode !== grFilter) return false;
    }
    if (!term) return true;
    const searchable = [
      s.session_id || "",
      s.conn_id || "",
      s.req_id || "",
      JSON.stringify(s.req_payload || {}),
    ].join(" ").toLowerCase();
    return searchable.includes(term);
  });
};

const renderSessions = (items) => {
  logsContainer.innerHTML = "";
  if (!items.length) {
    logsEmpty.style.display = "block";
    logsEmpty.textContent = allSessions.length === 0 ? "尚無紀錄" : "尚無符合條件的紀錄";
    return;
  }
  logsEmpty.style.display = "none";

  items.forEach((s) => {
    const el = document.createElement("div");
    el.className = "log-item";

    const headerId = s.session_id || s.conn_id || "直接提交";
    const headerTs = formatDate(s.started_at);
    const endpointBadge = s.endpoint !== "—"
      ? `<span class="badge">${s.endpoint.toUpperCase()}</span>`
      : "";
    const modeBadge = s.req_mode
      ? `<span class="badge">${s.req_mode.toUpperCase()}</span>`
      : "";
    const grModeLabels = {
      keyword: "關鍵字 Guardrail",
    };
    const grMode = s.guardrail_mode;
    const grBadge = grMode
      ? `<span class="badge guardrail-badge">${grModeLabels[grMode] || grMode}</span>`
      : `<span class="badge badge-muted">Guardrail OFF</span>`;

    const textIn = s.token_usage?.input || 0;
    const textOut = s.token_usage?.output || 0;
    const audioIn = s.audio_input_tokens || 0;
    const audioOut = s.audio_output_tokens || 0;
    const totalTokens = textIn + textOut + audioIn + audioOut;
    const costMeta = `<span class="log-metric cost">Cost: ${formatCost(s.req_cost || 0)}</span>`;
    const timeMeta = `<span class="log-metric time">Time: ${formatDuration(s.user_duration_ms)}</span>`;
    const eventsMeta = s.event_count
      ? `<span class="log-metric">${s.event_count} events</span>`
      : "";
    const tokenMeta = `<span class="log-metric">Tokens: ${totalTokens} (Text ${textIn}+${textOut} / Audio ${audioIn}+${audioOut})</span>`;

    const deleteBtn = s.req_id
      ? `<button class="log-delete-btn" data-id="${s.req_id}" title="Delete">✕</button>`
      : s.conn_id
        ? `<button class="log-delete-btn" data-conn="${s.conn_id}" title="Delete">✕</button>`
        : `<button class="log-delete-btn" disabled title="No ID">✕</button>`;

    const payloadSection = s.req_payload
      ? `<details>
           <summary>查看填單內容</summary>
           <pre>${JSON.stringify(s.req_payload, null, 2)}</pre>
         </details>`
      : "";

    const eventsSection = s.conn_id
      ? `<details>
           <summary>查看事件時序</summary>
           <div class="ws-events-list" data-conn="${s.conn_id}">載入中…</div>
         </details>`
      : "";

    el.innerHTML = `
      <div class="log-header">
        <div class="log-header-left">
          <div class="log-id">${headerId}</div>
          <span class="log-time">${headerTs}</span>
        </div>
        ${deleteBtn}
      </div>
      <div class="log-badges">
        ${endpointBadge}${modeBadge}${grBadge}
      </div>
      <div class="log-meta">
        ${eventsMeta}${tokenMeta}${costMeta}${timeMeta}
      </div>
      ${payloadSection}
      ${eventsSection}
    `;

    logsContainer.appendChild(el);

    // Lazy-load WS events on expand
    if (s.conn_id) {
      el.querySelector("details:last-of-type").addEventListener("toggle", async (e) => {
        if (!e.target.open) return;
        const eventsDiv = el.querySelector(".ws-events-list");
        if (eventsDiv.dataset.loaded) return;
        try {
          const r = await fetch(`/api/ws-sessions/${s.conn_id}/events`);
          const events = await r.json();
          eventsDiv.dataset.loaded = "1";
          eventsDiv.innerHTML = events.map((ev) => `
            <div class="ws-event-row">
              <span class="ws-dir ${ev.direction === "out" ? "ws-out" : "ws-in"}">
                ${ev.direction === "out" ? "→OAI" : "←OAI"}
              </span>
              <span class="log-time">${new Date(ev.created_at).toLocaleTimeString()}</span>
              <code>${ev.event_type}</code>
              ${ev.payload_json ? `<details><summary>JSON</summary><pre>${
                JSON.stringify(JSON.parse(ev.payload_json), null, 2)
              }</pre></details>` : ""}
            </div>
          `).join("");
        } catch {
          eventsDiv.textContent = "無法載入事件";
        }
      });
    }
  });
};

const loadSessions = async () => {
  try {
    const res = await fetch("/api/sessions");
    allSessions = await res.json();
    const filtered = getFiltered();
    updateSummary(filtered);
    renderSessions(filtered);
  } catch {
    logsContainer.innerHTML = "<div class='empty-state'>無法取得資料</div>";
  }
};

const refreshView = () => {
  const filtered = getFiltered();
  updateSummary(filtered);
  renderSessions(filtered);
};

const logDeleteAll = document.getElementById("log-delete-all");

logSearch.addEventListener("input", refreshView);
logMode.addEventListener("change", refreshView);
logGuardrail.addEventListener("change", refreshView);
logRefresh.addEventListener("click", loadSessions);
logDeleteAll.addEventListener("click", async () => {
  if (!window.confirm("確定要刪除所有紀錄嗎？此操作無法復原。")) return;
  try {
    const res = await fetch("/api/requests", { method: "DELETE" });
    if (!res.ok) throw new Error("delete all failed");
    await loadSessions();
  } catch {
    alert("刪除失敗，請稍後再試。");
  }
});

logsContainer.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("log-delete-btn")) return;
  const requestId = target.dataset.id;
  const connId = target.dataset.conn;
  if (!requestId && !connId) return;
  if (!window.confirm("確定要刪除這筆紀錄嗎？")) return;
  try {
    const url = requestId
      ? `/api/requests/${requestId}`
      : `/api/ws-sessions/${connId}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) throw new Error("delete failed");
    await loadSessions();
  } catch {
    alert("刪除失敗，請稍後再試。");
  }
});

loadSessions();
