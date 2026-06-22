(function () {
  const MODE_KEY = "vdmPanelMode";
  const tabs = document.querySelectorAll(".mode-tab");
  const shells = {
    pc: document.getElementById("mode-pc"),
    download: document.getElementById("mode-download"),
  };

  function showPopoutError(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.hidden = false;
    toast.textContent = message;
    toast.className = "toast";
  }

  function bindPopoutButton() {
    const btn = document.getElementById("popoutBtn");
    if (!btn || btn.dataset.vdmBound === "1") return;
    btn.dataset.vdmBound = "1";
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_MANAGER_TAB", mode: "download" }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          showPopoutError(err.message || "無法開啟分頁");
          return;
        }
        if (res?.error) {
          showPopoutError(res.error);
          return;
        }
        if (!location.search.includes("view=tab")) {
          window.close();
        }
      });
    });
  }

  function setMode(name) {
    const mode = name === "download" ? "download" : "pc";
    tabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
    shells.pc?.classList.toggle("active", mode === "pc");
    shells.download?.classList.toggle("active", mode === "download");
    try {
      sessionStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
    document.dispatchEvent(new CustomEvent("vdm-mode-change", { detail: { mode } }));
    if (mode === "download") bindPopoutButton();
  }

  tabs.forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  let initial = "pc";
  const urlParams = new URLSearchParams(location.search);
  const urlMode = urlParams.get("mode");
  if (urlMode === "download" || urlMode === "pc") {
    initial = urlMode;
  } else if (urlParams.get("view") === "tab") {
    initial = "download";
  } else {
    try {
      const saved = sessionStorage.getItem(MODE_KEY);
      if (saved === "download" || saved === "pc") initial = saved;
    } catch {
      /* ignore */
    }
  }
  setMode(initial);
  bindPopoutButton();
})();
