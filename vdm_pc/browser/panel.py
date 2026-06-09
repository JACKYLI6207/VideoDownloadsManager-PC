"""瀏覽器分頁（取代擴充「可下載」）。"""
from __future__ import annotations

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from vdm_pc.browser.driver import PlaywrightDriver
from vdm_pc.browser.sniffer import MediaSniffer, SniffedResource
from vdm_pc.config import browser_profile_dir


class BrowserPanel(QWidget):
    add_download = pyqtSignal(object)

    def __init__(self, settings: dict, parent=None) -> None:
        super().__init__(parent)
        self.settings = settings
        self.sniffer = MediaSniffer()
        self.sniffer.on_found = self._on_resource
        self.driver: PlaywrightDriver | None = None
        self._build_ui()

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setSpacing(10)

        nav = QHBoxLayout()
        self.url_input = QLineEdit()
        self.url_input.setPlaceholderText("輸入網址後按前往（需先啟動瀏覽器）")
        self.go_btn = QPushButton("前往")
        self.go_btn.clicked.connect(self._go)
        nav.addWidget(self.url_input, 1)
        nav.addWidget(self.go_btn)
        root.addLayout(nav)

        ctrl = QHBoxLayout()
        self.start_btn = QPushButton("啟動瀏覽器")
        self.start_btn.clicked.connect(self._start_browser)
        self.stop_btn = QPushButton("關閉瀏覽器")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self._stop_browser)
        self.status_label = QLabel("瀏覽器未啟動")
        self.status_label.setObjectName("muted")
        ctrl.addWidget(self.start_btn)
        ctrl.addWidget(self.stop_btn)
        ctrl.addStretch(1)
        ctrl.addWidget(self.status_label)
        root.addLayout(ctrl)

        body = QHBoxLayout()

        left = QFrame()
        left.setObjectName("card")
        left_layout = QVBoxLayout(left)
        left_layout.addWidget(QLabel("嗅探到的資源"))
        self.resource_list = QListWidget()
        self.resource_list.itemDoubleClicked.connect(self._add_selected)
        left_layout.addWidget(self.resource_list, 1)
        add_btn = QPushButton("加入下載佇列")
        add_btn.clicked.connect(self._add_selected)
        clear_btn = QPushButton("清除列表")
        clear_btn.clicked.connect(self._clear_resources)
        btn_row = QHBoxLayout()
        btn_row.addWidget(add_btn)
        btn_row.addWidget(clear_btn)
        left_layout.addLayout(btn_row)
        body.addWidget(left, 2)

        right = QFrame()
        right.setObjectName("card")
        right_layout = QVBoxLayout(right)
        right_layout.addWidget(QLabel("瀏覽器日誌"))
        self.log_area = QTextEdit()
        self.log_area.setReadOnly(True)
        right_layout.addWidget(self.log_area, 1)
        body.addWidget(right, 1)

        root.addLayout(body, 1)

    def _log(self, msg: str) -> None:
        self.log_area.append(msg)

    def _start_browser(self) -> None:
        if self.driver and self.driver.isRunning():
            return
        profile = browser_profile_dir(self.settings)
        self.driver = PlaywrightDriver(profile, self.sniffer)
        self.driver.browser_ready.connect(self._on_ready)
        self.driver.page_closed.connect(self._on_closed)
        self.driver.resource_detected.connect(self._on_detected)
        self.driver.error_occurred.connect(self._on_error)
        self.driver.start()
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.status_label.setText("正在啟動…")
        self._log("正在啟動 Chrome（Playwright 持久化設定檔）…")

    def _stop_browser(self) -> None:
        if self.driver and self.driver.isRunning():
            self.driver.stop_browser()
        self._on_closed()

    def _on_ready(self) -> None:
        self.status_label.setText("瀏覽器就緒")
        self._log("✅ 瀏覽器已就緒，請在彈出的 Chrome 視窗中操作")

    def _on_closed(self) -> None:
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.status_label.setText("瀏覽器未啟動")

    def _on_error(self, msg: str) -> None:
        self._log(f"⚠️ {msg}")
        self._log("請確認已安裝 Google Chrome，並執行：playwright install chrome")

    def _go(self) -> None:
        url = self.url_input.text().strip()
        if not url:
            return
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        if self.driver and self.driver.isRunning():
            self.driver.navigate(url)
            self._log(f"導航：{url}")
        else:
            self._log("請先啟動瀏覽器")

    def _on_detected(self, url: str, headers: dict, page_url: str, title: str) -> None:
        res = self.sniffer.add(url, headers, page_url, title)
        if res:
            self._log(f"捕捉：{res.title}")

    def _on_resource(self, res: SniffedResource) -> None:
        text = f"{res.title}\n{res.url[:120]}"
        for i in range(self.resource_list.count()):
            item = self.resource_list.item(i)
            if item and item.data(Qt.ItemDataRole.UserRole).url == res.url:
                return
        item = QListWidgetItem(text)
        item.setData(Qt.ItemDataRole.UserRole, res)
        self.resource_list.insertItem(0, item)

    def _add_selected(self) -> None:
        item = self.resource_list.currentItem()
        if not item:
            return
        res: SniffedResource = item.data(Qt.ItemDataRole.UserRole)
        self.add_download.emit(res)

    def _clear_resources(self) -> None:
        self.sniffer.clear()
        self.resource_list.clear()
