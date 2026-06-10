"""內建 VDM 擴充路徑（PC 精簡版）。"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def _is_vdm_pc_manifest(path: Path) -> bool:
    manifest = path / "manifest.json"
    if not manifest.is_file():
        return False
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        return data.get("description") == "VDM_PC"
    except (OSError, json.JSONDecodeError):
        return False


def bundled_vdm_extension_dir() -> Path | None:
    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / "vdm-extension"
        if _is_vdm_pc_manifest(bundled):
            return bundled.resolve()

    root = Path(__file__).resolve().parents[1]
    ext_root = root / "extension"
    if ext_root.is_dir():
        if _is_vdm_pc_manifest(ext_root):
            return ext_root.resolve()
        for child in sorted(ext_root.iterdir()):
            if child.is_dir() and _is_vdm_pc_manifest(child):
                return child.resolve()

    return None
