self.VDM = self.VDM || {};
const VDM = self.VDM;

VDM.USER_AGENT = typeof navigator !== "undefined" ? navigator.userAgent : "Mozilla/5.0";
VDM.maxConnections = 3;
VDM.maxConcurrentTasks = 2;

VDM.getWorkerCount = (total) =>
  Math.max(1, Math.min(VDM.maxConnections || 3, total || 1));

VDM.clampConnections = (n) => Math.max(1, Math.min(18, Number(n) || 3));

VDM.clampConcurrentTasks = (n) => Math.max(1, Math.min(6, Number(n) || 2));

/** 全局 HLS/HTTP 片段並行上限（任務數 × 單任務連線，硬上限 108 = 6×18） */
VDM.getGlobalSegmentLimit = () => {
  const tasks = VDM.clampConcurrentTasks(VDM.maxConcurrentTasks);
  const conn = VDM.clampConnections(VDM.maxConnections);
  return Math.min(108, Math.max(1, tasks * conn));
};

VDM._segmentSlots = { inUse: 0, waiters: [] };

VDM.acquireSegmentSlot = (signal) =>
  new Promise((resolve, reject) => {
    const tryAcquire = () => {
      if (signal?.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      if (VDM._segmentSlots.inUse < VDM.getGlobalSegmentLimit()) {
        VDM._segmentSlots.inUse++;
        resolve();
        return;
      }
      VDM._segmentSlots.waiters.push(tryAcquire);
    };
    const onAbort = () => {
      const i = VDM._segmentSlots.waiters.indexOf(tryAcquire);
      if (i >= 0) VDM._segmentSlots.waiters.splice(i, 1);
      reject(new Error("cancelled"));
    };
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    tryAcquire();
  });

VDM.releaseSegmentSlot = () => {
  VDM._segmentSlots.inUse = Math.max(0, VDM._segmentSlots.inUse - 1);
  const next = VDM._segmentSlots.waiters.shift();
  if (next) next();
};

VDM.uid = () => Math.random().toString(36).slice(2, 14);

VDM.sanitizeFilename = (name) => {
  const cleaned = String(name || "video").replace(/[<>:"/\\|?*]/g, "_").trim();
  return cleaned.slice(0, 180) || "video";
};

VDM.stripResolutionFromName = (name) =>
  String(name || "")
    .replace(/\s*\(\s*(?:4[Kk]|\d{3,4}[pP])\s*\)\s*$/i, "")
    .replace(/[\s_-]+(?:4[Kk]|\d{3,4}[pP])\s*$/i, "")
    .trim();

VDM.buildSaveFilename = (pageTitle, pageUrl) => {
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
  raw = VDM.stripResolutionFromName(raw);
  return VDM.sanitizeFilename(String(raw || "video").toUpperCase()) || "VIDEO";
};

VDM.formatSize = (n) => {
  if (!n || n <= 0) return "--";
  let val = Number(n);
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (val < 1024) return unit === "B" ? `${Math.floor(val)} B` : `${val.toFixed(1)} ${unit}`;
    val /= 1024;
  }
  return `${val.toFixed(1)} TB`;
};

VDM.formatSpeed = (n) => (n > 0 ? `${VDM.formatSize(n)}/s` : "0 B/s");

VDM.formatDuration = (seconds) => {
  if (!seconds || seconds <= 0) return "--";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

VDM.qualityLabel = (q) => {
  if (q >= 2160) return "4K";
  if (q >= 1440) return "1440P";
  if (q >= 1080) return "1080P";
  if (q >= 720) return "720P";
  if (q >= 480) return "480P";
  if (q >= 360) return "360P";
  if (q > 0) return `${q}P`;
  return "Auto";
};

VDM.resolveUrl = (base, ref) => {
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
};

VDM.peekRequestHeaders = (url) => {
  if (!url || !VDM._headerCache) return null;
  const entry = VDM._headerCache.get(VDM.normalizeUrl(url));
  if (!entry) return null;
  if (Date.now() - entry.at > VDM.HEADER_TTL) return null;
  return entry.headers;
};

VDM.rememberRequestHeaders = (url, requestHeaders) => {
  if (!url || !requestHeaders?.length) return;
  if (!VDM._headerCache) VDM._headerCache = new Map();
  const picked = {};
  for (const h of requestHeaders) {
    const lower = h.name.toLowerCase();
    if (VDM.CAPTURE_HEADER_NAMES.has(lower)) picked[h.name] = h.value;
  }
  if (!Object.keys(picked).length) return;
  VDM._headerCache.set(VDM.normalizeUrl(url), { headers: picked, at: Date.now() });
};

VDM.HEADER_TTL = 30 * 60 * 1000;
VDM.CAPTURE_HEADER_NAMES = new Set([
  "referer",
  "origin",
  "cookie",
  "user-agent",
  "authorization",
  "x-requested-with",
]);

VDM._cookiesHeader = async (url) => {
  if (!url || typeof chrome === "undefined" || !chrome.cookies?.getAll) return "";
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies.length) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
};

VDM.buildHeaders = async (video, targetUrl, options = {}) => {
  const { forBackground = true } = options;
  const url = targetUrl || video.url;
  const headers = {};
  const cached = VDM.peekRequestHeaders(url);
  if (cached) Object.assign(headers, cached);
  if (video.requestHeaders) Object.assign(headers, video.requestHeaders);

  const referer =
    headers.Referer ||
    headers.referer ||
    video.referer ||
    video.pageUrl ||
    "";
  if (referer) {
    headers.Referer = referer;
    if (!headers.Origin && !headers.origin) {
      try {
        headers.Origin = new URL(referer).origin;
      } catch {
        /* ignore */
      }
    }
  }

  headers["User-Agent"] =
    headers["User-Agent"] ||
    headers["user-agent"] ||
    video.userAgent ||
    VDM.USER_AGENT;

  // Service Worker fetch 禁止手動設 Cookie，否則會直接 Failed to fetch
  if (forBackground) {
    delete headers.Cookie;
    delete headers.cookie;
  } else if (!headers.Cookie && !headers.cookie) {
    let cookie = await VDM._cookiesHeader(url);
    if (!cookie && video.pageUrl && video.pageUrl !== url) {
      cookie = await VDM._cookiesHeader(video.pageUrl);
    }
    if (cookie) headers.Cookie = cookie;
  }

  headers.Accept = headers.Accept || "*/*";
  return headers;
};

VDM.isFetchNetworkError = (err) => {
  const msg = String(err?.message || err || "");
  return /failed to fetch|networkerror|network error/i.test(msg);
};

VDM.shortUrl = (url) => {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 48 ? `${u.pathname.slice(0, 48)}…` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return String(url).slice(0, 64);
  }
};

VDM.log = (level, message, detail = "") => {
  if (level === "debug") return;
  if (typeof VDM._logFn === "function") VDM._logFn(level, message, detail);
};

VDM.markFetchBlocked = (video, status) => {
  video._fetchBlocked = true;
  video._fetchBlockReason = status;
};

VDM.clearFetchBlocked = (video) => {
  if (!video) return;
  delete video._fetchBlocked;
  delete video._fetchBlockReason;
};

/** 導出 / 持久化用：移除執行期狀態，避免還原後無法繼續 */
VDM.sanitizeTaskVideo = (video) => {
  if (!video || typeof video !== "object") return video;
  const copy = { ...video };
  delete copy._fetchBlocked;
  delete copy._fetchBlockReason;
  delete copy._coverSaved;
  return copy;
};

VDM.isFetchBlocked = (video) => !!video._fetchBlocked;

VDM.isRecoverableFetchError = (err) => {
  const msg = err?.message || String(err || "");
  if (msg === "cancelled") return false;
  return VDM.isFetchNetworkError(err) || /\bHTTP \d{3}\b/.test(msg);
};

VDM.fetchBlockedError = (video) => {
  const code = video._fetchBlockReason || 403;
  return `HTTP ${code}（連線被拒/限速，請降低並行數或稍後再試）`;
};

VDM.bestReferer = (url, pageUrl, fallback = "") => {
  const cached = VDM.peekRequestHeaders(url);
  return cached?.Referer || cached?.referer || fallback || pageUrl || "";
};

VDM.refererCandidates = (video, url) => {
  const out = [];
  const add = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  const cached = VDM.peekRequestHeaders(url);
  add(cached?.Referer);
  add(cached?.referer);
  if (video.requestHeaders) {
    add(video.requestHeaders.Referer);
    add(video.requestHeaders.referer);
  }
  add(video.referer);
  add(video.pageUrl);
  try {
    add(new URL(url).origin + "/");
  } catch {
    /* ignore */
  }
  return out;
};

VDM.buildPageFetchHeaders = async (video, url) => {
  const headers = await VDM.buildHeaders(video, url, { forBackground: true });
  delete headers.Cookie;
  delete headers.cookie;
  return headers;
};

VDM._pageFetch = async (tabId, url, video) => {
  if (!tabId) throw new Error("無分頁 ID");
  const short = VDM.shortUrl(url);
  const errors = [];
  const refererList = VDM.refererCandidates(video, url);
  const extraHeaders = await VDM.buildPageFetchHeaders(video, url);
  if (typeof chrome !== "undefined" && chrome.tabs?.get) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url?.startsWith("chrome") || tab.url?.startsWith("edge")) {
        throw new Error(`分頁為 ${tab.url.split("/")[2]}，無法注入下載`);
      }
    } catch (e) {
      if (e.message?.includes("無法注入")) throw e;
      errors.push(`tabs.get: ${e.message || e}`);
    }
  }

  if (chrome.scripting?.executeScript) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "MAIN",
        func: async (fetchUrl, refs, hdrs) => {
          let last = "";
          for (const ref of refs) {
            const headers = { ...(hdrs || {}) };
            if (ref) headers.Referer = ref;
            try {
              const res = await fetch(fetchUrl, { credentials: "include", headers });
              if (res.ok) {
                const buf = await res.arrayBuffer();
                return {
                  ok: true,
                  status: res.status,
                  via: "main-world",
                  referer: ref,
                  bytes: Array.from(new Uint8Array(buf)),
                };
              }
              last = `HTTP ${res.status} (ref=${ref || "-"})`;
            } catch (e) {
              last = `${e.message || e} (ref=${ref || "-"})`;
            }
          }
          return { ok: false, status: 0, via: "main-world", error: last || "fail" };
        },
        args: [url, refererList, extraHeaders],
      });
      if (result?.ok) {
        VDM.log("info", "MAIN world fetch 成功", `${result.via} ${short}`);
        return result;
      }
      if (result) errors.push(`${result.via}: ${result.error || result.status}`);
    } catch (e) {
      errors.push(`executeScript: ${e.message || e}`);
    }
  }

  try {
    const res = await chrome.tabs.sendMessage(
      tabId,
      { type: "PAGE_FETCH", url, refererList, headers: extraHeaders },
      { frameId: 0 }
    );
    if (res?.ok) {
      VDM.log("info", "content-script fetch 成功", `${res.via || "cs"} ${short}`);
      return res;
    }
    if (res) errors.push(`${res.via || "content-script"}: ${res.error || res.status}`);
  } catch (e) {
    errors.push(`sendMessage: ${e.message || e}`);
  }

  const detail = errors.join(" | ") || "未知錯誤";
  VDM.log("error", "pageFetch 全部失敗", `${short}\n${detail}`);
  throw new Error(detail);
};

VDM.fetchTextInPage = async (tabId, url, video) => {
  const result = await VDM._pageFetch(tabId, url, video);
  if (!result?.ok) {
    throw new Error(`M3U8 HTTP ${result?.status || result?.error || "fail"}`);
  }
  if (result.text != null) return result.text;
  return new TextDecoder().decode(new Uint8Array(result.bytes || []));
};

VDM.fetchBytesInPage = async (tabId, url, video) => {
  const result = await VDM._pageFetch(tabId, url, video);
  if (!result?.ok) {
    throw new Error(`片段 HTTP ${result?.status || result?.error || "fail"}`);
  }
  return new Uint8Array(result.bytes || []).buffer;
};
