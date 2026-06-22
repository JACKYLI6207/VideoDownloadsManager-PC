"""合併中：本機片段合併 MP4。"""
from __future__ import annotations

from pathlib import Path

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QCheckBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from vdm_pc.config import download_root, save_settings
from vdm_pc.download.engine import DownloadEngine
from vdm_pc.merge_local import (
    folder_has_segments,
    folder_stable_for_merge,
    output_mp4_missing,
    scan_subfolders_with_segments,
)
from vdm_pc.models import DownloadTask

_STATUS_LABELS = {
    "pending": "等待中",
    "merging": "合併中",
    "paused": "已暫停",
    "failed": "失敗",
    "cancelled": "已取消",
}


class MergeTaskCard(QWidget):
    def __init__(self, task: DownloadTask, parent=None) -> None:
        super().__init__(parent)
        self.task_id = task.id
        self.setObjectName("taskCard")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 6, 8, 6)
        layout.setSpacing(3)

        self.title = QLabel(task.file_name)
        self.title.setStyleSheet("font-weight:600;font-size:12px;")
        layout.addWidget(self.title)

        self.source = QLabel(task.source_folder)
        self.source.setObjectName("muted")
        self.source.setStyleSheet("font-size:11px;color:#94a3b8;")
        self.source.setWordWrap(True)
        layout.addWidget(self.source)

        row = QHBoxLayout()
        row.setSpacing(6)
        tag = QLabel("合併")
        tag.setFixedWidth(26)
        tag.setStyleSheet("font-size:11px;color:#94a3b8;")
        self.bar = QProgressBar()
        self.bar.setRange(0, 100)
        self.bar.setTextVisible(False)
        self.bar.setObjectName("merge")
        self.pct = QLabel("0%")
        self.pct.setFixedWidth(30)
        self.pct.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.pct.setStyleSheet("font-size:11px;font-weight:700;color:#4ade80;")
        row.addWidget(tag)
        row.addWidget(self.bar, 1)
        row.addWidget(self.pct)
        layout.addLayout(row)

        self.meta = QLabel("")
        self.meta.setObjectName("muted")
        self.meta.setStyleSheet("font-size:11px;color:#94a3b8;")
        layout.addWidget(self.meta)

        self.err = QLabel("")
        self.err.setStyleSheet("color:#f87171;font-size:11px;")
        self.err.setWordWrap(True)
        layout.addWidget(self.err)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(4)
        btn_style = "QPushButton{padding:3px 8px;font-size:11px;}"
        self.pause_btn = QPushButton("暫停")
        self.resume_btn = QPushButton("繼續")
        self.retry_btn = QPushButton("重試")
        self.cancel_btn = QPushButton("中斷")
        for btn in (self.pause_btn, self.resume_btn, self.retry_btn, self.cancel_btn):
            btn.setStyleSheet(btn_style)
            btn_row.addWidget(btn)
        btn_row.addStretch(1)
        layout.addLayout(btn_row)

        self.setStyleSheet(
            "#taskCard { background:#23272f; border:1px solid #334155; border-radius:8px; }"
            "#taskCard QProgressBar { height:6px; background:#334155; }"
        )
        self.refresh(task)

    def refresh(self, task: DownloadTask) -> None:
        mg_val = int(task.merge_progress)
        if self.bar.value() != mg_val:
            self.bar.setValue(mg_val)
        if self.pct.text() != f"{mg_val}%":
            self.pct.setText(f"{mg_val}%")

        status = _STATUS_LABELS.get(task.status, task.status)
        if task.status == "merging":
            if task.merge_progress >= 94:
                status = "封裝 MP4"
            elif task.merge_progress > 0:
                status = "合併片段"
        seg = f"{task.total} 個片段" if task.total else ""
        meta = f"{status}  ·  {seg}".strip(" · ")
        if self.meta.text() != meta:
            self.meta.setText(meta)

        err = task.error or ""
        if self.err.text() != err:
            self.err.setText(err)
        self.err.setVisible(bool(err))

        running = task.status in {"merging", "downloading"}
        self.pause_btn.setEnabled(running and task.merge_progress < 100)
        self.resume_btn.setEnabled(task.status in {"paused", "failed", "pending"})
        self.retry_btn.setEnabled(True)
        self.cancel_btn.setEnabled(True)


class ActivePanel(QWidget):
    def __init__(self, engine: DownloadEngine, settings: dict, parent=None) -> None:
        super().__init__(parent)
        self.engine = engine
        self.settings = settings
        self._cards: dict[str, MergeTaskCard] = {}
        self._scan_timer = QTimer(self)
        self._scan_timer.timeout.connect(self._run_auto_scan_merge)
        self._build_ui()
        engine.task_changed.connect(self._on_task_changed)
        engine.stats_changed.connect(self._on_stats)
        self._apply_scan_timer()
        self.refresh()

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)

        out_row = QHBoxLayout()
        out_row.addWidget(QLabel("輸出目的地："))
        self.output_input = QLineEdit()
        self.output_input.setPlaceholderText("選擇合併 MP4 的輸出資料夾…")
        default_out = str(download_root(self.settings))
        self.output_input.setText(default_out)
        out_row.addWidget(self.output_input, 1)
        browse_out = QPushButton("瀏覽…")
        browse_out.clicked.connect(self._browse_output)
        out_row.addWidget(browse_out)
        root.addLayout(out_row)

        auto_row = QHBoxLayout()
        self.auto_scan_cb = QCheckBox("每")
        self.auto_scan_cb.setChecked(bool(self.settings.get("autoScanMergeEnabled")))
        self.auto_scan_cb.toggled.connect(self._on_scan_settings_changed)
        auto_row.addWidget(self.auto_scan_cb)
        self.scan_interval_spin = QSpinBox()
        self.scan_interval_spin.setRange(10, 3600)
        self.scan_interval_spin.setSuffix(" 秒")
        self.scan_interval_spin.setValue(int(self.settings.get("autoScanMergeIntervalSec") or 60))
        self.scan_interval_spin.valueChanged.connect(self._on_scan_settings_changed)
        auto_row.addWidget(self.scan_interval_spin)
        auto_row.addWidget(QLabel("自動掃描合併"))
        auto_row.addStretch(1)
        root.addLayout(auto_row)

        delete_row = QHBoxLayout()
        self.delete_segments_cb = QCheckBox("合併完刪除片段")
        self.delete_segments_cb.setChecked(bool(self.settings.get("deleteSegmentsAfterMerge")))
        self.delete_segments_cb.toggled.connect(self._on_scan_settings_changed)
        delete_row.addWidget(self.delete_segments_cb)
        delete_row.addStretch(1)
        root.addLayout(delete_row)

        seg_row = QHBoxLayout()
        seg_row.addWidget(QLabel("擴充片段根目錄："))
        self.segment_root_input = QLineEdit()
        self.segment_root_input.setPlaceholderText("與紅色擴充設定中選擇的存檔資料夾相同…")
        default_seg = self.settings.get("extensionSegmentRoot") or str(download_root(self.settings))
        self.segment_root_input.setText(default_seg)
        self.segment_root_input.editingFinished.connect(self._save_scan_settings)
        seg_row.addWidget(self.segment_root_input, 1)
        browse_seg = QPushButton("瀏覽…")
        browse_seg.clicked.connect(self._browse_segment_root)
        seg_row.addWidget(browse_seg)
        root.addLayout(seg_row)

        folder_header = QHBoxLayout()
        folder_header.addWidget(QLabel("片段資料夾（批量）："))
        folder_header.addStretch(1)
        self._folder_list = QListWidget()
        self._folder_list.setMaximumHeight(120)
        add_btn = QPushButton("添加資料夾")
        add_btn.clicked.connect(self._add_folder)
        batch_btn = QPushButton("批量添加子資料夾")
        batch_btn.clicked.connect(self._add_subfolders)
        remove_btn = QPushButton("移除")
        remove_btn.clicked.connect(self._remove_selected_folders)
        clear_btn = QPushButton("清空")
        clear_btn.clicked.connect(self._folder_list.clear)
        for btn in (add_btn, batch_btn, remove_btn, clear_btn):
            folder_header.addWidget(btn)
        root.addLayout(folder_header)
        root.addWidget(self._folder_list)

        start_row = QHBoxLayout()
        self.start_btn = QPushButton("開始合併")
        self.start_btn.setStyleSheet("font-weight:600;padding:6px 16px;")
        self.start_btn.clicked.connect(self._start_merge)
        start_row.addStretch(1)
        start_row.addWidget(self.start_btn)
        root.addLayout(start_row)

        header = QHBoxLayout()
        self.summary = QLabel("共 0 個合併任務")
        header.addWidget(self.summary, 1)
        root.addLayout(header)

        bulk = QHBoxLayout()
        for label, action in (
            ("暫停", "pause"),
            ("繼續", "resume"),
            ("重試", "retry"),
            ("中斷", "cancel"),
        ):
            btn = QPushButton(label)
            btn.clicked.connect(lambda _=False, a=action: self._bulk(a))
            bulk.addWidget(btn)
        bulk.addStretch(1)
        root.addLayout(bulk)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self.list_host = QWidget()
        self.list_layout = QVBoxLayout(self.list_host)
        self.list_layout.setSpacing(6)
        self.list_layout.setContentsMargins(0, 0, 0, 0)
        self.list_layout.addStretch(1)
        scroll.setWidget(self.list_host)
        root.addWidget(scroll, 1)

        self.empty = QLabel("尚無合併任務\n請添加含 .ts 片段的資料夾後點「開始合併」")
        self.empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty.setObjectName("muted")
        root.addWidget(self.empty)

    def _browse_output(self) -> None:
        initial = self.output_input.text().strip() or str(download_root(self.settings))
        path = QFileDialog.getExistingDirectory(self, "選擇輸出目的地", initial)
        if path:
            self.output_input.setText(path)

    def _browse_segment_root(self) -> None:
        initial = self.segment_root_input.text().strip() or str(download_root(self.settings))
        path = QFileDialog.getExistingDirectory(self, "選擇擴充片段根目錄", initial)
        if path:
            self.segment_root_input.setText(path)
            self._save_scan_settings()

    def _on_scan_settings_changed(self, *_args) -> None:
        self._save_scan_settings()
        self._apply_scan_timer()
        if self.auto_scan_cb.isChecked():
            self._run_auto_scan_merge()

    def _save_scan_settings(self) -> None:
        self.settings["autoScanMergeEnabled"] = self.auto_scan_cb.isChecked()
        self.settings["autoScanMergeIntervalSec"] = self.scan_interval_spin.value()
        self.settings["deleteSegmentsAfterMerge"] = self.delete_segments_cb.isChecked()
        self.settings["extensionSegmentRoot"] = self.segment_root_input.text().strip()
        save_settings(self.settings)

    def _apply_scan_timer(self) -> None:
        self._scan_timer.stop()
        if self.auto_scan_cb.isChecked():
            self._scan_timer.start(self.scan_interval_spin.value() * 1000)

    def _run_auto_scan_merge(self) -> None:
        if not self.auto_scan_cb.isChecked():
            return

        seg_root_text = self.segment_root_input.text().strip()
        output_dir = self.output_input.text().strip()
        if not seg_root_text:
            self.engine.log_bus.push("warn", "自動掃描：請先設定「擴充片段根目錄」。")
            return
        if not output_dir:
            self.engine.log_bus.push("warn", "自動掃描：請先設定「輸出目的地」。")
            return

        seg_root = Path(seg_root_text)
        out_path = Path(output_dir)
        if not seg_root.is_dir():
            self.engine.log_bus.push("warn", f"自動掃描：片段根目錄不存在：{seg_root_text}")
            return
        if not out_path.is_dir():
            self.engine.log_bus.push("warn", f"自動掃描：輸出目的地不存在：{output_dir}")
            return

        folders = scan_subfolders_with_segments(seg_root)
        if not folders:
            return

        active_sources = {t.source_folder for t in self.engine.list_local_merge_active()}
        added = 0
        for folder in folders:
            source_resolved = str(folder.resolve())
            if source_resolved in active_sources:
                continue
            if not output_mp4_missing(folder, out_path):
                continue
            if not folder_stable_for_merge(folder):
                continue
            try:
                self.engine.add_local_merge(source_resolved, output_dir, auto_start=True)
                active_sources.add(source_resolved)
                added += 1
                self.engine.log_bus.push("info", f"自動掃描已加入合併：{folder.name}")
            except Exception as exc:  # noqa: BLE001
                self.engine.log_bus.push("error", f"自動掃描合併失敗（{folder.name}）：{exc}")

        if added:
            self.refresh()

    def _existing_folder_paths(self) -> set[str]:
        paths: set[str] = set()
        for i in range(self._folder_list.count()):
            paths.add(self._folder_list.item(i).text())
        return paths

    def _append_folder(self, folder: Path) -> bool:
        resolved = str(folder.resolve())
        if resolved in self._existing_folder_paths():
            return False
        if not folder_has_segments(folder):
            return False
        self._folder_list.addItem(resolved)
        return True

    def _add_folder(self) -> None:
        initial = self.output_input.text().strip() or str(download_root(self.settings))
        path = QFileDialog.getExistingDirectory(self, "選擇含片段的資料夾", initial)
        if not path:
            return
        folder = Path(path)
        if not self._append_folder(folder):
            if str(folder.resolve()) in self._existing_folder_paths():
                QMessageBox.information(self, "提示", "此資料夾已在列表中。")
            else:
                QMessageBox.warning(self, "提示", "此資料夾內沒有找到 .ts 片段。")

    def _add_subfolders(self) -> None:
        initial = self.output_input.text().strip() or str(download_root(self.settings))
        path = QFileDialog.getExistingDirectory(self, "選擇父資料夾（掃描子資料夾）", initial)
        if not path:
            return
        found = scan_subfolders_with_segments(Path(path))
        if not found:
            QMessageBox.information(self, "提示", "未找到含 .ts 片段的子資料夾。")
            return
        added = sum(1 for folder in found if self._append_folder(folder))
        skipped = len(found) - added
        QMessageBox.information(
            self,
            "批量添加完成",
            f"已添加 {added} 個資料夾" + (f"（略過 {skipped} 個重複）" if skipped else ""),
        )

    def _remove_selected_folders(self) -> None:
        for item in self._folder_list.selectedItems():
            row = self._folder_list.row(item)
            self._folder_list.takeItem(row)

    def _start_merge(self) -> None:
        output_dir = self.output_input.text().strip()
        if not output_dir:
            QMessageBox.warning(self, "提示", "請先指定輸出目的地。")
            return
        out_path = Path(output_dir)
        if not out_path.is_dir():
            QMessageBox.warning(self, "提示", f"輸出目的地不存在：\n{output_dir}")
            return

        folders: list[str] = []
        for i in range(self._folder_list.count()):
            folders.append(self._folder_list.item(i).text())
        if not folders:
            QMessageBox.warning(self, "提示", "請先添加至少一個含片段的資料夾。")
            return

        added = 0
        errors: list[str] = []
        for folder in folders:
            try:
                self.engine.add_local_merge(folder, output_dir, auto_start=True)
                added += 1
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{folder}\n  {exc}")

        self._folder_list.clear()
        self.refresh()

        if added:
            msg = f"已加入 {added} 個合併任務，正在背景執行。"
        else:
            msg = "沒有成功加入的合併任務。"
        if errors:
            msg += f"\n\n失敗 {len(errors)} 個：\n" + "\n".join(errors[:5])
            if len(errors) > 5:
                msg += f"\n…等共 {len(errors)} 個"
        if added or errors:
            QMessageBox.information(self, "開始合併", msg)

    def refresh(self) -> None:
        tasks = self.engine.list_local_merge_active()
        self.empty.setVisible(not tasks)
        seen = set(self._cards)
        for task in tasks:
            card = self._cards.get(task.id)
            if not card:
                card = MergeTaskCard(task)
                card.pause_btn.clicked.connect(lambda _=False, tid=task.id: self.engine.pause(tid))
                card.resume_btn.clicked.connect(lambda _=False, tid=task.id: self.engine.resume(tid))
                card.retry_btn.clicked.connect(lambda _=False, tid=task.id: self.engine.retry(tid))
                card.cancel_btn.clicked.connect(lambda _=False, tid=task.id: self.engine.cancel(tid))
                self._cards[task.id] = card
                self.list_layout.insertWidget(self.list_layout.count() - 1, card)
            card.refresh(task)
            seen.discard(task.id)
        for tid in list(seen):
            card = self._cards.pop(tid, None)
            if card:
                card.setParent(None)
                card.deleteLater()
        self._update_summary()

    def _on_task_changed(self, task_id: str) -> None:
        task = self.engine.tasks.get(task_id)
        if not task or not self.engine.is_local_merge(task):
            if task_id in self._cards:
                self.refresh()
            return
        if task.status in {"pending", "merging", "paused", "failed"}:
            card = self._cards.get(task_id)
            if card:
                card.refresh(task)
                return
        self.refresh()

    def _on_stats(self, _stats: dict) -> None:
        self._update_summary()

    def _update_summary(self) -> None:
        tasks = self.engine.list_local_merge_active()
        running = sum(1 for t in tasks if t.status == "merging")
        queued = sum(1 for t in tasks if t.status in {"pending", "paused"})
        self.summary.setText(
            f"共 {len(tasks)} 個合併任務 · 執行 {running} · 排隊 {queued}"
        )

    def _bulk(self, action: str) -> None:
        ids = list(self._cards.keys())
        if not ids:
            return
        if action == "cancel":
            self._confirm_cancel(ids, title="確認中斷", prefix="確定要中斷全部")
            return
        self.engine.bulk(action, ids)

    def _confirm_cancel(self, ids: list[str], *, title: str, prefix: str) -> None:
        ok = QMessageBox.question(
            self,
            title,
            f"{prefix} {len(ids)} 個合併任務嗎？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if ok == QMessageBox.StandardButton.Yes:
            self.engine.bulk("cancel", ids)
