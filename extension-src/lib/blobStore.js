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

  VDM.ensureOffscreen = async () => {
    if (!chrome.offscreen?.createDocument) {
      throw new Error("需要 Chrome 109+");
    }
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen/save.html",
        reasons: ["BLOBS"],
        justification: "儲存合併後的影片檔",
      });
    } catch (e) {
      if (!String(e.message || e).includes("already exists")) throw e;
    }
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
