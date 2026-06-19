"""資料夾管理分頁：批次移除檔名文字、匯出檔名列表。"""
from __future__ import annotations

import os
import sys

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)


# ── 純邏輯（與 UI 無關） ───────────────────────────────────────────────────

def _is_self_executable(file_path: str) -> bool:
    if getattr(sys, "frozen", False):
        return os.path.normcase(file_path) == os.path.normcase(sys.executable)
    return os.path.normcase(file_path) == os.path.normcase(os.path.abspath(__file__))


def _collect_files(folder: str, exclude_names: set[str] | None = None) -> tuple[list[str], list[str]]:
    exclude = exclude_names or set()
    files: list[str] = []
    errors: list[str] = []
    try:
        entries = os.listdir(folder)
    except OSError as exc:
        return [], [f"無法讀取資料夾：{exc}"]
    for entry in sorted(entries):
        path = os.path.join(folder, entry)
        if entry in exclude:
            continue
        if not os.path.isfile(path):
            continue
        if _is_self_executable(path):
            continue
        files.append(entry)
    return files, errors


def _execute_rename(folder: str, remove_text: str) -> tuple[list[str], list[str]]:
    success: list[str] = []
    errors: list[str] = []
    files, errs = _collect_files(folder)
    errors.extend(errs)
    for entry in files:
        name, ext = os.path.splitext(entry)
        new_name = name.replace(remove_text, "") + ext
        if new_name == entry:
            continue
        if not new_name or new_name == ext:
            errors.append(f"略過（移除後檔名無效）：{entry}")
            continue
        new_path = os.path.join(folder, new_name)
        if os.path.exists(new_path):
            errors.append(f"略過（目標已存在）：{entry} → {new_name}")
            continue
        try:
            os.rename(os.path.join(folder, entry), new_path)
            success.append(f"{entry} → {new_name}")
        except OSError as exc:
            errors.append(f"失敗：{entry} → {new_name}（{exc}）")
    return success, errors


def _execute_export(folder: str, output_name: str) -> tuple[str | None, list[str], list[str]]:
    output_name = output_name.strip() or "檔名列表.txt"
    if not output_name.lower().endswith(".txt"):
        output_name += ".txt"
    output_path = os.path.join(folder, output_name)
    files, errors = _collect_files(folder, exclude_names={output_name})
    names_no_ext = [os.path.splitext(f)[0] for f in files]
    if not names_no_ext:
        return None, names_no_ext, errors or ["資料夾內沒有可匯出的檔案。"]
    try:
        with open(output_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(names_no_ext) + "\n")
    except OSError as exc:
        return None, names_no_ext, [f"無法寫入檔案：{exc}"]
    return output_path, names_no_ext, errors


# ── UI 元件 ───────────────────────────────────────────────────────────────

class _LogView(QPlainTextEdit):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setReadOnly(True)
        self.setFont(self.font())
        self.setStyleSheet("font-family: Consolas, monospace; font-size: 12px;")

    def append_line(self, text: str) -> None:
        self.appendPlainText(text)
        self.verticalScrollBar().setValue(self.verticalScrollBar().maximum())

    def clear_log(self) -> None:
        self.clear()


class _RenameTab(QWidget):
    def __init__(self, get_folder, parent=None) -> None:
        super().__init__(parent)
        self._get_folder = get_folder
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)

        form = QFormLayout()
        self.remove_input = QLineEdit()
        self.remove_input.setPlaceholderText("例：輸入 -34，檔名 12-34.mp4 → 12.mp4")
        self.remove_input.returnPressed.connect(self._on_execute)
        form.addRow("要從檔名中刪除的文字", self.remove_input)
        layout.addLayout(form)

        hint = QLabel("僅對目標資料夾內的檔案進行重新命名，不含子資料夾。")
        hint.setObjectName("muted")
        hint.setWordWrap(True)
        layout.addWidget(hint)

        btn = QPushButton("執行重新命名")
        btn.clicked.connect(self._on_execute)
        layout.addWidget(btn, 0, Qt.AlignmentFlag.AlignLeft)

        layout.addWidget(QLabel("執行結果："))
        self.log = _LogView()
        layout.addWidget(self.log, 1)

    def _on_execute(self) -> None:
        folder = self._get_folder()
        if not folder:
            return
        remove_text = self.remove_input.text()
        if not remove_text:
            QMessageBox.warning(self, "提示", "請先輸入要刪除的文字。")
            return
        reply = QMessageBox.question(
            self, "確認執行",
            f"將從「{folder}」內所有檔名中刪除：\n\n{remove_text}\n\n確定要執行嗎？",
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        self.log.clear_log()
        success, errors = _execute_rename(folder, remove_text)
        if success:
            self.log.append_line("【重新命名成功】")
            for line in success:
                self.log.append_line(line)
        else:
            self.log.append_line("【沒有檔案被重新命名】")
        if errors:
            self.log.append_line("")
            self.log.append_line("【略過或失敗】")
            for line in errors:
                self.log.append_line(line)
        if success:
            QMessageBox.information(self, "完成", f"已成功重新命名 {len(success)} 個檔案。")
        else:
            QMessageBox.information(self, "完成", "沒有符合條件的檔案被重新命名。")


class _ExportTab(QWidget):
    def __init__(self, get_folder, parent=None) -> None:
        super().__init__(parent)
        self._get_folder = get_folder
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)

        hint = QLabel(
            "將目標資料夾內所有檔案名稱匯出為 TXT 列表（不含副檔名），儲存於同一資料夾。\n"
            "適合搭配批次搜尋功能，快速建立搜尋關鍵字列表。"
        )
        hint.setObjectName("muted")
        hint.setWordWrap(True)
        layout.addWidget(hint)

        form = QFormLayout()
        self.name_input = QLineEdit("檔名列表.txt")
        self.name_input.setPlaceholderText("輸出檔名（.txt）")
        self.name_input.returnPressed.connect(self._on_execute)
        form.addRow("輸出檔名", self.name_input)
        layout.addLayout(form)

        btn = QPushButton("匯出檔名列表")
        btn.clicked.connect(self._on_execute)
        layout.addWidget(btn, 0, Qt.AlignmentFlag.AlignLeft)

        layout.addWidget(QLabel("執行結果："))
        self.log = _LogView()
        layout.addWidget(self.log, 1)

    def _on_execute(self) -> None:
        folder = self._get_folder()
        if not folder:
            return
        output_name = self.name_input.text().strip()
        if not output_name:
            QMessageBox.warning(self, "提示", "請輸入輸出檔名。")
            return
        if not output_name.lower().endswith(".txt"):
            output_name += ".txt"
        output_path = os.path.join(folder, output_name)
        if os.path.exists(output_path):
            reply = QMessageBox.question(
                self, "確認覆寫",
                f"檔案已存在：\n{output_path}\n\n確定要覆寫嗎？",
            )
            if reply != QMessageBox.StandardButton.Yes:
                return
        self.log.clear_log()
        out_path, filenames, errors = _execute_export(folder, output_name)
        if out_path:
            self.log.append_line("【匯出成功】")
            self.log.append_line(f"輸出路徑：{out_path}")
            self.log.append_line(f"共 {len(filenames)} 個檔案")
            self.log.append_line("")
            self.log.append_line("【檔名列表】")
            for name in filenames:
                self.log.append_line(name)
            QMessageBox.information(self, "完成", f"已匯出 {len(filenames)} 個檔名至：\n{out_path}")
        else:
            self.log.append_line("【匯出失敗】")
            for line in errors:
                self.log.append_line(line)
            QMessageBox.warning(self, "匯出失敗", errors[0] if errors else "無法匯出檔名列表。")


class FolderPanel(QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(8)

        # 目標資料夾列
        folder_row = QHBoxLayout()
        folder_row.addWidget(QLabel("目標資料夾："))
        self._folder_input = QLineEdit()
        self._folder_input.setPlaceholderText("選擇或輸入資料夾路徑…")
        folder_row.addWidget(self._folder_input, 1)
        browse_btn = QPushButton("瀏覽…")
        browse_btn.clicked.connect(self._browse)
        folder_row.addWidget(browse_btn)
        open_btn = QPushButton("開啟")
        open_btn.clicked.connect(self._open_folder)
        folder_row.addWidget(open_btn)
        root.addLayout(folder_row)

        # 功能分頁
        inner_tabs = QTabWidget()
        inner_tabs.addTab(_RenameTab(self._get_folder), "檔名批次移除")
        inner_tabs.addTab(_ExportTab(self._get_folder), "檔名列表匯出")
        root.addWidget(inner_tabs, 1)

    def _get_folder(self) -> str | None:
        path = self._folder_input.text().strip()
        if not path:
            QMessageBox.warning(self, "提示", "請先指定目標資料夾。")
            return None
        if not os.path.isdir(path):
            QMessageBox.warning(self, "提示", f"資料夾不存在：\n{path}")
            return None
        return os.path.abspath(path)

    def _browse(self) -> None:
        initial = self._folder_input.text().strip() or os.path.expanduser("~")
        if not os.path.isdir(initial):
            initial = os.path.expanduser("~")
        path = QFileDialog.getExistingDirectory(self, "選擇目標資料夾", initial)
        if path:
            self._folder_input.setText(path)

    def _open_folder(self) -> None:
        folder = self._get_folder()
        if not folder:
            return
        if os.name == "nt":
            os.startfile(folder)  # noqa: S606
        else:
            import subprocess
            subprocess.Popen(["xdg-open", folder])  # noqa: S603,S607
