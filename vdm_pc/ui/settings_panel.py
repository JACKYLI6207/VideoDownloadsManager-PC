"""設定分頁。"""
from __future__ import annotations

import os
import subprocess

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from vdm_pc.config import cache_root, download_root, save_settings


class SettingsPanel(QWidget):
    def __init__(self, settings: dict, engine, parent=None) -> None:
        super().__init__(parent)
        self.settings = settings
        self.engine = engine
        root = QVBoxLayout(self)
        form = QFormLayout()

        self.tasks_val = QLabel(str(settings["maxConcurrentTasks"]))
        self.tasks_slider = QSlider(Qt.Orientation.Horizontal)
        self.tasks_slider.setRange(1, 6)
        self.tasks_slider.setValue(int(settings["maxConcurrentTasks"]))
        self.tasks_slider.valueChanged.connect(self._on_tasks)
        tasks_row = QHBoxLayout()
        tasks_row.addWidget(self.tasks_slider, 1)
        tasks_row.addWidget(self.tasks_val)
        form.addRow("同時最大下載任務數", tasks_row)

        self.conn_val = QLabel(str(settings["maxConnections"]))
        self.conn_slider = QSlider(Qt.Orientation.Horizontal)
        self.conn_slider.setRange(1, 18)
        self.conn_slider.setValue(int(settings["maxConnections"]))
        self.conn_slider.valueChanged.connect(self._on_conn)
        conn_row = QHBoxLayout()
        conn_row.addWidget(self.conn_slider, 1)
        conn_row.addWidget(self.conn_val)
        form.addRow("單任務最大連線數（HLS 片段並行）", conn_row)

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

        root.addLayout(form)
        hint = QLabel(
            f"片段暫存：{cache_root(settings)}\n"
            "瀏覽器 Cookie 保存在 Playwright 持久化 Chrome 設定檔。\n"
            "HLS 合併使用內建 FFmpeg，輸出標準 MP4。"
        )
        hint.setObjectName("muted")
        hint.setWordWrap(True)
        root.addWidget(hint)
        root.addStretch(1)

    def _on_tasks(self, val: int) -> None:
        self.settings["maxConcurrentTasks"] = val
        self.tasks_val.setText(str(val))
        self.engine.update_settings(self.settings)
        save_settings(self.settings)

    def _on_conn(self, val: int) -> None:
        self.settings["maxConnections"] = val
        self.conn_val.setText(str(val))
        self.engine.update_settings(self.settings)
        save_settings(self.settings)

    def _on_subfolder(self) -> None:
        self.settings["downloadSubfolder"] = self.subfolder_input.text().strip()
        save_settings(self.settings)

    def _on_cache(self) -> None:
        self.settings["segmentCacheDir"] = self.cache_input.text().strip() or "vdm-cache"
        save_settings(self.settings)

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
