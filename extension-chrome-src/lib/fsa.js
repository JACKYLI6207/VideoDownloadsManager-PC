(function () {
  const VDM = self.VDM;
  const FSA_DB = "vdm-fsa";
  const FSA_STORE = "handles";
  const FSA_KEY = "saveDir";
  const FSA_CHUNK = 4 * 1024 * 1024;

  function _openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(FSA_DB, 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore(FSA_STORE);
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  VDM.fsaGetHandle = async () => {
    const db = await _openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(FSA_STORE, "readonly");
      const req = tx.objectStore(FSA_STORE).get(FSA_KEY);
      req.onsuccess = () => { resolve(req.result || null); db.close(); };
      req.onerror = () => { resolve(null); db.close(); };
    });
  };

  VDM.fsaSetHandle = async (handle) => {
    const db = await _openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FSA_STORE, "readwrite");
      tx.objectStore(FSA_STORE).put(handle, FSA_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = (e) => { db.close(); reject(e.target.error); };
    });
  };

  VDM.fsaClearHandle = async () => {
    const db = await _openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(FSA_STORE, "readwrite");
      tx.objectStore(FSA_STORE).delete(FSA_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  };

  VDM.fsaQueryPermission = async () => {
    const handle = await VDM.fsaGetHandle();
    if (!handle) return null;
    try {
      return await handle.queryPermission({ mode: "readwrite" });
    } catch {
      return "denied";
    }
  };

  /** 依 downloadPath 解析 FSA 目標 FileHandle（fileName 可含子路徑） */
  VDM.fsaResolveDestHandle = async (downloadPath) => {
    const handle = await VDM.fsaGetHandle();
    if (!handle) throw new Error("FSA：未設定存檔資料夾");

    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      throw new Error("FSA：存檔資料夾權限已失效，請在設定中重新選擇");
    }

    const parts = String(downloadPath).replace(/\\/g, "/").split("/").filter(Boolean);
    const baseName = parts.pop();
    let dir = handle;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    return dir.getFileHandle(baseName, { create: true });
  };

  /**
   * 分塊串流複製（禁止 pipeTo 整檔 / createObjectURL）。
   * Crashpad 日誌顯示大檔 blob 路徑會觸發 BlobStorageContext OOM。
   */
  VDM.fsaStreamFileToWritable = async (srcFile, writable) => {
    const reader = srcFile.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
      }
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
  };

  VDM.fsaSave = async (videoId, downloadPath) => {
    const destFh = await VDM.fsaResolveDestHandle(downloadPath);
    const writable = await destFh.createWritable();
    try {
      const opfsDir = await VDM.opfsTaskDir(videoId);
      const srcFh = await opfsDir.getFileHandle("merged.mp4");
      const srcFile = await srcFh.getFile();
      await VDM.fsaStreamFileToWritable(srcFile, writable);
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
    await VDM.opfsRemoveTask(videoId).catch(() => {});
  };

  VDM.fsaGetStatus = async () => {
    const handle = await VDM.fsaGetHandle();
    if (!handle) return { configured: false };
    let permission = "unknown";
    try {
      permission = await handle.queryPermission({ mode: "readwrite" });
    } catch {
      permission = "denied";
    }
    return { configured: true, name: handle.name, permission };
  };

  /** 片段模式：{subfolder}/{任務名}/ */
  VDM.buildTaskSegmentDirWithSub = (fileName, subfolder) => {
    const base = String(fileName || "").replace(/\.mp4$/i, "");
    const folder = VDM.sanitizeFilename(base) || "VIDEO";
    const sub = VDM.normalizeOptionalSubPath(subfolder);
    return sub ? `${sub}/${folder}` : folder;
  };

  /** 片段模式：{downloadSubfolder}/{任務名}/ */
  VDM.buildTaskSegmentDir = (fileName) => {
    return VDM.buildTaskSegmentDirWithSub(fileName, VDM.downloadSubfolder);
  };

  /** 任務實際片段目錄（優先 per-task segmentSubfolder，其次 segmentDir） */
  VDM.resolveTaskSegmentDir = (task) => {
    if (!task) return VDM.buildTaskSegmentDir("");
    if (task.importFsaKey) {
      return VDM.buildTaskSegmentDirWithSub(task.fileName, "");
    }
    if (task.segmentSubfolder !== undefined && task.segmentSubfolder !== null) {
      return VDM.buildTaskSegmentDirWithSub(task.fileName, task.segmentSubfolder);
    }
    if (task.segmentDir) return String(task.segmentDir);
    return VDM.buildTaskSegmentDir(task.fileName);
  };

  VDM.fsaSetImportHandle = async (key, handle) => {
    if (!key || !handle) throw new Error("缺少導入資料夾 key");
    const db = await _openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FSA_STORE, "readwrite");
      tx.objectStore(FSA_STORE).put(handle, `import:${key}`);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = (e) => {
        db.close();
        reject(e.target.error);
      };
    });
  };

  VDM.fsaGetImportHandle = async (key) => {
    if (!key) return null;
    const db = await _openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(FSA_STORE, "readonly");
      const req = tx.objectStore(FSA_STORE).get(`import:${key}`);
      req.onsuccess = () => {
        resolve(req.result || null);
        db.close();
      };
      req.onerror = () => {
        resolve(null);
        db.close();
      };
    });
  };

  async function _fsaRootHandle(importFsaKey = "") {
    if (importFsaKey) {
      const handle = await VDM.fsaGetImportHandle(importFsaKey);
      if (!handle) {
        VDM.diag?.("寫檔根目錄解析失敗", `importFsaKey=${importFsaKey} 找不到 handle → 會丟錯`);
        throw new Error("導入資料夾授權已失效，請重新導入並選擇資料夾");
      }
      await _fsaEnsurePermission(handle);
      VDM.diag?.("寫檔根目錄=指定資料夾", `importFsaKey=${importFsaKey} 資料夾名=${handle.name}`);
      return handle;
    }
    const handle = await VDM.fsaGetHandle();
    if (!handle) throw new Error("FSA：未設定片段存檔資料夾");
    await _fsaEnsurePermission(handle);
    VDM.diag?.("寫檔根目錄=設定資料夾", `資料夾名=${handle.name}`);
    return handle;
  }

  async function _fsaEnsurePermission(handle) {
    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      throw new Error("FSA：資料夾權限已失效，請在設定中重新選擇");
    }
  }

  const _fsaDirCache = new Map();

  VDM.fsaClearDirCache = (taskDir) => {
    if (taskDir) {
      for (const k of _fsaDirCache.keys()) {
        if (k.startsWith(`${taskDir}|`)) _fsaDirCache.delete(k);
      }
      return;
    }
    _fsaDirCache.clear();
  };

  /** 開啟（或建立）FSA 子資料夾 */
  VDM.fsaResolveDirHandle = async (relativePath, { create = true, importFsaKey = "" } = {}) => {
    const cacheKey = `${importFsaKey}|${relativePath}|${create ? 1 : 0}`;
    if (_fsaDirCache.has(cacheKey)) return _fsaDirCache.get(cacheKey);

    const handle = await _fsaRootHandle(importFsaKey);
    const parts = String(relativePath).replace(/\\/g, "/").split("/").filter(Boolean);
    let dir = handle;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    _fsaDirCache.set(cacheKey, dir);
    return dir;
  };

  VDM.fsaWriteSegmentBuffer = async (taskDir, index, buffer, importFsaKey = "") => {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
    if (bytes.byteLength < 376) throw new Error(`片段 ${index} 過小 (${bytes.byteLength}B)`);
    const blob = new Blob([bytes], { type: "video/mp2t" });
    await VDM.fsaWriteSegmentFromFile(taskDir, index, blob, importFsaKey);
  };

  VDM.fsaWriteSegmentFromFile = async (taskDir, index, srcFile, importFsaKey = "") => {
    if (srcFile.size < 376) throw new Error(`片段 ${index} 過小 (${srcFile.size}B)`);
    const dir = await VDM.fsaResolveDirHandle(taskDir, { importFsaKey });
    const name = VDM.opfsSegName(index);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await VDM.fsaStreamFileToWritable(srcFile, w);
  };

  /** offscreen 內 fetch → 直接串流寫入 FSA（不經 OPFS / 不傳 ArrayBuffer） */
  VDM.fsaFetchAndSaveSegment = async (taskDir, index, url, headers, signal, importFsaKey = "") => {
    const hdrs = { ...(headers || {}) };
    delete hdrs.Cookie;
    delete hdrs.cookie;
    const res = await fetch(url, { headers: hdrs, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const dir = await VDM.fsaResolveDirHandle(taskDir, { importFsaKey });
    const name = VDM.opfsSegName(index);
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    try {
      if (res.body) {
        await res.body.pipeTo(writable, { signal });
      } else {
        if (signal?.aborted) throw new Error("cancelled");
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 376) throw new Error(`片段 ${index} 過小 (${buf.byteLength}B)`);
        await writable.write(buf);
        await writable.close();
      }
    } catch (e) {
      await writable.abort().catch(() => {});
      if (signal?.aborted) throw new Error("cancelled");
      throw e;
    }

    const file = await fh.getFile();
    if (file.size < 376) {
      await dir.removeEntry(name).catch(() => {});
      throw new Error(`片段 ${index} 過小 (${file.size}B)`);
    }
    return file.size;
  };

  /** OPFS → FSA 串流複製（舊路徑 fallback） */
  VDM.fsaCopySegmentFromOpfs = async (taskDir, videoId, index, importFsaKey = "") => {
    const opfsDir = await VDM.opfsTaskDir(videoId);
    const segFh = await opfsDir.getFileHandle(VDM.opfsSegName(index));
    const file = await segFh.getFile();
    await VDM.fsaWriteSegmentFromFile(taskDir, index, file, importFsaKey);
    await VDM.opfsRemoveSegment(videoId, index).catch(() => {});
  };

  /** 掃描任務資料夾已有片段（一次列目錄，避免千次 I/O） */
  VDM.fsaScanSegments = async (taskDir, segmentCount, importFsaKey = "") => {
    try {
      await _fsaRootHandle(importFsaKey);
      const dir = await VDM.fsaResolveDirHandle(taskDir, { create: false, importFsaKey });
      const present = new Set();
      for await (const [name] of dir.entries()) {
        const m = /^(\d{5})\.ts$/.exec(String(name));
        if (m) present.add(parseInt(m[1], 10));
      }
      const missing = [];
      let downloaded = 0;
      for (let i = 0; i < segmentCount; i++) {
        if (present.has(i)) downloaded++;
        else missing.push(i);
      }
      return { downloaded, missing };
    } catch {
      return { downloaded: 0, missing: Array.from({ length: segmentCount }, (_, i) => i) };
    }
  };

  VDM.fsaWritePlaylist = async (taskDir, segments, importFsaKey = "") => {
    const dir = await VDM.fsaResolveDirHandle(taskDir, { importFsaKey });
    let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:0\n";
    for (let i = 0; i < segments.length; i++) {
      const dur = segments[i]?.duration != null ? segments[i].duration : 0;
      body += `#EXTINF:${dur},\n${VDM.opfsSegName(i)}\n`;
    }
    body += "#EXT-X-ENDLIST\n";
    const fh = await dir.getFileHandle("index.m3u8", { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob([body], { type: "application/vnd.apple.mpegurl" }));
    await w.close();
  };

  VDM.fsaClearTaskDir = async (taskDir, importFsaKey = "") => {
    try {
      VDM.fsaClearDirCache(taskDir);
      const handle = await _fsaRootHandle(importFsaKey);
      const parts = String(taskDir).replace(/\\/g, "/").split("/").filter(Boolean);
      if (!parts.length) return;
      const folderName = parts.pop();
      let parent = handle;
      for (const part of parts) {
        parent = await parent.getDirectoryHandle(part, { create: false });
      }
      await parent.removeEntry(folderName, { recursive: true });
    } catch {
      /* 資料夾不存在則略過 */
    }
  };
})();
