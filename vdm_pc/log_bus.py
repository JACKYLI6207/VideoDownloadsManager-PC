"""全域日誌匯流排。"""
from __future__ import annotations

from PyQt6.QtCore import QObject, pyqtSignal

from vdm_pc.models import LogEntry


class LogBus(QObject):
    entry_added = pyqtSignal(object)

    def __init__(self) -> None:
        super().__init__()
        self._entries: list[LogEntry] = []

    def push(self, level: str, message: str, detail: str = "") -> None:
        entry = LogEntry(level=level, message=message, detail=detail)
        self._entries.append(entry)
        if len(self._entries) > 500:
            self._entries = self._entries[-500:]
        self.entry_added.emit(entry)

    def list_entries(self) -> list[LogEntry]:
        return list(self._entries)

    def clear(self) -> None:
        self._entries.clear()
        self.entry_added.emit(None)
