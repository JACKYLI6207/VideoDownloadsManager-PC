"""未安裝時自動下載並安裝 Google Chrome。"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

import httpx

CHROME_INSTALLER_URL = "https://dl.google.com/chrome/install/latest/chrome_installer.exe"
_CHROME_CANDIDATES = (
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path.home() / "AppData" / "Local" / "Google" / "Chrome" / "Application" / "chrome.exe",
)


def find_chrome_exe() -> Path | None:
    for path in _CHROME_CANDIDATES:
        if path.is_file():
            return path
    return None


def _wait_for_chrome(timeout: float = 180.0) -> Path | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        chrome = find_chrome_exe()
        if chrome:
            return chrome
        time.sleep(2)
    return None


def _download_installer(dest: Path, *, log=None) -> None:
    if log:
        log("下載 Google Chrome 安裝程式…")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(follow_redirects=True, timeout=600) as client:
        with client.stream("GET", CHROME_INSTALLER_URL) as res:
            res.raise_for_status()
            with dest.open("wb") as out:
                for chunk in res.iter_bytes(1024 * 256):
                    out.write(chunk)


def install_chrome(*, log=None) -> Path:
    existing = find_chrome_exe()
    if existing:
        return existing

    cache_dir = Path.home() / "AppData" / "Local" / "VideoDownloadsManager-PC" / "chrome-setup"
    installer = cache_dir / "chrome_installer.exe"

    if not installer.is_file() or installer.stat().st_size < 100_000:
        _download_installer(installer, log=log)

    if log:
        log("正在安裝 Google Chrome（約 1～2 分鐘，請稍候）…")

    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.run(
        [str(installer), "/silent", "/install"],
        timeout=300,
        creationflags=flags,
        check=False,
    )

    chrome = _wait_for_chrome()
    if not chrome:
        raise RuntimeError("Google Chrome 安裝後仍找不到程式，請手動安裝後重試")

    if log:
        log(f"Google Chrome 已安裝：{chrome}")
    return chrome


def ensure_chrome_exe(*, log=None) -> Path:
    """回傳系統 Chrome；未安裝則自動下載安裝。"""
    chrome = find_chrome_exe()
    if chrome:
        return chrome
    return install_chrome(log=log)
