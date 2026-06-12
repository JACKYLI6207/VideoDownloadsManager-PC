"""Chrome 擴充：設定檔持久化 + BiDi 載入。"""

from __future__ import annotations

import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

import selenium.webdriver.chrome.webdriver  # noqa: F401 — PyInstaller 需打包
import selenium.webdriver.common.bidi.webextension  # noqa: F401

from vdm_pc.browser.extension_loader import chrome_arg_path, extension_id_from_path, extension_label

_KNOWN_EXT_LABELS = {
    "bgnkhhnnamicmpeenaelnjfhikgbkllg": "AdGuard",
    "ailoabdmgclmfmhdagmlohpjlbpffblp": "Surfshark",
    "lnemmogegmgllangfmlpclaomcknfnbp": "Hide Images",
}

_SYNC_FILES = (
    "manifest.json",
    "background/service_worker.js",
    "sidepanel/panel-pc.js",
    "sidepanel/panel-pc.html",
    "sidepanel/panel.js",
)


def extension_label_from_id(ext_id: str) -> str:
    return _KNOWN_EXT_LABELS.get(ext_id, ext_id)


def _extension_version(path: Path) -> str:
    manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
    return str(manifest.get("version") or "1.0.0")


def _extension_sync_key(path: Path) -> str:
    h = hashlib.sha256()
    for rel in _SYNC_FILES:
        fp = path / rel
        if fp.is_file():
            h.update(rel.encode())
            h.update(fp.read_bytes())
    return h.hexdigest()


def _installed_extension_dir(profile_dir: Path, ext_id: str) -> Path | None:
    ext_root = profile_dir / "Default" / "Extensions" / ext_id
    if not ext_root.is_dir():
        return None
    for child in sorted(ext_root.iterdir(), reverse=True):
        if child.is_dir() and (child / "manifest.json").is_file():
            return child
    return None


def _read_extension_settings(profile_dir: Path) -> dict:
    for name in ("Secure Preferences", "Preferences"):
        prefs_file = profile_dir / "Default" / name
        if not prefs_file.is_file():
            continue
        try:
            data = json.loads(prefs_file.read_text(encoding="utf-8"))
            settings = data.get("extensions", {}).get("settings", {})
            if isinstance(settings, dict) and settings:
                return settings
        except (OSError, json.JSONDecodeError):
            continue
    return {}


def preferences_has_extensions(profile_dir: Path, ext_ids: list[str]) -> bool:
    """Chrome 是否已在設定檔註冊擴充（僅複製資料夾不夠）。"""
    settings = _read_extension_settings(profile_dir)
    return bool(settings) and all(ext_id in settings for ext_id in ext_ids)


def seed_extensions_to_profile(ext_paths: list[Path], profile_dir: Path, *, log=None) -> list[Path]:
    """快取解壓擴充到設定檔（供 Chrome/BiDi 使用）。回傳有更新的路徑。"""
    updated: list[Path] = []
    for path in ext_paths:
        ext_id = extension_id_from_path(path)
        version = _extension_version(path)
        dest = profile_dir / "Default" / "Extensions" / ext_id / version

        if not (path / "manifest.json").is_file():
            continue

        installed_dir = _installed_extension_dir(profile_dir, ext_id)
        if installed_dir:
            same_version = _extension_version(installed_dir) == version
            same_payload = _extension_sync_key(path) == _extension_sync_key(installed_dir)
            if same_version and same_payload:
                continue

        ext_root = profile_dir / "Default" / "Extensions" / ext_id
        if ext_root.is_dir():
            shutil.rmtree(ext_root, ignore_errors=True)
        shutil.copytree(path, dest)
        updated.append(path)
        if log:
            log(f"同步擴充快取：{extension_label(path)} v{version}")
    return updated


def prepare_profile_extensions(ext_paths: list[Path], profile_dir: Path, *, log=None) -> bool:
    """啟動 Chrome 前準備。回傳是否需要 BiDi 載入。"""
    if not ext_paths:
        return False

    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "Default").mkdir(parents=True, exist_ok=True)

    updated = seed_extensions_to_profile(ext_paths, profile_dir, log=log)
    if updated:
        if log:
            log("擴充檔案已更新，啟動後以 BiDi 載入…")
        return True

    ext_ids = [extension_id_from_path(path) for path in ext_paths]
    if preferences_has_extensions(profile_dir, ext_ids):
        if log:
            log("擴充已註冊於設定檔，跳過 BiDi 安裝")
        return False

    if log:
        log("擴充尚未註冊，啟動後以 BiDi 載入…")
    return True


def _chrome_version_from_debugger(debugger_address: str) -> str:
    url = f"http://{debugger_address}/json/version"
    with urllib.request.urlopen(url, timeout=10) as res:
        data = json.loads(res.read().decode("utf-8", errors="replace"))
    browser = str(data.get("Browser") or "")
    if "/" in browser:
        return browser.split("/", 1)[1]
    return ""


def bidi_install_extensions(debugger_address: str, ext_paths: list[Path], *, log=None) -> None:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    if not ext_paths:
        return

    chrome_version = _chrome_version_from_debugger(debugger_address)
    opts = Options()
    opts.enable_bidi = True
    opts.add_experimental_option("debuggerAddress", debugger_address)
    if chrome_version:
        opts.browser_version = chrome_version
        if log:
            log(f"Chromedriver 對應 Chrome {chrome_version}")
    driver = webdriver.Chrome(options=opts)
    try:
        for path in ext_paths:
            if log:
                log(f"載入擴充：{extension_label(path)} …")
            driver.webextension.install(path=chrome_arg_path(path))
            if log:
                log(f"OK {extension_label(path)}")
    finally:
        driver.quit()

