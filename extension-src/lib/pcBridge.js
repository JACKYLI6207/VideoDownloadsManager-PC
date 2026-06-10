(function () {
  const VDM = (self.VDM = self.VDM || {});
  const PC_BRIDGE_PORT = 18429;
  const PC_BRIDGE_URL = `http://127.0.0.1:${PC_BRIDGE_PORT}/push-tasks`;

  VDM.isPcMode = function isPcMode() {
    try {
      return chrome.runtime.getManifest().description === "VDM_PC";
    } catch {
      return false;
    }
  };

  VDM.pushTasksToPc = async function pushTasksToPc(tasks) {
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
})();
