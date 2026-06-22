"""內建擴充路徑（整合版：PC 推送 + 擴充下載）。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

VDM_BUNDLED_MARKER = "VDM_Bundled"
# 舊版標記（向後相容）
VDM_PC_MARKER = "VDM_PC"
VDM_CHROME_MARKER = "VDM_Chrome"


def _is_vdm_manifest(path: Path, marker: str) -> bool:
    manifest = path / "manifest.json"
    if not manifest.is_file():
        return False
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        return data.get("description") == marker
    except (OSError, json.JSONDecodeError):
        return False


def _find_bundled(marker: str, meipass_name: str) -> Path | None:
    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / meipass_name
        if _is_vdm_manifest(bundled, marker):
            return bundled.resolve()

    root = Path(__file__).resolve().parents[1]
    ext_root = root / "extension"
    if not ext_root.is_dir():
        return None
    if _is_vdm_manifest(ext_root, marker):
        return ext_root.resolve()
    for child in sorted(ext_root.iterdir()):
        if child.is_dir() and _is_vdm_manifest(child, marker):
            return child.resolve()
    return None


def bundled_extension_dir() -> Path | None:
    for marker in (VDM_BUNDLED_MARKER, VDM_CHROME_MARKER, VDM_PC_MARKER):
        path = _find_bundled(marker, "vdm-extension")
        if path:
            return path
    return None


def bundled_vdm_extension_dir() -> Path | None:
    return bundled_extension_dir()


def bundled_chrome_extension_dir() -> Path | None:
    return bundled_extension_dir()


def bundled_extension_dirs() -> list[Path]:
    path = bundled_extension_dir()
    return [path] if path else []
