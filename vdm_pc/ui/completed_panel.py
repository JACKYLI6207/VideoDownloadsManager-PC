"""已完成分頁。"""
from __future__ import annotations

import os
import subprocess

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QListWidget, QPushButton, QVBoxLayout, QWidget

from vdm_pc.config import build_output_path
from vdm_pc.download.engine import DownloadEngine


class CompletedPanel(QWidget):
    def __init__(self, engine: DownloadEngine, settings: dict, parent=None) -> None:
        super().__init__(parent)
        self.engine = engine
        self.settings = settings
        root = QVBoxLayout(self)
        bar = QHBoxLayout()
        self.count = QLabel("0 個")
        open_btn = QPushButton("開啟檔案")
        open_btn.clicked.connect(self._open_selected)
        clear_btn = QPushButton("清除")
        clear_btn.clicked.connect(self._clear)
        bar.addWidget(self.count)
        bar.addStretch(1)
        bar.addWidget(open_btn)
        bar.addWidget(clear_btn)
        root.addLayout(bar)
        self.list = QListWidget()
        root.addWidget(self.list, 1)
        self.empty = QLabel("尚無已完成下載")
        self.empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty.setObjectName("muted")
        root.addWidget(self.empty)
        engine.task_completed.connect(lambda _t: self.refresh())
        self.refresh()

    def refresh(self) -> None:
        self.list.clear()
        for task in self.engine.completed:
            self.list.addItem(f"{task.file_name}  ·  {task.video.url[:80]}")
        n = len(self.engine.completed)
        self.count.setText(f"{n} 個")
        self.empty.setVisible(n == 0)

    def _open_selected(self) -> None:
        row = self.list.currentRow()
        if row < 0 or row >= len(self.engine.completed):
            return
        task = self.engine.completed[row]
        path = build_output_path(self.settings, task.file_name)
        if not path.is_file():
            return
        if os.name == "nt":
            os.startfile(str(path))  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", str(path)])  # noqa: S603,S607

    def _clear(self) -> None:
        self.engine.completed.clear()
        self.refresh()
