(function () {
  const VDM = self.VDM;

  /**
   * OPFS 合併完成後存檔。
   * 大檔（>64MB）只允許 FSA 分塊串流；禁止 fallback 到 bridge blob URL（Crashpad 已確認會 OOM 崩潰）。
   */
  async function saveOpfsOutput(videoId, fileName) {
    const size = await VDM.opfsGetMergedSize(videoId).catch(() => 0);
    const maxBridge = VDM.OPFS_BRIDGE_MAX_BYTES || 64 * 1024 * 1024;

    try {
      return await VDM.saveOpfsFileDirect(videoId, fileName);
    } catch (e) {
      if (size > maxBridge) {
        throw new Error(
          `${e.message || e}（已阻止橋接存檔，避免 Chrome 記憶體崩潰）`
        );
      }
      console.warn("VDM saveOpfsFileDirect failed, bridge fallback (small file):", e.message);
      return VDM.saveOpfsMergedViaBridge(videoId, fileName);
    }
  }

  VDM.DownloadEngine = class DownloadEngine {
    constructor() {
      this.tasks = new Map();
      this.controllers = new Map();
      this.paused = new Set();
      this.waitQueue = [];
      // 名額以 token 計（每次 start() 取得一個 token）。runningCount 由 token 數推得，
      // 而非靠 start() 的 .finally 手動 -1。如此即使某個 start() 因卡死（無逾時、
      // 不理 abort 的 fetchM3u8 / 分頁內 fetch 等）永不結算，仍能由看門狗回收名額。
      this.runningTokens = new Set();
      this.taskToken = new Map();
      this._tokenSeq = 0;
      this.activeRuns = new Set();
      this.runGen = new Map();
    }

    get runningCount() {
      return this.runningTokens.size;
    }
    set runningCount(_v) {
      /* 保留相容：名額改由 runningTokens 管理，忽略外部直接賦值 */
    }

    _freeSlot(taskId, token) {
      this.runningTokens.delete(token);
      if (this.taskToken.get(taskId) === token) this.taskToken.delete(taskId);
    }

    _bumpRun(taskId) {
      const next = (this.runGen.get(taskId) || 0) + 1;
      this.runGen.set(taskId, next);
      return next;
    }

    _runAlive(taskId, gen) {
      return (this.runGen.get(taskId) || 0) === gen;
    }

    _taskFullyComplete(task) {
      const hls = task.video?.isM3u8 || /\.m3u8/i.test(task.video?.url || "");
      if (hls && VDM.segmentsOnly !== false) {
        return task.total > 0 && (task.downloaded || 0) >= task.total;
      }
      if (hls && task.total > 0) return (task.merged || 0) >= task.total;
      if (task.total > 0) return (task.downloaded || 0) >= task.total;
      return (task.progress || 0) >= 99;
    }

    /** fetch/SW 中斷 → 暫停保留任務；只有使用者按「中斷」才 cancel */
    _abortToPaused(task, msg) {
      delete task._userPaused;
      this.paused.add(task.id);
      task.status = "paused";
      task.speed = 0;
      task.error = "";
      const text = msg || "連線中斷，將自動繼續下載";
      VDM.setTaskActivity(task, text);
    }

    enqueue(task, onProgress) {
      VDM.setTaskActivity(task, "排隊等待中…");
      this.waitQueue.push({ task, onProgress });
      this.pumpQueue();
    }

    pumpQueue() {
      const max = VDM.clampConcurrentTasks(VDM.maxConcurrentTasks);
      while (this.runningTokens.size < max && this.waitQueue.length) {
        const item = this.waitQueue.shift();
        if (!this.tasks.has(item.task.id)) continue;
        const token = ++this._tokenSeq;
        this.runningTokens.add(token);
        this.taskToken.set(item.task.id, token);
        this.start(item.task, item.onProgress).finally(() => {
          this._freeSlot(item.task.id, token);
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
        activity: "",
        hlsLanes: [],
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
        fetched: snap.fetched || snap.downloaded || 0,
        total: snap.total || 0,
        hlsLanes: Array.isArray(snap.hlsLanes) ? snap.hlsLanes.map((l) => ({ ...l })) : [],
        segmentDir: snap.segmentDir || "",
        segmentSubfolder:
          snap.segmentSubfolder !== undefined && snap.segmentSubfolder !== null
            ? snap.segmentSubfolder
            : undefined,
        importFsaKey: snap.importFsaKey || "",
        activity: snap.activity || (
          snap.total
            ? `還原暫停（下載 ${snap.downloaded || 0}/${snap.total}  ·  合併 ${snap.merged || 0}/${snap.total}）`
            : "瀏覽器已重新開啟，等待繼續"
        ),
        error: snap.error || "瀏覽器已重新開啟，可點「繼續」接續或「從頭下載」從頭開始",
        startedAt: snap.startedAt || Date.now(),
      };
      this.tasks.set(task.id, task);
      this.controllers.set(task.id, new AbortController());
      this.paused.add(task.id);
    }

    importTask(snap) {
      if (!snap?.id || this.tasks.has(snap.id)) return false;
      if (!snap?.video?.url) return false;
      if (!["pending", "downloading", "merging", "paused", "failed"].includes(snap.status)) {
        return false;
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
        fetched: snap.fetched || snap.downloaded || 0,
        total: snap.total || 0,
        hlsLanes: Array.isArray(snap.hlsLanes) ? snap.hlsLanes.map((l) => ({ ...l })) : [],
        segmentDir: snap.segmentDir || "",
        segmentSubfolder:
          snap.segmentSubfolder !== undefined && snap.segmentSubfolder !== null
            ? snap.segmentSubfolder
            : undefined,
        importFsaKey: snap.importFsaKey || "",
        activity: snap.activity || "已匯入，可點「繼續」接續下載",
        error: snap.error || "已匯入，可點「繼續」接續下載",
        startedAt: snap.startedAt || Date.now(),
      };
      this.tasks.set(task.id, task);
      this.controllers.set(task.id, new AbortController());
      this.paused.add(task.id);
      return true;
    }

    pause(taskId) {
      const t = this.tasks.get(taskId);
      if (!t || !["pending", "downloading", "merging"].includes(t.status)) return false;
      t._userPaused = true;
      this.waitQueue = this.waitQueue.filter((item) => item.task.id !== taskId);
      this.paused.add(taskId);
      t.status = "paused";
      t.speed = 0;
      t.error = "";
      if (t.total) {
        const saved = t.downloaded || 0;
        const inflight = t.fetched || 0;
        const extra =
          inflight > saved ? `（另有 ${inflight - saved} 段待存檔）` : "";
        VDM.setTaskActivity(
          t,
          VDM.segmentsOnly !== false && (t.video?.isM3u8 || /\.m3u8/i.test(t.video?.url || ""))
            ? `已暫停 · 存檔 ${saved}/${t.total}${extra}`
            : `已暫停（下載 ${saved}/${t.total}  ·  合併 ${t.merged || 0}/${t.total}）`
        );
      } else {
        VDM.setTaskActivity(t, "已暫停");
      }
      VDM.clearFetchBlocked(t.video);
      this._bumpRun(taskId);
      if (typeof VDM.fsaAbortOffscreenFetches === "function") {
        VDM.fsaAbortOffscreenFetches(taskId);
      }
      const ctrl = this.controllers.get(taskId);
      if (ctrl && !ctrl.signal.aborted) ctrl.abort();
      // 立即回收名額並補位（即使該任務的 start() 卡死也不影響其他任務）
      this.activeRuns.delete(taskId);
      const token = this.taskToken.get(taskId);
      if (token != null) this._freeSlot(taskId, token);
      this.pumpQueue();
      return true;
    }

    /**
     * 看門狗強制停滯暫停：偵測到「下載中」卻長時間零進度（卡死的 worker），
     * 中止其連線讓 start() 結算、回收並行名額；不設 _userPaused，背景會自動繼續。
     */
    stallPause(taskId, msg) {
      const t = this.tasks.get(taskId);
      if (!t || t.status !== "downloading") return false;
      delete t._userPaused;
      this.paused.add(taskId);
      t.status = "paused";
      t.speed = 0;
      t.error = "";
      VDM.setTaskActivity(t, msg || "連線停滯，將自動繼續…");
      this._bumpRun(taskId);
      if (typeof VDM.fsaAbortOffscreenFetches === "function") {
        VDM.fsaAbortOffscreenFetches(taskId);
      }
      const ctrl = this.controllers.get(taskId);
      if (ctrl && !ctrl.signal.aborted) ctrl.abort();
      // 立即釋放名額並補位：不等待可能卡死、不理會 abort 的 start() 結算。
      // 該卡死的 start() 之後若真的結算，_freeSlot 對已移除 token 是 no-op，不會誤扣。
      this.activeRuns.delete(taskId);
      const token = this.taskToken.get(taskId);
      if (token != null) this._freeSlot(taskId, token);
      this.pumpQueue();
      return true;
    }

    async resume(taskId, onProgress) {
      const t = this.tasks.get(taskId);
      if (!t || t.status !== "paused") return false;

      this._bumpRun(taskId);
      if (typeof VDM.fsaAbortOffscreenFetches === "function") {
        VDM.fsaAbortOffscreenFetches(taskId);
      }
      const staleCtrl = this.controllers.get(taskId);
      if (staleCtrl && !staleCtrl.signal.aborted) staleCtrl.abort();

      let waited = 0;
      while (this.activeRuns.has(taskId) && waited < 3000) {
        await new Promise((r) => setTimeout(r, 50));
        waited += 50;
      }
      if (this.activeRuns.has(taskId)) {
        this.activeRuns.delete(taskId);
      }

      delete t._userPaused;
      this.paused.delete(taskId);
      VDM.clearFetchBlocked(t.video);
      t.error = "";
      this.waitQueue = this.waitQueue.filter((item) => item.task.id !== taskId);
      this.controllers.set(taskId, new AbortController());
      t.status = "pending";
      VDM.setTaskActivity(t, "等待繼續下載…");
      this.enqueue(t, onProgress);
      return true;
    }

    _pauseOnFetchError(task, err, onProgress) {
      const msg = err?.message || String(err || "");
      if (msg === "cancelled") return false;
      VDM.diag?.("下載失敗→暫停",
        `id=${task.id} name=${task.fileName} importFsaKey=${task.importFsaKey || "(無)"} 錯誤=${msg}`);
      delete task._userPaused;
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
      this._bumpRun(taskId);
      const ctrl = this.controllers.get(taskId);
      if (ctrl) ctrl.abort();
      const t = this.tasks.get(taskId);
      if (t) {
        t.status = "cancelled";
        if (VDM.segmentsOnly === false && VDM.opfsAvailable() && t.video?.id) {
          VDM.opfsRemoveTask(t.video.id).catch(() => {});
        }
      }
      this.tasks.delete(taskId);
      this.controllers.delete(taskId);
      // 立即回收名額並補位，不等待可能卡死的 start() 結算
      this.activeRuns.delete(taskId);
      const token = this.taskToken.get(taskId);
      if (token != null) this._freeSlot(taskId, token);
      this.pumpQueue();
    }

    async retry(taskId, onProgress) {
      const t = this.tasks.get(taskId);
      if (!t || !["paused", "failed"].includes(t.status)) return false;

      this.waitQueue = this.waitQueue.filter((item) => item.task.id !== taskId);
      this.paused.delete(taskId);
      VDM.clearFetchBlocked(t.video);
      const segTotal = t.total || 0;
      const mergeDone =
        VDM.segmentsOnly === false &&
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
          await saveOpfsOutput(t.video.id, t.fileName);
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

      if (VDM.segmentsOnly === false && VDM.opfsAvailable() && t.video?.id) {
        await VDM.opfsRemoveTask(t.video.id).catch(() => {});
      } else if (VDM.segmentsOnly !== false) {
        if (t.video?.id) await VDM.opfsRemoveTask(t.video.id).catch(() => {});
        if (typeof VDM.fsaClearTaskDirViaOffscreen === "function") {
          const clearDir = VDM.resolveTaskSegmentDir(t);
          await VDM.fsaClearTaskDirViaOffscreen(clearDir, t.importFsaKey || "").catch(() => {});
        }
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

    /**
     * 合併背壓：下載不得超前合併超過 MERGE_LAG_MAX 段。
     * 日誌/Crashpad 顯示閃退發生在下載遠快於合併時（例：74% vs 18%），
     * OPFS 同時堆積大量 .ts + 週期性 commit 大檔 → Chrome storage 进程崩潰。
     */
    async _waitIfMergeLag(task, merger, onMergeProgress, onProgress) {
      const maxLag = 48;
      while (true) {
        if (this.paused.has(task.id)) throw new Error("cancelled");
        const lag = (task.downloaded || 0) - (task.merged || 0);
        if (lag <= maxLag) return;
        VDM.setTaskActivity(
          task,
          `合併趕進度（下載超前 ${lag} 段）${task.merged || 0}/${task.total}`
        );
        onProgress(task);
        await merger.onSegmentWritten(onMergeProgress);
        await new Promise((r) => setTimeout(r, 150));
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
      const runGen = this.runGen.get(task.id) || 0;
      this.activeRuns.add(task.id);
      task.status = "downloading";
      VDM.setTaskActivity(task, "準備下載…");
      onProgress(task);
      try {
        if (task.video.isM3u8 || /\.m3u8/i.test(task.video.url)) {
          await this._downloadHls(task, signal, onProgress, runGen);
        } else {
          await this._downloadHttp(task, signal, onProgress);
        }
        if (!this._runAlive(task.id, runGen)) return;
        if (task.status === "paused" || this.paused.has(task.id) || task._userPaused) {
          task.status = "paused";
          task.speed = 0;
        } else if (signal?.aborted) {
          this._abortToPaused(task);
        } else if (this._taskFullyComplete(task)) {
          task.status = "completed";
          task.progress = 100;
          this.tasks.delete(task.id);
          this.controllers.delete(task.id);
        } else if ((task.downloaded || 0) > 0 || (task.fetched || 0) > 0) {
          this._abortToPaused(task, "下載未完成，將自動繼續");
        }
      } catch (err) {
        // 此 start() 的 run 已被取代（看門狗 stallPause + 自動繼續會 bumpRun）：
        // 不可再改動共享 task 狀態，否則會把新的一輪誤踩成 paused/failed。
        if (!this._runAlive(task.id, runGen)) return;
        if (task.status === "paused" || this.paused.has(task.id) || task._userPaused) {
          task.status = "paused";
          task.speed = 0;
          onProgress(task);
          return;
        }
        if (signal?.aborted || err.message === "cancelled") {
          this._abortToPaused(task);
          onProgress(task);
          return;
        }
        task.status = "failed";
        task.error = err.message || String(err);
        VDM.diag?.("下載失敗（任務 failed）",
          `id=${task.id} name=${task.fileName} importFsaKey=${task.importFsaKey || "(無)"} 錯誤=${task.error}`);
        const segTotal = task.total || 0;
        if (
          task.video?.id &&
          segTotal > 0 &&
          (await VDM.opfsMergeComplete(task.video.id, segTotal).catch(() => false))
        ) {
          task.error = `${task.error}（已全部合併，請點「從頭下載」僅重試存檔）`;
        }
      } finally {
        this.activeRuns.delete(task.id);
      }
      onProgress(task);
    }

    _isBanStatus(status) {
      return status === 403 || status === 401 || status === 429;
    }

    /**
     * 建立「任務 signal + 逾時」合併中止器。
     * 連線停滯（socket 未斷但無資料）時，原生 fetch / arrayBuffer 不會自行結束，
     * 會讓 worker 永久卡在 await → start() 永不結算 → runningCount 名額被佔死。
     * 逾時觸發即中止該片段請求，讓任務轉為暫停並由背景自動繼續，回收並行名額。
     */
    _linkedTimeoutSignal(signal, timeoutMs) {
      const ctrl = new AbortController();
      let timedOut = false;
      const onAbort = () => ctrl.abort();
      if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, Math.max(1000, timeoutMs || 0));
      return {
        signal: ctrl.signal,
        timedOut: () => timedOut,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
        },
      };
    }

    async _fetchSegmentBody(video, url, signal) {
      const headers = await VDM.buildHeaders(video, url, { forBackground: true });
      const link = this._linkedTimeoutSignal(signal, VDM.SEGMENT_STALL_TIMEOUT_MS);
      try {
        const res = await fetch(url, { headers, signal: link.signal });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (!buf?.byteLength) throw new Error("空片段（0B）");
          if (buf.byteLength < 376) throw new Error(`片段過小 (${buf.byteLength}B)`);
          return buf;
        }
        if (this._isBanStatus(res.status)) {
          VDM.markFetchBlocked(video, res.status);
          throw new Error(VDM.fetchBlockedError(video));
        }
        if (video.tabId && !VDM.isFetchBlocked(video)) {
          const buf = await VDM.fetchBytesInPage(video.tabId, url, video);
          if (!buf?.byteLength) throw new Error("空片段（0B）");
          if (buf.byteLength < 376) throw new Error(`片段過小 (${buf.byteLength}B)`);
          return buf;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        // 逾時中止（非使用者暫停）：轉為可被自動繼續判定的網路錯誤
        if (link.timedOut() && !signal?.aborted) {
          throw new Error("片段下載逾時（連線停滯，將自動繼續）");
        }
        throw err;
      } finally {
        link.cleanup();
      }
    }

    async _fetchSegment(video, url, signal) {
      if (VDM.isFetchBlocked(video)) {
        throw new Error(VDM.fetchBlockedError(video));
      }
      await VDM.acquireSegmentSlot(signal);
      try {
        try {
          return await this._fetchSegmentBody(video, url, signal);
        } catch (err) {
          if (VDM.isFetchBlocked(video)) throw err;
          if (video.tabId && !/\bHTTP (403|401|429)\b/.test(err.message || "")) {
            try {
              const buf = await VDM.fetchBytesInPage(video.tabId, url, video);
              if (!buf?.byteLength) throw new Error("空片段（0B）");
              if (buf.byteLength < 376) throw new Error(`片段過小 (${buf.byteLength}B)`);
              return buf;
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

    /** 片段模式：SW 下載 → OPFS 暫存 → offscreen 複製到 FSA */
    async _downloadHlsSegmentsFsa(task, signal, onProgress, runGen = 0) {
      if (!this._runAlive(task.id, runGen)) return;
      const fsaKey = task.importFsaKey || "";
      VDM.diag("下載開始（HLS/FSA）",
        `id=${task.id} name=${task.fileName} importFsaKey=${fsaKey || "(無)→走設定資料夾"} ` +
        `segmentSubfolder=${task.segmentSubfolder ?? "(未設)"} segmentDir(舊)=${task.segmentDir || "-"}`);
      if (fsaKey) {
        const ready = await VDM.verifyImportFsaHandleViaOffscreen(fsaKey);
        VDM.diag("下載前驗證導入資料夾",
          `ok=${!!ready?.ok} name=${ready?.name || "-"} perm=${ready?.permission || "-"} err=${ready?.error || "-"}`);
        if (!ready?.ok) {
          throw new Error(
            ready?.error || "導入資料夾不可用，請刪除任務後重新導入並用「選擇資料夾」指定路徑"
          );
        }
      } else {
        const perm = await VDM.fsaQueryPermission();
        VDM.diag("下載走設定資料夾", `設定資料夾權限=${perm}`);
        if (perm !== "granted") {
          throw new Error("請在「設定」選擇「片段存檔資料夾」（必須設定才能下載 HLS 片段）");
        }
      }

      const video = task.video;
      const cacheKey = video.id;
      const playlist = await VDM.fetchM3u8(video.url, video);
      const segments = playlist.segments.map((s) => s.url);
      if (!segments.length) throw new Error("M3U8 沒有片段");

      const taskDir = VDM.resolveTaskSegmentDir(task);
      VDM.diag("解析片段目錄",
        `taskDir=${taskDir} 根=${fsaKey ? "指定資料夾(" + fsaKey + ")" : "設定資料夾"} 片段數=${segments.length}`);
      task.segmentDir = taskDir;
      task.total = segments.length;
      task.status = "downloading";
      task.merged = 0;
      task.mergeProgress = 0;

      if (typeof VDM.ensureOffscreen === "function") {
        await VDM.ensureOffscreen();
      }

      const scan = await VDM.fsaScanSegmentsViaOffscreen(taskDir, segments.length, fsaKey);
      task.downloaded = scan.downloaded;
      task.downloadProgress = VDM.segmentProgressPct(scan.downloaded, segments.length);
      task.progress = task.downloadProgress;
      VDM.setTaskActivity(
        task,
        scan.downloaded
          ? `還原進度 ${scan.downloaded}/${segments.length}  →  ${taskDir}`
          : `開始下載片段 → ${taskDir}`
      );
      onProgress(task);

      await VDM.fsaWritePlaylistViaOffscreen(taskDir, playlist.segments, fsaKey).catch(() => {});

      for (const idx of scan.missing) {
        if (await VDM.opfsValidateSegment(cacheKey, idx).catch(() => false)) {
          await VDM.fsaCopySegmentFromOpfsViaOffscreen(taskDir, cacheKey, idx, fsaKey).catch(() => {});
        }
      }
      const rescan = await VDM.fsaScanSegmentsViaOffscreen(taskDir, segments.length, fsaKey);
      scan.downloaded = rescan.downloaded;
      scan.missing = rescan.missing;

      const existingOnDisk = [];
      for (let i = 0; i < segments.length; i++) {
        if (!scan.missing.includes(i)) existingOnDisk.push(i);
      }
      VDM.seedHlsLaneProgress(task, segments.length, existingOnDisk);

      const lanes = VDM.partitionHlsLanes(segments, scan.missing);
      const copySlots = Math.min(8, Math.max(4, (VDM.maxConnections || 3) * 2));
      const maxPendingCopy = Math.max(32, (VDM.maxConnections || 3) * 12);

      const copyQueue = [];
      let copyPending = 0;
      let copyDone = 0;
      let fetched = 0;
      let downloadedBytes = 0;
      const state = { lastTime: Date.now(), lastBytes: 0, lastActAt: 0 };
      let halt = false;
      let copyErr = null;

      const touchProgress = (force) => {
        task.fetched = scan.downloaded + fetched;
        task.downloaded = scan.downloaded + copyDone;
        const show = Math.max(task.downloaded, task.fetched);
        task.downloadProgress = VDM.segmentProgressPct(show, segments.length);
        task.progress = task.downloadProgress;
        this._updateSpeed(task, downloadedBytes, state);
        const now = Date.now();
        if (force || !state.lastActAt || now - state.lastActAt > 800) {
          state.lastActAt = now;
          VDM.setTaskActivity(
            task,
            `下載 ${fetched}/${segments.length}  ·  存檔 ${task.downloaded}/${segments.length}`
          );
        }
        onProgress(task);
      };

      // 含 signal/paused：暫停或看門狗中止時，複製迴圈立即跳出，
      // 避免 worker 永久卡在 backpressure busy-loop 等待無回應的 offscreen 複製。
      const copyHalt = () => halt || copyErr || signal?.aborted || this.paused.has(task.id);

      const pumpCopy = () => {
        while (copyQueue.length && copyPending < copySlots && !copyHalt()) {
          const idx = copyQueue.shift();
          copyPending++;
          VDM.fsaCopySegmentFromOpfsViaOffscreen(taskDir, cacheKey, idx, fsaKey)
            .then(() => {
              copyDone++;
              VDM.markHlsLaneSegment(task, idx, "saved");
              touchProgress(false);
            })
            .catch((e) => {
              copyErr = e;
              halt = true;
            })
            .finally(() => {
              copyPending--;
              pumpCopy();
            });
        }
      };

      const waitCopyBackpressure = async () => {
        while (copyQueue.length + copyPending >= maxPendingCopy && !copyHalt()) {
          pumpCopy();
          await new Promise((r) => setTimeout(r, 40));
        }
      };

      const drainCopies = async () => {
        while (
          (copyQueue.length > 0 || copyPending > 0) &&
          !copyErr &&
          !signal?.aborted &&
          !this.paused.has(task.id)
        ) {
          pumpCopy();
          await new Promise((r) => setTimeout(r, 40));
        }
        if (copyErr) throw copyErr;
      };

      const fetchOne = async (idx, segUrl) => {
        if (!this._runAlive(task.id, runGen) || this.paused.has(task.id)) return;
        if (signal?.aborted) throw new Error("cancelled");
        await this._waitIfPaused(task.id);
        if (!this._runAlive(task.id, runGen)) return;
        if (copyHalt()) return;
        await waitCopyBackpressure();
        const buf = await this._fetchSegment(video, segUrl, signal);
        if (!this._runAlive(task.id, runGen) || this.paused.has(task.id)) return;
        await VDM.opfsWriteSegmentFast(cacheKey, idx, buf);
        fetched++;
        VDM.markHlsLaneSegment(task, idx, "fetched");
        downloadedBytes += buf.byteLength;
        copyQueue.push(idx);
        pumpCopy();
        touchProgress(false);
      };

      const runLane = async (lane) => {
        for (const [idx, segUrl] of lane) {
          if (halt || copyHalt()) return;
          try {
            await fetchOne(idx, segUrl);
          } catch (e) {
            if (!this._runAlive(task.id, runGen) || this.paused.has(task.id)) return;
            if (signal?.aborted || e.message === "cancelled") throw e;
            halt = true;
            this._pauseOnFetchError(task, e, onProgress);
            return;
          }
        }
      };

      const runStealQueue = async (missingIndices) => {
        if (!missingIndices?.length || halt || copyErr) return;
        const stealQ = missingIndices.map((idx) => [idx, segments[idx]]);
        const stealWorker = async () => {
          while (stealQ.length && !halt) {
            const item = stealQ.shift();
            if (!item) break;
            const [idx, segUrl] = item;
            try {
              await fetchOne(idx, segUrl);
            } catch (e) {
              if (!this._runAlive(task.id, runGen) || this.paused.has(task.id)) return;
              if (signal?.aborted || e.message === "cancelled") throw e;
              halt = true;
              this._pauseOnFetchError(task, e, onProgress);
              return;
            }
          }
        };
        const stealWorkers = VDM.getWorkerCount(stealQ.length);
        await Promise.all(Array.from({ length: stealWorkers }, () => stealWorker()));
      };

      await Promise.all(lanes.map((lane) => runLane(lane)));
      if (!halt && !copyErr) {
        await drainCopies().catch((e) => {
          if (!halt) {
            halt = true;
            this._pauseOnFetchError(task, e, onProgress);
          }
        });
        const stealScan = await VDM.fsaScanSegmentsViaOffscreen(taskDir, segments.length, fsaKey);
        if (stealScan.missing.length) {
          await runStealQueue(stealScan.missing);
          await drainCopies().catch((e) => {
            if (!halt) {
              halt = true;
              this._pauseOnFetchError(task, e, onProgress);
            }
          });
        }
      }
      if (this.paused.has(task.id) || task.status === "paused") {
        await drainCopies().catch(() => {});
        task.speed = 0;
        const finalScan = await VDM.fsaScanSegmentsViaOffscreen(taskDir, segments.length, fsaKey);
        task.downloaded = finalScan.downloaded;
        task.fetched = finalScan.downloaded;
        task.downloadProgress = VDM.segmentProgressPct(finalScan.downloaded, segments.length);
        task.progress = task.downloadProgress;
        if (!task.activity || /^下載 \d+\/\d+/.test(task.activity)) {
          VDM.setTaskActivity(task, `已暫停 · 存檔 ${finalScan.downloaded}/${segments.length}`);
        }
        onProgress(task);
        return;
      }
      if (copyErr && !this.paused.has(task.id)) {
        this._pauseOnFetchError(task, copyErr, onProgress);
        return;
      }
      if (halt) return;

      const finalScan = await VDM.fsaScanSegmentsViaOffscreen(taskDir, segments.length, fsaKey);
      task.downloaded = finalScan.downloaded;
      task.fetched = finalScan.downloaded;
      task.downloadProgress = VDM.segmentProgressPct(finalScan.downloaded, segments.length);
      task.progress = task.downloadProgress;
      if (finalScan.downloaded < segments.length) {
        throw new Error(`片段不完整（${finalScan.downloaded}/${segments.length}），請點「繼續」`);
      }
      await VDM.opfsRemoveTask(cacheKey).catch(() => {});
      VDM.setTaskActivity(task, `全部片段已存檔：${taskDir}`);
      onProgress(task);
    }
    async _downloadHttp(task, signal, onProgress) {
      const video = task.video;
      const headers = await VDM.buildHeaders(video, video.url);

      // 檢查是否有未完成的 OPFS 部分檔案（斷點續傳）
      const OPFS_THRESHOLD = 50 * 1024 * 1024;
      let resumeFrom = 0;
      if (VDM.opfsAvailable()) {
        resumeFrom = await VDM.opfsHttpPartialSize(video.id).catch(() => 0);
      }

      const fetchHeaders = resumeFrom > 0
        ? { ...headers, Range: `bytes=${resumeFrom}-` }
        : headers;

      const res = await fetch(video.url, { headers: fetchHeaders, signal });
      // 206 = 部分內容（斷點續傳成功），200 = 正常
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      // 若伺服器不支援 Range 返回 200，從頭開始（清掉舊 partial）
      if (res.status === 200 && resumeFrom > 0) {
        await VDM.opfsRemoveTask(video.id).catch(() => {});
        resumeFrom = 0;
      }

      const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
      const total = res.status === 206 ? resumeFrom + contentLength : contentLength;
      task.total = total;

      // 大檔案（> 50 MB）且 OPFS 可用 → 串流寫入磁碟，避免整個檔案堆在 RAM
      if (VDM.opfsAvailable() && total > OPFS_THRESHOLD) {
        const mb = (total / 1048576).toFixed(0);
        VDM.setTaskActivity(
          task,
          resumeFrom > 0
            ? `HTTP 斷點續傳 ${(resumeFrom / 1048576).toFixed(0)}/${mb} MB`
            : `HTTP 串流下載（${mb} MB）`
        );
        onProgress(task);
        await this._downloadHttpToOpfs(task, res.body.getReader(), total, resumeFrom, signal, onProgress);
        return;
      }

      if (total > 1_048_576 && res.headers.get("accept-ranges")?.toLowerCase() === "bytes") {
        await res.body.cancel().catch(() => {});
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
      chunks.length = 0;
      task.status = "merging";
      task.progress = 99;
      onProgress(task);
      await this._saveBlob(blob, task.fileName);
    }

    async _downloadHttpToOpfs(task, reader, total, resumeFrom, signal, onProgress) {
      const cacheKey = task.video.id;
      let downloaded = resumeFrom; // 從已下載的位元組繼續計
      let wasPaused = false;
      const state = { lastTime: Date.now(), lastBytes: resumeFrom };

      // 若是接續下載，先回報已有的進度
      if (resumeFrom > 0) {
        task.downloaded = resumeFrom;
        if (total) task.progress = Math.min(99, (resumeFrom * 100) / total);
        onProgress(task);
      }

      try {
        await VDM.opfsStreamToMerged(cacheKey, reader, signal, (chunkSize) => {
          if (this.paused.has(task.id)) { wasPaused = true; return false; }
          downloaded += chunkSize;
          task.downloaded = downloaded;
          if (total) task.progress = Math.min(99, (downloaded * 100) / total);
          this._updateSpeed(task, downloaded, state);
          if (!state.lastActAt || Date.now() - state.lastActAt > 1000) {
            state.lastActAt = Date.now();
            VDM.setTaskActivity(
              task,
              `HTTP 下載 ${(downloaded / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`
            );
          }
          onProgress(task);
          return true;
        }, { appendFrom: resumeFrom });
      } catch (e) {
        // 非暫停的真正錯誤才清除（保留部分檔案讓下次可接續）
        if (!this.paused.has(task.id) && task.status !== "paused") {
          VDM.opfsRemoveTask(cacheKey).catch(() => {});
        }
        throw e;
      }

      if (wasPaused || this.paused.has(task.id) || task.status === "paused") {
        // 保留 OPFS 部分檔案，下次 resume 可從斷點繼續
        task.status = "paused";
        onProgress(task);
        return;
      }

      task.status = "merging";
      task.progress = 99;
      VDM.setTaskActivity(task, "準備存檔…");
      onProgress(task);
      try {
        await saveOpfsOutput(cacheKey, task.fileName);
      } finally {
        VDM.opfsRemoveTask(cacheKey).catch(() => {});
      }
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
      buffers.fill(null);
      task.status = "merging";
      task.progress = 99;
      onProgress(task);
      await this._saveBlob(blob, task.fileName);
    }

    async _downloadHls(task, signal, onProgress, runGen = 0) {
      if (VDM.segmentsOnly !== false) {
        await this._downloadHlsSegmentsFsa(task, signal, onProgress, runGen);
        return;
      }
      // 強制使用磁碟模式避免大播放清單撐爆 RAM；僅在 OPFS 完全不可用時才退回記憶體模式
      if (VDM.opfsAvailable()) {
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
      VDM.initHlsLaneProgress(task, segments.length);
      const buffers = new Array(segments.length);
      let completed = 0;
      let downloadedBytes = 0;
      const state = { lastTime: Date.now(), lastBytes: 0 };
      const lanes = VDM.partitionHlsLanes(segments, null);
      let halt = false;

      const fetchToBuffer = async (idx, segUrl) => {
        if (signal?.aborted) throw new Error("cancelled");
        await this._waitIfPaused(task.id);
        const buf = await this._fetchSegment(video, segUrl, signal);
        buffers[idx] = buf;
        VDM.markHlsLaneSegment(task, idx, "fetched");
        VDM.markHlsLaneSegment(task, idx, "saved");
        completed++;
        downloadedBytes += buf.byteLength;
        task.downloaded = completed;
        task.progress = Math.min(90, (completed * 90) / segments.length);
        this._updateSpeed(task, downloadedBytes, state);
        onProgress(task);
      };

      const runLane = async (lane) => {
        for (const [idx, segUrl] of lane) {
          if (halt) return;
          try {
            await fetchToBuffer(idx, segUrl);
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

      const runStealQueue = async (missingIndices) => {
        if (!missingIndices?.length || halt) return;
        const stealQ = missingIndices.map((idx) => [idx, segments[idx]]);
        const stealWorker = async () => {
          while (stealQ.length && !halt) {
            const item = stealQ.shift();
            if (!item) break;
            const [idx, segUrl] = item;
            try {
              await fetchToBuffer(idx, segUrl);
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
        const stealWorkers = VDM.getWorkerCount(stealQ.length);
        await Promise.all(Array.from({ length: stealWorkers }, () => stealWorker()));
      };

      await Promise.all(lanes.map((lane) => runLane(lane)));
      if (!halt) {
        const missing = [];
        for (let i = 0; i < segments.length; i++) {
          if (!buffers[i]) missing.push(i);
        }
        if (missing.length) await runStealQueue(missing);
      }
      if (this.paused.has(task.id) || task.status === "paused") return;
      if (halt) return;

      task.status = "merging";
      task.progress = 92;
      onProgress(task);

      const merged = VDM.concatBuffers(buffers);
      buffers.fill(null);
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
      VDM.setTaskActivity(task, `解析 M3U8 完成（${segments.length} 段）`);

      if (await VDM.opfsMergeComplete(cacheKey, segments.length)) {
        task.total = segments.length;
        task.downloaded = segments.length;
        task.merged = segments.length;
        task.downloadProgress = 100;
        task.mergeProgress = 100;
        task.progress = 99;
        task.status = "merging";
        const saveMb = ((await VDM.opfsGetMergedSize(cacheKey).catch(() => 0)) / 1048576).toFixed(0);
        VDM.setTaskActivity(task, `FSA 串流存檔（${saveMb} MB）…`);
        onProgress(task);
        await saveOpfsOutput(cacheKey, task.fileName);
        return;
      }

      task.total = segments.length;
      task.status = "downloading";
      VDM.setTaskActivity(task, `還原進度（${segments.length} 段）…`);
      // 讀取 meta（含 mergedBytes），用於 merger seek 到正確的檔案位置
      const rawMeta = await VDM.opfsReadMergeMeta(cacheKey);
      const mergedThrough = rawMeta?.mergedThrough != null
        ? Math.min(rawMeta.mergedThrough, segments.length)
        : await VDM.opfsMergedThrough(cacheKey, segments.length);
      const mergedBytes = rawMeta?.mergedBytes || 0;
      await VDM.opfsSanitizeSegments(cacheKey, segments.length, mergedThrough);
      task.merged = mergedThrough;
      task.downloaded = await VDM.opfsBufferedCount(cacheKey, segments.length, mergedThrough);
      task.downloadProgress = VDM.segmentProgressPct(task.downloaded, segments.length);
      task.mergeProgress = VDM.segmentProgressPct(mergedThrough, segments.length);
      let downloadedBytes = 0;
      const state = { lastTime: Date.now(), lastBytes: 0, lastActAt: 0 };
      const needIndices = await VDM.opfsSegmentsToFetch(cacheKey, segments.length, mergedThrough);
      const existingOnDisk = [];
      for (let i = mergedThrough; i < segments.length; i++) {
        if (!needIndices.includes(i)) existingOnDisk.push(i);
      }
      VDM.seedHlsLaneProgress(task, segments.length, existingOnDisk);
      const lanes = VDM.partitionHlsLanes(segments, needIndices);
      const merger = VDM.createOpfsStreamMerger(cacheKey, segments.length, {
        startAppend: mergedThrough,
        startBytes: mergedBytes,
      });
      let halt = false;

      const onMergeProgress = (done, total, bytes) => {
        downloadedBytes = bytes;
        task.merged = done;
        task.mergeProgress = VDM.segmentProgressPct(done, total);
        task.progress = task.mergeProgress;
        this._updateSpeed(task, downloadedBytes, state);
        const now = Date.now();
        if (!state.lastActAt || now - state.lastActAt > 800 || done === total) {
          state.lastActAt = now;
          const mb = (bytes / 1048576).toFixed(1);
          VDM.setTaskActivity(
            task,
            `下載 ${task.downloaded || done}/${total}  ·  合併 ${done}/${total}（${mb} MB）`
          );
        }
        onProgress(task);
      };

      if (task.downloaded > mergedThrough) {
        await merger.onSegmentWritten(onMergeProgress);
        task.downloaded = await VDM.opfsBufferedCount(cacheKey, segments.length, task.merged);
        task.downloadProgress = VDM.segmentProgressPct(task.downloaded, segments.length);
      }

      const fetchOne = async (idx, segUrl) => {
        if (signal?.aborted) throw new Error("cancelled");
        await this._waitIfPaused(task.id);
        await this._waitIfMergeLag(task, merger, onMergeProgress, onProgress);
        const buf = await this._fetchSegment(video, segUrl, signal);
        await VDM.opfsWriteSegment(cacheKey, idx, buf);
        VDM.markHlsLaneSegment(task, idx, "fetched");
        VDM.markHlsLaneSegment(task, idx, "saved");
        task.downloaded = Math.max(task.downloaded || task.merged || 0, idx + 1);
        task.downloadProgress = VDM.segmentProgressPct(task.downloaded, segments.length);
        if (idx % 15 === 0 || idx === segments.length - 1) {
          VDM.setTaskActivity(
            task,
            `下載片段 ${task.downloaded}/${segments.length}  ·  合併 ${task.merged || 0}/${segments.length}`
          );
        }
        merger.onSegmentWritten(onMergeProgress).catch(() => {});
        this._updateSpeed(task, downloadedBytes, state);
        onProgress(task);
      };

      const runLane = async (lane) => {
        for (const [idx, segUrl] of lane) {
          if (halt) return;
          try {
            await fetchOne(idx, segUrl);
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

      const runStealQueue = async (missingIndices) => {
        if (!missingIndices?.length || halt) return;
        const stealQ = missingIndices.map((idx) => [idx, segments[idx]]);
        const stealWorker = async () => {
          while (stealQ.length && !halt) {
            const item = stealQ.shift();
            if (!item) break;
            const [idx, segUrl] = item;
            try {
              await fetchOne(idx, segUrl);
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
        const stealWorkers = VDM.getWorkerCount(stealQ.length);
        await Promise.all(Array.from({ length: stealWorkers }, () => stealWorker()));
      };

      await Promise.all(lanes.map((lane) => runLane(lane)));
      if (!halt) {
        const stillNeed = await VDM.opfsSegmentsToFetch(cacheKey, segments.length, mergedThrough);
        if (stillNeed.length) await runStealQueue(stillNeed);
      }
      if (this.paused.has(task.id) || task.status === "paused") {
        await merger.pause().catch(() => {});
        VDM.setTaskActivity(
          task,
          `已暫停（下載 ${task.downloaded}/${segments.length}  ·  合併 ${task.merged}/${segments.length}）`
        );
        onProgress(task);
        return;
      }
      if (halt) return;

      task.status = "merging";
      VDM.setTaskActivity(task, `合併收尾 ${task.merged}/${segments.length}…`);
      onProgress(task);
      const finalMergedBytes = await merger.finish(onMergeProgress);

      task.downloadProgress = 100;
      task.mergeProgress = 100;
      task.progress = 99;
      const saveMb = (finalMergedBytes / 1048576).toFixed(0);
      VDM.setTaskActivity(task, `FSA 串流存檔（${saveMb} MB）…`);
      onProgress(task);
      await saveOpfsOutput(cacheKey, task.fileName);
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
