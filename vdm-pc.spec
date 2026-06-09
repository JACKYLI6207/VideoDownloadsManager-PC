# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

block_cipher = None

playwright_datas, playwright_binaries, playwright_hidden = collect_all("playwright")
imageio_datas, imageio_binaries, imageio_hidden = collect_all("imageio_ffmpeg")
pyqt_datas, pyqt_binaries, pyqt_hidden = collect_all("PyQt6")

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=playwright_binaries + imageio_binaries + pyqt_binaries,
    datas=playwright_datas + imageio_datas + pyqt_datas,
    hiddenimports=[
        "vdm_pc",
        "vdm_pc.app",
        "vdm_pc.browser.driver",
        "vdm_pc.browser.panel",
        "vdm_pc.browser.sniffer",
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
        "imageio_ffmpeg",
        "httpx",
        "h11",
        "certifi",
        "anyio",
        "sniffio",
        "httpcore",
        "idna",
    ]
    + playwright_hidden
    + imageio_hidden
    + pyqt_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="VideoDownloadsManagerPC",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="VideoDownloadsManagerPC",
)
