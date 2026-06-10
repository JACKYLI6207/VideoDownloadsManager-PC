# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

block_cipher = None

# 僅打包 FFmpeg 二進位（HLS 合併必需，約 80MB）
imageio_datas, imageio_binaries, imageio_hidden = collect_all("imageio_ffmpeg")

from pathlib import Path as _Path

_root = _Path(".")
_icon = _root / "logo.ico"
_ext_root = _Path("extension")
_vdm_ext_datas = []
if _ext_root.is_dir():
    import json as _json

    def _try_add_vdm_ext(_path):
        _manifest = _path / "manifest.json"
        if not _manifest.is_file():
            return False
        try:
            _data = _json.loads(_manifest.read_text(encoding="utf-8"))
            if _data.get("description") == "VDM_PC":
                _vdm_ext_datas.append((str(_path), "vdm-extension"))
                return True
        except (OSError, _json.JSONDecodeError):
            pass
        return False

    if not _try_add_vdm_ext(_ext_root):
        for _child in sorted(_ext_root.iterdir()):
            if _child.is_dir() and _try_add_vdm_ext(_child):
                break

_icon_datas = [(str(_icon), ".")] if _icon.is_file() else []

# PyQt6 / Selenium 依實際 import 由 hook 自動收集，不用 collect_all 整包打入
_hidden = [
    "vdm_pc",
    "vdm_pc.app",
    "vdm_pc.bridge_server",
    "vdm_pc.extension_bundle",
    "vdm_pc.browser.driver",
    "vdm_pc.browser.panel",
    "vdm_pc.browser.chrome_paths",
    "vdm_pc.browser.chrome_install",
    "vdm_pc.browser.extension_install",
    "vdm_pc.browser.extension_loader",
    "vdm_pc.config",
    "vdm_pc.cpu_limit",
    "vdm_pc.download.engine",
    "vdm_pc.download.disk_store",
    "vdm_pc.download.ffmpeg_util",
    "vdm_pc.download.m3u8",
    "vdm_pc.import_tasks",
    "vdm_pc.log_bus",
    "vdm_pc.models",
    "vdm_pc.persist",
    "vdm_pc.ui.active_panel",
    "vdm_pc.ui.completed_panel",
    "vdm_pc.ui.log_panel",
    "vdm_pc.ui.settings_panel",
    "vdm_pc.ui.styles",
    "PyQt6.sip",
    "selenium.webdriver.chrome.webdriver",
    "selenium.webdriver.chrome.options",
    "selenium.webdriver.chrome.service",
    "selenium.webdriver.common.bidi.webextension",
    "selenium.webdriver.common.selenium_manager",
    "websocket",
    "imageio_ffmpeg",
    "httpx",
    "h11",
    "certifi",
    "httpcore",
    "idna",
] + imageio_hidden

_excludes = [
    "tkinter",
    "matplotlib",
    "numpy",
    "pandas",
    "PIL",
    "PyQt6.QtWebEngineCore",
    "PyQt6.QtWebEngineWidgets",
    "PyQt6.QtWebEngineQuick",
    "PyQt6.QtMultimedia",
    "PyQt6.QtMultimediaWidgets",
    "PyQt6.QtBluetooth",
    "PyQt6.QtNfc",
    "PyQt6.QtPositioning",
    "PyQt6.QtSensors",
    "PyQt6.QtSerialPort",
    "PyQt6.QtCharts",
    "PyQt6.QtDataVisualization",
    "PyQt6.QtGraphs",
    "PyQt6.QtGraphsWidgets",
    "PyQt6.Qt3DCore",
    "PyQt6.Qt3DRender",
    "PyQt6.Qt3DInput",
    "PyQt6.Qt3DLogic",
    "PyQt6.Qt3DAnimation",
    "PyQt6.Qt3DExtras",
    "PyQt6.QtQuick",
    "PyQt6.QtQuickWidgets",
    "PyQt6.QtQuick3D",
    "PyQt6.QtQml",
    "PyQt6.QtDesigner",
    "PyQt6.QtHelp",
    "PyQt6.QtPdf",
    "PyQt6.QtPdfWidgets",
    "PyQt6.QtOpenGL",
    "PyQt6.QtOpenGLWidgets",
    "selenium.webdriver.firefox",
    "selenium.webdriver.edge",
    "selenium.webdriver.ie",
    "selenium.webdriver.safari",
    "selenium.webdriver.webkitgtk",
    "selenium.webdriver.wpewebkit",
]

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=imageio_binaries,
    datas=imageio_datas + _vdm_ext_datas + _icon_datas,
    hiddenimports=_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=_excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="VideoDownloadsManagerPC",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(_icon) if _icon.is_file() else None,
)
