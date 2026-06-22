"""Verify popout button wiring and panel script load safety."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
src = root / "extension-chrome-src" / "sidepanel"
html = (src / "panel.html").read_text(encoding="utf-8")
mode_js = (src / "panel-mode.js").read_text(encoding="utf-8")
pc_js = (src / "panel-pc.js").read_text(encoding="utf-8")
panel_js = (src / "panel.js").read_text(encoding="utf-8")
manifest = (root / "extension-chrome-src" / "manifest.json").read_text(encoding="utf-8")

errors: list[str] = []

if "popoutBtn" not in html:
    errors.append("panel.html missing id=popoutBtn")

if "OPEN_MANAGER_TAB" not in mode_js or "popoutBtn" not in mode_js:
    errors.append("panel-mode.js must bind popoutBtn via OPEN_MANAGER_TAB")

if not re.search(r"\(function\s*\(\)\s*\{", pc_js):
    errors.append("panel-pc.js must be wrapped in IIFE to avoid const $ clash with panel.js")

if re.search(r"^const \$", panel_js, re.M) and re.search(r"^const \$", pc_js, re.M):
    if not re.search(r"\(function\s*\(\)\s*\{", pc_js):
        errors.append("panel-pc.js and panel.js both declare const $ at top level")

sw = (root / "extension-chrome-src" / "background" / "service_worker.js").read_text(encoding="utf-8")
if 'msg.mode === "pc"' not in sw or "openManagerTab(resolved.tabId" not in sw:
    errors.append("service_worker OPEN_MANAGER_TAB must pass mode to openManagerTab")

manifest_data = json.loads(manifest)
version = str(manifest_data.get("version") or "")
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    errors.append(f"manifest version invalid: {version!r}")

script_order = re.findall(r'<script src="([^"]+)"', html)
expected = ["panel-mode.js", "panel-pc.js", "panel.js"]
if script_order != expected:
    errors.append(f"script load order wrong: {script_order} != {expected}")

if errors:
    print("VERIFY FAILED:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)

print("VERIFY OK: popout wiring, IIFE, SW handler, version bump")
