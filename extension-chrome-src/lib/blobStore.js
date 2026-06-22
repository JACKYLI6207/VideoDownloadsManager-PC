(function () {
  const VDM = self.VDM;
  const DB_NAME = "vdm-blob-store";
  const STORE = "chunks";
  const CHUNK = 8 * 1024 * 1024;

  const coverCacheKey = (saveName) => `cover:${saveName}`;

  async function saveJpegBufferToDownloads(buffer, saveName) {
    if (!buffer?.byteLength || !saveName) return false;
    const path = VDM.buildDownloadPath(`${saveName}.jpg`);
    const blob = new Blob([buffer], { type: "image/jpeg" });
    try {
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        const objUrl = URL.createObjectURL(blob);
        try {
          await VDM.startChromeDownload(objUrl, path);
          return true;
        } finally {
          setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
        }
      }
      await VDM.saveBlobViaOffscreen(blob, path);
      return true;
    } catch {
      return false;
    }
  }

  function tryDirectPosterDownload(url, saveName) {
    if (!url || !saveName || !chrome.downloads?.download) return Promise.resolve(false);
    const path = VDM.buildDownloadPath(`${saveName}.jpg`);
    return new Promise((resolve) => {
      chrome.downloads.download({ url, filename: path, saveAs: false }, (id) => {
        resolve(!chrome.runtime.lastError && !!id);
      });
    });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  VDM.putBlobBuffer = async (key, buffer) => {
    const bytes =
      buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
    const total = bytes.byteLength;
    const n = Math.max(1, Math.ceil(total / CHUNK));
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    os.put({ total, n }, `${key}:meta`);
    for (let i = 0; i < n; i++) {
      const start = i * CHUNK;
      const end = Math.min(start + CHUNK, total);
      os.put(bytes.subarray(start, end), `${key}:${i}`);
    }
    await txDone(tx);
  };

  VDM.readBlobBuffer = async (key) => {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const os = tx.objectStore(STORE);
    const meta = await new Promise((resolve, reject) => {
      const r = os.get(`${key}:meta`);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!meta) throw new Error("暫存資料不存在");
    const parts = [];
    for (let i = 0; i < meta.n; i++) {
      const part = await new Promise((resolve, reject) => {
        const r = os.get(`${key}:${i}`);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      parts.push(part);
    }
    await txDone(tx);
    const out = new Uint8Array(meta.total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out.buffer;
  };

  VDM.deleteBlobBuffer = async (key) => {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    const meta = await new Promise((resolve) => {
      const r = os.get(`${key}:meta`);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    });
    if (meta) {
      os.delete(`${key}:meta`);
      for (let i = 0; i < meta.n; i++) os.delete(`${key}:${i}`);
    }
    await txDone(tx);
  };

  let _offscreenReady = null;

  VDM.ensureOffscreen = async () => {
    if (!chrome.offscreen?.createDocument) {
      throw new Error("需要 Chrome 109+");
    }
    if (_offscreenReady) return _offscreenReady;

    _offscreenReady = (async () => {
      try {
        if (typeof chrome.offscreen.hasDocument === "function") {
          if (await chrome.offscreen.hasDocument()) return;
        }
        await chrome.offscreen.createDocument({
          url: "offscreen/save.html",
          reasons: ["WORKERS"],
          justification: "FSA 分塊串流存檔（避免 blob URL 大檔 OOM）",
        });
      } catch (e) {
        const msg = String(e.message || e);
        // 並行 createDocument 或已有 offscreen 時視為成功
        if (/already exists|single offscreen document|Only a single offscreen/i.test(msg)) return;
        throw e;
      }
    })();

    try {
      await _offscreenReady;
    } catch (e) {
      _offscreenReady = null;
      throw e;
    }
  };

  /**
   * 在 offscreen document 內執行 OPFS → FSA 分塊串流存檔。
   * 比 SW / bridge 的 createObjectURL 路徑穩定，是大檔唯一安全存檔方式。
   */
  VDM.saveOpfsViaOffscreenFsa = async (videoId, fileName) => {
    await VDM.ensureOffscreen();
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "OFFSCREEN_FSA_SAVE", videoId, fileName },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (res?.error) {
            reject(new Error(res.error));
            return;
          }
          resolve(res);
        }
      );
    });
  };

  function fsaOffscreenRequest(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "OFFSCREEN_FSA", ...payload }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (res?.error) {
          reject(new Error(res.error));
          return;
        }
        resolve(res);
      });
    });
  }

  const fsaOffscreenAborters = new Map();

  VDM.fsaAbortOffscreenFetches = (taskId) => {
    if (!taskId) return;
    for (const [requestId, entry] of fsaOffscreenAborters) {
      if (entry.taskId !== taskId) continue;
      entry.abort?.();
      entry.reject?.(new Error("cancelled"));
      chrome.runtime.sendMessage({ type: "OFFSCREEN_FSA_ABORT", requestId }).catch(() => {});
      fsaOffscreenAborters.delete(requestId);
    }
  };

  /** offscreen 內 fetch 串流直寫 FSA（片段模式主路徑） */
  VDM.fsaFetchAndSaveSegmentViaOffscreen = async (
    taskDir,
    index,
    url,
    headers,
    signal,
    taskId,
    importFsaKey = ""
  ) => {
    await VDM.ensureOffscreen();
    const requestId = `${taskId || taskDir}:${index}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const localAbort = new AbortController();
    const onAbort = () => {
      localAbort.abort();
      chrome.runtime.sendMessage({ type: "OFFSCREEN_FSA_ABORT", requestId }).catch(() => {});
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      const res = await new Promise((resolve, reject) => {
        fsaOffscreenAborters.set(requestId, {
          taskId,
          abort: () => localAbort.abort(),
          reject,
        });
        chrome.runtime.sendMessage(
          {
            type: "OFFSCREEN_FSA",
            action: "fetchAndSaveSegment",
            requestId,
            taskDir,
            index,
            url,
            headers,
            importFsaKey,
          },
          (reply) => {
            fsaOffscreenAborters.delete(requestId);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (reply?.error) {
              reject(new Error(reply.error));
              return;
            }
            resolve(reply);
          }
        );
      });
      return res.byteLength || 0;
    } catch (e) {
      if (localAbort.signal.aborted || signal?.aborted) {
        throw new Error("cancelled");
      }
      throw e;
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
      fsaOffscreenAborters.delete(requestId);
    }
  };

  VDM.fsaCopySegmentFromOpfsViaOffscreen = async (taskDir, videoId, index, importFsaKey = "") => {
    await VDM.ensureOffscreen();
    return fsaOffscreenRequest({ action: "copySegmentFromOpfs", taskDir, videoId, index, importFsaKey });
  };

  /** fallback：SW 已下載的 buffer 寫入 FSA */
  VDM.fsaWriteSegmentViaOffscreen = async (taskDir, index, buffer, importFsaKey = "") => {
    await VDM.ensureOffscreen();
    return fsaOffscreenRequest({ action: "writeSegment", taskDir, index, buffer, importFsaKey });
  };

  VDM.fsaScanSegmentsViaOffscreen = async (taskDir, segmentCount, importFsaKey = "") => {
    await VDM.ensureOffscreen();
    const res = await fsaOffscreenRequest({ action: "scanSegments", taskDir, segmentCount, importFsaKey });
    return { downloaded: res.downloaded || 0, missing: res.missing || [] };
  };

  VDM.fsaWritePlaylistViaOffscreen = async (taskDir, segments, importFsaKey = "") => {
    await VDM.ensureOffscreen();
    return fsaOffscreenRequest({ action: "writePlaylist", taskDir, segments, importFsaKey });
  };

  VDM.fsaClearTaskDirViaOffscreen = async (taskDir, importFsaKey = "") => {
    await VDM.ensureOffscreen();
    return fsaOffscreenRequest({ action: "clearTaskDir", taskDir, importFsaKey });
  };

  VDM.verifyImportFsaHandleViaOffscreen = async (importFsaKey) => {
    await VDM.ensureOffscreen();
    return fsaOffscreenRequest({ action: "verifyImportHandle", importFsaKey });
  };

  VDM.startChromeDownload = (blobUrl, fileName) =>
    new Promise((resolve, reject) => {
      if (!chrome.downloads?.download) {
        reject(new Error("chrome.downloads 不可用"));
        return;
      }
      chrome.downloads.download({ url: blobUrl, filename: fileName, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: "REVOKE_BLOB_URL", url: blobUrl }).catch(() => {});
        }, 120_000);
        resolve(id);
      });
    });

  VDM.saveBlobViaOffscreen = async (blob, fileName) => {
    const key = VDM.uid();
    const buffer = await blob.arrayBuffer();
    await VDM.putBlobBuffer(key, buffer);
    await VDM.ensureOffscreen();
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "OFFSCREEN_DOWNLOAD_BLOB",
          key,
          fileName,
          mimeType: blob.type || "video/mp4",
        },
        async (res) => {
          await VDM.deleteBlobBuffer(key).catch(() => {});
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (res?.error) {
            reject(new Error(res.error));
            return;
          }
          if (!res?.blobUrl) {
            reject(new Error("無法建立下載連結"));
            return;
          }
          try {
            const id = await VDM.startChromeDownload(res.blobUrl, fileName);
            resolve(id);
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  };

  async function tabExists(tabId) {
    if (!tabId) return false;
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  async function fetchCoverJpegBytes(video, tabId, url) {
    if (tabId && (await tabExists(tabId)) && chrome.scripting?.executeScript) {
      try {
        const referer = video.referer || video.pageUrl || "";
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: async (imgUrl, ref) => {
            try {
              const res = await fetch(imgUrl, {
                credentials: "include",
                headers: ref ? { Referer: ref } : {},
              });
              if (!res.ok) return null;
              const blob = await res.blob();
              if (/image\/jpe?g/i.test(blob.type)) {
                const buf = await blob.arrayBuffer();
                return Array.from(new Uint8Array(buf));
              }
              const bitmap = await createImageBitmap(blob);
              const canvas = document.createElement("canvas");
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              canvas.getContext("2d").drawImage(bitmap, 0, 0);
              const jpeg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
              if (!jpeg) return null;
              const buf = await jpeg.arrayBuffer();
              return Array.from(new Uint8Array(buf));
            } catch {
              return null;
            }
          },
          args: [url, referer],
        });
        if (result?.length) return new Uint8Array(result).buffer;
      } catch {
        /* fall through */
      }
    }

    try {
      const headers = await VDM.buildHeaders(video, url, { forBackground: true });
      const res = await fetch(url, { headers });
      if (res.ok) return res.arrayBuffer();
    } catch {
      /* fall through */
    }

    if (tabId && (await tabExists(tabId))) {
      try {
        return await VDM.fetchBytesInPage(tabId, url, video);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  VDM.prefetchCoverJpeg = async (video, tabId, saveName) => {
    const url = video?.posterUrl;
    if (!url || !saveName) return false;

    if (await tryDirectPosterDownload(url, saveName)) {
      video._coverSaved = true;
      return true;
    }

    const buffer = await fetchCoverJpegBytes(video, tabId, url);
    if (!buffer?.byteLength) return false;
    await VDM.putBlobBuffer(coverCacheKey(saveName), buffer);
    const saved = await saveJpegBufferToDownloads(buffer, saveName);
    if (saved) video._coverSaved = true;
    return saved;
  };

  VDM.takeCachedCover = async (saveName) => {
    try {
      return await VDM.readBlobBuffer(coverCacheKey(saveName));
    } catch {
      return null;
    }
  };

  VDM.deleteCachedCover = async (saveName) => {
    await VDM.deleteBlobBuffer(coverCacheKey(saveName)).catch(() => {});
  };

  VDM.saveCoverJpg = async (video, fileNameBase, tabId) => {
    if (!fileNameBase) return false;
    if (video?._coverSaved) return true;

    const cached = await VDM.takeCachedCover(fileNameBase);
    if (cached?.byteLength) {
      const ok = await saveJpegBufferToDownloads(cached, fileNameBase);
      if (ok) {
        video._coverSaved = true;
        await VDM.deleteCachedCover(fileNameBase);
      }
      return ok;
    }

    const url = video?.posterUrl;
    if (!url) return false;

    const path = VDM.buildDownloadPath(`${fileNameBase}.jpg`);
    const tryDirectDownload = () =>
      new Promise((resolve) => {
        if (!chrome.downloads?.download) {
          resolve(false);
          return;
        }
        chrome.downloads.download({ url, filename: path, saveAs: false }, (id) => {
          resolve(!chrome.runtime.lastError && !!id);
        });
      });

    if (await tryDirectDownload()) {
      video._coverSaved = true;
      return true;
    }

    const buffer = await fetchCoverJpegBytes(video, tabId, url);
    if (!buffer?.byteLength) return false;
    const ok = await saveJpegBufferToDownloads(buffer, fileNameBase);
    if (ok) video._coverSaved = true;
    return ok;
  };
})();
