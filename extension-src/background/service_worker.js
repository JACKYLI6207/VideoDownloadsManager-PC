importScripts(
  "../lib/utils.js",
  "../lib/detector.js",
  "../lib/m3u8.js",
  "../lib/videoStore.js",
  "../lib/pcBridge.js",
  "../lib/blobStore.js",
  "../lib/opfsStore.js",
  "../lib/downloadEngine.js"
);

const store = new VDM.VideoStore();
const engine = new VDM.DownloadEngine();
const tabTitles = new Map();
const tabPosterBest = new Map();
const m3u8Pending = new Set();
const DOWNLOAD_HDR_RULE = 9001;

async function loadSettings() {
  const { vdmSettings = {} } = await chrome.storage.local.get("vdmSettings");
  VDM.maxConnections = VDM.clampConnections(vdmSettings.maxConnections);
  VDM.maxConcurrentTasks = VDM.clampConcurrentTasks(vdmSettings.maxConcurrentTasks);
  VDM.useDiskCache = vdmSettings.useDiskCache !== false;
  VDM.openInTab = !!vdmSettings.openInTab;
  VDM.downloadSubfolder = VDM.normalizeDownloadPath(
    vdmSettings.downloadSubfolder ?? "VideoDownloadsManager"
  );
  VDM.segmentCacheDir = String(vdmSettings.segmentCacheDir ?? "vdm-cache").trim() || "vdm-cache";
  if (VDM.isPcMode()) {
    VDM.openInTab = false;
  }
}

const MANAGER_PAGE = VDM.isPcMode() ? "sidepanel/panel-pc.html" : "sidepanel/panel.html";
let lastWebTabId = null;

function isWebTabUrl(url) {
  return (
    url &&
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("edge://")
  );
}

function managerTabUrl(sourceTabId) {
  const params = new URLSearchParams({ view: "tab" });
  if (sourceTabId) params.set("tabId", String(sourceTabId));
  return `${chrome.runtime.getURL(MANAGER_PAGE)}?${params}`;
}

async function setManagerSourceTab(tabId) {
  if (!tabId) return;
  lastWebTabId = tabId;
  await chrome.storage.session.set({ vdmManagerTabId: tabId });
}

async function resolveTargetTabId(preferredTabId) {
  const tryTab = async (tid) => {
    if (!tid || tid < 0) return null;
    try {
      const tab = await chrome.tabs.get(tid);
      if (isWebTabUrl(tab.url)) return { tabId: tid, pageUrl: tab.url };
    } catch {
      /* tab closed */
    }
    return null;
  };

  const finalize = async (hit) => {
    if (hit && hit.tabId !== lastWebTabId) {
      await setManagerSourceTab(hit.tabId);
    }
    return hit;
  };

  let hit = await tryTab(preferredTabId);
  if (hit) return finalize(hit);

  /* 彈出視窗：優先使用者正在看的分頁，避免 session 指到群組內其他空白分頁 */
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  hit = await tryTab(focused?.id);
  if (hit) return finalize(hit);

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  hit = await tryTab(active?.id);
  if (hit) return finalize(hit);

  hit = await tryTab(lastWebTabId);
  if (hit) return finalize(hit);

  const { vdmManagerTabId } = await chrome.storage.session.get("vdmManagerTabId");
  hit = await tryTab(vdmManagerTabId);
  if (hit) return finalize(hit);

  const windowTabs = await chrome.tabs.query({ currentWindow: true });
  for (let i = windowTabs.length - 1; i >= 0; i--) {
    hit = await tryTab(windowTabs[i].id);
    if (hit) return finalize(hit);
  }
  return { tabId: null, pageUrl: "" };
}

async function openManagerTab(sourceTabId) {
  if (sourceTabId) await setManagerSourceTab(sourceTabId);
  const base = chrome.runtime.getURL(MANAGER_PAGE);
  const targetUrl = managerTabUrl(sourceTabId);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url?.startsWith(base) && t.url.includes("view=tab"));
  if (existing) {
    await chrome.tabs.update(existing.id, { url: targetUrl, active: true });
    return { tabId: existing.id, reused: true };
  }
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  return { tabId: tab.id, reused: false };
}

async function applyUiMode() {
  if (!chrome.action?.setPopup) return;
  try {
    await chrome.action.setPopup({ popup: VDM.openInTab ? "" : MANAGER_PAGE });
  } catch (e) {
    console.error("VDM applyUiMode failed", e);
  }
}

function taskSnapshot(t) {
  return {
    id: t.id,
    video: VDM.sanitizeTaskVideo(t.video),
    fileName: t.fileName,
    status: t.status,
    progress: t.progress,
    downloadProgress: t.downloadProgress,
    mergeProgress: t.mergeProgress,
    merged: t.merged,
    downloaded: t.downloaded,
    total: t.total,
    error: t.error,
    startedAt: t.startedAt,
  };
}

let persistTasksTimer = null;
async function persistTasksNow() {
  if (persistTasksTimer) {
    clearTimeout(persistTasksTimer);
    persistTasksTimer = null;
  }
  try {
    const tasks = engine.listActive().map(taskSnapshot);
    await chrome.storage.local.set({ vdmActiveTasks: tasks });
  } catch {
    /* ignore */
  }
}

function schedulePersistTasks() {
  if (persistTasksTimer) return;
  persistTasksTimer = setTimeout(async () => {
    persistTasksTimer = null;
    await persistTasksNow();
  }, 250);
}

async function restoreTasks() {
  const { vdmActiveTasks = [] } = await chrome.storage.local.get("vdmActiveTasks");
  for (const snap of vdmActiveTasks) {
    if (!snap?.id) continue;
    if (!["pending", "downloading", "merging", "paused", "failed"].includes(snap.status)) continue;
    engine.restoreTask(snap);
  }
}

const initPromise = (async function init() {
  try {
    await store.restore();
    await restoreTasks();
    await loadSettings();
    await applyUiMode();
  } catch (e) {
    console.error("VDM restore failed", e);
  }
})();

chrome.action.onClicked.addListener(async (tab) => {
  await loadSettings();
  if (!VDM.openInTab) return;
  const resolved = await resolveTargetTabId(tab?.id);
  await openManagerTab(resolved.tabId || tab?.id);
});

VDM._logFn = (level, message, detail) => {
  pushLog(level, message, detail);
};

async function resolvePageUrl(tabId) {
  const cached = store.getTabUrl(tabId);
  if (cached && !cached.startsWith("chrome")) return cached;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url && !tab.url.startsWith("chrome")) {
      store.setTabUrl(tabId, tab.url);
      return tab.url;
    }
  } catch {
    /* tab gone */
  }
  return cached || "";
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

const logDedupe = new Map();
let logBroadcastTimer = null;

function scheduleLogBroadcast() {
  if (logBroadcastTimer) return;
  logBroadcastTimer = setTimeout(() => {
    logBroadcastTimer = null;
    broadcast({ type: "LOG_UPDATED" });
  }, 2000);
}

async function pushLog(level, message, detail = "") {
  if (level === "debug") return;
  try {
    const key = `${level}|${message}|${detail}`;
    const now = Date.now();
    const prev = logDedupe.get(key);
    if (prev && now - prev < 8000) return;
    logDedupe.set(key, now);

    const { vdmLogs = [] } = await chrome.storage.local.get("vdmLogs");
    vdmLogs.unshift({
      time: now,
      level,
      message: String(message),
      detail: detail ? String(detail) : "",
    });
    if (vdmLogs.length > 60) vdmLogs.length = 60;
    await chrome.storage.local.set({ vdmLogs });
    scheduleLogBroadcast();
  } catch (e) {
    console.error("VDM log failed", e);
  }
}

async function pushCompletedTask(task) {
  const { vdmCompleted = [] } = await chrome.storage.local.get("vdmCompleted");
  vdmCompleted.unshift({
    id: task.id,
    fileName: task.fileName,
    pageUrl: task.video?.pageUrl || "",
    quality: task.video?.quality || 0,
    completedAt: Date.now(),
  });
  if (vdmCompleted.length > 50) vdmCompleted.length = 50;
  await chrome.storage.local.set({ vdmCompleted });
  broadcast({ type: "COMPLETED_UPDATED" });
}

const taskBroadcastAt = new Map();

function broadcastTask(task) {
  const now = Date.now();
  const last = taskBroadcastAt.get(task.id) || 0;
  const terminal = ["failed", "completed", "cancelled"].includes(task.status);
  if (!terminal && now - last < 450) return;
  taskBroadcastAt.set(task.id, now);
  broadcast({ type: "TASK_UPDATED", task });
}

function updateBadge(tabId) {
  const count = store.countForTab(tabId);
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#067EFF" });
}

async function handleSniff(url, tabId, pageUrl, referer) {
  if (!url || !tabId || tabId < 0) return;
  if (!pageUrl || pageUrl.startsWith("chrome")) return;
  if (VDM.isYoutubeUrl(url) || VDM.isYoutubeUrl(pageUrl)) return;
  if (!VDM.isVideoUrl(url) || VDM.isLikelyAdUrl(url)) return;

  store.setTabUrl(tabId, pageUrl);

  if (/\.m3u8/i.test(url)) {
    const key = `${tabId}:${VDM.normalizeUrl(url)}`;
    if (m3u8Pending.has(key)) return;
    m3u8Pending.add(key);
    try {
      await parseAndStoreM3u8(url, tabId, pageUrl, referer || pageUrl);
    } finally {
      setTimeout(() => m3u8Pending.delete(key), 3000);
    }
    return;
  }

  const size = await probeSize(url, referer || pageUrl);
  if (VDM.isPreviewClip(url, size) && size === 0) return;
  if (size === 0 && !/\.(mp4|webm|m3u8)(\?|$)/i.test(url)) return;

  const quality = VDM.guessQuality(url);
  if (size && size < VDM.MIN_MAIN_BYTES && quality && quality < VDM.MIN_MAIN_QUALITY) {
    if (!VDM.isPreviewClip(url, size)) return;
  }

  const pageTitle = await resolvePageTitle(tabId, pageUrl);
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  const video = VDM.createVideo({
    url,
    pageUrl,
    tabId,
    title: pageTitle,
    quality,
    mimeType: ext === "mp4" || ext === "m4v" ? "video/mp4" : `video/${ext}`,
    referer: VDM.bestReferer(url, pageUrl, referer || pageUrl),
    requestHeaders: requestHeadersForUrl(url),
    size,
  });
  video.tabId = tabId;
  attachCachedPoster(video, tabId);

  if (store.add(video)) {
    if (!video.posterUrl) {
      resolvePosterUrl(tabId)
        .then((poster) => {
          if (poster) applyPosterToTab(tabId, poster, pageUrl);
        })
        .catch(() => {});
    }
    await store.persist();
    updateBadge(tabId);
    broadcast({ type: "VIDEOS_UPDATED", tabId, pageUrl });
  }
}

function requestHeadersForUrl(url) {
  return VDM.peekRequestHeaders(url);
}

function attachCachedPoster(video, tabId) {
  const cached = tabPosterBest.get(tabId);
  if (cached?.url && !video.posterUrl) video.posterUrl = cached.url;
}

function applyPosterToTab(tabId, url, pageUrl) {
  if (!url || tabId < 0) return false;
  const score = VDM.scorePosterUrl(url);
  const prev = tabPosterBest.get(tabId);
  if (prev && prev.score >= score) return false;
  tabPosterBest.set(tabId, { url, score });
  let changed = false;
  for (const v of store.getForTab(tabId)) {
    const curScore = v.posterUrl ? VDM.scorePosterUrl(v.posterUrl) : -1;
    if (score > curScore) {
      v.posterUrl = url;
      changed = true;
    }
  }
  if (changed) {
    store.persist();
    broadcast({ type: "VIDEOS_UPDATED", tabId, pageUrl });
  }
  return true;
}

function handlePosterSniff(url, tabId, pageUrl, { trusted = false } = {}) {
  if (!url || tabId < 0 || !pageUrl || pageUrl.startsWith("chrome")) return;
  if (VDM.isYoutubeUrl(pageUrl)) return;
  if (!trusted && !VDM.isPosterImageUrl(url)) return;
  store.setTabUrl(tabId, pageUrl);
  applyPosterToTab(tabId, url, pageUrl);
}

async function setDownloadHeaderRule(referer) {
  if (!referer || !chrome.declarativeNetRequest?.updateDynamicRules) return;
  let origin = "";
  try {
    origin = new URL(referer).origin;
  } catch {
    /* ignore */
  }
  const requestHeaders = [
    { header: "Referer", operation: "set", value: referer },
  ];
  if (origin) requestHeaders.push({ header: "Origin", operation: "set", value: origin });
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [DOWNLOAD_HDR_RULE],
      addRules: [
        {
          id: DOWNLOAD_HDR_RULE,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders },
          condition: {
            urlFilter: "|https",
            resourceTypes: ["xmlhttprequest", "media", "other", "image"],
          },
        },
      ],
    });
    await pushLog("debug", "已套用下載 Referer 規則", referer.slice(0, 100));
  } catch (e) {
    await pushLog("warn", "Referer 規則套用失敗", e.message || String(e));
  }
}

async function clearDownloadHeaderRule() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [DOWNLOAD_HDR_RULE] });
  } catch {
    /* ignore */
  }
}

function prepareVideoForDownload(video, pageUrl) {
  const fresh = requestHeadersForUrl(video.url);
  if (fresh) video.requestHeaders = fresh;
  video.referer = VDM.bestReferer(video.url, pageUrl, video.referer || pageUrl);
  return video;
}

function normalizeSubfolder(name) {
  return VDM.normalizeDownloadPath(name);
}

async function resolvePageTitle(tabId, pageUrl) {
  const cached = tabTitles.get(tabId);
  if (cached && !/^https?:\/\//i.test(cached)) return cached;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.title && !/^https?:\/\//i.test(tab.title)) {
      tabTitles.set(tabId, tab.title);
      return tab.title;
    }
  } catch {
    /* tab gone */
  }
  try {
    const slug = decodeURIComponent(
      new URL(pageUrl).pathname.split("/").filter(Boolean).pop() || ""
    );
    if (slug) return slug;
  } catch {
    /* ignore */
  }
  return "video";
}

async function resolvePosterUrl(tabId, { waitMs = 0 } = {}) {
  if (!tabId || !chrome.scripting?.executeScript) return "";
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (maxWait) => {
        const abs = (u) => {
          try {
            return new URL(u, location.href).href;
          } catch {
            return "";
          }
        };
        const pick = () => {
          for (const v of document.querySelectorAll("video")) {
            const p = v.poster || v.getAttribute("poster");
            if (p) return abs(p);
          }
          for (const sel of [
            'meta[property="og:image"]',
            'meta[property="og:image:url"]',
            'meta[property="og:image:secure_url"]',
            'meta[name="twitter:image"]',
            'meta[name="twitter:image:src"]',
            'link[rel="image_src"]',
          ]) {
            const el = document.querySelector(sel);
            const href = el?.content || el?.href;
            if (href) return abs(href);
          }
          for (const sel of [
            ".vjs-poster img",
            ".plyr__poster",
            '[class*="poster"] img',
            'img[class*="thumb"]',
            'img[class*="cover"]',
            ".video-player img",
            "#player img",
          ]) {
            const el = document.querySelector(sel);
            const src = el?.src || el?.getAttribute("data-src");
            if (src) return abs(src);
          }
          let best = null;
          let bestArea = 0;
          for (const img of document.querySelectorAll("img")) {
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w < 160 || h < 90) continue;
            const area = w * h;
            if (area > bestArea) {
              bestArea = area;
              best = img;
            }
          }
          if (best?.src) return abs(best.src);
          return "";
        };
        if (!maxWait) return pick();
        return new Promise((resolve) => {
          let url = pick();
          if (url) {
            resolve(url);
            return;
          }
          const deadline = Date.now() + maxWait;
          const done = (finalUrl) => {
            obs.disconnect();
            resolve(finalUrl || "");
          };
          const obs = new MutationObserver(() => {
            url = pick();
            if (url) done(url);
          });
          obs.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
          });
          const tick = () => {
            url = pick();
            if (url) {
              done(url);
              return;
            }
            if (Date.now() >= deadline) {
              done(pick());
              return;
            }
            setTimeout(tick, 200);
          };
          setTimeout(tick, 200);
        });
      },
      args: [waitMs],
    });
    return result || "";
  } catch {
    return "";
  }
}

VDM.resolvePosterUrl = resolvePosterUrl;

async function attachPostersForTab(tabId) {
  const pageUrl = store.getTabUrl(tabId);
  const cached = tabPosterBest.get(tabId);
  if (cached?.url) {
    applyPosterToTab(tabId, cached.url, pageUrl);
    return;
  }
  const posterUrl = await resolvePosterUrl(tabId);
  if (posterUrl) applyPosterToTab(tabId, posterUrl, pageUrl);
}

const coverSaveQueue = [];
let coverPumpRunning = false;

async function pumpCoverSaveQueue() {
  if (coverPumpRunning) return;
  coverPumpRunning = true;
  while (coverSaveQueue.length) {
    const { video, fileNameBase, tabId } = coverSaveQueue.shift();
    try {
      const ok = await VDM.saveCoverJpg(video, fileNameBase, tabId);
      if (ok) await pushLog("info", `封面已存檔：${fileNameBase}.jpg`);
    } catch {
      /* ignore */
    }
  }
  coverPumpRunning = false;
}

function queueCoverSave(video, fileNameBase, tabId) {
  coverSaveQueue.push({ video, fileNameBase, tabId });
  pumpCoverSaveQueue();
}

function hlsDisplayTitle(pageTitle, { resolution = 0, quality = 0 } = {}) {
  const base = String(pageTitle || "video").trim() || "video";
  if (resolution > 0) return `${base} (${resolution}P)`;
  if (quality > 0) return `${base} (${VDM.qualityLabel(quality)})`;
  return base;
}

function enrichVideoTitles(videos, pageTitle) {
  if (!pageTitle) return videos;
  for (const v of videos) {
    if (v.title && !VDM.isGenericHlsTitle(v.title)) continue;
    v.title = hlsDisplayTitle(pageTitle, v);
  }
  return videos;
}

function pickBestVideo(videos) {
  if (!videos?.length) return null;
  let best = videos[0];
  for (const v of videos) {
    const vq = v.quality || 0;
    const bq = best.quality || 0;
    if (vq > bq || (vq === bq && (v.size || 0) > (best.size || 0))) best = v;
  }
  return best;
}

function handleTaskProgress(t) {
  broadcastTask(t);
  if (t.status === "failed") {
    pushLog("error", `下載失敗：${t.fileName}`, t.error || "未知錯誤");
  }
  if (t.status === "completed") {
    pushLog("info", `下載完成：${t.fileName}`);
    const coverBase = t.fileName.replace(/\.mp4$/i, "");
    if (!t.video?._coverSaved) {
      queueCoverSave(t.video, coverBase, t.video?.tabId);
    }
    pushCompletedTask(t);
    engine.tasks.delete(t.id);
    engine.controllers.delete(t.id);
  }
  if (t.status === "cancelled") {
    engine.tasks.delete(t.id);
    engine.controllers.delete(t.id);
  }
  if (["failed", "completed", "cancelled"].includes(t.status)) {
    if (!engine.listActive().length && !engine.waitQueue.length) {
      clearDownloadHeaderRule();
    }
  }
  if (["paused", "failed", "pending", "completed", "cancelled"].includes(t.status)) {
    persistTasksNow().catch(() => {});
  } else {
    schedulePersistTasks();
  }
}

async function resolveCoverMeta(video, tabId, { posterWaitMs = 1200 } = {}) {
  if (!video.posterUrl) {
    const cached = tabPosterBest.get(tabId);
    if (cached?.url) video.posterUrl = cached.url;
  }
  if (!video.posterUrl) {
    video.posterUrl = await resolvePosterUrl(tabId, { waitMs: posterWaitMs });
  }
  return !!video.posterUrl;
}

function buildPcFileName(saveName) {
  const base = String(saveName || "video").replace(/\.mp4$/i, "");
  return `${base}.mp4`;
}

async function buildPcTaskPayloads(items) {
  const usedNames = new Set();
  const pending = [];

  for (const { video, tabId, pageUrl, pageTitle } of items) {
    video.tabId = tabId;
    prepareVideoForDownload(video, pageUrl);

    let saveName = VDM.buildSaveFilename(pageTitle, pageUrl);
    if (usedNames.has(saveName)) {
      let n = 2;
      while (usedNames.has(`${saveName}_${n}`)) n++;
      saveName = `${saveName}_${n}`;
    }
    usedNames.add(saveName);
    pending.push({ video, saveName, pageUrl, tabId });
  }

  if (!pending.length) return [];

  return pending.map(({ video, saveName }) => ({
    id: VDM.uid(),
    video: VDM.sanitizeTaskVideo(video),
    fileName: buildPcFileName(saveName),
    status: "pending",
  }));
}

async function pushDownloadItemsToPc(items) {
  const tasks = await buildPcTaskPayloads(items);
  if (!tasks.length) return [];
  await VDM.pushTasksToPc(tasks);
  await pushLog("info", `已送至 PC 版：${tasks.length} 個任務`);
  return tasks;
}

async function downloadCoversForItems(items) {
  if (!items.length) return { count: 0, total: 0 };
  const batchMode = items.length > 1;
  const posterWaitMs = batchMode ? 250 : 1200;
  const usedNames = new Set();
  let done = 0;

  for (const { video, tabId, pageUrl, pageTitle } of items) {
    video.tabId = tabId;
    attachCachedPoster(video, tabId);
    await attachPostersForTab(tabId).catch(() => {});
    attachCachedPoster(video, tabId);
    prepareVideoForDownload(video, pageUrl);

    let saveName = VDM.buildSaveFilename(pageTitle, pageUrl);
    if (usedNames.has(saveName)) {
      let n = 2;
      while (usedNames.has(`${saveName}_${n}`)) n++;
      saveName = `${saveName}_${n}`;
    }
    usedNames.add(saveName);

    if (await prepareCoverForDownload(video, tabId, saveName, { posterWaitMs }).catch(() => false)) {
      done++;
    }
  }

  return { count: done, total: items.length };
}

async function prepareCoverForDownload(video, tabId, saveName, { posterWaitMs = 1200 } = {}) {
  if (!video.posterUrl) {
    const cached = tabPosterBest.get(tabId);
    if (cached?.url) video.posterUrl = cached.url;
  }
  if (!video.posterUrl) {
    video.posterUrl = await resolvePosterUrl(tabId, { waitMs: posterWaitMs });
  }
  if (!video.posterUrl) {
    await pushLog("warn", `找不到封面：${saveName}`, String(video.pageUrl || "").slice(0, 120));
    return false;
  }
  await setDownloadHeaderRule(video.referer || video.pageUrl || "");
  const ok = await VDM.saveCoverJpg(video, saveName, tabId);
  if (ok) {
    await pushLog("info", `封面已存檔：${saveName}.jpg`);
  } else {
    await pushLog("warn", `封面下載失敗：${saveName}.jpg`, video.posterUrl.slice(0, 120));
  }
  return ok;
}

async function enqueueDownloadTasks(items) {
  const activeUrls = new Set(
    engine.listActive().map((t) => VDM.normalizeUrl(t.video?.url || ""))
  );
  const usedNames = new Set();
  const pending = [];

  for (const { video, tabId, pageUrl, pageTitle } of items) {
    const norm = VDM.normalizeUrl(video.url);
    if (activeUrls.has(norm)) continue;
    activeUrls.add(norm);

    video.tabId = tabId;
    prepareVideoForDownload(video, pageUrl);

    let saveName = VDM.buildSaveFilename(pageTitle, pageUrl);
    if (usedNames.has(saveName)) {
      let n = 2;
      while (usedNames.has(`${saveName}_${n}`)) n++;
      saveName = `${saveName}_${n}`;
    }
    usedNames.add(saveName);

    pending.push({ video, saveName, pageUrl, tabId });
  }

  if (!pending.length) return [];

  const batchMode = pending.length > 1;
  const posterWaitMs = batchMode ? 250 : 1200;

  const primary = prepareVideoForDownload(pending[0].video, pending[0].pageUrl);
  await setDownloadHeaderRule(primary.referer);

  const started = [];
  for (const { video, saveName } of pending) {
    const task = engine.createTask(video, saveName);
    started.push(task);
    engine.enqueue(task, handleTaskProgress);
  }

  Promise.all(
    pending.map(({ video, tabId, saveName }) =>
      prepareCoverForDownload(video, tabId, saveName, { posterWaitMs }).catch(() => false)
    )
  ).catch(() => {});

  schedulePersistTasks();
  return started;
}

async function collectGroupDownloadItems(anchorTabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(anchorTabId);
  } catch {
    return { error: "找不到分頁" };
  }
  const groupId = tab.groupId;
  if (groupId == null || groupId === -1) {
    return { error: "目前分頁不在任何 Chrome 群組中" };
  }
  const groupTabs = await chrome.tabs.query({ groupId });
  const webTabs = groupTabs.filter((t) => isWebTabUrl(t.url));
  const rows = await Promise.all(
    webTabs.map(async (t) => {
      const pageUrl = t.url;
      const pageTitle = await resolvePageTitle(t.id, pageUrl);
      const all = enrichVideoTitles(store.getForTab(t.id), pageTitle);
      const best = pickBestVideo(all);
      if (!best) return null;
      return { video: best, tabId: t.id, pageUrl, pageTitle };
    })
  );
  const items = rows.filter(Boolean);
  return { groupId, items };
}

async function getTabGroupInfo(anchorTabId) {
  if (!anchorTabId) return { inGroup: false };
  try {
    const tab = await chrome.tabs.get(anchorTabId);
    const groupId = tab.groupId;
    if (groupId == null || groupId === -1) return { inGroup: false };
    const groupTabs = await chrome.tabs.query({ groupId });
    const webTabs = groupTabs.filter((t) => isWebTabUrl(t.url));
    const hits = await Promise.all(
      webTabs.map((t) => Promise.resolve(!!pickBestVideo(store.getForTab(t.id))))
    );
    const downloadable = hits.filter(Boolean).length;
    return { inGroup: true, groupId, tabCount: groupTabs.length, downloadable };
  } catch {
    return { inGroup: false };
  }
}

function pathInSubfolder(filename, subfolder) {
  const f = String(filename || "").replace(/\\/g, "/");
  const s = normalizeSubfolder(subfolder);
  return f.includes(`/${s}/`) || f.startsWith(`${s}/`) || f.endsWith(`/${s}`);
}

async function waitDownloadComplete(downloadId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === "complete") return item;
    if (item?.state === "interrupted") {
      throw new Error(item.error || "下載標記檔失敗");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("開啟資料夾逾時");
}

async function openDownloadSubfolder(subfolder) {
  const clean = normalizeSubfolder(subfolder);
  const items = await chrome.downloads.search({
    orderBy: ["-startTime"],
    limit: 80,
  });
  const hit = items.find((item) => pathInSubfolder(item.filename, clean));
  if (hit) {
    await chrome.downloads.show(hit.id);
    return { ok: true };
  }
  const downloadId = await chrome.downloads.download({
    url: "data:text/plain,Video%20Downloads%20Manager",
    filename: `${clean}/.vdm-folder.txt`,
    conflictAction: "overwrite",
    saveAs: false,
  });
  await waitDownloadComplete(downloadId);
  await chrome.downloads.show(downloadId);
  return { ok: true };
}

async function probeSize(url, referer) {
  try {
    const headers = await VDM.buildHeaders(
      { url, referer, pageUrl: referer },
      url
    );
    let res = await fetch(url, { method: "HEAD", headers });
    if (!res.ok) {
      res = await fetch(url, { method: "GET", headers });
    }
    const len = parseInt(res.headers.get("content-length") || "0", 10);
    if (len && len < VDM.MIN_MAIN_BYTES && !/\.m3u8/i.test(url)) {
      if (VDM.isPreviewClip(url, len)) return len;
      return 0;
    }
    return len;
  } catch {
    return 0;
  }
}

async function parseAndStoreM3u8(url, tabId, pageUrl, referer) {
  const bestRef = VDM.bestReferer(url, pageUrl, referer);
  const pageTitle = await resolvePageTitle(tabId, pageUrl);
  const baseVideo = {
    pageUrl,
    tabId,
    referer: bestRef,
    userAgent: VDM.USER_AGENT,
    requestHeaders: requestHeadersForUrl(url),
  };
  let added = false;

  try {
    const playlist = await VDM.fetchM3u8(url, { ...baseVideo, url });

    if (playlist.isVariant) {
      const variants = playlist.playlists
        .filter((p) => !VDM.isLikelyAdUrl(p.url))
        .filter((p) => !p.bandwidth || p.bandwidth >= 400_000)
        .filter((p) => !p.resolution || p.resolution >= VDM.MIN_MAIN_QUALITY)
        .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0) || (b.resolution || 0) - (a.resolution || 0))
        .slice(0, 4);

      const variantRows = await Promise.all(
        variants.map(async (variant) => {
          let duration = 0;
          let estimatedSize = 0;
          try {
            const sub = await VDM.fetchM3u8(variant.url, { ...baseVideo, url: variant.url });
            const meta = VDM.m3u8Meta(sub, variant.bandwidth);
            duration = meta.duration;
            estimatedSize = meta.estimatedSize;
          } catch {
            /* ignore */
          }
          return { variant, duration, estimatedSize };
        })
      );

      for (const { variant, duration, estimatedSize } of variantRows) {
        const video = VDM.createVideo({
          ...baseVideo,
          url: variant.url,
          title: hlsDisplayTitle(pageTitle, {
            resolution: variant.resolution,
            quality: variant.resolution || VDM.guessQuality(variant.url),
          }),
          quality: variant.resolution || VDM.guessQuality(variant.url),
          isM3u8: true,
          duration,
          size: estimatedSize,
          mimeType: "application/vnd.apple.mpegurl",
        });
        video.tabId = tabId;
        attachCachedPoster(video, tabId);
        if (store.add(video)) added = true;
      }
    } else {
      const quality = VDM.guessQuality(url);
      const meta = VDM.m3u8Meta(playlist);
      if (playlist.segments.length <= 2 && quality < VDM.MIN_MAIN_QUALITY) return;
      const video = VDM.createVideo({
        ...baseVideo,
        url,
        title: hlsDisplayTitle(pageTitle, { quality }),
        quality,
        isM3u8: true,
        duration: meta.duration,
        size: meta.estimatedSize,
        mimeType: "application/vnd.apple.mpegurl",
      });
      video.tabId = tabId;
      attachCachedPoster(video, tabId);
      if (store.add(video)) added = true;
    }
  } catch {
    if (!added && !VDM.isLikelyAdUrl(url)) {
      const video = VDM.createVideo({
        ...baseVideo,
        url,
        title: pageTitle,
        quality: VDM.guessQuality(url),
        isM3u8: true,
        mimeType: "application/vnd.apple.mpegurl",
      });
      video.tabId = tabId;
      attachCachedPoster(video, tabId);
      if (store.add(video)) added = true;
    }
  }

  if (added) {
    await store.persist();
    attachPostersForTab(tabId).catch(() => {});
    updateBadge(tabId);
    broadcast({ type: "VIDEOS_UPDATED", tabId, pageUrl });
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (VDM.isVideoUrl(details.url)) {
      VDM.rememberRequestHeaders(details.url, details.requestHeaders);
      if (/\.ts(?:\?|$)/i.test(details.url)) return;
      const cached = requestHeadersForUrl(details.url);
      const referer = cached?.Referer || cached?.referer || "";
      resolvePageUrl(details.tabId).then((pageUrl) => {
        if (!pageUrl) return;
        handleSniff(details.url, details.tabId, pageUrl, referer || pageUrl);
      });
      return;
    }
    if (VDM.isPosterImageUrl(details.url)) {
      VDM.rememberRequestHeaders(details.url, details.requestHeaders);
      resolvePageUrl(details.tabId).then((pageUrl) => {
        if (!pageUrl) return;
        handlePosterSniff(details.url, details.tabId, pageUrl);
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || details.type === "main_frame") return;
    if (VDM.isVideoUrl(details.url)) return;
    if (!VDM.isPosterImageUrl(details.url)) return;
    resolvePageUrl(details.tabId).then((pageUrl) => {
      if (!pageUrl) return;
      handlePosterSniff(details.url, details.tabId, pageUrl);
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    const url = details.url;
    if (!url || url.startsWith("chrome")) return;
    tabPosterBest.delete(details.tabId);
    store.clearTab(details.tabId);
    store.setTabUrl(details.tabId, url);
    store.persist();
    updateBadge(details.tabId);
    broadcast({ type: "VIDEOS_UPDATED", tabId: details.tabId, pageUrl: url });
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && !info.url.startsWith("chrome")) {
    if (isWebTabUrl(info.url)) lastWebTabId = tabId;
    store.setTabUrl(tabId, info.url);
    if (tab.title) tabTitles.set(tabId, tab.title);
  }
  if (info.status === "complete" && tab.url) {
    updateBadge(tabId);
    broadcast({ type: "VIDEOS_UPDATED", tabId, pageUrl: tab.url });
  }
});

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (tab.url) {
      if (isWebTabUrl(tab.url)) lastWebTabId = info.tabId;
      store.setTabUrl(info.tabId, tab.url);
      updateBadge(info.tabId);
      broadcast({ type: "VIDEOS_UPDATED", tabId: info.tabId, pageUrl: tab.url });
    }
  } catch {
    /* ignore */
  }
});

async function findTabByPageUrl(pageUrl) {
  if (!pageUrl) return null;
  let target;
  try {
    target = new URL(pageUrl);
  } catch {
    return null;
  }
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url || !isWebTabUrl(t.url)) continue;
    try {
      const u = new URL(t.url);
      if (u.origin === target.origin && u.pathname === target.pathname) return t.id;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function exportTasksPayload() {
  return {
    format: "vdm-active-tasks",
    version: 1,
    exportedAt: Date.now(),
    tasks: engine.listActive().map(taskSnapshot),
  };
}

async function importTasksPayload(data) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data) ? data : [];
  if (!tasks.length) return { error: "匯入檔沒有任務" };

  const activeUrls = new Set(
    engine.listActive().map((t) => VDM.normalizeUrl(t.video?.url || ""))
  );
  let imported = 0;
  let skipped = 0;

  for (const snap of tasks) {
    if (!snap?.video?.url) {
      skipped++;
      continue;
    }
    const norm = VDM.normalizeUrl(snap.video.url);
    if (activeUrls.has(norm)) {
      skipped++;
      continue;
    }
    activeUrls.add(norm);
    const clean = {
      ...snap,
      video: VDM.sanitizeTaskVideo(snap.video),
      status: "paused",
      error: snap.error || "已匯入，可點「繼續」接續下載",
    };
    if (!clean.id) clean.id = VDM.uid();
    engine.restoreTask(clean);
    imported++;
  }

  if (!imported) return { error: "沒有可匯入的任務（可能皆已在進行中）" };
  await persistTasksNow();
  await pushLog("info", `已匯入 ${imported} 個任務${skipped ? `（略過 ${skipped} 個）` : ""}`);
  return { ok: true, imported, skipped };
}

async function bulkTaskAction(action, taskIds = []) {
  const ids = [...new Set(taskIds)].filter((id) => engine.tasks.has(id));
  if (!ids.length) return { error: "沒有可操作的任務" };

  await loadSettings();
  let done = 0;
  const errors = [];

  for (const taskId of ids) {
    try {
      if (action === "pause") {
        engine.pause(taskId);
        done++;
      } else if (action === "cancel") {
        engine.cancel(taskId);
        done++;
      } else if (action === "resume") {
        const t = engine.tasks.get(taskId);
        if (!t || t.status !== "paused") continue;
        const newTabId = await findTabByPageUrl(t.video?.pageUrl);
        if (newTabId) {
          t.video.tabId = newTabId;
          prepareVideoForDownload(t.video, t.video.pageUrl);
        }
        await setDownloadHeaderRule(t.video?.referer || t.video?.pageUrl || "");
        if (engine.resume(taskId, handleTaskProgress)) done++;
      } else if (action === "retry") {
        const res = await retryDownloadTask(taskId);
        if (res.ok) done++;
        else if (res.error) errors.push(res.error);
      }
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }

  persistTasksNow().catch(() => {});
  if (!done) return { error: errors[0] || "批量操作失敗" };
  return { ok: true, count: done, errors: errors.length ? errors : undefined };
}

async function retryDownloadTask(taskId) {
  const t = engine.tasks.get(taskId);
  if (!t || !["paused", "failed"].includes(t.status)) {
    return { error: "此任務無法從頭下載" };
  }

  const newTabId = await findTabByPageUrl(t.video?.pageUrl);
  if (newTabId) {
    t.video.tabId = newTabId;
    prepareVideoForDownload(t.video, t.video.pageUrl);
  }

  await setDownloadHeaderRule(t.video.referer || t.video.pageUrl || "");
  const ok = await engine.retry(taskId, handleTaskProgress);
  if (!ok) return { error: "從頭下載失敗" };
  await pushLog("info", `從頭下載：${t.fileName}`);
  return { ok: true, task: t };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  store.clearTab(tabId);
  tabTitles.delete(tabId);
  tabPosterBest.delete(tabId);
  store.persist();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(async (e) => {
      await pushLog("error", "背景處理失敗", e.message || String(e));
      sendResponse({ error: e.message || String(e) });
    });
  return true;
});

async function handleMessage(msg, sender) {
  await initPromise;
  const tabId = msg.tabId ?? sender.tab?.id;

  switch (msg.type) {
    case "SNIFF_URL": {
      const tid = sender.tab?.id;
      if (!tid || !msg.url) return { ok: false };
      const pageUrl = msg.pageUrl || sender.tab?.url || store.getTabUrl(tid);
      store.setTabUrl(tid, pageUrl);
      await handleSniff(msg.url, tid, pageUrl, pageUrl);
      return { ok: true };
    }
    case "SNIFF_POSTER": {
      const tid = sender.tab?.id;
      if (!tid || !msg.url) return { ok: false };
      const pageUrl = msg.pageUrl || sender.tab?.url || store.getTabUrl(tid);
      handlePosterSniff(msg.url, tid, pageUrl, { trusted: !!msg.trusted });
      return { ok: true };
    }
    case "GET_VIDEOS": {
      const resolved = await resolveTargetTabId(msg.tabId);
      const tid = resolved.tabId;
      const pageUrl = resolved.pageUrl || msg.pageUrl || "";
      const pageTitle = tid ? await resolvePageTitle(tid, pageUrl) : "";
      const videos = tid ? enrichVideoTitles(store.getForTab(tid), pageTitle) : [];
      return { videos, pageUrl, tabId: tid };
    }
    case "GET_ACTIVE_TASKS": {
      const tasks = engine.listActive();
      return {
        tasks,
        stats: {
          total: tasks.length,
          running: engine.runningCount,
          queued: engine.waitQueue.length,
          maxConcurrent: VDM.clampConcurrentTasks(VDM.maxConcurrentTasks),
        },
      };
    }
    case "GET_COMPLETED_TASKS": {
      const { vdmCompleted = [] } = await chrome.storage.local.get("vdmCompleted");
      return { tasks: vdmCompleted };
    }
    case "CLEAR_COMPLETED": {
      await chrome.storage.local.set({ vdmCompleted: [] });
      broadcast({ type: "COMPLETED_UPDATED" });
      return { ok: true };
    }
    case "GET_SETTINGS": {
      await loadSettings();
      return {
        maxConnections: VDM.maxConnections,
        maxConcurrentTasks: VDM.maxConcurrentTasks,
        useDiskCache: VDM.useDiskCache,
        downloadSubfolder: VDM.downloadSubfolder,
        segmentCacheDir: VDM.segmentCacheDir,
        openInTab: VDM.openInTab,
        diskCacheAvailable: VDM.opfsAvailable(),
      };
    }
    case "OPEN_MANAGER_TAB": {
      const resolved = await resolveTargetTabId(msg.tabId);
      return openManagerTab(resolved.tabId || lastWebTabId);
    }
    case "SET_MANAGER_SOURCE": {
      if (msg.tabId) await setManagerSourceTab(msg.tabId);
      return { ok: true, tabId: msg.tabId || null };
    }
    case "USE_RECENT_TAB": {
      const tid = lastWebTabId || (await chrome.storage.session.get("vdmManagerTabId")).vdmManagerTabId;
      if (!tid) return { error: "找不到可監視的網頁分頁，請先切換到影片分頁" };
      await setManagerSourceTab(tid);
      const pageUrl = await resolvePageUrl(tid);
      return { tabId: tid, pageUrl };
    }
    case "OPEN_DOWNLOAD_FOLDER": {
      await openDownloadSubfolder(msg.subfolder);
      return { ok: true };
    }
    case "SET_SETTINGS": {
      const { vdmSettings: prev = {} } = await chrome.storage.local.get("vdmSettings");
      const next = {
        ...prev,
        maxConnections: VDM.clampConnections(msg.maxConnections ?? prev.maxConnections),
        maxConcurrentTasks: VDM.clampConcurrentTasks(
          msg.maxConcurrentTasks ?? prev.maxConcurrentTasks
        ),
        useDiskCache: msg.useDiskCache !== undefined ? !!msg.useDiskCache : prev.useDiskCache !== false,
        downloadSubfolder: VDM.normalizeDownloadPath(
          msg.downloadSubfolder ?? prev.downloadSubfolder ?? "VideoDownloadsManager"
        ),
        segmentCacheDir: String(msg.segmentCacheDir ?? prev.segmentCacheDir ?? "vdm-cache").trim() || "vdm-cache",
        openInTab: msg.openInTab !== undefined ? !!msg.openInTab : !!prev.openInTab,
      };
      await chrome.storage.local.set({ vdmSettings: next });
      await loadSettings();
      await applyUiMode();
      engine.pumpQueue();
      return { ok: true, ...next, diskCacheAvailable: VDM.opfsAvailable() };
    }
    case "GET_TAB_GROUP_INFO": {
      const resolved = await resolveTargetTabId(msg.tabId);
      return getTabGroupInfo(resolved.tabId);
    }
    case "START_GROUP_DOWNLOADS": {
      await loadSettings();
      const resolved = await resolveTargetTabId(msg.tabId);
      if (!resolved.tabId) {
        return { error: "找不到目前分頁" };
      }
      const collected = await collectGroupDownloadItems(resolved.tabId);
      if (collected.error) return { error: collected.error };
      if (!collected.items?.length) {
        return { error: "群組內沒有偵測到可下載影片（請先在各分頁播放影片）" };
      }
      if (msg.coverOnly) {
        const result = await downloadCoversForItems(collected.items);
        if (!result.count) return { error: "群組內找不到封面或下載失敗" };
        await pushLog("info", `群組封面已下載 ${result.count}/${result.total} 個`);
        return { coverOnly: true, count: result.count, total: result.total };
      }
      if (VDM.isPcMode()) {
        try {
          const started = await pushDownloadItemsToPc(collected.items);
          if (!started.length) return { error: "群組內影片無法送至 PC 版" };
          return { tasks: started, count: started.length };
        } catch (err) {
          const msgErr = err?.message || String(err);
          await pushLog("error", `群組送至 PC 失敗：${msgErr}`);
          return { error: msgErr };
        }
      }
      const started = await enqueueDownloadTasks(collected.items);
      if (!started.length) {
        return { error: "群組內影片已在下載中或無法加入" };
      }
      await pushLog("info", `群組下載：已加入 ${started.length} 個任務（各分頁最高畫質）`);
      return { tasks: started, count: started.length };
    }
    case "START_DOWNLOADS": {
      await loadSettings();
      const resolved = await resolveTargetTabId(msg.tabId);
      const tid = resolved.tabId;
      if (!tid) {
        await pushLog("error", "找不到目前分頁");
        return { error: "找不到目前分頁" };
      }
      const pageUrl = resolved.pageUrl || (await resolvePageUrl(tid));
      const pageTitle = await resolvePageTitle(tid, pageUrl);
      const ids = new Set(msg.videoIds || []);
      const videos = enrichVideoTitles(
        store.getForTab(tid).filter((v) => ids.has(v.id)),
        pageTitle
      );
      if (!videos.length) {
        const msgErr = `找不到選取的影片（分頁 ${tid}，共 ${store.getForTab(tid).length} 個可下載）`;
        await pushLog("error", msgErr, `pageUrl=${pageUrl}`);
        return { error: msgErr };
      }
      const items = videos.map((video) => ({ video, tabId: tid, pageUrl, pageTitle }));
      if (msg.coverOnly) {
        const result = await downloadCoversForItems(items);
        if (!result.count) return { error: "找不到封面或下載失敗" };
        await pushLog("info", `封面已下載 ${result.count}/${result.total} 個`);
        return { coverOnly: true, count: result.count, total: result.total };
      }
      if (VDM.isPcMode()) {
        try {
          const started = await pushDownloadItemsToPc(items);
          if (!started.length) return { error: "選取的影片無法送至 PC 版" };
          return { tasks: started };
        } catch (err) {
          const msgErr = err?.message || String(err);
          await pushLog("error", `送至 PC 失敗：${msgErr}`);
          return { error: msgErr };
        }
      }
      const started = await enqueueDownloadTasks(items);
      if (!started.length) {
        return { error: "選取的影片已在下載中或無法加入" };
      }
      await pushLog("info", `已加入 ${started.length} 個下載任務`);
      return { tasks: started };
    }
    case "START_COVER_DOWNLOADS": {
      await loadSettings();
      const resolved = await resolveTargetTabId(msg.tabId);
      const tid = resolved.tabId;
      if (!tid) return { error: "找不到目前分頁" };
      const pageUrl = resolved.pageUrl || (await resolvePageUrl(tid));
      const pageTitle = await resolvePageTitle(tid, pageUrl);
      const ids = new Set(msg.videoIds || []);
      const videos = enrichVideoTitles(
        store.getForTab(tid).filter((v) => ids.has(v.id)),
        pageTitle
      );
      if (!videos.length) return { error: "找不到選取的影片" };
      const items = videos.map((video) => ({ video, tabId: tid, pageUrl, pageTitle }));
      const result = await downloadCoversForItems(items);
      if (!result.count) return { error: "找不到封面或下載失敗" };
      await pushLog("info", `封面已下載 ${result.count}/${result.total} 個`);
      return { coverOnly: true, count: result.count, total: result.total };
    }
    case "START_GROUP_COVER_DOWNLOADS": {
      await loadSettings();
      const resolved = await resolveTargetTabId(msg.tabId);
      if (!resolved.tabId) return { error: "找不到目前分頁" };
      const collected = await collectGroupDownloadItems(resolved.tabId);
      if (collected.error) return { error: collected.error };
      if (!collected.items?.length) {
        return { error: "群組內沒有偵測到可下載影片" };
      }
      const result = await downloadCoversForItems(collected.items);
      if (!result.count) return { error: "群組內找不到封面或下載失敗" };
      await pushLog("info", `群組封面已下載 ${result.count}/${result.total} 個`);
      return { coverOnly: true, count: result.count, total: result.total };
    }
    case "PAUSE_TASK":
      engine.pause(msg.taskId);
      persistTasksNow().catch(() => {});
      return { ok: true };
    case "BULK_TASK_ACTION":
      return bulkTaskAction(msg.action, msg.taskIds);
    case "EXPORT_ACTIVE_TASKS":
      return { data: exportTasksPayload() };
    case "IMPORT_ACTIVE_TASKS":
      return importTasksPayload(msg.data);
    case "RESUME_TASK": {
      await loadSettings();
      const t = engine.tasks.get(msg.taskId);
      if (!t) return { error: "找不到任務" };
      const newTabId = await findTabByPageUrl(t.video?.pageUrl);
      if (newTabId) {
        t.video.tabId = newTabId;
        prepareVideoForDownload(t.video, t.video.pageUrl);
      }
      await setDownloadHeaderRule(t.video?.referer || t.video?.pageUrl || "");
      if (!engine.resume(msg.taskId, handleTaskProgress)) {
        return { error: "此任務無法繼續" };
      }
      return { ok: true };
    }
    case "CANCEL_TASK":
      engine.cancel(msg.taskId);
      return { ok: true };
    case "RETRY_TASK":
      return retryDownloadTask(msg.taskId);
    case "GET_CURRENT_TAB": {
      return resolveTargetTabId(msg.tabId);
    }
    case "GET_LOGS": {
      const { vdmLogs = [] } = await chrome.storage.local.get("vdmLogs");
      return { logs: vdmLogs };
    }
    case "CLEAR_LOGS": {
      await chrome.storage.local.set({ vdmLogs: [] });
      return { ok: true };
    }
    default:
      return { error: `未知指令：${msg.type || "(無)"}` };
  }
}

chrome.alarms.create("vdm-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "vdm-keepalive") return;
  if (engine.listActive().length > 0) {
    broadcast({ type: "TASK_TICK" });
    persistTasksNow().catch(() => {});
  }
});

if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    persistTasksNow().catch(() => {});
  });
}
