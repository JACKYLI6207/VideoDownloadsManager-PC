const $ = (sel) => document.querySelector(sel);

let sourceTabId = null;
let running = false;
let batchCancel = false;
let manualCalibrating = false;
let manualConfirmResolve = null;
let manualCancelReject = null;
let tabUpdateListener = null;

function showToast(message, level = "error") {
  const el = $("#toast");
  el.hidden = false;
  el.textContent = message;
  el.className = level === "info" ? "toast info" : "toast";
}

function parseListFromTextarea() {
  const text = $("#listText")?.value || "";
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+[\.\)、]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function updateListCount() {
  const count = parseListFromTextarea().length;
  const el = $("#listCount");
  if (el) el.textContent = `${count} 項`;
}

function readSourceTabFromUrl() {
  const params = new URLSearchParams(location.search);
  const tid = parseInt(params.get("sourceTabId") || "", 10);
  return Number.isFinite(tid) && tid > 0 ? tid : null;
}

async function resolveSourceTab() {
  const fromUrl = readSourceTabFromUrl();
  if (fromUrl) {
    sourceTabId = fromUrl;
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_CURRENT_TAB" });
    if (res?.tabId) sourceTabId = res.tabId;
  } catch {
    /* ignore */
  }
}

async function refreshSourceInfo() {
  await resolveSourceTab();
  const el = $("#sourceUrl");
  const meta = $("#sourceMeta");
  if (!sourceTabId) {
    el.textContent = "找不到來源分頁，請先切換到目標網站再開啟此頁。";
    meta.textContent = "";
    return;
  }
  try {
    const tab = await chrome.tabs.get(sourceTabId);
    el.textContent = tab.url || "(無 URL)";
    const groupText =
      tab.groupId != null && tab.groupId !== -1 ? ` · 群組 ID ${tab.groupId}` : " · 不在群組";
    meta.textContent = `分頁 #${tab.id}${groupText}`;
  } catch {
    el.textContent = "來源分頁已關閉，請重新從主面板開啟。";
    meta.textContent = "";
    sourceTabId = null;
  }
}

function appendLog(text, level = "") {
  const log = $("#progressLog");
  const line = document.createElement("div");
  line.className = `line${level ? ` ${level}` : ""}`;
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function setRunning(on) {
  running = on;
  $("#startBtn").disabled = on;
  $("#stopBtn").disabled = !on;
  $("#txtFile").disabled = on;
  $("#listText").disabled = on;
}

function reportProgress(payload) {
  const { index, total, query, status, url, note, summary } = payload;
  if (status === "running") {
    $("#progressSummary").textContent = `處理中 ${index}/${total}…`;
    appendLog(`[${index}/${total}] ${query} — 搜索中…`);
    return;
  }
  if (status === "done") {
    appendLog(`[${index}/${total}] ${query} → ${url || note || "完成"}`, "ok");
    return;
  }
  if (status === "skipped") {
    appendLog(`[${index}/${total}] ${query} — ${note || "略過"}`, "warn");
    return;
  }
  if (status === "error") {
    appendLog(`[${index}/${total}] ${query} — ${note || "失敗"}`, "err");
    return;
  }
  if (status === "finished") {
    setRunning(false);
    $("#progressSummary").textContent = summary || "已完成";
    showToast(summary || "批量搜索完成", "info");
  }
  if (status === "cancelled") {
    setRunning(false);
    $("#progressSummary").textContent = "已停止";
    appendLog("批量搜索已停止", "warn");
  }
}

async function injectSiteSearch(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["lib/siteSearch.js"],
  });
}

async function autoDetectSearchConfig(tabId) {
  try {
    await injectSiteSearch(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => VDM.detectPageSearch(),
    });
    return result || null;
  } catch {
    return null;
  }
}

async function loadCachedSearchConfig(origin) {
  const key = VDM.searchConfigCacheKey(origin);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function saveCachedSearchConfig(origin, config) {
  const key = VDM.searchConfigCacheKey(origin);
  await chrome.storage.session.set({ [key]: config });
  showConfirmedFormat(config);
}

function showConfirmedFormat(config, sampleQuery = "SAMPLE-001") {
  const el = $("#confirmedFormat");
  if (!el || !config?.template) return;
  el.hidden = false;
  el.textContent = `已確認格式：${VDM.buildSearchUrl(config, sampleQuery)}`;
}

function showManualPanel(show) {
  manualCalibrating = show;
  const panel = $("#manualSearchPanel");
  if (panel) panel.classList.toggle("active", show);
  $("#confirmManualBtn").disabled = !show;
  $("#focusSourceBtn").disabled = !show;
  $("#cancelManualBtn").disabled = !show;
}

async function parseConfigFromSearchUrl(pageUrl) {
  if (!pageUrl || pageUrl.startsWith("chrome")) return null;
  const config = VDM.parseSearchUrlTemplate(pageUrl);
  if (config) return config;
  if (VDM.isLikelySearchResultsUrl(pageUrl)) {
    return {
      mode: "url",
      template: pageUrl,
      field: "unknown",
      origin: new URL(pageUrl).origin,
      source: "manual-raw",
      fallback: true,
    };
  }
  return null;
}

function cleanupManualWaiters() {
  if (tabUpdateListener) {
    chrome.tabs.onUpdated.removeListener(tabUpdateListener);
    tabUpdateListener = null;
  }
  manualConfirmResolve = null;
  manualCancelReject = null;
}

async function promptManualSearchCalibration(tabId, sampleQuery, origin) {
  showManualPanel(true);
  $("#manualSearchStatus").textContent =
    "請切換到來源分頁，在搜索框輸入任意關鍵字並搜索（建議用列表第一項）。完成後按「確認搜索格式」，或等待系統自動偵測。";

  const tab = await chrome.tabs.get(tabId);
  const baselineUrl = tab.url || "";
  await chrome.tabs.update(tabId, { active: true });

  let searchUrl = "";
  try {
    searchUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("等待手動搜索逾時，請完成搜索後按「確認搜索格式」"));
      }, 180000);

      const cleanup = () => {
        clearTimeout(timer);
        if (tabUpdateListener) {
          chrome.tabs.onUpdated.removeListener(tabUpdateListener);
          tabUpdateListener = null;
        }
        manualConfirmResolve = null;
        manualCancelReject = null;
      };

      tabUpdateListener = (id, info, t) => {
        if (id !== tabId || batchCancel) return;
        const url = info.url || t?.url;
        if (!url || url === baselineUrl || url.startsWith("chrome")) return;
        if (!VDM.isLikelySearchResultsUrl(url)) return;
        cleanup();
        resolve(url);
      };
      chrome.tabs.onUpdated.addListener(tabUpdateListener);

      manualConfirmResolve = async () => {
        try {
          const current = await chrome.tabs.get(tabId);
          if (!VDM.isLikelySearchResultsUrl(current.url || "")) {
            showToast("目前分頁不像搜索結果頁，請先在網站完成搜索");
            return;
          }
          cleanup();
          resolve(current.url || "");
        } catch {
          cleanup();
          reject(new Error("來源分頁已關閉"));
        }
      };

      manualCancelReject = () => {
        cleanup();
        reject(new Error("已取消"));
      };
    });
  } catch (e) {
    showManualPanel(false);
    throw e;
  }

  showManualPanel(false);

  const config = await parseConfigFromSearchUrl(searchUrl);
  if (!config?.template) {
    throw new Error("無法從目前 URL 解析搜索格式，請確認已在搜索結果頁");
  }
  if (config.fallback) {
    throw new Error("無法解析搜索關鍵字位置，請改用含 ?keyword= 或 /search/關鍵字 的搜索結果頁");
  }

  await saveCachedSearchConfig(origin, config);
  appendLog(`手動確認格式：${VDM.buildSearchUrl(config, sampleQuery || "SAMPLE-001")}`, "ok");
  return config;
}

async function ensureSearchConfig(tabId, sampleQuery, { forceRecalibrate = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith("chrome")) {
    throw new Error("來源分頁不是有效網頁");
  }
  const origin = new URL(tab.url).origin;

  if (!forceRecalibrate) {
    const cached = await loadCachedSearchConfig(origin);
    if (cached?.template && !VDM.isUncertainSearchConfig(cached)) {
      showConfirmedFormat(cached, sampleQuery);
      return cached;
    }
  }

  let config = VDM.parseSearchUrlTemplate(tab.url);
  if (config && !VDM.isUncertainSearchConfig(config)) {
    await saveCachedSearchConfig(origin, config);
    return config;
  }

  const auto = await autoDetectSearchConfig(tabId);
  if (auto?.source === "current-url" && !VDM.isUncertainSearchConfig(auto)) {
    await saveCachedSearchConfig(origin, auto);
    return auto;
  }

  if (auto && !VDM.isUncertainSearchConfig(auto)) {
    await saveCachedSearchConfig(origin, auto);
    return auto;
  }

  return promptManualSearchCalibration(tabId, sampleQuery, origin);
}

async function detectSearchConfig(tabId, sampleQuery, options = {}) {
  return ensureSearchConfig(tabId, sampleQuery, options);
}

async function pickFirstResultFromTab(tabId) {
  await injectSiteSearch(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => VDM.pickFirstResultUrl(),
  });
  return result || "";
}

async function waitTabComplete(tabId, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (batchCancel) throw new Error("已取消");
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return tab;
    } catch {
      throw new Error("分頁已關閉");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("載入逾時");
}

let groupQueue = Promise.resolve();

function enqueueGroupOp(fn) {
  const run = groupQueue.then(fn, fn);
  groupQueue = run.catch(() => {});
  return run;
}

async function resolveGroupContext(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const groupId = tab.groupId;
  return {
    groupId: groupId != null && groupId !== -1 ? groupId : null,
    windowId: tab.windowId,
  };
}

async function resolveLiveGroupId(groupId, sourceTabId) {
  if (!sourceTabId) return groupId;
  try {
    const tab = await chrome.tabs.get(sourceTabId);
    const live = tab.groupId;
    return live != null && live !== -1 ? live : groupId;
  } catch {
    return groupId;
  }
}

async function addTabToGroup(tabId, groupId, windowId, sourceTabId) {
  if (groupId == null || !tabId) return false;
  return enqueueGroupOp(async () => {
    let targetGroupId = await resolveLiveGroupId(groupId, sourceTabId);
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        targetGroupId = await resolveLiveGroupId(targetGroupId, sourceTabId);
        const tab = await chrome.tabs.get(tabId);
        if (!tab || tab.groupId === targetGroupId) return true;
        if (windowId && tab.windowId !== windowId) {
          await chrome.tabs.move(tabId, { windowId, index: -1 });
        }
        await chrome.tabs.group({ tabIds: tabId, groupId: targetGroupId });
        const after = await chrome.tabs.get(tabId);
        if (after.groupId === targetGroupId) return true;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
    return false;
  });
}

async function sweepTabsIntoGroup(tabIds, groupId, windowId, sourceTabId) {
  const targetGroupId = await resolveLiveGroupId(groupId, sourceTabId);
  if (!targetGroupId) return;

  const ungrouped = [];
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.groupId !== targetGroupId) ungrouped.push(tabId);
    } catch {
      /* tab closed */
    }
  }
  if (!ungrouped.length) return;

  await enqueueGroupOp(async () => {
    const liveGroupId = await resolveLiveGroupId(targetGroupId, sourceTabId);
    for (let i = 0; i < ungrouped.length; i += 8) {
      const chunk = ungrouped.slice(i, i + 8);
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (windowId) {
            for (const tabId of chunk) {
              const tab = await chrome.tabs.get(tabId);
              if (tab.windowId !== windowId) {
                await chrome.tabs.move(tabId, { windowId, index: -1 });
              }
            }
          }
          await chrome.tabs.group({ tabIds: chunk, groupId: liveGroupId });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
      }
    }
  });
}

async function createTabInContext(url, windowId, ctx = {}) {
  const { groupId, sourceTabId, batchCreatedTabIds } = ctx;
  const opts = { url, active: false };
  if (windowId) opts.windowId = windowId;
  const tab = await chrome.tabs.create(opts);
  if (batchCreatedTabIds) batchCreatedTabIds.add(tab.id);
  if (groupId) {
    await addTabToGroup(tab.id, groupId, windowId, sourceTabId);
  }
  return tab;
}

async function processOneQuery({
  query,
  index,
  total,
  config,
  groupId,
  windowId,
  openFirstResult,
  sourceTabId: batchSourceTabId,
  batchCreatedTabIds,
}) {
  const tabCtx = { groupId, windowId, sourceTabId: batchSourceTabId, batchCreatedTabIds };
  if (batchCancel) return false;
  reportProgress({ index, total, query, status: "running" });

  const searchUrl = VDM.buildSearchUrl(config, query);
  if (!searchUrl) {
    reportProgress({ index, total, query, status: "error", note: "無法建立搜索 URL" });
    return false;
  }

  try {
    if (openFirstResult) {
      const searchTab = await createTabInContext(searchUrl, windowId, tabCtx);
      await waitTabComplete(searchTab.id);
      if (batchCancel) {
        try {
          await chrome.tabs.remove(searchTab.id);
        } catch {
          /* ignore */
        }
        throw new Error("已取消");
      }
      const resultUrl = await pickFirstResultFromTab(searchTab.id);
      try {
        await chrome.tabs.remove(searchTab.id);
      } catch {
        /* ignore */
      }
      const finalUrl = resultUrl || searchUrl;
      const resultTab = await createTabInContext(finalUrl, windowId, tabCtx);
      const grouped = await addTabToGroup(resultTab.id, groupId, windowId, batchSourceTabId);
      reportProgress({
        index,
        total,
        query,
        status: resultUrl ? "done" : "skipped",
        url: finalUrl,
        note: resultUrl
          ? grouped || !groupId
            ? ""
            : "已開啟但未加入群組"
          : "未找到首筆結果，已開搜索頁",
      });
    } else {
      const tab = await createTabInContext(searchUrl, windowId, tabCtx);
      const grouped = await addTabToGroup(tab.id, groupId, windowId, batchSourceTabId);
      reportProgress({
        index,
        total,
        query,
        status: grouped || !groupId ? "done" : "skipped",
        url: searchUrl,
        note: grouped || !groupId ? "" : "已開啟但未加入群組",
      });
    }
    return true;
  } catch (e) {
    if (e.message === "已取消") throw e;
    reportProgress({ index, total, query, status: "error", note: e.message || "失敗" });
    return false;
  }
}

async function runWithConcurrency(items, concurrency, workerFn) {
  let next = 0;
  let done = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  const runners = Array.from({ length: limit }, async () => {
    while (next < items.length && !batchCancel) {
      const i = next++;
      if (await workerFn(items[i], i)) done++;
    }
  });

  await Promise.all(runners);
  return done;
}

async function runBatchSearch({ queries, openFirstResult, concurrency, forceRecalibrate }) {
  batchCancel = false;
  groupQueue = Promise.resolve();
  const batchCreatedTabIds = new Set();
  const { groupId, windowId } = await resolveGroupContext(sourceTabId);
  const sampleQuery = queries[0] || "SAMPLE-001";
  const config = await ensureSearchConfig(sourceTabId, sampleQuery, { forceRecalibrate });
  appendLog(`搜索格式：${config.source || "?"} → ${VDM.buildSearchUrl(config, sampleQuery)}`, "ok");
  appendLog(
    `同時併行 ${Math.max(1, concurrency)} 個${openFirstResult ? "（首筆結果模式需等搜索頁載入）" : ""}${groupId ? " · 目標群組 #" + groupId : " · 來源不在群組"}`,
    "ok"
  );

  const total = queries.length;
  const jobs = queries.map((query, i) => ({ query, index: i + 1 }));

  let done = 0;
  try {
    done = await runWithConcurrency(jobs, concurrency, async (job) =>
      processOneQuery({
        query: job.query,
        index: job.index,
        total,
        config,
        groupId,
        windowId,
        openFirstResult,
        sourceTabId,
        batchCreatedTabIds,
      })
    );
  } catch (e) {
    if (e.message === "已取消") batchCancel = true;
    else throw e;
  }

  if (groupId && batchCreatedTabIds.size) {
    await sweepTabsIntoGroup(batchCreatedTabIds, groupId, windowId, sourceTabId);
  }

  if (batchCancel) {
    reportProgress({ status: "cancelled" });
  } else {
    reportProgress({ status: "finished", summary: `完成 ${done}/${total}` });
  }
}

$("#txtFile")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    $("#listText").value = text;
    updateListCount();
    showToast(`已載入 ${parseListFromTextarea().length} 項`, "info");
  } catch (err) {
    showToast(err.message || "讀取檔案失敗");
  }
});

$("#listText")?.addEventListener("input", updateListCount);

$("#clearList")?.addEventListener("click", () => {
  $("#listText").value = "";
  $("#txtFile").value = "";
  updateListCount();
});

$("#refreshSource")?.addEventListener("click", async () => {
  try {
    await refreshSourceInfo();
    showToast("已更新來源分頁", "info");
  } catch (err) {
    showToast(err.message || "更新失敗");
  }
});

$("#testDetect")?.addEventListener("click", async () => {
  try {
    await resolveSourceTab();
    if (!sourceTabId) throw new Error("找不到來源分頁");
    const sample = parseListFromTextarea()[0] || "SAMPLE-001";
    const force = !!$("#recalibrateEachRun")?.checked;
    const config = await ensureSearchConfig(sourceTabId, sample, { forceRecalibrate: force });
    appendLog(`偵測：${config.source || "?"} → ${VDM.buildSearchUrl(config, sample)}`, "ok");
    showToast("搜索格式已確認", "info");
  } catch (err) {
    showToast(err.message || "偵測失敗");
  }
});

$("#focusSourceBtn")?.addEventListener("click", async () => {
  if (!sourceTabId) return;
  try {
    await chrome.tabs.update(sourceTabId, { active: true });
    showToast("已切換到來源分頁，請在該站搜索一次", "info");
  } catch {
    showToast("無法切換到來源分頁");
  }
});

$("#confirmManualBtn")?.addEventListener("click", () => {
  if (manualConfirmResolve) manualConfirmResolve();
});

$("#cancelManualBtn")?.addEventListener("click", () => {
  batchCancel = true;
  if (manualCancelReject) manualCancelReject();
  else cleanupManualWaiters();
  showManualPanel(false);
  setRunning(false);
  showToast("已取消格式確認", "info");
});

$("#backToMain")?.addEventListener("click", () => {
  const url = chrome.runtime.getURL("sidepanel/panel.html");
  chrome.tabs.create({ url });
});

$("#stopBtn")?.addEventListener("click", () => {
  batchCancel = true;
  cleanupManualWaiters();
  showManualPanel(false);
  appendLog("已要求停止…", "warn");
});

$("#startBtn")?.addEventListener("click", async () => {
  if (running) return;
  const queries = parseListFromTextarea();
  if (!queries.length) {
    showToast("請載入或輸入至少一個名稱");
    return;
  }
  setRunning(true);
  batchCancel = false;
  try {
    await resolveSourceTab();
    if (!sourceTabId) throw new Error("找不到來源分頁");
    $("#progressLog").innerHTML = "";
    $("#progressSummary").textContent = `準備搜索 ${queries.length} 項…`;
    await runBatchSearch({
      queries,
      openFirstResult: !!$("#openFirstResult")?.checked,
      concurrency: Math.max(1, parseInt($("#concurrency")?.value || "3", 10) || 3),
      forceRecalibrate: !!$("#recalibrateEachRun")?.checked,
    });
  } catch (err) {
    setRunning(false);
    showToast(err.message || "無法開始");
  }
});

(async function init() {
  updateListCount();
  try {
    await refreshSourceInfo();
  } catch (err) {
    showToast(err.message || "初始化失敗");
  }
})();
