(function () {
  const VDM = self.VDM;
  const MERGED_NAME = "merged.mp4";
  const MERGE_META = "merge.json";

  VDM.opfsAvailable = () => typeof navigator?.storage?.getDirectory === "function";

  VDM.buildDownloadPath = (fileName) => {
    const sub = VDM.normalizeDownloadPath(VDM.downloadSubfolder || "");
    return sub ? `${sub}/${fileName}` : fileName;
  };

  async function getRoot() {
    if (!VDM.opfsAvailable()) throw new Error("此瀏覽器不支援磁碟暫存");
    return navigator.storage.getDirectory();
  }

  async function getCacheRoot() {
    const root = await getRoot();
    const name = VDM.segmentCacheDir || "vdm-cache";
    return root.getDirectoryHandle(name, { create: true });
  }

  VDM.opfsTaskDir = async (videoId) => {
    const cache = await getCacheRoot();
    return cache.getDirectoryHandle(videoId, { create: true });
  };

  VDM.opfsSegName = (index) => `${String(index).padStart(5, "0")}.ts`;

  VDM.opfsSegPartName = (index) => `${VDM.opfsSegName(index)}.part`;

  VDM.opfsRemoveSegment = async (videoId, index) => {
    const dir = await VDM.opfsTaskDir(videoId);
    await dir.removeEntry(VDM.opfsSegName(index)).catch(() => {});
    await dir.removeEntry(VDM.opfsSegPartName(index)).catch(() => {});
  };

  VDM.opfsValidateSegment = async (videoId, index) => {
    const MIN_BYTES = 376;
    try {
      const dir = await VDM.opfsTaskDir(videoId);
      const file = await (await dir.getFileHandle(VDM.opfsSegName(index))).getFile();
      if (file.size < MIN_BYTES) return false;
      const head = new Uint8Array(await file.slice(0, 1).arrayBuffer());
      if (head[0] === 0x47) return true;
      return file.size >= 2048;
    } catch {
      return false;
    }
  };

  VDM.opfsSanitizeSegments = async (videoId, segmentCount, mergedThrough = 0) => {
    const dir = await VDM.opfsTaskDir(videoId);
    // 一次目錄掃描：清 .part；清 mergedThrough 以下殘留 .ts
    // 避免 O(mergedThrough) 筆 OPFS 個別刪除造成大 playlist 啟動很慢
    for await (const [name] of dir.entries()) {
      const n = String(name);
      if (n.endsWith(".part")) { await dir.removeEntry(n).catch(() => {}); continue; }
      if (n.endsWith(".ts")) {
        const idx = parseInt(n, 10);
        if (!isNaN(idx) && idx < mergedThrough) {
          await dir.removeEntry(n).catch(() => {});
        }
      }
    }
    for (let i = mergedThrough; i < segmentCount; i++) {
      try {
        await dir.getFileHandle(VDM.opfsSegName(i));
      } catch {
        continue;
      }
      if (!(await VDM.opfsValidateSegment(videoId, i))) {
        await VDM.opfsRemoveSegment(videoId, i);
      }
    }
  };

  VDM.opfsWriteSegment = async (videoId, index, buffer) => {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
    const dir = await VDM.opfsTaskDir(videoId);
    const segName = VDM.opfsSegName(index);
    const partName = VDM.opfsSegPartName(index);
    await dir.removeEntry(partName).catch(() => {});
    const partFh = await dir.getFileHandle(partName, { create: true });
    const pw = await partFh.createWritable();
    await pw.write(bytes);
    await pw.close();
    await dir.removeEntry(segName).catch(() => {});
    const partFile = await (await dir.getFileHandle(partName)).getFile();
    const segFh = await dir.getFileHandle(segName, { create: true });
    const sw = await segFh.createWritable();
    await partFile.stream().pipeTo(sw);
    await dir.removeEntry(partName);
  };

  /** 片段模式 OPFS 暫存：單次寫入，複製到 FSA 後即刪 */
  VDM.opfsWriteSegmentFast = async (videoId, index, buffer) => {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
    const dir = await VDM.opfsTaskDir(videoId);
    const segName = VDM.opfsSegName(index);
    await dir.removeEntry(segName).catch(() => {});
    const fh = await dir.getFileHandle(segName, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  };

  VDM.opfsMergeSegments = async (videoId, segmentCount, onProgress) => {
    const dir = await VDM.opfsTaskDir(videoId);
    let mergedBytes = 0;

    for (let i = 0; i < segmentCount; i++) {
      const segName = VDM.opfsSegName(i);
      const segFh = await dir.getFileHandle(segName);
      const segFile = await segFh.getFile();
      // 每段獨立 open → pipeTo → close（原子提交）
      const outFh = await dir.getFileHandle(MERGED_NAME, { create: true });
      const w = await outFh.createWritable(mergedBytes > 0 ? { keepExistingData: true } : undefined);
      if (mergedBytes > 0) await w.seek(mergedBytes);
      await segFile.stream().pipeTo(w);
      mergedBytes += segFile.size;
      await dir.removeEntry(segName);
      if (onProgress) onProgress(i + 1, segmentCount, mergedBytes);
    }

    return mergedBytes;
  };

  VDM.opfsGetMergedFile = async (videoId) => {
    const dir = await VDM.opfsTaskDir(videoId);
    const fh = await dir.getFileHandle(MERGED_NAME);
    return fh.getFile();
  };

  VDM.opfsGetMergedSize = async (videoId) => {
    try {
      return (await VDM.opfsGetMergedFile(videoId)).size;
    } catch {
      return 0;
    }
  };

  /** 超過此大小禁止 blob URL / bridge 存檔（會導致 Chrome renderer OOM 崩潰） */
  VDM.OPFS_BRIDGE_MAX_BYTES = 64 * 1024 * 1024;

  VDM.opfsHasMerged = async (videoId) => {
    try {
      const dir = await VDM.opfsTaskDir(videoId);
      await dir.getFileHandle(MERGED_NAME);
      return true;
    } catch {
      return false;
    }
  };

  VDM.opfsReadMergeMeta = async (videoId) => {
    try {
      const dir = await VDM.opfsTaskDir(videoId);
      const fh = await dir.getFileHandle(MERGE_META);
      const text = await (await fh.getFile()).text();
      const data = JSON.parse(text);
      if (typeof data.mergedThrough === "number") return data;
    } catch {
      /* no meta */
    }
    return null;
  };

  VDM.opfsWriteMergeMeta = async (videoId, mergedThrough, mergedBytes = 0) => {
    const dir = await VDM.opfsTaskDir(videoId);
    const fh = await dir.getFileHandle(MERGE_META, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify({ mergedThrough, mergedBytes }));
    await w.close();
  };

  VDM.opfsMergeComplete = async (videoId, segmentCount) => {
    const meta = await VDM.opfsReadMergeMeta(videoId);
    if (!meta || meta.mergedThrough < segmentCount) return false;
    if (!(await VDM.opfsHasMerged(videoId))) return false;
    let merged;
    try {
      merged = await VDM.opfsGetMergedFile(videoId);
    } catch {
      return false;
    }
    if (merged.size < 64 * 1024) return false;
    const dir = await VDM.opfsTaskDir(videoId);
    for (let i = 0; i < segmentCount; i++) {
      try {
        await dir.getFileHandle(VDM.opfsSegName(i));
        return false;
      } catch {
        /* merged or absent */
      }
    }
    return true;
  };

  VDM.opfsMergedThrough = async (videoId, segmentCount) => {
    const meta = await VDM.opfsReadMergeMeta(videoId);
    if (meta?.mergedThrough != null) {
      return Math.min(meta.mergedThrough, segmentCount);
    }
    const dir = await VDM.opfsTaskDir(videoId);
    for (let i = 0; i < segmentCount; i++) {
      try {
        await dir.getFileHandle(VDM.opfsSegName(i));
        return i;
      } catch {
        /* no .ts at this index */
      }
    }
    return 0;
  };

  VDM.opfsSegmentsToFetch = async (videoId, segmentCount, mergedThrough = 0) => {
    const dir = await VDM.opfsTaskDir(videoId);
    const need = [];
    for (let i = mergedThrough; i < segmentCount; i++) {
      try {
        await dir.getFileHandle(VDM.opfsSegName(i));
      } catch {
        need.push(i);
      }
    }
    return need;
  };

  VDM.opfsBufferedCount = async (videoId, segmentCount, mergedThrough = 0) => {
    let n = mergedThrough;
    const dir = await VDM.opfsTaskDir(videoId);
    for (let i = mergedThrough; i < segmentCount; i++) {
      try {
        await dir.getFileHandle(VDM.opfsSegName(i));
        n++;
      } catch {
        /* not on disk */
      }
    }
    return n;
  };

  VDM.createOpfsStreamMerger = (videoId, segmentCount, { startAppend = 0, startBytes = 0 } = {}) => {
    let nextAppend = startAppend;
    let mergedBytes = 0;
    let writable = null;          // 保持開啟避免 OPFS 每段複製整個大檔
    let chain = Promise.resolve();
    let initialized = false;
    const pendingDelete = [];     // 已寫入 staging、等 close() 後刪除的 .ts 索引
    const dirPromise = VDM.opfsTaskDir(videoId);
    const COMMIT_EVERY = 96;      // 減少大檔週期性 close/commit 次數（背壓已限制 .ts 堆積）

    /**
     * 初始化 mergedBytes 並截斷 merged.mp4 至最後一次已 commit 的位置。
     * 只在第一次呼叫時執行。
     */
    async function ensureInit(dir) {
      if (initialized) return;
      initialized = true;
      if (startAppend === 0) { mergedBytes = 0; return; }

      let actualSize = 0;
      try {
        const fh = await dir.getFileHandle(MERGED_NAME);
        actualSize = (await fh.getFile()).size;
      } catch { actualSize = 0; }

      // startBytes = meta 記錄的最後一次 commit 點（應 ≤ actualSize）
      // 若 actualSize > startBytes 代表有未 commit 的 staging 殘留 → 截斷回安全點
      const target = startBytes > 0 ? Math.min(startBytes, actualSize) : actualSize;
      mergedBytes = target;

      if (actualSize > target && target > 0) {
        try {
          const fh = await dir.getFileHandle(MERGED_NAME);
          const w = await fh.createWritable({ keepExistingData: true });
          await w.truncate(target);
          await w.close();
        } catch { /* ignore */ }
      }
    }

    /**
     * 取得（或建立）持久 writable。
     * writable 跨片段保持開啟（寫 staging），只在 commitAndClean() 才 close()。
     * 避免每段 createWritable({ keepExistingData: true }) 複製整個大檔的 O(n²) 問題。
     */
    async function getWritable(dir) {
      if (writable) return writable;
      const outFh = await dir.getFileHandle(MERGED_NAME, { create: true });
      if (mergedBytes > 0) {
        writable = await outFh.createWritable({ keepExistingData: true });
        await writable.seek(mergedBytes);
      } else {
        writable = await outFh.createWritable();
      }
      return writable;
    }

    /** 在 staging 裡 append 一批已就緒片段（不關閉 writable，快速路徑）。 */
    async function appendReady(onProgress) {
      const dir = await dirPromise;
      await ensureInit(dir);

      while (nextAppend < segmentCount) {
        const segName = VDM.opfsSegName(nextAppend);
        let segFile;
        try {
          segFile = await (await dir.getFileHandle(segName)).getFile();
        } catch {
          break; // 片段尚未下載完成
        }
        try {
          const w = await getWritable(dir);
          await segFile.stream().pipeTo(w, { preventClose: true });
          mergedBytes += segFile.size;
          pendingDelete.push(nextAppend);
          nextAppend++;
          if (onProgress) onProgress(nextAppend, segmentCount, mergedBytes);
          if (pendingDelete.length >= COMMIT_EVERY) {
            await commitAndClean();
          }
        } catch {
          break;
        }
      }
    }

    /**
     * 提交 staging → 更新 meta → 刪除已合併的 .ts。
     * 只在「主動暫停」和「完成」時呼叫，避免頻繁 close()。
     */
    async function commitAndClean() {
      if (writable) {
        await writable.close();
        writable = null;
      }
      await VDM.opfsWriteMergeMeta(videoId, nextAppend, mergedBytes);
      const dir = await dirPromise;
      for (const idx of pendingDelete) {
        await dir.removeEntry(VDM.opfsSegName(idx)).catch(() => {});
      }
      pendingDelete.length = 0;
    }

    return {
      onSegmentWritten(onProgress) {
        // 無論上一段成功或失敗都繼續跑（防止 chain 卡在 rejected state）
        chain = chain.then(() => appendReady(onProgress), () => appendReady(onProgress));
        return chain;
      },
      /** 主動暫停時呼叫：等 chain 落定 → commit → 清 .ts */
      async pause() {
        await chain.catch(() => {});
        await commitAndClean();
      },
      async finish(onProgress) {
        await chain.catch(() => {});
        while (nextAppend < segmentCount) {
          await appendReady(onProgress);
        }
        await commitAndClean();
        return mergedBytes;
      },
      isComplete() {
        return nextAppend >= segmentCount;
      },
    };
  };

  /**
   * 取得 HTTP 大型下載的部分已存 OPFS 大小（用於斷點續傳）。
   * 若不存在則回傳 0。
   */
  VDM.opfsHttpPartialSize = async (videoId) => {
    try {
      const dir = await VDM.opfsTaskDir(videoId);
      const fh = await dir.getFileHandle(MERGED_NAME);
      const file = await fh.getFile();
      return file.size > 0 ? file.size : 0;
    } catch {
      return 0;
    }
  };

  /**
   * 將 ReadableStreamDefaultReader 串流直寫到 merged.mp4（供大型 HTTP 下載使用）。
   * onChunk(byteLength) 回傳 false 時停止並關閉 writable。
   * appendFrom > 0 時以 append 模式開啟（支援斷點續傳）。
   */
  VDM.opfsStreamToMerged = async (videoId, reader, signal, onChunk, { appendFrom = 0 } = {}) => {
    const dir = await VDM.opfsTaskDir(videoId);
    const fh = await dir.getFileHandle(MERGED_NAME, { create: true });
    const writable = await fh.createWritable({ keepExistingData: appendFrom > 0 });
    if (appendFrom > 0) {
      await writable.seek(appendFrom);
    }
    try {
      while (true) {
        if (signal?.aborted) throw new Error("cancelled");
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        const cont = onChunk ? onChunk(value.byteLength || value.length || 0) : true;
        if (!cont) break;
      }
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
  };

  VDM.opfsRemoveTask = async (videoId) => {
    try {
      const cache = await getCacheRoot();
      await cache.removeEntry(videoId, { recursive: true });
    } catch {
      /* already gone */
    }
  };

  /** 舊版合併模式殘留：列出 OPFS 暫存任務數 */
  VDM.opfsCacheInfo = async () => {
    try {
      const cache = await getCacheRoot();
      let tasks = 0;
      for await (const [name] of cache.entries()) {
        if (name) tasks++;
      }
      return { tasks, dir: VDM.segmentCacheDir || "vdm-cache" };
    } catch {
      return { tasks: 0, dir: VDM.segmentCacheDir || "vdm-cache" };
    }
  };

  /** 清除全部 OPFS 暫存（舊版合併/失敗任務殘留，通常在 C 槽 Chrome 設定目錄） */
  VDM.opfsClearAllCache = async () => {
    const cache = await getCacheRoot();
    let removed = 0;
    for await (const [name] of cache.entries()) {
      await cache.removeEntry(name, { recursive: true }).catch(() => {});
      removed++;
    }
    return { removed };
  };

  /**
   * 透過 File System Access API 直接將 OPFS merged.mp4 串流寫入使用者指定資料夾。
   * 使用分塊讀寫（4MB），避免 pipeTo / BlobStorageContext 在大檔時造成 Chrome 崩潰。
   */
  VDM.saveOpfsFileDirect = async (videoId, fileName) => {
    if (typeof VDM.fsaQueryPermission !== "function") throw new Error("FSA 模組未載入");
    const perm = await VDM.fsaQueryPermission();
    if (perm !== "granted") {
      const size = await VDM.opfsGetMergedSize(videoId);
      if (size > VDM.OPFS_BRIDGE_MAX_BYTES) {
        throw new Error(
          "大檔案必須在設定中選擇「直接存檔資料夾」；未設定時 Chrome 會因記憶體不足而崩潰"
        );
      }
      throw new Error("FSA 存檔資料夾未設定或權限已失效");
    }
    // 優先走 offscreen 分塊串流（比 SW 內 pipeTo 穩定，不觸發 BlobStorageContext OOM）
    if (typeof VDM.saveOpfsViaOffscreenFsa === "function") {
      return VDM.saveOpfsViaOffscreenFsa(videoId, fileName);
    }
    if (typeof VDM.fsaSave !== "function") throw new Error("FSA 模組未載入");
    await VDM.fsaSave(videoId, fileName);
  };

  // 串化橋接分頁建立：防止多任務同時 chrome.tabs.create 衝突
  let _bridgeChain = Promise.resolve();

  VDM.saveOpfsMergedViaBridge = (videoId, fileName) => {
    const downloadPath = VDM.buildDownloadPath(fileName);
    // 排入序列，每次只打開一個橋接分頁
    _bridgeChain = _bridgeChain.then(
      () => _openBridgeTab(videoId, downloadPath),
      () => _openBridgeTab(videoId, downloadPath)
    );
    return _bridgeChain;
  };

  function _openBridgeTab(videoId, downloadPath) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onMsg);
        reject(new Error("存檔逾時（檔案過大時請稍候）"));
      }, 600_000);

      function onMsg(msg) {
        if (msg.type !== "BRIDGE_DOWNLOAD_DONE" || msg.videoId !== videoId) return;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(onMsg);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.downloadId);
      }

      chrome.runtime.onMessage.addListener(onMsg);
      const url = chrome.runtime.getURL(
        `download/bridge.html?videoId=${encodeURIComponent(videoId)}&file=${encodeURIComponent(downloadPath)}`
      );
      chrome.tabs.create({ url, active: false });
    });
  }
})();
