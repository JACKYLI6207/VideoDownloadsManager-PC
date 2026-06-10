"""Google Chrome 路徑。"""
from __future__ import annotations

from pathlib import Path

from vdm_pc.browser.chrome_install import ensure_chrome_exe


def resolve_chrome_exe(*, log=None) -> Path:
    """回傳 chrome.exe；未安裝時自動下載安裝 Google Chrome。"""
    return ensure_chrome_exe(log=log)
