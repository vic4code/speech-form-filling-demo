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

const getFiltered = () => {
  const term = logSearch.value.trim().toLowerCase();
  const mode = logMode.value;
  return allSessions.filter((s) => {
    if (mode !== "all" && s.req_mode !== mode) return false;
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
    const costMeta = s.req_cost != null
      ? `<span class="log-metric cost">Cost: ${formatCost(s.req_cost)}</span>`
      : "";
    const timeMeta = s.user_duration_ms
      ? `<span class="log-metric time">Time: ${formatDuration(s.user_duration_ms)}</span>`
      : "";
    const eventsMeta = s.event_count
      ? `<span class="log-metric">${s.event_count} events</span>`
      : "";
    const tokenMeta = s.token_usage && (s.token_usage.input || s.token_usage.output)
      ? `<span class="log-metric">In: ${s.token_usage.input}</span>
         <span class="log-metric">Out: ${s.token_usage.output}</span>`
      : "";

    const deleteBtn = s.req_id
      ? `<button class="button secondary log-delete" data-id="${s.req_id}">刪除</button>`
      : "";

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
        <div class="log-id">${headerId}</div>
        <span class="log-time">${headerTs}</span>
      </div>
      <div class="log-actions">
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${endpointBadge}${modeBadge}
        </div>
        <div class="log-actions-buttons">${deleteBtn}</div>
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

logSearch.addEventListener("input", refreshView);
logMode.addEventListener("change", refreshView);
logRefresh.addEventListener("click", loadSessions);

logsContainer.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("log-delete")) return;
  const requestId = target.dataset.id;
  if (!requestId || !window.confirm("確定要刪除這筆紀錄嗎？")) return;
  try {
    const response = await fetch(`/api/requests/${requestId}`, { method: "DELETE" });
    if (!response.ok) throw new Error("delete failed");
    await loadSessions();
  } catch {
    alert("刪除失敗，請稍後再試。");
  }
});

loadSessions();
