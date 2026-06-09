"""進行中任務分頁。"""
from __future__ import annotations

import json
from pathlib import Path

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from vdm_pc.download.engine import DownloadEngine
from vdm_pc.import_tasks import export_payload, import_tasks, parse_import_file
from vdm_pc.models import DownloadTask

_STATUS_LABELS = {
    "pending": "等待中",
    "downloading": "下載中",
    "merging": "合併中",
    "paused": "已暫停",
    "failed": "失敗",
    "cancelled": "已取消",
    "completed": "已完成",
}


def _fmt_size(n: float) -> str:
    if n <= 0:
        return "0 B/s"
    val = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if val < 1024:
            return f"{val:.1f} {unit}/s" if unit != "B" else f"{int(val)} B/s"
        val /= 1024
    return f"{val:.1f} TB/s"


def _seg_pct(done: int, total: int) -> int:
    if not total:
        return 0
    return max(0, min(100, int(done * 100 / total)))


def _is_hls(task: DownloadTask) -> bool:
    return bool(task.video.is_m3u8 or ".m3u8" in (task.video.url or "").lower())


class TaskCard(QWidget):
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

        self.dl_row = self._progress_row("下載", "#2563eb")
        layout.addLayout(self.dl_row["layout"])
        self.dl_bar = self.dl_row["bar"]
        self.dl_pct = self.dl_row["pct"]

        self.mg_row = self._progress_row("合併", "#16a34a", merge=True)
        self.mg_bar = self.mg_row["bar"]
        self.mg_pct = self.mg_row["pct"]
        self.mg_wrap = QWidget()
        mg_inner = QVBoxLayout(self.mg_wrap)
        mg_inner.setContentsMargins(0, 0, 0, 0)
        mg_inner.setSpacing(0)
        mg_inner.addLayout(self.mg_row["layout"])
        layout.addWidget(self.mg_wrap)

        self.meta = QLabel("")
        self.meta.setObjectName("muted")
        self.meta.setStyleSheet("font-size:11px;color:#64748b;")
        layout.addWidget(self.meta)

        self.err = QLabel("")
        self.err.setStyleSheet("color:#dc2626;font-size:11px;")
        self.err.setWordWrap(True)
        layout.addWidget(self.err)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(4)
        btn_style = "QPushButton{padding:3px 8px;font-size:11px;}"
        self.pause_btn = QPushButton("暫停")
        self.resume_btn = QPushButton("繼續")
        self.retry_btn = QPushButton("從頭下載")
        self.cancel_btn = QPushButton("中斷")
        for btn in (self.pause_btn, self.resume_btn, self.retry_btn, self.cancel_btn):
            btn.setStyleSheet(btn_style)
            btn_row.addWidget(btn)
        btn_row.addStretch(1)
        layout.addLayout(btn_row)

        self.setStyleSheet(
            "#taskCard { background:#fff; border:1px solid #d8dee6; border-radius:8px; }"
            "#taskCard QProgressBar { height:6px; }"
        )
        self.refresh(task)

    def _progress_row(self, label: str, color: str, *, merge: bool = False) -> dict:
        row = QHBoxLayout()
        row.setSpacing(6)
        tag = QLabel(label)
        tag.setFixedWidth(26)
        tag.setStyleSheet("font-size:11px;color:#667;")
        bar = QProgressBar()
        bar.setRange(0, 100)
        bar.setTextVisible(False)
        if merge:
            bar.setObjectName("merge")
        pct = QLabel("0%")
        pct.setFixedWidth(30)
        pct.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        pct.setStyleSheet(f"font-size:11px;font-weight:700;color:{color};")
        row.addWidget(tag)
        row.addWidget(bar, 1)
        row.addWidget(pct)
        return {"layout": row, "bar": bar, "pct": pct}

    def refresh(self, task: DownloadTask) -> None:
        is_hls = _is_hls(task)
        self.mg_wrap.setVisible(is_hls)

        if is_hls and task.total:
            dl_val = _seg_pct(task.downloaded, task.total)
            mg_val = int(task.merge_progress)
            seg = f"{task.downloaded}/{task.total}"
        else:
            dl_val = int(task.download_progress)
            mg_val = int(task.merge_progress)
            seg = task.status

        if self.dl_bar.value() != dl_val:
            self.dl_bar.setValue(dl_val)
        if self.dl_pct.text() != f"{dl_val}%":
            self.dl_pct.setText(f"{dl_val}%")
        if self.mg_bar.value() != mg_val:
            self.mg_bar.setValue(mg_val)
        if self.mg_pct.text() != f"{mg_val}%":
            self.mg_pct.setText(f"{mg_val}%")

        status = _STATUS_LABELS.get(task.status, task.status)
        if task.status == "merging" and is_hls and task.merge_progress >= 94:
            status = "封裝 MP4"
        meta = f"{status}  ·  {seg}  ·  {_fmt_size(task.speed)}"
        if self.meta.text() != meta:
            self.meta.setText(meta)

        err = task.error or ""
        if self.err.text() != err:
            self.err.setText(err)
        self.err.setVisible(bool(err))

        running = task.status in {"downloading", "merging"}
        self.pause_btn.setEnabled(running)
        self.resume_btn.setEnabled(task.status in {"paused", "failed", "pending"})
        self.retry_btn.setEnabled(True)
        self.cancel_btn.setEnabled(True)


class ActivePanel(QWidget):
    def __init__(self, engine: DownloadEngine, parent=None) -> None:
        super().__init__(parent)
        self.engine = engine
        self._cards: dict[str, TaskCard] = {}
        self._build_ui()
        engine.task_changed.connect(self._on_task_changed)
        engine.stats_changed.connect(self._on_stats)
        self.refresh()

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)

        header = QHBoxLayout()
        self.summary = QLabel("共 0 個任務")
        self.cancel_all_btn = QPushButton("全體中斷")
        self.cancel_all_btn.setStyleSheet("color:#dc2626;")
        self.cancel_all_btn.clicked.connect(self._cancel_all)
        header.addWidget(self.summary, 1)
        header.addWidget(self.cancel_all_btn)
        root.addLayout(header)

        toolbar = QHBoxLayout()
        export_btn = QPushButton("導出")
        export_btn.clicked.connect(self._export)
        import_btn = QPushButton("導入")
        import_btn.clicked.connect(self._import)
        toolbar.addStretch(1)
        toolbar.addWidget(export_btn)
        toolbar.addWidget(import_btn)
        root.addLayout(toolbar)

        self.speed_label = QLabel("總速度：0 B/s")
        self.speed_label.setObjectName("muted")
        self.speed_label.setStyleSheet("font-size:11px;color:#64748b;padding:0 2px 4px;")
        root.addWidget(self.speed_label)

        bulk = QHBoxLayout()
        for label, action in (
            ("暫停", "pause"),
            ("繼續", "resume"),
            ("從頭下載", "retry"),
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

        self.empty = QLabel("尚無進行中的下載")
        self.empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty.setObjectName("muted")
        root.addWidget(self.empty)

    def refresh(self) -> None:
        tasks = self.engine.list_active()
        self.empty.setVisible(not tasks)
        self.cancel_all_btn.setEnabled(bool(tasks))
        seen = set(self._cards)
        for task in tasks:
            card = self._cards.get(task.id)
            if not card:
                card = TaskCard(task)
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
        self._update_speed_label()

    def _on_task_changed(self, task_id: str) -> None:
        task = self.engine.tasks.get(task_id)
        if task and task.status in {"pending", "downloading", "merging", "paused", "failed"}:
            card = self._cards.get(task_id)
            if card:
                card.refresh(task)
                return
        self.refresh()

    def _on_stats(self, stats: dict) -> None:
        self.summary.setText(
            f"共 {stats.get('total', 0)} 個任務 · 執行 {stats.get('running', 0)} · 排隊 {stats.get('queued', 0)}"
        )
        self.speed_label.setText(f"總速度：{_fmt_size(float(stats.get('totalSpeed') or 0))}")

    def _update_speed_label(self) -> None:
        total = sum(
            t.speed for t in self.engine.list_active() if t.status in {"downloading", "merging"}
        )
        self.speed_label.setText(f"總速度：{_fmt_size(total)}")

    def _bulk(self, action: str) -> None:
        ids = list(self._cards.keys())
        if not ids:
            return
        if action == "cancel":
            self._confirm_cancel(ids, title="確認中斷", prefix="確定要中斷全部")
            return
        self.engine.bulk(action, ids)

    def _cancel_all(self) -> None:
        ids = list(self._cards.keys())
        if not ids:
            return
        self._confirm_cancel(ids, title="全體中斷", prefix="確定要中斷全部")

    def _confirm_cancel(self, ids: list[str], *, title: str, prefix: str) -> None:
        ok = QMessageBox.question(
            self,
            title,
            f"{prefix} {len(ids)} 個任務嗎？\n已下載的暫存片段將被清除，此操作無法復原。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if ok == QMessageBox.StandardButton.Yes:
            self.engine.bulk("cancel", ids)

    def _export(self) -> None:
        path, _ = QFileDialog.getSaveFileName(self, "導出任務", "vdm-tasks.json", "JSON (*.json)")
        if not path:
            return
        payload = export_payload(self.engine.list_active())
        Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _import(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "導入任務", "", "JSON (*.json)")
        if not path:
            return
        try:
            tasks, skipped = import_tasks(
                parse_import_file(Path(path).read_text(encoding="utf-8")),
                {t.video.url for t in self.engine.list_active()},
            )
            for task in tasks:
                self.engine.add_task(task)
            QMessageBox.information(
                self,
                "導入完成",
                f"已導入 {len(tasks)} 個任務（略過 {skipped} 個）\n狀態為暫停，請點「繼續」開始下載。",
            )
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "導入失敗", str(exc))
