(function () {
  const VDM = self.VDM;

  VDM.DownloadEngine = class DownloadEngine {
    constructor() {
      this.tasks = new Map();
      this.controllers = new Map();
      this.paused = new Set();
      this.waitQueue = [];
      this.runningCount = 0;
      this.activeRuns = new Set();
    }

    enqueue(task, onProgress) {
      this.waitQueue.push({ task, onProgress });
      this.pumpQueue();
    }

    pumpQueue() {
      const max = VDM.clampConcurrentTasks(VDM.maxConcurrentTasks);
      while (this.runningCount < max && this.waitQueue.length) {
        const item = this.waitQueue.shift();
        if (!this.tasks.has(item.task.id)) continue;
        this.runningCount++;
        this.start(item.task, item.onProgress).finally(() => {
          this.runningCount = Math.max(0, this.runningCount - 1);
          this.pumpQueue();
        });
      }
    }

    listActive() {
      return [...this.tasks.values()].filter((t) =>
        ["pending", "downloading", "merging", "paused", "failed"].includes(t.status)
      );
    }

    createTask(video, fileName) {
      const task = {
        id: VDM.uid(),
        video,
        fileName: VDM.sanitizeFilename(fileName) + ".mp4",
        status: "pending",
        progress: 0,
        downloadProgress: 0,
        mergeProgress: 0,
        merged: 0,
        speed: 0,
        downloaded: 0,
        total: 0,
        error: "",
        startedAt: Date.now(),
      };
      this.tasks.set(task.id, task);
      this.controllers.set(task.id, new AbortController());
      return task;
    }

    restoreTask(snap) {
      if (!snap?.id || this.tasks.has(snap.id)) return;
      if (!["pending", "downloading", "merging", "paused", "failed"].includes(snap.status)) {
        return;
      }
      const task = {
        id: snap.id,
        video: VDM.sanitizeTaskVideo(snap.video),
        fileName: snap.fileName,
        status: "paused",
        progress: snap.progress || 0,
        downloadProgress: snap.downloadProgress || 0,
        mergeProgress: snap.mergeProgress || 0,
        merged: snap.merged || 0,
        speed: 0,
        downloaded: snap.downloaded || 0,
        total: snap.total || 0,
        error: "瀏覽器已重新開啟，可點「繼續」接續或「從頭下載」從頭開始",
        startedAt: snap.startedAt || Date.now(),
      };
      this.tasks.set(task.id, task);
      this.controllers.set(task.id, new AbortController());
      this.paused.add(task.id);
    }

    pause(taskId) {
      const t = this.tasks.get(taskId);
      if (!t || !["pending", "downloading", "merging"].includes(t.status)) return;
      this.paused.add(taskId);
      t.status = "paused";
      VDM.clearFetchBlocked(t.video);
      const ctrl = this.controllers.get(taskId);
      if (ctrl && !ctrl.signal.aborted) ctrl.abort();
    }

    resume(taskId, onProgress) {
      const t = this.tasks.get(taskId);
      if (!t || t.status !== "paused") return false;
      this.paused.delete(taskId);
      VDM.clearFetchBlocked(t.video);
      t.error = "";
      this.controllers.set(taskId, new AbortController());
      t.status = "pending";
      this.enqueue(t, onProgress);
      return true;
    }

    _pauseOnFetchError(task, err, onProgress) {
      const msg = err?.message || String(err || "");
      if (msg === "cancelled") return false;
      this.paused.add(task.id);
      task.status = "paused";
      task.error = `${msg}（已暫停，請點「繼續」接續下載）`;
      VDM.clearFetchBlocked(task.video);
      onProgress(task);
      return true;
    }

    cancel(taskId) {
      this.waitQueue = this.waitQueue.filter((item) => item.task.id !== taskId);
      this.paused.delete(taskId);
      const ctrl = this.controllers.get(taskId);
      if (ctrl) ctrl.abort();
      const t = this.tasks.get(taskId);
      if (t) {
        t.status = "cancelled";
        if (VDM.opfsAvailable() && t.video?.id) {
          VDM.opfsRemoveTask(t.video.id).catch(() => {});
        }
      }
      this.tasks.delete(taskId);
      this.controllers.delete(taskId);
    }

    async retry(taskId, onProgress) {
      const t = this.tasks.get(taskId);
      if (!t || !["paused", "failed"].includes(t.status)) return false;

      this.waitQueue = this.waitQueue.filter((item) => item.task.id !== taskId);
      this.paused.delete(taskId);
      VDM.clearFetchBlocked(t.video);
      const segTotal = t.total || 0;
      const mergeDone =
        segTotal > 0 &&
        (await VDM.opfsMergeComplete(t.video.id, segTotal).catch(() => false));
      if (mergeDone) {
        this.controllers.set(taskId, new AbortController());
        t.status = "merging";
        t.progress = 99;
        t.mergeProgress = 100;
        t.downloadProgress = 100;
        t.error = "";
        onProgress(t);
        try {
          await VDM.saveOpfsMergedViaBridge(t.video.id, t.fileName);
          t.status = "completed";
          t.progress = 100;
          this.tasks.delete(taskId);
          this.controllers.delete(taskId);
          onProgress(t);
          return true;
        } catch (e) {
          t.status = "failed";
          t.error = e.message || String(e);
          onProgress(t);
          return false;
        }
      }

      if (VDM.opfsAvailable() && t.video?.id) {
        await VDM.opfsRemoveTask(t.video.id).catch(() => {});
      }

      this.controllers.set(taskId, new AbortController());
      this.paused.delete(taskId);
      t.status = "pending";
      t.progress = 0;
      t.downloadProgress = 0;
      t.mergeProgress = 0;
      t.merged = 0;
      t.downloaded = 0;
      t.total = 0;
      t.speed = 0;
      t.error = "";
      this.enqueue(t, onProgress);
      return true;
    }

    async _waitIfPaused(taskId) {
      while (this.paused.has(taskId)) {
        const t = this.tasks.get(taskId);
        if (!t || t.status === "cancelled") throw new Error("cancelled");
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    _updateSpeed(task, downloaded, state) {
      const now = Date.now();
      if (now - state.lastTime >= 400) {
        const elapsed = (now - state.lastTime) / 1000;
        if (elapsed > 0) task.speed = Math.max(0, (downloaded - state.lastBytes) / elapsed);
        state.lastTime = now;
        state.lastBytes = downloaded;
      }
    }

    async _saveOutput(task, blob, fileName) {
      const path = VDM.buildDownloadPath(fileName);
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        const url = URL.createObjectURL(blob);
        try {
          return await chrome.downloads.download({ url, filename: path, saveAs: false });
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
      }
      return VDM.saveBlobViaOffscreen(blob, path);
    }

    async _saveBlob(blob, fileName) {
      return this._saveOutput(null, blob, fileName);
    }

    _useDiskCache() {
      return VDM.useDiskCache !== false && VDM.opfsAvailable();
    }

    async start(task, onProgress) {
      if (this.paused.has(task.id)) {
        task.status = "paused";
        onProgress(task);
        return;
      }
      const signal = this.controllers.get(task.id)?.signal;
      this.activeRuns.add(task.id);
      task.status = "downloading";
      onProgress(task);
      try {
        if (task.video.isM3u8 || /\.m3u8/i.test(task.video.url)) {
          await this._downloadHls(task, signal, onProgress);
        } else {
          await this._downloadHttp(task, signal, onProgress);
        }
        if (task.status === "paused" || this.paused.has(task.id)) {
          task.status = "paused";
        } else if (signal?.aborted) {
          task.status = "cancelled";
        } else {
          task.status = "completed";
          task.progress = 100;
          this.tasks.delete(task.id);
          this.controllers.delete(task.id);
        }
      } catch (err) {
        if (task.status === "paused" || this.paused.has(task.id)) {
          task.status = "paused";
          onProgress(task);
          return;
        }
        if (signal?.aborted || err.message === "cancelled") {
          task.status = "cancelled";
        } else {
          task.status = "failed";
          task.error = err.message || String(err);
          const segTotal = task.total || 0;
          if (
            task.video?.id &&
            segTotal > 0 &&
            (await VDM.opfsMergeComplete(task.video.id, segTotal).catch(() => false))
          ) {
            task.error = `${task.error}（已全部合併，請點「從頭下載」僅重試存檔）`;
          }
        }
        if (VDM.opfsAvailable() && task.video?.id && task.status === "cancelled") {
          VDM.opfsRemoveTask(task.video.id).catch(() => {});
        }
      } finally {
        this.activeRuns.delete(task.id);
      }
      onProgress(task);
    }

    _isBanStatus(status) {
      return status === 403 || status === 401 || status === 429;
    }

    async _fetchSegment(video, url, signal) {
      if (VDM.isFetchBlocked(video)) {
        throw new Error(VDM.fetchBlockedError(video));
      }
      await VDM.acquireSegmentSlot(signal);
      try {
        const headers = await VDM.buildHeaders(video, url, { forBackground: true });
        try {
          const res = await fetch(url, { headers, signal });
          if (res.ok) return res.arrayBuffer();
          if (this._isBanStatus(res.status)) {
            VDM.markFetchBlocked(video, res.status);
            throw new Error(VDM.fetchBlockedError(video));
          }
          if (video.tabId && !VDM.isFetchBlocked(video)) {
            return VDM.fetchBytesInPage(video.tabId, url, video);
          }
          throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          if (VDM.isFetchBlocked(video)) throw err;
          if (video.tabId && !/\bHTTP (403|401|429)\b/.test(err.message || "")) {
            try {
              return await VDM.fetchBytesInPage(video.tabId, url, video);
            } catch (pageErr) {
              if (/\bHTTP (403|401|429)\b/.test(pageErr.message || "")) {
                VDM.markFetchBlocked(video, 403);
                throw new Error(VDM.fetchBlockedError(video));
              }
            }
          }
          throw new Error(
            VDM.isFetchNetworkError(err) ? "Failed to fetch（請保持影片分頁開啟）" : err.message
          );
        }
      } finally {
        VDM.releaseSegmentSlot();
      }
    }

    async _downloadHttp(task, signal, onProgress) {
      const video = task.video;
      const headers = await VDM.buildHeaders(video, video.url);
      const res = await fetch(video.url, { headers, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const total = parseInt(res.headers.get("content-length") || "0", 10);
      task.total = total;

      if (total > 1_048_576 && res.headers.get("accept-ranges")?.toLowerCase() === "bytes") {
        await this._downloadRanges(task, video.url, headers, total, signal, onProgress);
        return;
      }

      const reader = res.body.getReader();
      const chunks = [];
      let downloaded = 0;
      const state = { lastTime: Date.now(), lastBytes: 0 };

      while (true) {
        await this._waitIfPaused(task.id);
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.length;
        task.downloaded = downloaded;
        if (total) task.progress = Math.min(99, (downloaded * 100) / total);
        this._updateSpeed(task, downloaded, state);
        onProgress(task);
      }

      const blob = new Blob(chunks, { type: "video/mp4" });
      task.status = "merging";
      task.progress = 99;
      onProgress(task);
      await this._saveBlob(blob, task.fileName);
    }

    async _downloadRanges(task, url, headers, total, signal, onProgress) {
      let connections = VDM.maxConnections || 3;
      if (total < 10_485_760) connections = Math.min(2, connections);
      else if (total < 52_428_800) connections = Math.min(4, connections);
      connections = Math.min(connections, VDM.maxConnections || 3);
      const chunk = Math.floor(total / connections);
      const parts = [];

      for (let i = 0; i < connections; i++) {
        const start = i * chunk;
        const end = i === connections - 1 ? total - 1 : start + chunk - 1;
        parts.push({ start, end, index: i });
      }

      const buffers = new Array(connections);
      let downloaded = 0;
      const state = { lastTime: Date.now(), lastBytes: 0 };

      await Promise.all(
        parts.map(async ({ start, end, index }) => {
          await VDM.acquireSegmentSlot(signal);
          try {
            const res = await fetch(url, {
              headers: { ...headers, Range: `bytes=${start}-${end}` },
              signal,
            });
            if (!res.ok) throw new Error(`Range HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            buffers[index] = buf;
            downloaded += buf.byteLength;
            task.downloaded = downloaded;
            task.total = total;
            task.progress = Math.min(95, (downloaded * 95) / total);
            this._updateSpeed(task, downloaded, state);
            onProgress(task);
          } finally {
            VDM.releaseSegmentSlot();
          }
        })
      );

      const blob = new Blob(buffers, { type: "video/mp4" });
      task.status = "merging";
      task.progress = 99;
      onProgress(task);
      await this._saveBlob(blob, task.fileName);
    }

    async _downloadHls(task, signal, onProgress) {
      if (this._useDiskCache()) {
        await this._downloadHlsDisk(task, signal, onProgress);
      } else {
        await this._downloadHlsMemory(task, signal, onProgress);
      }
    }

    async _downloadHlsMemory(task, signal, onProgress) {
      const video = task.video;
      const playlist = await VDM.fetchM3u8(video.url, video);
      const segments = playlist.segments.map((s) => s.url);
      if (!segments.length) throw new Error("M3U8 沒有片段");

      task.total = segments.length;
      task.status = "downloading";
      const buffers = new Array(segments.length);
      let completed = 0;
      let downloadedBytes = 0;
      const state = { lastTime: Date.now(), lastBytes: 0 };
      const queue = [...segments.entries()];
      const workers = VDM.getWorkerCount(segments.length);
      let halt = false;

      const worker = async () => {
        while (queue.length && !halt) {
          if (signal?.aborted) throw new Error("cancelled");
          await this._waitIfPaused(task.id);
          const item = queue.shift();
          if (!item) break;
          const [idx, segUrl] = item;
          try {
            const buf = await this._fetchSegment(video, segUrl, signal);
            buffers[idx] = buf;
            completed++;
            downloadedBytes += buf.byteLength;
            task.downloaded = completed;
            task.progress = Math.min(90, (completed * 90) / segments.length);
            this._updateSpeed(task, downloadedBytes, state);
            onProgress(task);
          } catch (e) {
            if (signal?.aborted || e.message === "cancelled") {
              if (this.paused.has(task.id)) return;
              throw e;
            }
            halt = true;
            this._pauseOnFetchError(task, e, onProgress);
            return;
          }
        }
      };

      await Promise.all(Array.from({ length: workers }, () => worker()));
      if (this.paused.has(task.id) || task.status === "paused") return;
      if (halt) return;

      task.status = "merging";
      task.progress = 92;
      onProgress(task);

      const merged = VDM.concatBuffers(buffers);
      const blob = new Blob([merged], { type: "video/mp4" });
      task.progress = 99;
      onProgress(task);
      await this._saveBlob(blob, task.fileName);
    }

    async _downloadHlsDisk(task, signal, onProgress) {
      const video = task.video;
      const cacheKey = video.id;

      const playlist = await VDM.fetchM3u8(video.url, video);
      const segments = playlist.segments.map((s) => s.url);
      if (!segments.length) throw new Error("M3U8 沒有片段");

      if (await VDM.opfsMergeComplete(cacheKey, segments.length)) {
        task.total = segments.length;
        task.downloaded = segments.length;
        task.merged = segments.length;
        task.downloadProgress = 100;
        task.mergeProgress = 100;
        task.progress = 99;
        task.status = "merging";
        onProgress(task);
        await VDM.saveOpfsMergedViaBridge(cacheKey, task.fileName);
        return;
      }

      task.total = segments.length;
      task.status = "downloading";
      const mergedThrough = await VDM.opfsMergedThrough(cacheKey, segments.length);
      await VDM.opfsSanitizeSegments(cacheKey, segments.length, mergedThrough);
      task.merged = mergedThrough;
      task.downloaded = await VDM.opfsBufferedCount(cacheKey, segments.length, mergedThrough);
      task.downloadProgress = VDM.segmentProgressPct(task.downloaded, segments.length);
      task.mergeProgress = VDM.segmentProgressPct(mergedThrough, segments.length);
      let downloadedBytes = 0;
      const state = { lastTime: Date.now(), lastBytes: 0 };
      const needIndices = await VDM.opfsSegmentsToFetch(cacheKey, segments.length, mergedThrough);
      const queue = needIndices.map((idx) => [idx, segments[idx]]);
      const workers = VDM.getWorkerCount(Math.max(1, queue.length));
      const merger = VDM.createOpfsStreamMerger(cacheKey, segments.length, {
        startAppend: mergedThrough,
      });
      let halt = false;

      const onMergeProgress = (done, total, bytes) => {
        downloadedBytes = bytes;
        task.merged = done;
        task.mergeProgress = VDM.segmentProgressPct(done, total);
        task.progress = task.mergeProgress;
        this._updateSpeed(task, downloadedBytes, state);
        VDM.opfsWriteMergeMeta(cacheKey, done).catch(() => {});
        onProgress(task);
      };

      if (task.downloaded > mergedThrough) {
        await merger.onSegmentWritten(onMergeProgress);
        task.downloaded = await VDM.opfsBufferedCount(cacheKey, segments.length, task.merged);
        task.downloadProgress = VDM.segmentProgressPct(task.downloaded, segments.length);
      }

      const worker = async () => {
        while (queue.length && !halt) {
          if (signal?.aborted) throw new Error("cancelled");
          await this._waitIfPaused(task.id);
          const item = queue.shift();
          if (!item) break;
          const [idx, segUrl] = item;
          try {
            const buf = await this._fetchSegment(video, segUrl, signal);
            await VDM.opfsWriteSegment(cacheKey, idx, buf);
            task.downloaded = await VDM.opfsBufferedCount(
              cacheKey,
              segments.length,
              task.merged
            );
            task.downloadProgress = VDM.segmentProgressPct(task.downloaded, segments.length);
            await merger.onSegmentWritten(onMergeProgress);
            this._updateSpeed(task, downloadedBytes, state);
            onProgress(task);
          } catch (e) {
            if (signal?.aborted || e.message === "cancelled") {
              if (this.paused.has(task.id)) return;
              throw e;
            }
            halt = true;
            this._pauseOnFetchError(task, e, onProgress);
            return;
          }
        }
      };

      await Promise.all(Array.from({ length: workers }, () => worker()));
      if (this.paused.has(task.id) || task.status === "paused") return;
      if (halt) return;

      task.status = "merging";
      onProgress(task);
      await merger.finish(onMergeProgress);
      await VDM.opfsWriteMergeMeta(cacheKey, segments.length).catch(() => {});

      task.downloadProgress = 100;
      task.mergeProgress = 100;
      task.progress = 99;
      onProgress(task);
      await VDM.saveOpfsMergedViaBridge(cacheKey, task.fileName);
    }
  };

  VDM.concatBuffers = (buffers) => {
    const total = buffers.reduce((s, b) => s + (b?.byteLength || 0), 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const buf of buffers) {
      if (!buf) continue;
      out.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }
    return out;
  };
})();
