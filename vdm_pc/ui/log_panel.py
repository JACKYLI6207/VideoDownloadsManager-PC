"""日誌分頁。"""
from __future__ import annotations

from datetime import datetime

from PyQt6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QTextEdit, QVBoxLayout, QWidget

from vdm_pc.log_bus import LogBus


class LogPanel(QWidget):
    def __init__(self, log_bus: LogBus, parent=None) -> None:
        super().__init__(parent)
        self.log_bus = log_bus
        root = QVBoxLayout(self)
        bar = QHBoxLayout()
        bar.addWidget(QLabel("錯誤 / 事件日誌"))
        bar.addStretch(1)
        clear_btn = QPushButton("清除")
        clear_btn.clicked.connect(self._clear)
        bar.addWidget(clear_btn)
        root.addLayout(bar)
        self.text = QTextEdit()
        self.text.setReadOnly(True)
        root.addWidget(self.text, 1)
        log_bus.entry_added.connect(self._append)
        self._reload()

    def _reload(self) -> None:
        self.text.clear()
        for entry in self.log_bus.list_entries():
            self._append(entry)

    def _append(self, entry) -> None:
        if entry is None:
            self.text.clear()
            return
        ts = datetime.fromtimestamp(entry.ts).strftime("%H:%M:%S")
        line = f"[{ts}] [{entry.level}] {entry.message}"
        if entry.detail:
            line += f"\n  {entry.detail}"
        self.text.append(line)

    def _clear(self) -> None:
        self.log_bus.clear()
