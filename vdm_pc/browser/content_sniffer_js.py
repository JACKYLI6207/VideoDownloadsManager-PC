"""注入頁面的 fetch/XHR 嗅探（對齊擴充 content/sniffer.js）。"""

SNIFFER_SCRIPT = r"""
(function () {
  if (window.__vdmPcSniffer) return;
  window.__vdmPcSniffer = true;
  function report(url) {
    if (!url || typeof url !== "string") return;
    const u = url.trim();
    if (!u) return;
    if (!/\.m3u8|\.mpd|\.mp4|\.webm|\.m4v|videoplayback|mime=video|type=video/i.test(u)) return;
    if (/\.ts(?:\?|$)/i.test(u)) return;
    try {
      const payload = JSON.stringify({ url: u, pageUrl: location.href || "" });
      if (typeof vdmSniff === "function") {
        vdmSniff(payload);
      }
    } catch (e) {}
  }
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (_m, url) {
    try { report(String(url)); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  if (window.fetch) {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      try {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        report(String(u));
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }
})();
"""
