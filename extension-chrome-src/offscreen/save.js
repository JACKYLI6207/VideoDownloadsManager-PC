const fsaFetchAborters = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "OFFSCREEN_FSA_ABORT") {
    const ac = fsaFetchAborters.get(msg.requestId);
    if (ac) ac.abort();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "REVOKE_BLOB_URL") {
    try {
      URL.revokeObjectURL(msg.url);
    } catch {
      /* ignore */
    }
    return;
  }

  if (msg.type === "OFFSCREEN_FSA_SAVE") {
    (async () => {
      try {
        const { videoId, fileName } = msg;
        if (!videoId || !fileName) throw new Error("缺少 videoId 或 fileName");
        await VDM.fsaSave(videoId, fileName);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "OFFSCREEN_FSA") {
    (async () => {
      try {
        const { action, taskDir, index, buffer, videoId, segmentCount, segments, importFsaKey = "" } = msg;
        if (action === "writeSegment") {
          await VDM.fsaWriteSegmentBuffer(taskDir, index, buffer, importFsaKey);
          sendResponse({ ok: true });
        } else if (action === "copySegmentFromOpfs") {
          await VDM.fsaCopySegmentFromOpfs(taskDir, videoId, index, importFsaKey);
          sendResponse({ ok: true });
        } else if (action === "fetchAndSaveSegment") {
          const ac = new AbortController();
          if (msg.requestId) fsaFetchAborters.set(msg.requestId, ac);
          try {
            const byteLength = await VDM.fsaFetchAndSaveSegment(
              taskDir,
              index,
              msg.url,
              msg.headers,
              ac.signal,
              importFsaKey
            );
            sendResponse({ ok: true, byteLength });
          } catch (e) {
            const msgText = e?.name === "AbortError" ? "cancelled" : e.message || String(e);
            sendResponse({ error: msgText });
          } finally {
            if (msg.requestId) fsaFetchAborters.delete(msg.requestId);
          }
        } else if (action === "scanSegments") {
          sendResponse(await VDM.fsaScanSegments(taskDir, segmentCount, importFsaKey));
        } else if (action === "writePlaylist") {
          await VDM.fsaWritePlaylist(taskDir, segments, importFsaKey);
          sendResponse({ ok: true });
        } else if (action === "clearTaskDir") {
          await VDM.fsaClearTaskDir(taskDir, importFsaKey);
          sendResponse({ ok: true });
        } else if (action === "verifyImportHandle") {
          const handle = await VDM.fsaGetImportHandle(importFsaKey);
          if (!handle) {
            sendResponse({ ok: false, error: "找不到導入資料夾，請重新用「選擇資料夾」指定" });
            return;
          }
          const perm = await handle.queryPermission({ mode: "readwrite" });
          if (perm !== "granted") {
            sendResponse({ ok: false, error: "導入資料夾沒有寫入權限，請重新選擇並授權" });
            return;
          }
          sendResponse({ ok: true, name: handle.name, permission: perm });
        } else {
          throw new Error(`未知 FSA 操作：${action}`);
        }
      } catch (e) {
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "OFFSCREEN_DOWNLOAD_OPFS") {
    (async () => {
      try {
        const file = await VDM.opfsGetMergedFile(msg.taskId);
        const max = VDM.OPFS_BRIDGE_MAX_BYTES || 64 * 1024 * 1024;
        if (file.size > max) {
          throw new Error(
            `檔案 ${(file.size / 1048576).toFixed(0)}MB 過大，請在設定中選擇「直接存檔資料夾」`
          );
        }
        const blobUrl = URL.createObjectURL(file);
        await VDM.opfsRemoveTask(msg.taskId);
        sendResponse({ blobUrl });
      } catch (e) {
        await VDM.opfsRemoveTask(msg.taskId).catch(() => {});
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "OFFSCREEN_DOWNLOAD_BLOB") {
    (async () => {
      try {
        const buffer = await VDM.readBlobBuffer(msg.key);
        const max = VDM.OPFS_BRIDGE_MAX_BYTES || 64 * 1024 * 1024;
        if (buffer.byteLength > max) {
          throw new Error("暫存資料過大，請使用直接存檔資料夾");
        }
        const blob = new Blob([buffer], { type: msg.mimeType || "video/mp4" });
        const blobUrl = URL.createObjectURL(blob);
        await VDM.deleteBlobBuffer(msg.key);
        sendResponse({ blobUrl });
      } catch (e) {
        await VDM.deleteBlobBuffer(msg.key).catch(() => {});
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true;
  }
});
