"""Chrome 瀏覽器驅動（BiDi 載入 VDM 擴充）。"""

from __future__ import annotations

import socket
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PyQt6.QtCore import QThread, pyqtSignal

from vdm_pc.browser.chrome_paths import resolve_chrome_exe
from vdm_pc.browser.extension_install import (
    bidi_install_extensions,
    prepare_profile_extensions,
    preferences_has_extensions,
)
from vdm_pc.browser.extension_loader import (
    extension_id_from_path,
    extension_label,
    parse_extension_urls,
    sync_extensions,
)
from vdm_pc.extension_bundle import bundled_vdm_extension_dir


class PlaywrightDriver(QThread):
    browser_ready = pyqtSignal()
    extensions_loaded = pyqtSignal(str)
    status_message = pyqtSignal(str)
    page_closed = pyqtSignal()
    error_occurred = pyqtSignal(str)

    def __init__(
        self,
        profile_dir: Path,
        *,
        extension_urls: list[str] | None = None,
        headless: bool = False,
    ) -> None:
        super().__init__()
        self.profile_dir = profile_dir
        self.extension_urls = extension_urls or []
        self.headless = headless
        self.active = True
        self._target_url: str | None = None
        self._cdp_port: int | None = None
        self._chrome_proc: subprocess.Popen | None = None

    def navigate(self, url: str) -> None:
        self._target_url = url

    def stop_browser(self) -> None:
        self.active = False

    @staticmethod
    def _pick_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    @staticmethod
    def _wait_cdp_port(port: int, timeout: float = 45.0) -> None:
        deadline = time.time() + timeout
        url = f"http://127.0.0.1:{port}/json/version"
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=1.5) as res:
                    if res.status == 200:
                        return
            except OSError:
                time.sleep(0.25)
        raise RuntimeError(f"Chrome 偵錯埠 {port} 未就緒")

    def _launch_chrome(self, port: int, chrome_exe: Path) -> subprocess.Popen:
        cmd = [
            str(chrome_exe),
            f"--user-data-dir={self.profile_dir}",
            f"--remote-debugging-port={port}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-blink-features=AutomationControlled",
            "--enable-unsafe-extension-debugging",
            "about:blank",
        ]
        return subprocess.Popen(cmd)

    def _shutdown_browser(self) -> None:
        if self._chrome_proc is not None:
            try:
                self._chrome_proc.terminate()
                self._chrome_proc.wait(timeout=8)
            except Exception:
                try:
                    self._chrome_proc.kill()
                except Exception:
                    pass
            self._chrome_proc = None
        self._cdp_port = None

    def _navigate_cdp(self, target: str) -> None:
        if not self._cdp_port:
            return
        nav_url = f"http://127.0.0.1:{self._cdp_port}/json/new?{urllib.parse.quote(target)}"
        urllib.request.urlopen(nav_url, timeout=10)

    def run(self) -> None:
        try:
            def log(msg: str) -> None:
                self.status_message.emit(msg)

            vdm_path = bundled_vdm_extension_dir()
            if not vdm_path:
                self.error_occurred.emit("找不到內建 VDM 擴充，請重新建置 EXE")
                return

            user_paths = sync_extensions(self.extension_urls, log=log) if self.extension_urls else []
            ext_paths = [vdm_path] + user_paths

            prepare_profile_extensions(ext_paths, self.profile_dir, log=log)

            chrome_exe = resolve_chrome_exe(log=log)
            port = self._pick_free_port()
            self._cdp_port = port
            log("啟動 Google Chrome（含 VDM 擴充）…")
            self._chrome_proc = self._launch_chrome(port, chrome_exe)
            self._wait_cdp_port(port)
            debugger = f"localhost:{port}"

            try:
                bidi_install_extensions(debugger, [vdm_path], log=log)
            except Exception as exc:  # noqa: BLE001
                self.error_occurred.emit(f"VDM 擴充安裝失敗：{exc}")
                raise

            if user_paths:
                user_ids = [extension_id_from_path(path) for path in user_paths]
                if not preferences_has_extensions(self.profile_dir, user_ids):
                    try:
                        bidi_install_extensions(debugger, user_paths, log=log)
                    except Exception as exc:  # noqa: BLE001
                        log(f"其他擴充安裝失敗：{exc}")

            labels = [extension_label(path) for path in ext_paths]
            self.extensions_loaded.emit(
                f"{'、'.join(labels)}（{len(ext_paths)} 個，請點工具列圖示開面板）"
            )
            self.browser_ready.emit()

            while self.active:
                if self._target_url:
                    target = self._target_url
                    self._target_url = None
                    try:
                        self._navigate_cdp(target)
                    except Exception as exc:  # noqa: BLE001
                        self.error_occurred.emit(str(exc))
                time.sleep(0.2)
        except Exception as exc:  # noqa: BLE001
            self.error_occurred.emit(str(exc))
        finally:
            self._shutdown_browser()
            self.page_closed.emit()
