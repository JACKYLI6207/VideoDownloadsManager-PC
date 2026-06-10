"""設定讀寫（對應擴充 vdmSettings）。"""
from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[1]

DEFAULTS = {
    "maxConcurrentTasks": 2,
    "maxConnections": 3,
    "downloadFolder": "",
    "downloadSubfolder": "",
    "segmentCacheDir": "vdm-cache",
    "browserProfileDir": "",
    "browserExtensionUrls": "",
}

_CONFIG_PATH = Path.home() / "AppData" / "Roaming" / "VideoDownloadsManager-PC" / "settings.json"


def app_icon_path() -> Path | None:
    """執行時 logo.ico 路徑（開發 / PyInstaller 打包）。"""
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(Path(meipass) / "logo.ico")
        candidates.append(Path(sys.executable).with_name("logo.ico"))
    candidates.append(_PROJECT_ROOT / "logo.ico")
    for path in candidates:
        if path.is_file():
            return path
    return None


def _ensure_parent() -> None:
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)


def load_settings() -> dict:
    data = deepcopy(DEFAULTS)
    if _CONFIG_PATH.is_file():
        try:
            loaded = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data.update(loaded)
        except (OSError, json.JSONDecodeError):
            pass
    data["maxConcurrentTasks"] = max(1, int(data.get("maxConcurrentTasks") or 2))
    data["maxConnections"] = max(1, int(data.get("maxConnections") or 3))
    if not data.get("downloadFolder"):
        data["downloadFolder"] = str(Path.home() / "Downloads" / "VideoDownloadsManager")
    return data


def save_settings(settings: dict) -> None:
    _ensure_parent()
    payload = {k: settings.get(k, DEFAULTS[k]) for k in DEFAULTS}
    _CONFIG_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def download_root(settings: dict) -> Path:
    root = Path(settings.get("downloadFolder") or DEFAULTS["downloadFolder"])
    root.mkdir(parents=True, exist_ok=True)
    return root


def normalize_subfolder(path: str) -> str:
    raw = str(path or "").replace("\\", "/").strip()
    if not raw:
        return ""
    parts = []
    for seg in raw.split("/"):
        seg = seg.replace("<", "_").replace(">", "_").replace(":", "_").replace('"', "_")
        seg = seg.replace("|", "_").replace("?", "_").replace("*", "_").strip()
        if seg and seg not in {".", ".."}:
            parts.append(seg)
    return "/".join(parts)


def build_output_path(settings: dict, file_name: str) -> Path:
    root = download_root(settings)
    sub = normalize_subfolder(settings.get("downloadSubfolder") or "")
    if sub:
        root = root / Path(*sub.split("/"))
    root.mkdir(parents=True, exist_ok=True)
    return root / file_name


def cache_root(settings: dict) -> Path:
    base = Path.home() / "AppData" / "Local" / "VideoDownloadsManager-PC"
    name = settings.get("segmentCacheDir") or "vdm-cache"
    root = base / name
    root.mkdir(parents=True, exist_ok=True)
    return root


def browser_profile_dir(settings: dict, *, with_extensions: bool = False) -> Path:
    del with_extensions  # 擴充與一般瀏覽共用同一設定檔
    custom = settings.get("browserProfileDir") or ""
    if custom:
        path = Path(custom)
    else:
        path = Path.home() / "AppData" / "Local" / "VideoDownloadsManager-PC" / "browser-profile"
    path.mkdir(parents=True, exist_ok=True)
    return path
