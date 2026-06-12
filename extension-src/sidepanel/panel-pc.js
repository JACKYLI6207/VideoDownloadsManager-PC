let currentTabId = null;
let currentPageUrl = "";
let videos = [];
const selected = new Set();

const $ = (sel) => document.querySelector(sel);

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

function formatVideoLabel(v) {
  const name = v.title || v.url.split("?")[0].split("/").pop() || "video";
  const q = qualityLabel(v.quality);
  const size = formatSize(v.size);
  const dur = formatDuration(v.duration);
  return { name, meta: `解析度 ${q}  ·  容量 ${size}  ·  時長 ${dur}` };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message, level = "error") {
  const el = $("#toast");
  el.hidden = false;
  el.textContent = message;
  el.className = level === "info" ? "toast info" : "toast";
}

function hideToast() {
  $("#toast").hidden = true;
}

async function apiAllowError(type, payload = {}) {
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
  return res;
}

async function api(type, payload = {}) {
  const res = await apiAllowError(type, payload);
  if (res.error) throw new Error(res.error);
  return res;
}

async function refreshContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id && tab.url && !tab.url.startsWith("chrome-extension")) {
      currentTabId = tab.id;
      currentPageUrl = tab.url;
    }
  } catch {
    /* ignore */
  }
  const res = await api("GET_CURRENT_TAB");
  if (res.tabId) {
    currentTabId = res.tabId;
    currentPageUrl = res.pageUrl || currentPageUrl || "";
  }
}

async function loadVideos() {
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
  const groupBtn = $("#groupDownloadBtn");
  const groupCoverBtn = $("#groupCoverDownloadBtn");
  try {
    const res = await api("GET_TAB_GROUP_INFO");
    if (res.inGroup && res.downloadable > 0) {
      if (groupBtn) {
        groupBtn.hidden = false;
        groupBtn.textContent = `群組添加至可下載清單（${res.downloadable} 個最高畫質）`;
      }
      if (groupCoverBtn) {
        groupCoverBtn.hidden = false;
        groupCoverBtn.textContent = `群組下載封面（${res.downloadable} 個）`;
      }
    } else {
      if (groupBtn) groupBtn.hidden = true;
      if (groupCoverBtn) groupCoverBtn.hidden = true;
    }
  } catch {
    if (groupBtn) groupBtn.hidden = true;
    if (groupCoverBtn) groupCoverBtn.hidden = true;
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
        "無法連結影片分頁。<br />請先切到影片分頁再開啟此面板。";
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

$("#selectAll")?.addEventListener("change", (e) => {
  selected.clear();
  if (e.target.checked) videos.forEach((v) => selected.add(v.id));
  renderDetected();
});

function pickBestVideo(list) {
  if (!list?.length) return null;
  let best = list[0];
  for (const v of list) {
    const vq = v.quality || 0;
    const bq = best.quality || 0;
    if (vq > bq || (vq === bq && (v.size || 0) > (best.size || 0))) best = v;
  }
  return best;
}

function stripResolutionFromName(name) {
  return String(name || "")
    .replace(/\s*\(\s*(?:4[Kk]|\d{3,4}[pP])\s*\)\s*$/i, "")
    .replace(/[\s_-]+(?:4[Kk]|\d{3,4}[pP])\s*$/i, "")
    .trim();
}

function sanitizeSaveFilename(name) {
  return String(name || "video").replace(/[<>:"/\\|?*]/g, "_").trim().slice(0, 180) || "video";
}

function buildSaveFilename(pageTitle, pageUrl) {
  let raw = "";
  try {
    if (pageUrl) {
      raw = decodeURIComponent(new URL(pageUrl).pathname.split("/").filter(Boolean).pop() || "");
    }
  } catch {
    /* ignore */
  }
  if (!raw) {
    const title = String(pageTitle || "").trim();
    raw = title.includes("/") ? title.split("/").filter(Boolean).pop() || title : title;
  }
  raw = stripResolutionFromName(raw);
  return sanitizeSaveFilename(String(raw || "video").toUpperCase()) || "VIDEO";
}

async function getDownloadSubfolder() {
  const { vdmSettings = {} } = await chrome.storage.local.get("vdmSettings");
  const sub = String(vdmSettings.downloadSubfolder || "VideoDownloadsManager").trim();
  return sub.replace(/^[/\\]+|[/\\]+$/g, "") || "VideoDownloadsManager";
}

function buildDownloadPath(fileName, subfolder) {
  const sub = String(subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return sub ? `${sub}/${fileName}` : fileName;
}

async function resolvePosterInTab(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return "";
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const abs = (u) => {
          try {
            return new URL(u, location.href).href;
          } catch {
            return "";
          }
        };
        for (const v of document.querySelectorAll("video")) {
          const p = v.poster || v.getAttribute("poster");
          if (p) return abs(p);
        }
        for (const sel of [
          'meta[property="og:image"]',
          'meta[property="og:image:url"]',
          'meta[name="twitter:image"]',
        ]) {
          const el = document.querySelector(sel);
          if (el?.content) return abs(el.content);
        }
        return "";
      },
    });
    return result || "";
  } catch {
    return "";
  }
}

function downloadPosterUrl(url, saveName, subfolder) {
  if (!url || !saveName || !chrome.downloads?.download) return Promise.resolve(false);
  const filename = buildDownloadPath(`${saveName}.jpg`, subfolder);
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      resolve(!chrome.runtime.lastError && !!id);
    });
  });
}

async function downloadCoverItems(items) {
  const subfolder = await getDownloadSubfolder();
  const used = new Set();
  let done = 0;
  for (const { video, tabId, pageUrl, pageTitle } of items) {
    let posterUrl = video?.posterUrl || "";
    if (!posterUrl && tabId) posterUrl = await resolvePosterInTab(tabId);
    if (!posterUrl) continue;
    let saveName = buildSaveFilename(pageTitle, pageUrl);
    if (used.has(saveName)) {
      let n = 2;
      while (used.has(`${saveName}_${n}`)) n++;
      saveName = `${saveName}_${n}`;
    }
    used.add(saveName);
    if (await downloadPosterUrl(posterUrl, saveName, subfolder)) done++;
  }
  return { count: done, total: items.length };
}

async function collectSelectedCoverItems(videoIds) {
  await refreshContext();
  const res = await api("GET_VIDEOS");
  const pageUrl = res.pageUrl || currentPageUrl;
  const tabId = res.tabId || currentTabId;
  let pageTitle = "";
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      pageTitle = tab?.title || "";
    } catch {
      /* ignore */
    }
  }
  const list = (res.videos || videos).filter((v) => videoIds.includes(v.id));
  return list.map((video) => ({ video, tabId, pageUrl, pageTitle }));
}

async function collectGroupItemsFromTabs() {
  await refreshContext();
  const info = await api("GET_TAB_GROUP_INFO");
  if (!info.inGroup || info.groupId == null) throw new Error("目前分頁不在任何群組中");
  const tabs = await chrome.tabs.query({ groupId: info.groupId });
  const items = [];
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith("chrome")) continue;
    const res = await apiAllowError("GET_VIDEOS", { tabId: tab.id, pageUrl: tab.url });
    if (res.error) continue;
    const best = pickBestVideo(res.videos);
    if (!best) continue;
    items.push({
      video: best,
      tabId: tab.id,
      pageUrl: res.pageUrl || tab.url,
      pageTitle: tab.title || "",
    });
  }
  if (!items.length) throw new Error("群組內沒有偵測到可下載影片");
  return items;
}

async function collectGroupCoverItems() {
  return collectGroupItemsFromTabs();
}

async function withButton(btn, busyText, run) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  hideToast();
  try {
    await refreshContext();
    return await run();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$("#downloadBtn").addEventListener("click", async (e) => {
  e.preventDefault();
  const ids = [...selected];
  if (!ids.length) return;
  const btn = $("#downloadBtn");
  try {
    await withButton(btn, "傳送中…", async () => {
      const res = await api("START_DOWNLOADS", { videoIds: ids });
      if (!res.tasks?.length) throw new Error("無法建立任務");
      showToast(`已添加 ${res.tasks.length} 個至 PC 可下載清單`, "info");
    });
  } catch (err) {
    showToast(err.message || "傳送失敗", "error");
  }
});

$("#groupDownloadBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = $("#groupDownloadBtn");
  try {
    await withButton(btn, "傳送中…", async () => {
      const items = await collectGroupItemsFromTabs();
      const res = await api("START_GROUP_DOWNLOADS", { items, resniff: false });
      if (!res.tasks?.length) throw new Error(res.error || "無法開始群組添加");
      showToast(`群組已添加 ${res.tasks.length} 個至 PC 可下載清單`, "info");
    });
  } catch (err) {
    showToast(err.message || "群組添加失敗", "error");
  }
});

$("#coverDownloadBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const ids = [...selected];
  if (!ids.length) return;
  const btn = $("#coverDownloadBtn");
  try {
    await withButton(btn, "下載中…", async () => {
      const items = await collectSelectedCoverItems(ids);
      const { count, total } = await downloadCoverItems(items);
      if (!count) throw new Error("找不到封面或下載失敗");
      showToast(`封面已下載 ${count}/${total} 個`, "info");
    });
  } catch (err) {
    showToast(err.message || "封面下載失敗", "error");
  }
});

$("#groupCoverDownloadBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = $("#groupCoverDownloadBtn");
  try {
    await withButton(btn, "下載中…", async () => {
      const items = await collectGroupCoverItems();
      const { count, total } = await downloadCoverItems(items);
      if (!count) throw new Error("群組內找不到封面或下載失敗");
      showToast(`群組封面已下載 ${count}/${total} 個`, "info");
    });
  } catch (err) {
    showToast(err.message || "群組封面下載失敗", "error");
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "VIDEOS_UPDATED") {
    loadVideos();
  }
});

(async function init() {
  try {
    await loadVideos();
  } catch (err) {
    showToast(err.message || "載入失敗", "error");
  }
})();
