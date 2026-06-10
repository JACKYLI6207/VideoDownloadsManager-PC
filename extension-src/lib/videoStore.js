(function () {
  const VDM = self.VDM;

  VDM.createVideo = (fields) => ({
    id: VDM.uid(),
    url: fields.url,
    pageUrl: fields.pageUrl,
    tabId: fields.tabId,
    title: fields.title || "",
    quality: fields.quality || 0,
    mimeType: fields.mimeType || "video/mp4",
    referer: fields.referer || fields.pageUrl || "",
    userAgent: fields.userAgent || VDM.USER_AGENT,
    requestHeaders: fields.requestHeaders || null,
    size: fields.size || 0,
    duration: fields.duration || 0,
    isM3u8: !!fields.isM3u8,
    posterUrl: fields.posterUrl || "",
  });

  VDM.mergeVideoMeta = (existing, incoming) => {
    if (incoming.size > existing.size) existing.size = incoming.size;
    if (incoming.duration > existing.duration) existing.duration = incoming.duration;
    if (incoming.quality > existing.quality) existing.quality = incoming.quality;
    if (
      incoming.title &&
      (!existing.title || VDM.isGenericHlsTitle(existing.title))
    ) {
      existing.title = incoming.title;
    }
    if (incoming.requestHeaders && !existing.requestHeaders) {
      existing.requestHeaders = incoming.requestHeaders;
    }
    if (incoming.posterUrl && !existing.posterUrl) {
      existing.posterUrl = incoming.posterUrl;
    }
  };

  VDM.trimPageVideos = (items) => {
    let filtered = items.filter((v) => !VDM.isLikelyAdUrl(v.url));
    const mainItems = filtered.filter((v) => !VDM.isPreviewClip(v.url, v.size));
    if (mainItems.length) filtered = mainItems;
    const hasHigh = filtered.some((v) => v.quality >= VDM.MIN_MAIN_QUALITY);
    if (hasHigh) {
      filtered = filtered.filter((v) => v.quality >= VDM.MIN_MAIN_QUALITY || v.quality === 0);
    }
    filtered = filtered.filter(
      (v) => v.size === 0 || v.size >= VDM.MIN_MAIN_BYTES || v.isM3u8
    );
    filtered = filtered.filter((v) => VDM.hasDisplayMeta(v));
    filtered.sort(
      (a, b) =>
        VDM.scoreVideo(b.url, b.quality, b.size, b.isM3u8) -
        VDM.scoreVideo(a.url, a.quality, a.size, a.isM3u8)
    );
    return filtered.slice(0, VDM.MAX_VIDEOS_PER_PAGE);
  };

  VDM.VideoStore = class VideoStore {
    constructor() {
      this.byPage = new Map();
      this.byTab = new Map();
    }

    pageKey(tabId, pageUrl) {
      return `${tabId}::${pageUrl}`;
    }

    add(video) {
      if (VDM.isLikelyAdUrl(video.url)) return false;
      const key = this.pageKey(video.tabId, video.pageUrl);
      const items = this.byPage.get(key) || [];
      const norm = VDM.normalizeUrl(video.url);
      for (const existing of items) {
        if (VDM.normalizeUrl(existing.url) === norm) {
          VDM.mergeVideoMeta(existing, video);
          return false;
        }
      }
      items.push(video);
      const trimmed = VDM.trimPageVideos(items);
      this.byPage.set(key, trimmed);
      return trimmed.some((v) => v.id === video.id);
    }

    get(tabId, pageUrl) {
      const exact = this.byPage.get(this.pageKey(tabId, pageUrl));
      if (exact?.length) return [...exact];
      return this.getForTab(tabId);
    }

    getForTab(tabId) {
      const all = [];
      for (const [key, items] of this.byPage.entries()) {
        if (key.startsWith(`${tabId}::`)) all.push(...items);
      }
      if (!all.length) return [];
      const seen = new Set();
      const unique = [];
      for (const v of all) {
        const norm = VDM.normalizeUrl(v.url);
        if (seen.has(norm)) continue;
        seen.add(norm);
        unique.push(v);
      }
      return VDM.trimPageVideos(unique);
    }

    count(tabId, pageUrl) {
      return this.getForTab(tabId).length;
    }

    countForTab(tabId) {
      return this.getForTab(tabId).length;
    }

    listStreamUrlsForTab(tabId) {
      const urls = new Set();
      for (const [key, items] of this.byPage.entries()) {
        if (!key.startsWith(`${tabId}::`)) continue;
        for (const v of items) {
          if (!v.url) continue;
          if (v.isM3u8 || /\.m3u8|\.mp4|\.m4v|videoplayback/i.test(v.url)) {
            urls.add(v.url);
          }
        }
      }
      return [...urls];
    }

    clearTab(tabId) {
      for (const key of [...this.byPage.keys()]) {
        if (key.startsWith(`${tabId}::`)) this.byPage.delete(key);
      }
    }

    clearPage(tabId, pageUrl) {
      this.byPage.delete(this.pageKey(tabId, pageUrl));
    }

    setTabUrl(tabId, pageUrl) {
      this.byTab.set(tabId, pageUrl);
    }

    getTabUrl(tabId) {
      return this.byTab.get(tabId) || "";
    }

    async persist() {
      const data = Object.fromEntries(this.byPage);
      const tabs = Object.fromEntries(this.byTab);
      await chrome.storage.session.set({ vdmVideos: data, vdmTabUrls: tabs });
    }

    async restore() {
      const { vdmVideos = {}, vdmTabUrls = {} } = await chrome.storage.session.get([
        "vdmVideos",
        "vdmTabUrls",
      ]);
      this.byPage = new Map(Object.entries(vdmVideos));
      this.byTab = new Map(
        Object.entries(vdmTabUrls).map(([k, v]) => [Number(k), v])
      );
    }
  };
})();
