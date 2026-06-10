chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "REVOKE_BLOB_URL") {
    try {
      URL.revokeObjectURL(msg.url);
    } catch {
      /* ignore */
    }
    return;
  }

  if (msg.type === "OFFSCREEN_DOWNLOAD_OPFS") {
    (async () => {
      try {
        const file = await VDM.opfsGetMergedFile(msg.taskId);
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
