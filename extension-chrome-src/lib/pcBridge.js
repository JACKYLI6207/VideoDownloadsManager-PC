(function () {
  const VDM = (self.VDM = self.VDM || {});
  const PC_BRIDGE_PORT = 18429;
  const PC_BRIDGE_BASE = `http://127.0.0.1:${PC_BRIDGE_PORT}`;
  const PC_BRIDGE_URL = `${PC_BRIDGE_BASE}/push-tasks`;
  const BUNDLED_EXTENSION_IDS = new Set([
    "ggdnpjnbnfkefamaimapljjpfefmjjpf",
    "anokolhjgbidjccbgmahcgdagmmdoddi",
  ]);

  function manifestDescription() {
    try {
      return chrome.runtime.getManifest().description || "";
    } catch {
      return "";
    }
  }

  VDM.isPcMode = function isPcMode() {
    return manifestDescription() === "VDM_PC";
  };

  VDM.isBundledExtension = function isBundledExtension() {
    const desc = manifestDescription();
    if (desc === "VDM_Bundled" || desc === "VDM_Chrome" || desc === "VDM_PC") return true;
    try {
      return BUNDLED_EXTENSION_IDS.has(chrome.runtime.id);
    } catch {
      return false;
    }
  };

  VDM.isBundledChrome = VDM.isBundledExtension;

  VDM.pushTasksToPc = async function pushTasksToPc(tasks) {
    if (!VDM.isBundledExtension() && !VDM.isPcMode()) {
      throw new Error("非 PC 整合擴充模式");
    }
    const payload = {
      format: "vdm-active-tasks",
      version: 1,
      source: "vdm-extension-pc",
      tasks: tasks || [],
    };
    const res = await fetch(PC_BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(`PC 版未回應（${res.status}）${detail ? `：${detail.slice(0, 80)}` : ""}`);
    }
    return res.json().catch(() => ({}));
  };

  VDM.pushNamesToPc = async function pushNamesToPc(names) {
    if (!VDM.isBundledExtension() && !VDM.isPcMode()) {
      throw new Error("非 PC 整合擴充模式");
    }
    const list = Array.isArray(names) ? names.filter(Boolean) : [];
    if (!list.length) throw new Error("名稱列表為空");
    const res = await fetch(`${PC_BRIDGE_BASE}/push-names`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "vdm-search-names",
        version: 1,
        source: "vdm-extension-pc",
        names: list,
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(`PC 版未回應（${res.status}）${detail ? `：${detail.slice(0, 80)}` : ""}`);
    }
    return res.json().catch(() => ({}));
  };
})();
