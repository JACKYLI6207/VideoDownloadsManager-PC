"""主視窗。"""
from __future__ import annotations

from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QLabel, QMainWindow, QTabWidget, QVBoxLayout, QWidget

from vdm_pc.browser.panel import BrowserPanel
from vdm_pc.config import app_icon_path
from vdm_pc.download.engine import DownloadEngine
from vdm_pc.log_bus import LogBus
from vdm_pc.models import DownloadTask, VideoMeta
from vdm_pc.ui.active_panel import ActivePanel
from vdm_pc.ui.completed_panel import CompletedPanel
from vdm_pc.ui.log_panel import LogPanel
from vdm_pc.ui.settings_panel import SettingsPanel
from vdm_pc.ui.styles import APP_STYLESHEET


class MainWindow(QMainWindow):
    def __init__(self, settings: dict, engine: DownloadEngine, log_bus: LogBus) -> None:
        super().__init__()
        self.settings = settings
        self.engine = engine
        self.log_bus = log_bus
        self.setWindowTitle("Video Downloads Manager PC")
        icon_file = app_icon_path()
        if icon_file:
            self.setWindowIcon(QIcon(str(icon_file)))
        self.setStyleSheet(APP_STYLESHEET)

        host = QWidget()
        self.setCentralWidget(host)
        layout = QVBoxLayout(host)

        header = QLabel("⬇ Video Downloads Manager PC")
        header.setStyleSheet("font-size:18px;font-weight:700;padding:8px 4px;")
        layout.addWidget(header)

        tabs = QTabWidget()
        self._tabs = tabs
        self.browser_panel = BrowserPanel(settings)
        self.browser_panel.add_download.connect(self._add_from_browser)
        tabs.addTab(self.browser_panel, "瀏覽器")
        self.active_panel = ActivePanel(engine)
        tabs.addTab(self.active_panel, "進行中")
        tabs.addTab(CompletedPanel(engine, settings), "已完成")
        tabs.addTab(LogPanel(log_bus), "日誌")
        tabs.addTab(SettingsPanel(settings, engine), "設定")
        layout.addWidget(tabs, 1)

        log_bus.push("info", "VDM PC 已啟動")

    def _add_from_browser(self, payload) -> None:
        if isinstance(payload, DownloadTask):
            task = payload
        else:
            video = VideoMeta(
                url=payload.url,
                page_url=payload.page_url,
                referer=payload.headers.get("referer") or payload.page_url,
                title=payload.title,
                is_m3u8=".m3u8" in payload.url.lower(),
                request_headers=dict(payload.headers),
            )
            task = DownloadTask.create(video, payload.title)
        self.engine.add_task(task, auto_start=True)
        self.log_bus.push("info", f"已加入下載：{task.file_name}")
        self._tabs.setCurrentWidget(self.active_panel)
        self.active_panel.refresh()
