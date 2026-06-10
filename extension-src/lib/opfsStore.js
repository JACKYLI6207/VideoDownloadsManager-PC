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
    for await (const [name] of dir.entries()) {
      if (String(name).endsWith(".part")) {
        await dir.removeEntry(name).catch(() => {});
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

  VDM.opfsMergeSegments = async (videoId, segmentCount, onProgress) => {
    const dir = await VDM.opfsTaskDir(videoId);
    const outFh = await dir.getFileHandle(MERGED_NAME, { create: true });
    const writable = await outFh.createWritable();
    let mergedBytes = 0;

    for (let i = 0; i < segmentCount; i++) {
      const segName = VDM.opfsSegName(i);
      const segFh = await dir.getFileHandle(segName);
      const segFile = await segFh.getFile();
      await segFile.stream().pipeTo(writable, { preventClose: true });
      mergedBytes += segFile.size;
      await dir.removeEntry(segName);
      if (onProgress) onProgress(i + 1, segmentCount, mergedBytes);
    }

    await writable.close();
    return mergedBytes;
  };

  VDM.opfsGetMergedFile = async (videoId) => {
    const dir = await VDM.opfsTaskDir(videoId);
    const fh = await dir.getFileHandle(MERGED_NAME);
    return fh.getFile();
  };

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

  VDM.opfsWriteMergeMeta = async (videoId, mergedThrough) => {
    const dir = await VDM.opfsTaskDir(videoId);
    const fh = await dir.getFileHandle(MERGE_META, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify({ mergedThrough }));
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

  VDM.createOpfsStreamMerger = (videoId, segmentCount, { startAppend = 0 } = {}) => {
    let nextAppend = startAppend;
    let writable = null;
    let mergedBytes = 0;
    let chain = Promise.resolve();
    const dirPromise = VDM.opfsTaskDir(videoId);

    async function getWritable() {
      if (!writable) {
        const dir = await dirPromise;
        const outFh = await dir.getFileHandle(MERGED_NAME, { create: true });
        const opts = startAppend > 0 ? { keepExistingData: true } : undefined;
        writable = await outFh.createWritable(opts);
      }
      return writable;
    }

    async function appendReady(onProgress) {
      const dir = await dirPromise;
      const w = await getWritable();
      while (nextAppend < segmentCount) {
        const segName = VDM.opfsSegName(nextAppend);
        try {
          const segFh = await dir.getFileHandle(segName);
          const segFile = await segFh.getFile();
          await segFile.stream().pipeTo(w, { preventClose: true });
          mergedBytes += segFile.size;
          await dir.removeEntry(segName);
          nextAppend++;
          if (onProgress) onProgress(nextAppend, segmentCount, mergedBytes);
        } catch {
          break;
        }
      }
    }

    return {
      onSegmentWritten(onProgress) {
        chain = chain.then(() => appendReady(onProgress));
        return chain;
      },
      async finish(onProgress) {
        await chain;
        while (nextAppend < segmentCount) {
          await appendReady(onProgress);
        }
        if (writable) {
          await writable.close();
          writable = null;
        }
        return mergedBytes;
      },
      isComplete() {
        return nextAppend >= segmentCount;
      },
    };
  };

  VDM.opfsRemoveTask = async (videoId) => {
    try {
      const cache = await getCacheRoot();
      await cache.removeEntry(videoId, { recursive: true });
    } catch {
      /* already gone */
    }
  };

  VDM.saveOpfsMergedViaBridge = async (videoId, fileName) => {
    const downloadPath = VDM.buildDownloadPath(fileName);
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
  };
})();
