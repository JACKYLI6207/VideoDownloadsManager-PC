"""設定分頁。"""
from __future__ import annotations

import os
import subprocess

from PyQt6.QtGui import QIntValidator
from PyQt6.QtWidgets import (
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from vdm_pc.browser.extension_loader import extensions_root, parse_extension_urls, sync_extensions

from vdm_pc.config import cache_root, download_root, save_settings


class _ExtUrlsInput(QPlainTextEdit):
    """QPlainTextEdit 無 editingFinished，改在失焦時儲存。"""

    def __init__(self, on_commit, parent=None) -> None:
        super().__init__(parent)
        self._on_commit = on_commit

    def focusOutEvent(self, event) -> None:  # noqa: N802
        super().focusOutEvent(event)
        self._on_commit()


class SettingsPanel(QWidget):
    def __init__(self, settings: dict, engine, parent=None) -> None:
        super().__init__(parent)
        self.settings = settings
        self.engine = engine
        root = QVBoxLayout(self)
        form = QFormLayout()

        self.tasks_input = QLineEdit(str(settings["maxConcurrentTasks"]))
        self.tasks_input.setValidator(QIntValidator(1, 9999, self))
        self.tasks_input.setFixedWidth(72)
        self.tasks_input.setPlaceholderText("1 以上整數")
        self.tasks_input.editingFinished.connect(self._on_tasks)
        form.addRow("同時最大下載任務數", self.tasks_input)

        self.conn_input = QLineEdit(str(settings["maxConnections"]))
        self.conn_input.setValidator(QIntValidator(1, 9999, self))
        self.conn_input.setFixedWidth(72)
        self.conn_input.setPlaceholderText("1 以上整數")
        self.conn_input.editingFinished.connect(self._on_conn)
        form.addRow("單任務最大連線數（HLS 片段並行）", self.conn_input)

        folder_row = QHBoxLayout()
        self.folder_label = QLabel(str(download_root(settings)))
        pick_btn = QPushButton("選擇")
        pick_btn.clicked.connect(self._pick_folder)
        open_btn = QPushButton("開啟")
        open_btn.clicked.connect(self._open_folder)
        folder_row.addWidget(self.folder_label, 1)
        folder_row.addWidget(pick_btn)
        folder_row.addWidget(open_btn)
        form.addRow("下載根目錄", folder_row)

        self.subfolder_input = QLineEdit(settings.get("downloadSubfolder") or "")
        self.subfolder_input.setPlaceholderText("例：MyVideos/2024（可選子資料夾）")
        self.subfolder_input.editingFinished.connect(self._on_subfolder)
        form.addRow("相對子路徑", self.subfolder_input)

        self.cache_input = QLineEdit(settings.get("segmentCacheDir") or "vdm-cache")
        self.cache_input.editingFinished.connect(self._on_cache)
        form.addRow("片段暫存目錄名", self.cache_input)

        self.ext_urls_input = _ExtUrlsInput(self._on_ext_urls)
        self.ext_urls_input.setPlainText(settings.get("browserExtensionUrls") or "")
        self.ext_urls_input.setPlaceholderText(
            "每行一個：Chrome 線上商店網址、本機 .crx 或解壓資料夾路徑"
        )
        self.ext_urls_input.setMaximumHeight(88)
        ext_btn_row = QHBoxLayout()
        ext_install_btn = QPushButton("下載擴充")
        ext_install_btn.clicked.connect(self._install_extensions)
        ext_open_btn = QPushButton("開啟擴充資料夾")
        ext_open_btn.clicked.connect(self._open_extensions_dir)
        ext_btn_row.addWidget(ext_install_btn)
        ext_btn_row.addWidget(ext_open_btn)
        ext_btn_row.addStretch(1)
        ext_wrap = QVBoxLayout()
        ext_wrap.addWidget(self.ext_urls_input)
        ext_wrap.addLayout(ext_btn_row)
        form.addRow("瀏覽器擴充網址", ext_wrap)

        root.addLayout(form)
        hint = QLabel(
            f"片段暫存：{cache_root(settings)}\n"
            f"擴充檔案：{extensions_root()}\n"
            "有擴充時會自動安裝至內建 Chrome；請點工具列圖示開啟面板。\n"
            "任務數／連線數可自訂；全局片段並行硬上限仍為 108。\n"
            "HLS 合併使用內建 FFmpeg，輸出標準 MP4。"
        )
        hint.setObjectName("muted")
        hint.setWordWrap(True)
        root.addWidget(hint)
        root.addStretch(1)

    @staticmethod
    def _parse_positive_int(text: str, fallback: int) -> int:
        try:
            return max(1, int(str(text).strip()))
        except (TypeError, ValueError):
            return fallback

    def _on_tasks(self) -> None:
        val = self._parse_positive_int(self.tasks_input.text(), int(self.settings.get("maxConcurrentTasks") or 2))
        self.tasks_input.setText(str(val))
        self.settings["maxConcurrentTasks"] = val
        self.engine.update_settings(self.settings)
        save_settings(self.settings)

    def _on_conn(self) -> None:
        val = self._parse_positive_int(self.conn_input.text(), int(self.settings.get("maxConnections") or 3))
        self.conn_input.setText(str(val))
        self.settings["maxConnections"] = val
        self.engine.update_settings(self.settings)
        save_settings(self.settings)

    def _on_subfolder(self) -> None:
        self.settings["downloadSubfolder"] = self.subfolder_input.text().strip()
        save_settings(self.settings)

    def _on_cache(self) -> None:
        self.settings["segmentCacheDir"] = self.cache_input.text().strip() or "vdm-cache"
        save_settings(self.settings)

    def _on_ext_urls(self) -> None:
        self.settings["browserExtensionUrls"] = self.ext_urls_input.toPlainText().strip()
        save_settings(self.settings)

    def _install_extensions(self) -> None:
        self._on_ext_urls()
        urls = parse_extension_urls(self.settings.get("browserExtensionUrls") or "")
        if not urls:
            return
        paths = sync_extensions(urls)
        self.ext_urls_input.setToolTip(f"已就緒 {len(paths)} 個擴充，請重新啟動瀏覽器")

    def _open_extensions_dir(self) -> None:
        path = str(extensions_root())
        if os.name == "nt":
            os.startfile(path)  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", path])  # noqa: S603,S607

    def _pick_folder(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "選擇下載資料夾", self.settings.get("downloadFolder", ""))
        if path:
            self.settings["downloadFolder"] = path
            self.folder_label.setText(path)
            save_settings(self.settings)

    def _open_folder(self) -> None:
        path = str(download_root(self.settings))
        if os.name == "nt":
            os.startfile(path)  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", path])  # noqa: S603,S607
