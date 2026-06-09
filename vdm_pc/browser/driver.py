"""Playwright 瀏覽器驅動（參考 m3u8-video-sniffer PlaywrightDriver）。"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from PyQt6.QtCore import QThread, pyqtSignal
from playwright.sync_api import sync_playwright

from vdm_pc.browser.sniffer import MediaSniffer


class PlaywrightDriver(QThread):
    browser_ready = pyqtSignal()
    page_closed = pyqtSignal()
    resource_detected = pyqtSignal(str, dict, str, str)
    error_occurred = pyqtSignal(str)

    def __init__(self, profile_dir: Path, sniffer: MediaSniffer, headless: bool = False) -> None:
        super().__init__()
        self.profile_dir = profile_dir
        self.sniffer = sniffer
        self.headless = headless
        self.active = True
        self._target_url: str | None = None
        self._recent: dict[str, float] = {}

    def navigate(self, url: str) -> None:
        self._target_url = url

    def stop_browser(self) -> None:
        self.active = False

    def run(self) -> None:
        try:
            if getattr(sys, "frozen", False):
                driver_root = Path(sys._MEIPASS) / "playwright" / "driver"
                if driver_root.is_dir():
                    os.environ.setdefault("PLAYWRIGHT_DRIVER_PATH", str(driver_root))
            with sync_playwright() as p:
                context = p.chromium.launch_persistent_context(
                    user_data_dir=str(self.profile_dir),
                    channel="chrome",
                    headless=self.headless,
                    args=["--disable-blink-features=AutomationControlled"],
                    ignore_default_args=["--enable-automation"],
                )
                page = context.pages[0] if context.pages else context.new_page()

                def on_page(new_page) -> None:
                    self._setup_page(new_page)

                context.on("page", on_page)
                self._setup_page(page)
                self.browser_ready.emit()

                last_url = ""
                while self.active:
                    if self._target_url:
                        target = self._target_url
                        self._target_url = None
                        try:
                            page.goto(target, wait_until="domcontentloaded", timeout=60000)
                        except Exception as exc:  # noqa: BLE001
                            self.error_occurred.emit(str(exc))

                    try:
                        cur = page.url
                        if cur != last_url:
                            last_url = cur
                    except Exception:
                        pass

                    time.sleep(0.2)

                context.close()
        except Exception as exc:  # noqa: BLE001
            self.error_occurred.emit(str(exc))
        finally:
            self.page_closed.emit()

    def _setup_page(self, page) -> None:
        def on_request(request) -> None:
            url = request.url
            if not url:
                return
            now = time.time()
            if self._recent.get(url, 0) > now - 1.0:
                return
            self._recent[url] = now
            try:
                page_url = page.url
                title = page.title() or ""
            except Exception:
                page_url = ""
                title = ""
            headers = {k.lower(): v for k, v in request.headers.items()}
            self.resource_detected.emit(url, headers, page_url, title)

        def on_response(response) -> None:
            url = response.url
            if not url:
                return
            now = time.time()
            if self._recent.get(url, 0) > now - 1.0:
                return
            self._recent[url] = now
            try:
                page_url = page.url
                title = page.title() or ""
            except Exception:
                page_url = ""
                title = ""
            req = response.request
            headers = {k.lower(): v for k, v in req.headers.items()}
            self.resource_detected.emit(url, headers, page_url, title)

        page.on("request", on_request)
        page.on("response", on_response)
