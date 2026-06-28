let currentTabId = null;
let currentPageUrl = "";
let videos = [];
const selected = new Set();
const selectedTasks = new Set();
const taskMap = new Map();
let activeTaskStats = { total: 0, running: 0, queued: 0, maxConcurrent: 2 };
let activeTabName = "detected";
const failedToastShown = new Set();
let loadTasksTimer = null;
let loadLogsTimer = null;

const urlParams = new URLSearchParams(location.search);
const isTabView = urlParams.get("view") === "tab";
const initialTabId = Number(urlParams.get("tabId")) || null;
if (isTabView) {
  document.body.classList.add("tab-mode");
  if (initialTabId > 0) currentTabId = initialTabId;
}

const dlRoot = document.getElementById("mode-download");
const $ = (sel) => (dlRoot ? dlRoot.querySelector(sel) : document.querySelector(sel));
const $toastEl = () => document.getElementById("toast");

function scheduleLoadTasks() {
  if (loadTasksTimer) return;
  loadTasksTimer = setTimeout(async () => {
    loadTasksTimer = null;
    await loadTasks();
  }, 400);
}

function scheduleLoadLogs() {
  if (activeTabName !== "log") return;
  if (loadLogsTimer) return;
  loadLogsTimer = setTimeout(async () => {
    loadLogsTimer = null;
    await loadLogs();
  }, 2000);
}

function formatVideoLabel(v) {
  const name = v.title || v.url.split("?")[0].split("/").pop() || "video";
  const q = qualityLabel(v.quality);
  const size = formatSize(v.size);
  const dur = formatDuration(v.duration);
  return { name, meta: `解析度 ${q}  ·  容量 ${size}  ·  時長 ${dur}` };
}

function qualityLabel(q) {
  if (q >= 2160) return "4K";
  if (q >= 1440) return "1440P";
  if (q >= 1080) return "1080P";
  if (q >= 720) return "720P";
  if (q >= 480) return "480P";
  if (q >= 360) return "360P";
  if (q > 0) return `${q}P`;
  return "Auto";
}

function formatSize(n) {
  if (!n || n <= 0) return "--";
  let val = Number(n);
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (val < 1024) return unit === "B" ? `${Math.floor(val)} B` : `${val.toFixed(1)} ${unit}`;
    val /= 1024;
  }
  return `${val.toFixed(1)} TB`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "--";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSpeed(n) {
  return n > 0 ? `${formatSize(n)}/s` : "0 B/s";
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function segmentProgressPct(done, total) {
  if (!total || total <= 0 || !done || done <= 0) return 0;
  const raw = (done * 100) / total;
  if (raw > 0 && raw < 1) return 1;
  return Math.min(100, Math.floor(raw));
}

function statusText(status) {
  return {
    pending: "排隊中",
    downloading: "下載中",
    merging: "合併中",
    paused: "已暫停",
    failed: "失敗",
    cancelled: "已取消",
    completed: "已完成",
  }[status] || status;
}

function taskStatusClass(status) {
  if (status === "downloading" || status === "merging") return "status-active";
  if (status === "paused") return "status-paused";
  if (status === "pending") return "status-pending";
  if (status === "failed") return "status-failed";
  return "";
}

async function runTaskAction(type, taskId) {
  try {
    await api(type, { taskId });
    await loadTasks();
  } catch (e) {
    showToast(e.message || String(e), "error");
    await loadTasks();
  }
}

function showToast(message, level = "error") {
  const el = $toastEl();
  el.hidden = false;
  el.textContent = message;
  el.className = level === "info" ? "toast info" : "toast";
}

function hideToast() {
  $toastEl().hidden = true;
}

// 確保活著的背景 Service Worker 與面板同版本。
// MV3 常見：擴充更新後舊 SW 仍在跑，新面板對到舊背景 → 指定路徑、日誌全失效。
// 偵測到不一致時直接 chrome.runtime.reload() 強制重啟整個擴充（含 SW），
// 用時間戳避免無限重載迴圈。回傳 true 代表版本一致、可繼續。
async function ensureSwFresh() {
  const panelVer = chrome.runtime.getManifest().version;
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "GET_SW_VERSION" });
  } catch {
    res = null;
  }
  const swVer = res?.swVersion || "";
  if (swVer && swVer === panelVer) {
    try {
      await chrome.storage.local.remove("vdmSwHealAt");
    } catch {
      /* ignore */
    }
    return true;
  }

  let lastHeal = 0;
  try {
    const obj = await chrome.storage.local.get("vdmSwHealAt");
    lastHeal = Number(obj?.vdmSwHealAt || 0);
  } catch {
    /* ignore */
  }
  const now = Date.now();
  if (now - lastHeal > 20000) {
    try {
      await chrome.storage.local.set({ vdmSwHealAt: now });
    } catch {
      /* ignore */
    }
    showToast(
      `偵測到背景版本不一致（面板 v${panelVer}，背景 v${swVer || "未知/舊版"}），` +
        "正在自動重啟擴充修復…完成後請重開本面板。",
      "info"
    );
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch {
        /* ignore */
      }
    }, 1200);
  } else {
    showToast(
      `背景版本仍不一致（面板 v${panelVer}，背景 v${swVer || "未知/舊版"}）。` +
        "自動修復未生效，請到 chrome://extensions 對本擴充按「移除」後重新安裝，或完全關閉瀏覽器再開。",
      "error"
    );
  }
  return false;
}

async function api(type, payload = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type,
      tabId: currentTabId,
      pageUrl: currentPageUrl,
      ...payload,
    });
  } catch (e) {
    throw new Error(`連線背景失敗：${e.message || e}`);
  }
  if (!res) throw new Error("背景服務無回應，請到 chrome://extensions/ 重新整理擴充");
  if (res.error) throw new Error(res.error);
  return res;
}

async function refreshContext() {
  if (!isTabView) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id && tab.url && !tab.url.startsWith("chrome-extension")) {
        currentTabId = tab.id;
        currentPageUrl = tab.url;
      }
    } catch {
      /* ignore */
    }
  }
  const res = await api("GET_CURRENT_TAB");
  if (res.tabId) {
    currentTabId = res.tabId;
    currentPageUrl = res.pageUrl || currentPageUrl || "";
  }
  updateSourceTabLabel();
}

async function openInBrowserTab() {
  openInBrowserTabNow();
}

function buildTabViewUrl(tabId, mode = "download") {
  const params = new URLSearchParams({ view: "tab", mode });
  if (tabId) params.set("tabId", String(tabId));
  return `${chrome.runtime.getURL("sidepanel/panel.html")}?${params}`;
}

function openInBrowserTabNow() {
  chrome.runtime.sendMessage({ type: "OPEN_MANAGER_TAB", mode: "download" }, (res) => {
    const err = chrome.runtime.lastError;
    if (err) {
      showToast(err.message || "無法開啟分頁", "error");
      return;
    }
    if (res?.error) {
      showToast(res.error, "error");
      return;
    }
    if (!isTabView) window.close();
  });
}

function updateSourceTabLabel() {
  if (!isTabView) return;
  const el = $("#sourceTabLabel");
  if (!el) return;
  if (!currentPageUrl) {
    el.textContent = "監視分頁：尚未連結（請點「改用最近分頁」）";
    return;
  }
  try {
    const u = new URL(currentPageUrl);
    const path = u.pathname.length > 36 ? `${u.pathname.slice(0, 36)}…` : u.pathname;
    el.textContent = `監視分頁：${u.hostname}${path}`;
  } catch {
    el.textContent = `監視分頁：${currentPageUrl.slice(0, 72)}`;
  }
}

async function loadVideos() {
  try {
    await refreshContext();
    if (!currentTabId) {
      videos = [];
      renderDetected();
      scheduleUpdateGroupDownloadBtn();
      return;
    }
    const res = await api("GET_VIDEOS");
    videos = res.videos || [];
    if (res.tabId) currentTabId = res.tabId;
    if (res.pageUrl) currentPageUrl = res.pageUrl;
    selected.clear();
    selectHighestQuality();
    renderDetected();
    scheduleUpdateGroupDownloadBtn();
  } catch (err) {
    videos = [];
    renderDetected();
    scheduleUpdateGroupDownloadBtn();
    throw err;
  }
}

let loadGroupInfoTimer = null;
function scheduleUpdateGroupDownloadBtn() {
  if (loadGroupInfoTimer) return;
  loadGroupInfoTimer = setTimeout(async () => {
    loadGroupInfoTimer = null;
    await updateGroupDownloadBtn();
  }, 450);
}

async function updateGroupDownloadBtn() {
  const btn = $("#groupDownloadBtn");
  if (!btn) return;
  try {
    const res = await api("GET_TAB_GROUP_INFO");
    if (res.inGroup && res.downloadable > 0) {
      btn.hidden = false;
      btn.textContent = `群組下載（${res.downloadable} 個最高畫質）`;
    } else {
      btn.hidden = true;
    }
  } catch {
    btn.hidden = true;
  }
}

function selectHighestQuality() {
  if (!videos.length) return;
  let best = videos[0];
  for (const v of videos) {
    const vq = v.quality || 0;
    const bq = best.quality || 0;
    if (vq > bq || (vq === bq && (v.size || 0) > (best.size || 0))) best = v;
  }
  selected.add(best.id);
}

async function loadCompleted() {
  const res = await api("GET_COMPLETED_TASKS");
  renderCompleted(res.tasks || []);
}

async function loadTasks() {
  const res = await api("GET_ACTIVE_TASKS");
  const tasks = res.tasks || [];
  if (res.stats) activeTaskStats = res.stats;
  tasks.forEach((t) => taskMap.set(t.id, t));
  renderActive(tasks);
}

function updateActiveTaskCount(activeLen) {
  const el = $("#activeTaskCount");
  if (!el) return;
  const total = activeLen ?? activeTaskStats.total ?? 0;
  const running = activeTaskStats.running ?? 0;
  const queued = activeTaskStats.queued ?? 0;
  if (total <= 0) {
    el.textContent = "0 個任務";
    return;
  }
  const parts = [`共 ${total} 個任務`];
  if (running > 0 || queued > 0) {
    parts.push(`執行 ${running}`);
    if (queued > 0) parts.push(`排隊 ${queued}`);
  }
  el.textContent = parts.join(" · ");
}

async function loadLogs() {
  const res = await api("GET_LOGS");
  renderLogs(res.logs || []);
}

function renderDetected() {
  const list = $("#detectedList");
  const empty = $("#detectedEmpty");
  const footer = $("#downloadFooter");
  $("#detectedCount").textContent = `${videos.length} 個`;

  list.innerHTML = "";
  if (!videos.length) {
    empty.style.display = "block";
    footer.style.display = "none";
    if (!currentTabId) {
      empty.innerHTML =
        "無法連結影片分頁。<br />請先切到影片分頁再開啟此面板，或點「改用最近分頁」。";
    } else {
      empty.innerHTML =
        "尚未偵測到可下載影片。<br />請先播放影片；若剛更新擴充，請重新整理影片分頁後再試。";
    }
    return;
  }
  empty.style.display = "none";
  footer.style.display = "block";
  $("#selectAll").checked = selected.size === videos.length;

  for (const v of videos) {
    const { name, meta } = formatVideoLabel(v);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <label>
        <input type="checkbox" data-id="${v.id}" ${selected.has(v.id) ? "checked" : ""} />
        <div>
          <div class="title">${escapeHtml(name)}</div>
          <div class="meta">${escapeHtml(meta)}</div>
        </div>
      </label>`;
    card.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selected.add(v.id);
      else selected.delete(v.id);
      $("#selectAll").checked = selected.size === videos.length;
    });
    list.appendChild(card);
  }
}

function taskDisplayName(t) {
  return (t.fileName || "").replace(/\.mp4$/i, "") || t.video?.title || "video";
}

/** HLS 各並行車道進度列（依 maxConnections 分段） */
function renderHlsLaneRows(t, isHls) {
  if (!isHls || !t.hlsLanes?.length || t.hlsLanes.length <= 1) return "";
  const rows = t.hlsLanes.map((lane) => {
    const inflight = lane.fetched || 0;
    const saved = lane.saved || 0;
    const show = segmentsOnlyMode ? Math.max(saved, inflight) : inflight;
    const lp = segmentProgressPct(show, lane.total);
    const label = segmentsOnlyMode
      ? `下載 ${inflight}/${lane.total} · 存 ${saved}/${lane.total}`
      : `${show}/${lane.total}`;
    return `
      <div class="progress-row lane-row">
        <span class="progress-tag">#${lane.index}</span>
        <div class="progress-wrap"><div class="progress-bar lane" style="width:${lp}%"></div></div>
        <span class="progress-pct lane-pct">${escapeHtml(label)}</span>
      </div>`;
  });
  return `<div class="lane-progress-block">${rows.join("")}</div>`;
}

function updateActiveToolbar(active) {
  const toolbar = $("#activeToolbar");
  const bulkBar = $("#activeBulkBar");
  if (!toolbar || !bulkBar) return;
  const ids = new Set(active.map((t) => t.id));
  for (const id of [...selectedTasks]) {
    if (!ids.has(id)) selectedTasks.delete(id);
  }
  const hasActive = active.length > 0;
  toolbar.hidden = !hasActive;
  bulkBar.hidden = selectedTasks.size === 0;
  const selectAllTasks = $("#selectAllTasks");
  if (selectAllTasks) {
    selectAllTasks.checked = hasActive && selectedTasks.size === active.length;
  }
  const countEl = $("#activeSelectedCount");
  if (countEl) {
    countEl.textContent =
      selectedTasks.size > 0 ? `已選 ${selectedTasks.size} 個` : `${active.length} 個`;
  }
}

function renderActive(tasks) {
  const list = $("#activeList");
  const empty = $("#activeEmpty");
  list.innerHTML = "";

  const active = tasks.filter((t) =>
    ["pending", "downloading", "merging", "paused", "failed"].includes(t.status)
  );

  if (!active.length) {
    empty.style.display = "block";
    updateActiveTaskCount(0);
    updateActiveToolbar([]);
    return;
  }
  empty.style.display = "none";
  updateActiveTaskCount(active.length);
  updateActiveToolbar(active);

  const statusOrder = { downloading: 0, merging: 1, pending: 2, paused: 3, failed: 4 };
  active.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  for (const t of active) {
    const name = taskDisplayName(t);
    const isHls = t.video?.isM3u8 || /\.m3u8/i.test(t.video?.url || "");
    const dlPct =
      isHls && t.total
        ? segmentProgressPct(
            segmentsOnlyMode
              ? Math.max(t.downloaded || 0, t.fetched || 0)
              : t.downloaded || 0,
            t.total
          )
        : Math.max(0, Math.min(100, Math.floor(t.downloadProgress ?? t.progress ?? 0)));
    const mgPct =
      isHls && t.total && !segmentsOnlyMode
        ? segmentProgressPct(t.merged || 0, t.total)
        : Math.max(0, Math.min(100, Math.floor(t.mergeProgress ?? 0)));
    const pct = isHls ? dlPct : Math.max(0, Math.min(100, Math.floor(t.progress || 0)));

    let sizeText;
    if (t.total && isHls) {
      const saved = t.downloaded || 0;
      const inflight = t.fetched || saved;
      sizeText = segmentsOnlyMode
        ? `整體 存檔 ${saved}/${t.total} · 下載 ${inflight}/${t.total}  ·  ${formatSpeed(t.status === "paused" ? 0 : t.speed)}`
        : `整體 ${saved}/${t.total}  ·  ${formatSpeed(t.status === "paused" ? 0 : t.speed)}`;
    } else if (t.total) {
      sizeText = `${formatSize(t.downloaded)} / ${formatSize(t.total)}  ·  ${formatSpeed(t.speed)}`;
    } else {
      sizeText = `${formatSize(t.downloaded)}  ·  ${formatSpeed(t.speed)}`;
    }

    const progressHtml = isHls && !segmentsOnlyMode
      ? `
      <div class="progress-row">
        <span class="progress-tag">下載</span>
        <div class="progress-wrap"><div class="progress-bar dl" style="width:${dlPct}%"></div></div>
        <span class="progress-pct">${dlPct}%</span>
      </div>
      <div class="progress-row merge-row">
        <span class="progress-tag">合併</span>
        <div class="progress-wrap"><div class="progress-bar merge" style="width:${mgPct}%"></div></div>
        <span class="progress-pct">${mgPct}%</span>
      </div>`
      : isHls
      ? `
      <div class="progress-row">
        <span class="progress-tag">片段</span>
        <div class="progress-wrap"><div class="progress-bar dl" style="width:${dlPct}%"></div></div>
        <span class="progress-pct">${dlPct}%</span>
      </div>`
      : `
      <div class="progress-row">
        <span class="progress-tag">進度</span>
        <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
        <span class="progress-pct">${pct}%</span>
      </div>`;

    const laneHtml = renderHlsLaneRows(t, isHls);

    const card = document.createElement("div");
    const statusCls = taskStatusClass(t.status);
    card.className = `card task-card ${statusCls}${t.status === "failed" ? " failed" : ""}`;
    card.dataset.taskId = t.id;
    card.dataset.status = t.status;
    card.innerHTML = `
      <label class="task-select">
        <input type="checkbox" data-task-id="${t.id}" ${selectedTasks.has(t.id) ? "checked" : ""} />
        <div class="title">${escapeHtml(name)}</div>
      </label>
      ${progressHtml}
      ${laneHtml}
      <div class="meta">
        <span class="status-badge badge-${t.status}">${escapeHtml(statusText(t.status))}</span>
        <span class="meta-detail">${escapeHtml(sizeText)}</span>
      </div>
      ${(() => {
        let act = t.activity || "";
        if (t._autoRetryAt) {
          const secs = Math.max(0, Math.ceil((t._autoRetryAt - Date.now()) / 1000));
          if (secs > 0 && !act.includes("自動繼續")) {
            act = act ? `${act}（${secs} 秒後自動繼續）` : `${secs} 秒後自動繼續…`;
          }
        }
        return act ? `<div class="task-activity">${escapeHtml(act)}</div>` : "";
      })()}
      <div class="actions">
        <button type="button" class="btn btn-pause pause" data-id="${t.id}">暫停</button>
        <button type="button" class="btn btn-resume resume" data-id="${t.id}">繼續</button>
        <button type="button" class="btn btn-retry retry" data-id="${t.id}">從頭下載</button>
        <button type="button" class="btn btn-cancel cancel" data-id="${t.id}">中斷</button>
      </div>`;

    const paused = t.status === "paused";
    const canRestart = paused || t.status === "failed";
    const pausable = !paused && ["pending", "downloading", "merging"].includes(t.status);
    const pauseBtn = card.querySelector(".pause");
    const resumeBtn = card.querySelector(".resume");
    pauseBtn.hidden = !pausable;
    resumeBtn.hidden = !paused;
    card.querySelector(".retry").disabled = !canRestart;
    card.querySelector(".cancel").disabled = !["pending", "downloading", "merging", "paused", "failed"].includes(t.status);

    pauseBtn.onclick = () => runTaskAction("PAUSE_TASK", t.id);
    resumeBtn.onclick = () => runTaskAction("RESUME_TASK", t.id);
    card.querySelector(".retry").onclick = () =>
      api("RETRY_TASK", { taskId: t.id })
        .then(loadTasks)
        .catch((e) => showToast(e.message || String(e), "error"));
    card.querySelector(".cancel").onclick = () => runTaskAction("CANCEL_TASK", t.id);

    const taskCheckbox = card.querySelector(".task-select input");
    if (taskCheckbox) {
      taskCheckbox.addEventListener("change", (e) => {
        const id = e.target.dataset.taskId;
        if (e.target.checked) selectedTasks.add(id);
        else selectedTasks.delete(id);
        updateActiveToolbar(active);
      });
    }

    if (t.error && t.error !== t.activity) {
      const err = document.createElement("div");
      err.className = "meta error";
      if (t._autoRetryAt) {
        const secsLeft = Math.max(0, Math.ceil((t._autoRetryAt - Date.now()) / 1000));
        err.textContent = `${t.error}（${secsLeft} 秒後自動重試）`;
      } else {
        err.textContent = t.error;
      }
      card.appendChild(err);
    }

    list.appendChild(card);
  }
}

function renderCompleted(tasks) {
  const list = $("#completedList");
  const empty = $("#completedEmpty");
  list.innerHTML = "";
  $("#completedCount").textContent = `${tasks.length} 個`;

  if (!tasks.length) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  for (const t of tasks) {
    const name = (t.fileName || "").replace(/\.mp4$/i, "") || "video";
    const q = t.quality > 0 ? qualityLabel(t.quality) : "";
    const card = document.createElement("div");
    card.className = "card completed-card";
    card.innerHTML = `
      <div class="title">${escapeHtml(name)}.mp4</div>
      <div class="meta">${escapeHtml(formatTime(t.completedAt))}${q ? `  ·  ${escapeHtml(q)}` : ""}</div>`;
    list.appendChild(card);
  }
}

function renderLogs(logs) {
  const list = $("#logList");
  const empty = $("#logEmpty");
  list.innerHTML = "";
  if (!logs.length) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  for (const item of logs) {
    const div = document.createElement("div");
    div.className = `log-item ${item.level || "info"}`;
    div.innerHTML = `<time>${formatTime(item.time)}</time>${escapeHtml(item.message)}${item.detail ? `<br><span style="color:#888">${escapeHtml(item.detail)}</span>` : ""}`;
    list.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function switchTab(name) {
  if (activeTabName === "settings" && name !== "settings") {
    flushSaveSettings().catch(() => {});
  }
  activeTabName = name;
  dlRoot.querySelectorAll(".tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === name);
  });
  dlRoot.querySelectorAll(".panel").forEach((el) => {
    el.classList.toggle("active", el.id === `panel-${name}`);
  });
  hideToast();
  if (name === "active") loadTasks();
  else if (name === "completed") loadCompleted();
  else if (name === "log") loadLogs();
  else if (name === "settings") loadSettings();
  else loadVideos();
}

let segmentsOnlyMode = true;
let fsaDirLabel = "";

function updateFsaPathPreview() {
  const sub = ($("#downloadSubfolder")?.value ?? "").trim();
  const el = $("#fsaPathPreview");
  if (!el) return;
  if (!fsaDirLabel) {
    el.textContent = "完整路徑範例：（請先選擇資料夾）/子路徑/任務名/00000.ts";
    return;
  }
  const subPart = sub ? `${sub}/` : "";
  el.textContent = sub
    ? `完整路徑：${fsaDirLabel}/${subPart}任務名/00000.ts`
    : `完整路徑：${fsaDirLabel}/任務名/00000.ts（子路徑留空）`;
}

async function loadOpfsCacheInfo() {
  const el = $("#opfsCacheInfo");
  if (!el) return;
  try {
    const res = await api("GET_OPFS_CACHE_INFO");
    if (!res.tasks) {
      el.textContent = "內部暫存：無殘留";
      return;
    }
    el.textContent = `內部暫存：${res.tasks} 個舊任務目錄（可能在 C 槽）`;
  } catch {
    el.textContent = "";
  }
}

async function loadSettings() {
  loadFsaStatus().catch(() => {});
  loadOpfsCacheInfo().catch(() => {});
  const res = await api("GET_SETTINGS");
  segmentsOnlyMode = res.segmentsOnly !== false;
  const tasksVal = res.maxConcurrentTasks || 2;
  $("#maxConcurrentTasks").value = tasksVal;
  const val = res.maxConnections || 3;
  $("#maxConnections").value = val;
  $("#useDiskCache").checked = res.useDiskCache !== false;
  $("#openInTab").checked = !!res.openInTab;
  $("#downloadSubfolder").value = res.downloadSubfolder ?? "";
  $("#segmentCacheDir").value = res.segmentCacheDir || "vdm-cache";
  updateFsaPathPreview();
}

function applySettingsToForm(res) {
  if (res.maxConcurrentTasks != null) {
    $("#maxConcurrentTasks").value = res.maxConcurrentTasks;
  }
  if (res.maxConnections != null) {
    $("#maxConnections").value = res.maxConnections;
  }
  if (res.downloadSubfolder != null) {
    $("#downloadSubfolder").value = res.downloadSubfolder;
  }
  if (res.useDiskCache != null) {
    $("#useDiskCache").checked = res.useDiskCache !== false;
  }
  if (res.openInTab != null) {
    $("#openInTab").checked = !!res.openInTab;
  }
  if (res.segmentCacheDir != null) {
    $("#segmentCacheDir").value = res.segmentCacheDir;
  }
}

function collectSettings() {
  return {
    maxConcurrentTasks: Number($("#maxConcurrentTasks").value),
    maxConnections: Number($("#maxConnections").value),
    useDiskCache: $("#useDiskCache").checked,
    openInTab: $("#openInTab").checked,
    downloadSubfolder: $("#downloadSubfolder").value.trim(),
    segmentCacheDir: $("#segmentCacheDir").value.trim(),
  };
}

let settingsTimer = null;
let settingsSavePromise = null;

async function flushSaveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = null;
  if (settingsSavePromise) return settingsSavePromise;
  const s = collectSettings();
  settingsSavePromise = api("SET_SETTINGS", s)
    .then((res) => {
      applySettingsToForm(res);
      return res;
    })
    .finally(() => {
      settingsSavePromise = null;
    });
  return settingsSavePromise;
}

function scheduleSaveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    flushSaveSettings().catch(() => {});
  }, 200);
}

if (dlRoot) {
  dlRoot.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

$("#selectAll")?.addEventListener("change", (e) => {
  selected.clear();
  if (e.target.checked) videos.forEach((v) => selected.add(v.id));
  renderDetected();
});

$("#selectAllTasks")?.addEventListener("change", (e) => {
  selectedTasks.clear();
  if (e.target.checked) {
    for (const t of taskMap.values()) {
      if (["pending", "downloading", "merging", "paused", "failed"].includes(t.status)) {
        selectedTasks.add(t.id);
      }
    }
  }
  loadTasks();
});

async function runBulkTaskAction(action) {
  const taskIds = [...selectedTasks];
  if (!taskIds.length) return;
  try {
    const res = await api("BULK_TASK_ACTION", { action, taskIds });
    if (res.error) throw new Error(res.error);
    if (action === "cancel") {
      taskIds.forEach((id) => selectedTasks.delete(id));
    }
    showToast(`已對 ${res.count} 個任務執行操作`, "info");
    await loadTasks();
  } catch (err) {
    showToast(err.message || "批量操作失敗", "error");
  }
}

$("#bulkPauseBtn")?.addEventListener("click", () => runBulkTaskAction("pause"));
$("#bulkResumeBtn")?.addEventListener("click", () => runBulkTaskAction("resume"));
$("#bulkRetryBtn")?.addEventListener("click", () => runBulkTaskAction("retry"));
$("#bulkCancelBtn")?.addEventListener("click", () => runBulkTaskAction("cancel"));

$("#exportTasksBtn")?.addEventListener("click", async () => {
  try {
    const res = await api("EXPORT_ACTIVE_TASKS");
    const json = JSON.stringify(res.data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `vdm-tasks-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已導出 ${res.data?.tasks?.length || 0} 個任務`, "info");
  } catch (err) {
    showToast(err.message || "導出失敗", "error");
  }
});

$("#importTasksFile")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const tasks = Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data) ? data : [];
    if (!tasks.length) throw new Error("匯入檔沒有任務");
    const choice = await showImportSegmentDialog(tasks.length);
    if (!choice) return;
    const res = await api("IMPORT_ACTIVE_TASKS", {
      data: {
        ...data,
        _importOpts: {
          segmentPathMode: choice.segmentPathMode,
          customSubfolder: choice.customSubfolder,
          importFsaKey: choice.importFsaKey,
          importFsaLabel: choice.importFsaLabel,
        },
      },
      segmentPathMode: choice.segmentPathMode,
      customSubfolder: choice.customSubfolder,
      importFsaKey: choice.importFsaKey,
      importFsaLabel: choice.importFsaLabel,
    });
    if (res.error) throw new Error(res.error);
    const panelVer = chrome.runtime.getManifest().version;
    console.log("[VDM:panel] 導入結果", res, "panel版本=", panelVer);
    // 版本錯位偵測：送了指定資料夾，但背景沒認得 → 擴充新舊腳本不一致
    if (choice.importFsaKey && !res.importFsaKey) {
      throw new Error(
        `擴充背景版本不一致（面板 v${panelVer}，背景 v${res.swVersion || "未知"}），未套用指定資料夾。` +
        "請到 chrome://extensions 對本擴充按「重新載入」，或完全關閉程式與瀏覽器後重啟，再重試導入。"
      );
    }
    const pathHint = res.importFsaKey
      ? `${choice.importFsaLabel || "指定資料夾"}`
      : res.segmentSubfolder || "根目錄";
    const counts = `新增 ${res.added ?? res.imported}${res.updated ? `、更新 ${res.updated}` : ""}`;
    showToast(`已導入（${counts}）→ ${pathHint}（背景 v${res.swVersion || "?"}）`, "info");
    await loadTasks();
  } catch (err) {
    showToast(err.message || "導入失敗", "error");
  }
});

let importSegmentContext = null;

function formatImportSegmentPreview(fsaName, subfolder) {
  const root = fsaName || "（請先在設定選擇片段存檔資料夾）";
  const sub = String(subfolder || "").trim();
  if (!sub) return `${root}/任務名/00000.ts`;
  return `${root}/${sub}/任務名/00000.ts`;
}

function updateImportSegmentPreviews() {
  if (!importSegmentContext) return;
  const { fsaName, defaultSubfolder } = importSegmentContext;
  const defaultPreview = document.getElementById("importDefaultPathPreview");
  const customPreview = document.getElementById("importCustomPathPreview");
  const customInput = document.getElementById("importCustomSubfolder");
  if (defaultPreview) {
    defaultPreview.textContent = formatImportSegmentPreview(fsaName, defaultSubfolder);
  }
  if (customPreview && customInput) {
    if (customInput.dataset.importFsaKey) {
      const label = customInput.dataset.importFsaLabel || customInput.value.trim() || "指定資料夾";
      customPreview.textContent = `${label}/任務名/00000.ts（直接寫入所選資料夾）`;
    } else {
      customPreview.textContent = formatImportSegmentPreview(fsaName, customInput.value.trim());
    }
  }
}

async function _fsaIsSameEntry(a, b) {
  if (!a || !b) return false;
  if (typeof a.isSameEntry === "function") {
    try {
      return await a.isSameEntry(b);
    } catch {
      return false;
    }
  }
  return a === b;
}

async function _fsaFindDirParts(current, target, stack, depth) {
  if (depth > 12) return null;
  if (await _fsaIsSameEntry(current, target)) return stack;
  for await (const [name, entry] of current.entries()) {
    if (entry.kind !== "directory") continue;
    const found = await _fsaFindDirParts(entry, target, [...stack, name], depth + 1);
    if (found) return found;
  }
  return null;
}

async function _fsaRelativeSubfolder(root, picked) {
  if (!root || !picked) return null;
  const parts = await _fsaFindDirParts(root, picked, [], 0);
  return parts === null ? null : parts.join("/");
}

function looksLikeAbsolutePath(text) {
  const s = String(text || "").trim();
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("/");
}

async function _fsaGetImportHandle(key) {
  if (!key) return null;
  const db = await _fsaOpenDb();
  return new Promise((resolve) => {
    const tx = db.transaction("handles", "readonly");
    const req = tx.objectStore("handles").get(`import:${key}`);
    req.onsuccess = () => { resolve(req.result || null); db.close(); };
    req.onerror = () => { resolve(null); db.close(); };
  });
}

async function pickImportSubfolder(customInput, overlay) {
  const root = await _fsaGetHandle();
  const pickerOpts = { mode: "readwrite" };
  if (root) pickerOpts.startIn = root;
  const picked = await window.showDirectoryPicker(pickerOpts);
  let perm = await picked.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") perm = await picked.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") throw new Error("未取得資料夾寫入權限");

  const batchKey = `import-${crypto.randomUUID()}`;
  // 寫入瀏覽器同源共享 IndexedDB（與「設定資料夾」同一套機制，offscreen 寫檔時讀得到）
  await _fsaSetImportHandle(batchKey, picked);

  // 存進去後立刻讀回來驗證，確認真的存得到、能寫
  const readback = await _fsaGetImportHandle(batchKey);
  if (!readback) throw new Error("資料夾授權儲存失敗，請重試");
  const rbPerm = await readback.queryPermission({ mode: "readwrite" });
  if (rbPerm !== "granted") throw new Error("資料夾讀回後無寫入權限，請重新選擇並授權");

  const customRadio = overlay.querySelector('input[name="importSegmentPathMode"][value="custom"]');
  if (customRadio) customRadio.checked = true;
  customInput.disabled = false;
  const pickBtn = document.getElementById("importPickSubfolder");
  if (pickBtn) pickBtn.disabled = false;
  customInput.dataset.importFsaKey = batchKey;
  customInput.dataset.importFsaLabel = picked.name;
  customInput.value = picked.name;
  delete customInput.dataset.relativeSubfolder;
  updateImportSegmentPreviews();
  showToast(`已選擇：${picked.name}（已驗證可寫入）`, "info");
}

function showImportSegmentDialog(taskCount) {
  return new Promise(async (resolve) => {
    const overlay = document.getElementById("importSegmentModal");
    const summary = document.getElementById("importSegmentSummary");
    const customInput = document.getElementById("importCustomSubfolder");
    const pickBtn = document.getElementById("importPickSubfolder");
    const cancelBtn = document.getElementById("importSegmentCancel");
    const confirmBtn = document.getElementById("importSegmentConfirm");
    const modeRadios = overlay?.querySelectorAll('input[name="importSegmentPathMode"]');
    if (!overlay || !summary || !customInput || !cancelBtn || !confirmBtn || !modeRadios?.length) {
      resolve(null);
      return;
    }

    const [settings, fsa] = await Promise.all([
      api("GET_SETTINGS").catch(() => ({})),
      api("GET_FSA_STATUS").catch(() => ({})),
    ]);
    importSegmentContext = {
      fsaName: fsa?.configured ? fsa.name || "" : "",
      defaultSubfolder: settings.downloadSubfolder ?? "",
    };

    summary.textContent = `本批共 ${taskCount} 個任務，請選擇片段儲存子路徑`;
    customInput.value = "";
    delete customInput.dataset.importFsaKey;
    delete customInput.dataset.importFsaLabel;
    modeRadios.forEach((radio) => {
      radio.checked = radio.value === "default";
    });
    customInput.disabled = true;
    if (pickBtn) pickBtn.disabled = true;
    updateImportSegmentPreviews();

    const onModeChange = () => {
      const mode = overlay.querySelector('input[name="importSegmentPathMode"]:checked')?.value;
      const enabled = mode === "custom";
      customInput.disabled = !enabled;
      if (pickBtn) pickBtn.disabled = !enabled;
      updateImportSegmentPreviews();
    };

    const onPickFolder = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await pickImportSubfolder(customInput, overlay);
      } catch (err) {
        if (err.name !== "AbortError") showToast(err.message || "選擇資料夾失敗", "error");
      }
    };

    const cleanup = (result) => {
      overlay.hidden = true;
      customInput.removeEventListener("input", updateImportSegmentPreviews);
      modeRadios.forEach((radio) => radio.removeEventListener("change", onModeChange));
      pickBtn?.removeEventListener("click", onPickFolder);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      importSegmentContext = null;
      resolve(result);
    };

    const onCancel = () => cleanup(null);
    const onConfirm = () => {
      let mode = overlay.querySelector('input[name="importSegmentPathMode"]:checked')?.value || "default";
      const customPath = customInput.value.trim();
      const importFsaKey = customInput.dataset.importFsaKey || "";
      if (importFsaKey || customPath) mode = "custom";
      if (mode === "custom" && !importFsaKey) {
        if (!customPath) {
          showToast("請輸入子路徑，或點「選擇資料夾」指定磁碟位置", "error");
          return;
        }
        if (looksLikeAbsolutePath(customPath)) {
          showToast("磁碟路徑不能只手打，請點「選擇資料夾」", "error");
          return;
        }
      }
      cleanup({
        segmentPathMode: mode,
        customSubfolder: mode === "custom" && !importFsaKey ? customPath : "",
        importFsaKey,
        importFsaLabel: customInput.dataset.importFsaLabel || customPath,
      });
    };

    customInput.addEventListener("input", updateImportSegmentPreviews);
    modeRadios.forEach((radio) => radio.addEventListener("change", onModeChange));
    pickBtn?.addEventListener("click", onPickFolder);
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);

    overlay.hidden = false;
    customInput.disabled = true;
    if (pickBtn) pickBtn.disabled = true;
  });
}

$("#maxConcurrentTasks").addEventListener("input", () => scheduleSaveSettings());
$("#maxConcurrentTasks").addEventListener("change", () => flushSaveSettings().catch(() => {}));
$("#maxConnections").addEventListener("input", () => scheduleSaveSettings());
$("#maxConnections").addEventListener("change", () => flushSaveSettings().catch(() => {}));

window.addEventListener("pagehide", () => {
  if (activeTabName !== "settings") return;
  clearTimeout(settingsTimer);
  settingsTimer = null;
  const s = collectSettings();
  chrome.runtime.sendMessage({ type: "SET_SETTINGS", ...s });
});

$("#useDiskCache").addEventListener("change", scheduleSaveSettings);
$("#openInTab").addEventListener("change", async (e) => {
  scheduleSaveSettings();
  if (e.target.checked && !isTabView) {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
      settingsTimer = null;
      try {
        await openInBrowserTab();
      } catch (err) {
        showToast(err.message || "無法開啟分頁", "error");
      }
    }, 450);
  }
});
$("#downloadSubfolder").addEventListener("input", () => {
  updateFsaPathPreview();
  scheduleSaveSettings();
});
$("#segmentCacheDir").addEventListener("input", scheduleSaveSettings);

$("#clearOpfsCache")?.addEventListener("click", async () => {
  if (!confirm("確定清除 Chrome 內部 OPFS 暫存？\n\n這會刪除舊版合併模式留下的片段/暫存，不影響你已存到本機資料夾的 .ts 檔。")) return;
  try {
    const res = await api("CLEAR_OPFS_CACHE");
    showToast(`已清除 ${res.removed || 0} 個內部暫存目錄`, "info");
    loadOpfsCacheInfo().catch(() => {});
  } catch (err) {
    showToast(err.message || "清除失敗", "error");
  }
});

/* ── FSA 直接存檔資料夾 ── */
const FSA_DB = "vdm-fsa";

function _fsaOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FSA_DB, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore("handles");
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}
async function _fsaGetHandle() {
  const db = await _fsaOpenDb();
  return new Promise((resolve) => {
    const tx = db.transaction("handles", "readonly");
    const req = tx.objectStore("handles").get("saveDir");
    req.onsuccess = () => { resolve(req.result || null); db.close(); };
    req.onerror = () => { resolve(null); db.close(); };
  });
}
async function _fsaSetHandle(handle) {
  const db = await _fsaOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, "saveDir");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = (e) => { db.close(); reject(e.target.error); };
  });
}
async function _fsaSetImportHandle(key, handle) {
  if (!key || !handle) throw new Error("缺少導入資料夾");
  const db = await _fsaOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, `import:${key}`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = (e) => { db.close(); reject(e.target.error); };
  });
}
async function _fsaClearHandle() {
  const db = await _fsaOpenDb();
  return new Promise((resolve) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").delete("saveDir");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); resolve(); };
  });
}

async function loadFsaStatus() {
  try {
    const handle = await _fsaGetHandle();
    const nameEl = $("#fsaDirName");
    const clearBtn = $("#clearFsaDir");
    const pickBtn = $("#pickFsaDir");
    const reauthBtn = $("#reauthFsaDir");
    const reauthHint = $("#fsaReauthHint");
    if (!handle) {
      fsaDirLabel = "";
      nameEl.textContent = "未設定（HLS 無法下載）";
      nameEl.style.color = "#c62828";
      clearBtn.hidden = true;
      reauthBtn.hidden = true;
      pickBtn.hidden = false;
      pickBtn.textContent = "選擇資料夾";
      reauthHint.hidden = true;
      updateFsaPathPreview();
      return;
    }
    fsaDirLabel = handle.name;
    let perm = "unknown";
    try { perm = await handle.queryPermission({ mode: "readwrite" }); } catch { perm = "denied"; }
    clearBtn.hidden = false;
    if (perm === "granted") {
      nameEl.textContent = `✅ ${handle.name}`;
      nameEl.style.color = "#7fff9a";
      reauthBtn.hidden = true;
      pickBtn.hidden = false;
      pickBtn.textContent = "更換資料夾";
      reauthHint.hidden = true;
    } else {
      nameEl.textContent = `⚠ ${handle.name}（需重新授權）`;
      nameEl.style.color = "#ffcc44";
      reauthBtn.hidden = false;
      pickBtn.hidden = false;
      pickBtn.textContent = "更換資料夾";
      reauthHint.hidden = false;
    }
    updateFsaPathPreview();
  } catch {
    $("#fsaDirName").textContent = "讀取失敗";
  }
}

async function reauthFsaDir() {
  const handle = await _fsaGetHandle();
  if (!handle) {
    showToast("請先選擇資料夾", "error");
    return;
  }
  const perm = await handle.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") throw new Error("未取得資料夾寫入權限");
  await loadFsaStatus();
  showToast(`已重新授權：${handle.name}`, "info");
}

$("#reauthFsaDir")?.addEventListener("click", async () => {
  try {
    await reauthFsaDir();
  } catch (err) {
    showToast(err.message || "重新授權失敗", "error");
  }
});

$("#pickFsaDir").addEventListener("click", async () => {
  try {
    const existing = await _fsaGetHandle();
    if (existing) {
      const current = await existing.queryPermission({ mode: "readwrite" });
      if (current !== "granted") {
        const perm = await existing.requestPermission({ mode: "readwrite" });
        if (perm === "granted") {
          await loadFsaStatus();
          showToast(`已重新授權：${existing.name}`, "info");
          return;
        }
      }
    }
    const handle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "downloads" });
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") throw new Error("未取得資料夾寫入權限");
    await _fsaSetHandle(handle);
    await loadFsaStatus();
    showToast(`已設定直接存檔資料夾：${handle.name}`, "info");
  } catch (err) {
    if (err.name !== "AbortError") showToast(err.message || "選擇資料夾失敗", "error");
  }
});

$("#clearFsaDir").addEventListener("click", async () => {
  await _fsaClearHandle();
  await loadFsaStatus();
  showToast("已清除直接存檔資料夾；大型影片下載可能因 Chrome 記憶體不足而閃退", "info");
});

$("#openCacheInfo").addEventListener("click", () => {
  showToast(
    "片段暫存位於瀏覽器內部（OPFS），檔案總管無法開啟。完成後請到「完成檔路徑」找影片。",
    "info"
  );
});

$("#openInTabNow").addEventListener("click", async () => {
  try {
    if (isTabView) {
      await loadVideos();
      await loadTasks();
      showToast("已重新整理", "info");
      return;
    }
    await openInBrowserTab();
  } catch (err) {
    showToast(err.message || "無法開啟分頁", "error");
  }
});

$("#linkRecentTab")?.addEventListener("click", async () => {
  try {
    const res = await api("USE_RECENT_TAB");
    currentTabId = res.tabId;
    currentPageUrl = res.pageUrl || "";
    updateSourceTabLabel();
    await loadVideos();
    showToast("已切換監視分頁", "info");
  } catch (err) {
    showToast(err.message || "無法切換分頁", "error");
  }
});

$("#copyLogBtn")?.addEventListener("click", async () => {
  try {
    const res = await api("GET_LOGS");
    const lines = (res.logs || []).map((item) => {
      const t = new Date(item.time).toLocaleString("zh-TW");
      return `[${t}] [${(item.level || "info").toUpperCase()}] ${item.message}${item.detail ? "\n  " + item.detail : ""}`;
    });
    await navigator.clipboard.writeText(lines.join("\n") || "(日誌為空)");
    showToast("日誌已複製到剪貼簿", "info");
  } catch (err) {
    showToast(err.message || "複製失敗", "error");
  }
});

$("#clearLogBtn").addEventListener("click", async () => {
  await api("CLEAR_LOGS");
  renderLogs([]);
});

$("#clearCompletedBtn").addEventListener("click", async () => {
  await api("CLEAR_COMPLETED");
  renderCompleted([]);
});

$("#downloadBtn").addEventListener("click", async (e) => {
  e.preventDefault();
  const ids = [...selected];
  if (!ids.length) return;
  const btn = $("#downloadBtn");
  btn.disabled = true;
  btn.textContent = "加入中…";
  hideToast();
  try {
    await refreshContext();
    const res = await api("START_DOWNLOADS", { videoIds: ids });
    if (!res.tasks?.length) throw new Error("無法開始下載（背景未建立任務）");
    showToast(`已加入 ${res.tasks.length} 個下載，請看「進行中」`, "info");
    switchTab("active");
    await loadTasks();
    await loadLogs();
  } catch (err) {
    const msg = err.message || "下載失敗";
    showToast(msg, "error");
    switchTab("log");
    await loadLogs();
  } finally {
    btn.disabled = false;
    btn.textContent = "下載選取項目";
  }
});

$("#groupDownloadBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = $("#groupDownloadBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "加入中…";
  hideToast();
  try {
    await refreshContext();
    const res = await api("START_GROUP_DOWNLOADS");
    if (!res.tasks?.length) throw new Error(res.error || "無法開始群組下載");
    showToast(`群組已加入 ${res.tasks.length} 個下載，請看「進行中」`, "info");
    switchTab("active");
    await loadTasks();
    await loadLogs();
  } catch (err) {
    showToast(err.message || "群組下載失敗", "error");
    switchTab("log");
    await loadLogs();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "VIDEOS_UPDATED" && activeTabName === "detected") {
    loadVideos();
  } else if (msg.type === "VIDEOS_UPDATED") {
    scheduleUpdateGroupDownloadBtn();
  }
  if (msg.type === "TASK_UPDATED" || msg.type === "TASK_TICK") {
    if (msg.task) taskMap.set(msg.task.id, msg.task);
    if (activeTabName === "active") scheduleLoadTasks();
    if (msg.task?.status === "completed" && activeTabName === "completed") loadCompleted();
    if (msg.task?.status === "failed" && msg.task?.error) {
      if (!failedToastShown.has(msg.task.id)) {
        failedToastShown.add(msg.task.id);
        showToast(`下載失敗：${msg.task.error}`, "error");
      }
    }
  }
  if (msg.type === "LOG_UPDATED") {
    scheduleLoadLogs();
  }
  if (msg.type === "COMPLETED_UPDATED" && activeTabName === "completed") {
    loadCompleted();
  }
});

(async function init() {
  hideToast();
  // 先確認背景版本一致；若不一致會自動重啟擴充，這裡直接停止後續初始化避免對到舊背景
  try {
    const fresh = await ensureSwFresh();
    if (!fresh) return;
  } catch {
    /* ignore，仍嘗試正常初始化 */
  }
  if (isTabView) {
    $("#openInTabNow").textContent = "重新整理列表";
    const bar = document.getElementById("downloadModeBar");
    if (bar) bar.hidden = true;
  }
  try {
    await loadVideos();
  } catch (err) {
    showToast(err.message || "無法載入可下載列表", "error");
  }
  try {
    await loadTasks();
  } catch (err) {
    showToast(err.message || "無法載入進行中任務", "error");
  }
  try {
    await loadCompleted();
  } catch {
    /* ignore */
  }
  try {
    await loadLogs();
  } catch {
    /* ignore */
  }
  try {
    await loadSettings();
  } catch {
    /* ignore */
  }
  setInterval(() => {
    if (activeTabName === "active") scheduleLoadTasks();
  }, 1500);
})();
