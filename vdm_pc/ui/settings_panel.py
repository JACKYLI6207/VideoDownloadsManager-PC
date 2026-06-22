"""設定分頁。"""
from __future__ import annotations

import os
import subprocess

from PyQt6.QtWidgets import (
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from vdm_pc.browser.extension_loader import extensions_root, parse_extension_urls, sync_extensions
from vdm_pc.config import save_settings


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
            f"擴充檔案：{extensions_root()}\n"
            "有擴充時會自動安裝至內建 Chrome；請點工具列圖示開啟面板。"
        )
        hint.setObjectName("muted")
        hint.setWordWrap(True)
        root.addWidget(hint)
        root.addStretch(1)

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
