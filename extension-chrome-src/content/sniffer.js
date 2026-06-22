(function () {
  if (window.__vdmSniffer) return;
  window.__vdmSniffer = true;

  const VDM = self.VDM;

  function reportVideo(url) {
    if (!url || typeof url !== "string") return;
    if (!/\.m3u8|\.mp4|\.webm|\.ts(\?|$)/i.test(url)) return;
    chrome.runtime.sendMessage({
      type: "SNIFF_URL",
      url,
      pageUrl: location.href,
      tabId: undefined,
    }).catch(() => {});
  }

  function reportPoster(url, { trusted = false } = {}) {
    if (!url || typeof url !== "string") return;
    if (!trusted && VDM?.isPosterImageUrl && !VDM.isPosterImageUrl(url)) return;
    chrome.runtime.sendMessage({
      type: "SNIFF_POSTER",
      url,
      pageUrl: location.href,
      trusted,
    }).catch(() => {});
  }

  function report(url) {
    reportVideo(url);
    reportPoster(url);
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (_method, url) {
    try { report(String(url)); } catch (_) {}
    return origOpen.apply(this, arguments);
  };

  if (window.fetch) {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      try {
        const u = typeof input === "string" ? input : input?.url || "";
        report(String(u));
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }

  if (window === window.top) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type !== "PAGE_FETCH") return;
      const refs = msg.refererList?.length ? msg.refererList : [msg.referer || ""];
      const hdrs = msg.headers || {};
      (async () => {
        let last = "";
        for (const ref of refs) {
          const headers = { ...hdrs };
          if (ref) headers.Referer = ref;
          try {
            const res = await fetch(msg.url, { credentials: "include", headers });
            if (res.ok) {
              const buf = await res.arrayBuffer();
              sendResponse({
                ok: true,
                status: res.status,
                via: "content-script",
                referer: ref,
                bytes: Array.from(new Uint8Array(buf)),
              });
              return;
            }
            last = `HTTP ${res.status} (ref=${ref || "-"})`;
          } catch (e) {
            last = `${e.message || e} (ref=${ref || "-"})`;
          }
        }
        sendResponse({ ok: false, status: 0, via: "content-script", error: last || "fail" });
      })();
      return true;
    });

    const abs = (u) => {
      try {
        return new URL(u, location.href).href;
      } catch {
        return "";
      }
    };

    const pickPosterFromDom = () => {
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

    const scanDomPoster = () => {
      const url = pickPosterFromDom();
      if (url) reportPoster(url, { trusted: true });
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scanDomPoster);
    } else {
      scanDomPoster();
    }
    new MutationObserver(scanDomPoster).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  }
})();
