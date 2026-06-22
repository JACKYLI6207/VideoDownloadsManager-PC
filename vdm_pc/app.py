"""主視窗。"""
from __future__ import annotations

from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QLabel, QMainWindow, QTabWidget, QVBoxLayout, QWidget

from vdm_pc.browser.panel import BrowserPanel
from vdm_pc.config import app_icon_path
from vdm_pc.download.engine import DownloadEngine
from vdm_pc.log_bus import LogBus
from vdm_pc.ui.active_panel import ActivePanel
from vdm_pc.ui.folder_panel import FolderPanel
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
        header.setStyleSheet("font-size:18px;font-weight:700;padding:8px 4px;color:#f1f5f9;")
        layout.addWidget(header)

        tabs = QTabWidget()
        self._tabs = tabs
        self.browser_panel = BrowserPanel(settings)
        tabs.addTab(self.browser_panel, "瀏覽器")
        self.active_panel = ActivePanel(engine, settings)
        tabs.addTab(self.active_panel, "合併中")
        tabs.addTab(LogPanel(log_bus), "日誌")
        tabs.addTab(SettingsPanel(settings, engine), "設定")
        tabs.addTab(FolderPanel(), "資料夾")
        layout.addWidget(tabs, 1)

        log_bus.push("info", "VDM PC 已啟動")
