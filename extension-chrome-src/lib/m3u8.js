(function () {
  const VDM = self.VDM;

  VDM.parseM3u8 = (text, baseUrl) => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const playlists = [];
    const segments = [];
    let bandwidth = 0;
    let resolution = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const bw = line.match(/BANDWIDTH=(\d+)/i);
        bandwidth = bw ? parseInt(bw[1], 10) : 0;
        const res = line.match(/RESOLUTION=\d+x(\d+)/i);
        resolution = res ? parseInt(res[1], 10) : 0;
        const next = lines[i + 1];
        if (next && !next.startsWith("#")) {
          playlists.push({
            url: VDM.resolveUrl(baseUrl, next),
            bandwidth,
            resolution,
          });
          i++;
        }
      } else if (line.startsWith("#EXTINF")) {
        const durMatch = line.match(/#EXTINF:([\d.]+)/);
        const duration = durMatch ? parseFloat(durMatch[1]) : 0;
        const next = lines[i + 1];
        if (next && !next.startsWith("#")) {
          segments.push({
            url: VDM.resolveUrl(baseUrl, next),
            duration,
          });
          i++;
        }
      }
    }

    return {
      isVariant: playlists.length > 0,
      playlists,
      segments,
      targetDuration: 0,
    };
  };

  VDM.m3u8Meta = (playlist, bandwidth = 0) => {
    let duration = playlist.segments.reduce((s, seg) => s + (seg.duration || 0), 0);
    let estimatedSize = 0;
    if (bandwidth && duration) estimatedSize = Math.floor((bandwidth * duration) / 8);
    return { duration, estimatedSize };
  };

  VDM.fetchM3u8 = async (url, video) => {
    const referer = VDM.bestReferer(url, video.pageUrl, video.referer);
    video.referer = referer;
    VDM.log("info", "開始解析 M3U8", `${VDM.shortUrl(url)}\nReferer: ${referer.slice(0, 80)}`);

    if (video.tabId) {
      try {
        const text = await VDM.fetchTextInPage(video.tabId, url, video);
        const parsed = VDM.parseM3u8(text, url);
        VDM.log(
          "info",
          "M3U8 解析完成",
          parsed.isVariant
            ? `主清單，${parsed.playlists.length} 條變體`
            : `${parsed.segments.length} 個片段`
        );
        return parsed;
      } catch (err) {
        VDM.log("warn", "分頁內 M3U8 失敗，嘗試背景", err.message || String(err));
      }
    } else {
      VDM.log("warn", "無 tabId", "請在影片分頁開啟擴充後下載");
    }

    const headers = await VDM.buildHeaders(video, url, { forBackground: true });
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return VDM.parseM3u8(text, url);
    } catch (err) {
      const msg = err.message || String(err);
      VDM.log("error", "M3U8 下載失敗", msg);
      throw new Error(
        video.tabId
          ? `M3U8 失敗：${msg}（請確認影片分頁仍開啟且正在播放）`
          : `M3U8 失敗：${msg}`
      );
    }
  };
})();
