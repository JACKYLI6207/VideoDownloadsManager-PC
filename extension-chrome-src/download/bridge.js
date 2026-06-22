function waitDownloadEnd(downloadId, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChange);
      reject(new Error("瀏覽器下載逾時"));
    }, timeoutMs);

    function onChange(delta) {
      if (delta.id !== downloadId) return;
      const st = delta.state?.current;
      if (st === "complete") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChange);
        resolve();
      } else if (st === "interrupted") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChange);
        chrome.downloads.search({ id: downloadId }, (items) => {
          reject(new Error(items[0]?.error || "瀏覽器下載中斷"));
        });
      }
    }

    chrome.downloads.onChanged.addListener(onChange);
    chrome.downloads.search({ id: downloadId }, (items) => {
      const item = items[0];
      if (item?.state === "complete") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChange);
        resolve();
      } else if (item?.state === "interrupted") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChange);
        reject(new Error(item.error || "瀏覽器下載中斷"));
      }
    });
  });
}

(async function () {
  const params = new URLSearchParams(location.search);
  const videoId = params.get("videoId");
  const fileName = params.get("file") || "video.mp4";
  let blobUrl = "";

  function finish(payload) {
    chrome.runtime.sendMessage({ type: "BRIDGE_DOWNLOAD_DONE", videoId, ...payload });
    setTimeout(() => window.close(), 300);
  }

  try {
    if (!videoId) throw new Error("缺少 videoId");
    const file = await VDM.opfsGetMergedFile(videoId);
    const max = VDM.OPFS_BRIDGE_MAX_BYTES || 64 * 1024 * 1024;
    if (file.size > max) {
      throw new Error(
        `檔案 ${(file.size / 1048576).toFixed(0)}MB 過大，請在設定中選擇「直接存檔資料夾」（FSA），` +
          "否則 Chrome 會因記憶體不足而崩潰"
      );
    }
    blobUrl = URL.createObjectURL(file);

    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: blobUrl, filename: fileName, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });

    await waitDownloadEnd(downloadId);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    await VDM.opfsRemoveTask(videoId);
    finish({ downloadId });
  } catch (e) {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    finish({ error: e.message || String(e) });
  }
})();
