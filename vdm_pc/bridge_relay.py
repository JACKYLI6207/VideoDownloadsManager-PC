"""橋接 HTTP 執行緒 → Qt 主執行緒的訊號轉發。"""
from __future__ import annotations

from PyQt6.QtCore import QObject, pyqtSignal


class BridgeRelay(QObject):
    tasks_received = pyqtSignal(list)
    names_received = pyqtSignal(list)
