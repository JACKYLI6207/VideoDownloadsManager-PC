(function () {
  const VDM = self.VDM;

  VDM.VIDEO_EXTENSIONS = new Set([
    "mp4", "webm", "mkv", "mov", "avi", "flv", "m4v", "3gp", "ts", "m3u8", "mpd",
  ]);

  VDM.MIN_MAIN_QUALITY = 360;
  VDM.MIN_MAIN_BYTES = 800_000;
  VDM.MAX_VIDEOS_PER_PAGE = 6;

  VDM.AD_URL_PATTERNS = [
    /(?:^|[/._-])ads?(?:[./_-]|$)/i,
    /advert/i,
    /preroll/i,
    /midroll/i,
    /postroll/i,
    /vast/i,
    /doubleclick/i,
    /googlesyndication/i,
    /adserver/i,
    /\/ad\//i,
    /creative/i,
    /promo/i,
    /imasdk/i,
    /gampad/i,
    /pubads/i,
    /adnxs/i,
    /taboola/i,
    /outbrain/i,
    /teads/i,
  ];

  VDM.guessQuality = (url, text = "") => {
    const combined = `${url} ${text}`;
    const m = combined.match(/(\d{3,4})[pP]|RESOLUTION=(\d+)x(\d+)/i);
    if (m) {
      for (const g of m.slice(1)) {
        if (g) {
          const val = parseInt(g, 10);
          if (val >= 240) return Math.min(val, 4320);
        }
      }
    }
    if (/2160|4k/i.test(combined)) return 2160;
    if (/1440/.test(combined)) return 1440;
    if (/1080/.test(combined)) return 1080;
    if (/720/.test(combined)) return 720;
    if (/480/.test(combined)) return 480;
    if (/360/.test(combined)) return 360;
    return 0;
  };

  VDM.extensionFromUrl = (url) => {
    try {
      const path = new URL(url).pathname.toLowerCase();
      const i = path.lastIndexOf(".");
      return i >= 0 ? path.slice(i + 1) : "";
    } catch {
      return "";
    }
  };

  VDM.isVideoUrl = (url) => {
    if (!url || /^(data:|blob:|javascript:|about:)/i.test(url)) return false;
    const lower = url.toLowerCase();
    if (/\.m3u8(?:\?|$)/i.test(lower)) return true;
    const ext = VDM.extensionFromUrl(url);
    if (VDM.VIDEO_EXTENSIONS.has(ext)) return true;
    return /\/video\/|videoplayback|mime=video|type=video/i.test(lower);
  };

  VDM.normalizeUrl = (url) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
    } catch {
      return url;
    }
  };

  VDM.isPreviewClip = (url, size = 0) => {
    const name = url.split("?")[0].split("/").pop().toLowerCase();
    if (/preview|thumb|trailer|sample|teaser/.test(name)) {
      return size === 0 || size < 5_000_000;
    }
    return false;
  };

  VDM.isYoutubeUrl = (url) => /youtube\.com|youtu\.be/i.test(url || "");

  VDM.isLikelyAdUrl = (url) => VDM.AD_URL_PATTERNS.some((re) => re.test(url || ""));

  VDM.POSTER_SKIP_PATTERNS = [
    /favicon/i,
    /sprite/i,
    /\blogo\b/i,
    /\bicon/i,
    /avatar/i,
    /badge/i,
    /1x1/i,
    /pixel/i,
    /tracking/i,
    /analytics/i,
    /beacon/i,
    /emoji/i,
    /flag/i,
    /spacer/i,
  ];

  VDM.isPosterImageUrl = (url) => {
    if (!url || /^(data:|blob:|javascript:)/i.test(url)) return false;
    if (VDM.isLikelyAdUrl(url)) return false;
    const lower = url.toLowerCase();
    if (VDM.POSTER_SKIP_PATTERNS.some((re) => re.test(lower))) return false;
    if (/\b(16|32|48|64|96)x(16|32|48|64|96)\b/i.test(lower)) return false;
    const ext = VDM.extensionFromUrl(url);
    if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) {
      if (/banner|widget|button|nav|menu|footer|header|social|share|\bad\b|ads\b/i.test(lower)) {
        return false;
      }
      return true;
    }
    return /poster|cover|thumb|thumbnail|keyart|fanart|sample/i.test(lower);
  };

  VDM.segmentProgressPct = (done, total) => {
    if (!total || total <= 0 || !done || done <= 0) return 0;
    const raw = (done * 100) / total;
    if (raw > 0 && raw < 1) return 1;
    return Math.min(100, Math.floor(raw));
  };

  VDM.scorePosterUrl = (url) => {
    let score = 0;
    const lower = String(url || "").toLowerCase();
    if (/poster/i.test(lower)) score += 120;
    if (/cover/i.test(lower)) score += 100;
    if (/keyart|fanart/i.test(lower)) score += 90;
    if (/thumb/i.test(lower)) score += 70;
    if (/\.jpe?g(?:\?|$)/i.test(lower)) score += 25;
    if (/preview|sample|splash/i.test(lower)) score += 20;
    if (/small|mini|tiny|low/i.test(lower)) score -= 50;
    if (/banner|widget|social|share/i.test(lower)) score -= 80;
    return score;
  };

  VDM.hasDisplayMeta = (video) =>
    (video.quality > 0) || (video.size > 0) || (video.duration > 0);

  VDM.isGenericHlsTitle = (title) =>
    !title || /^HLS(\s|$|stream)/i.test(String(title).trim());

  VDM.normalizeDownloadPath = (path) => {
    const raw = String(path || "VideoDownloadsManager").replace(/\\/g, "/").trim();
    if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith("/")) return "VideoDownloadsManager";
    const parts = raw
      .split("/")
      .map((seg) => seg.replace(/[<>:"|?*]/g, "_").trim())
      .filter((seg) => seg && seg !== "." && seg !== "..");
    return parts.join("/") || "VideoDownloadsManager";
  };

  VDM.guessMasterM3u8Candidates = (url) => {
    const out = [];
    const add = (u) => {
      if (!u || u === url) return;
      if (!out.includes(u)) out.push(u);
    };
    try {
      const u = new URL(url);
      if (!/\.m3u8/i.test(u.pathname)) return out;
      const parts = u.pathname.split("/").filter(Boolean);
      const names = ["index.m3u8", "master.m3u8", "playlist.m3u8", "manifest.m3u8"];
      for (let drop = 1; drop <= 2 && parts.length > drop; drop++) {
        const base = parts.slice(0, -drop);
        for (const name of names) {
          add(`${u.origin}/${[...base, name].join("/")}`);
        }
      }
      const stripped = u.pathname
        .replace(/\/(?:\d{3,4}[pP]?|low|mid|high|source)\/[^/]*$/i, "")
        .replace(/\/(?:480|720|1080|360|240|2160)[pP]?(?:\/[^/]*)?$/i, "");
      if (stripped && stripped !== u.pathname) {
        const dir = stripped.endsWith("/") ? stripped : `${stripped}/`;
        for (const name of names) {
          add(`${u.origin}${dir}${name}`);
        }
      }
    } catch {
      /* ignore */
    }
    return out;
  };

  VDM.prioritizeSniffUrls = (urls) => {
    const masters = [];
    const m3u8 = [];
    const other = [];
    for (const u of urls) {
      if (/master|index\.m3u8|manifest\.m3u8/i.test(u)) masters.push(u);
      else if (/\.m3u8/i.test(u)) m3u8.push(u);
      else other.push(u);
    }
    return [...new Set([...masters, ...m3u8, ...other])].slice(0, 10);
  };

  VDM.scoreVideo = (url, quality, size = 0, isM3u8 = false) => {
    let score = quality * 10;
    if (size > 0) score += Math.min(Math.floor(size / 1_048_576), 500);
    if (isM3u8) score += 50;
    if (VDM.isLikelyAdUrl(url)) score -= 10_000;
    if (quality && quality < VDM.MIN_MAIN_QUALITY) score -= 500;
    if (size && size < VDM.MIN_MAIN_BYTES) score -= 300;
    return score;
  };
})();
