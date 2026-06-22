"""Verify periodic auto-scan merge wiring in PC app."""

from __future__ import annotations



import sys

from pathlib import Path



root = Path(__file__).resolve().parents[1]

sw = (root / "extension-chrome-src/background/service_worker.js").read_text(encoding="utf-8")

pc = (root / "vdm_pc/ui/active_panel.py").read_text(encoding="utf-8")

merge = (root / "vdm_pc/merge_local.py").read_text(encoding="utf-8")

main_py = (root / "main.py").read_text(encoding="utf-8")



errors: list[str] = []



if "notifyPcMergeReady" in sw:

    errors.append("service_worker must not notify PC merge-ready")



if "pushMergeReadyToPc" in sw:

    errors.append("service_worker must not call pushMergeReadyToPc")



if "/merge-ready" in (root / "vdm_pc/bridge_server.py").read_text(encoding="utf-8"):

    errors.append("bridge_server must not expose /merge-ready")



if "on_merge_ready" in main_py:

    errors.append("main.py must not wire merge-ready callback")



if "_run_auto_scan_merge" not in pc:

    errors.append("active_panel missing _run_auto_scan_merge")



if "auto_scan_cb" not in pc or "scan_interval_spin" not in pc:

    errors.append("active_panel missing auto scan checkbox / interval spinbox")



if "output_mp4_missing" not in pc:

    errors.append("active_panel must skip folders when output mp4 already exists")



if "folder_stable_for_merge" not in pc:

    errors.append("active_panel must wait for stable segment folders before merge")



if "output_mp4_missing" not in merge or "expected_output_mp4" not in merge:

    errors.append("merge_local missing output mp4 helpers")



if "autoScanMergeEnabled" not in (root / "vdm_pc/config.py").read_text(encoding="utf-8"):

    errors.append("config missing autoScanMergeEnabled setting")



if errors:

    print("VERIFY FAILED:")

    for e in errors:

        print(f"  - {e}")

    sys.exit(1)



print("VERIFY OK: periodic scan auto-merge, no extension merge-ready bridge")

