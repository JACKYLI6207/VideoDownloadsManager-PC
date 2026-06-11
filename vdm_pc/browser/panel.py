"""瀏覽器分頁：擴充嗅探 → 待下載列表 → 加入佇列。"""
from __future__ import annotations

import json
from pathlib import Path

from PyQt6.QtCore import Qt, pyqtSignal, pyqtSlot
from PyQt6.QtGui import QGuiApplication
from PyQt6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
    QFileDialog,
)

from vdm_pc.browser.driver import PlaywrightDriver
from vdm_pc.browser.extension_loader import parse_extension_urls
from vdm_pc.config import browser_profile_dir
from vdm_pc.import_tasks import export_payload, import_tasks, normalize_url, parse_import_file
from vdm_pc.models import DownloadTask, VideoMeta, format_resolution, resolve_quality


def _resolution_quality(task: DownloadTask) -> int:
    return resolve_quality(
        task.video.url,
        task.file_name,
        task.video.title,
        quality=task.video.quality,
    )


def _resolution_label(task: DownloadTask) -> str:
    return format_resolution(_resolution_quality(task))


def _copyable_name(file_name: str) -> str:
    if file_name.lower().endswith(".mp4"):
        return file_name[:-4]
    return file_name


class _ResolutionTableItem(QTableWidgetItem):
    """解析度欄位以數值排序（非字串）。"""

    def __init__(self, text: str, quality: int) -> None:
        super().__init__(text)
        self._quality = quality

    def __lt__(self, other: QTableWidgetItem) -> bool:  # type: ignore[override]
        if isinstance(other, _ResolutionTableItem):
            return self._quality < other._quality
        return super().__lt__(other)


def _task_from_snap(snap: dict) -> DownloadTask | None:
    if not isinstance(snap, dict):
        return None
    video_raw = snap.get("video")
    if not isinstance(video_raw, dict) or not video_raw.get("url"):
        return None
    video = VideoMeta.from_dict(video_raw)
    file_name = str(snap.get("fileName") or video.title or "video")
    task = DownloadTask.create(video, file_name)
    if snap.get("id"):
        task.id = str(snap["id"])
    task.status = "pending"
    return task


class BrowserPanel(QWidget):
    _LIST_ROW_HEIGHT = 40

    add_download = pyqtSignal(object)
    tasks_received = pyqtSignal(list)

    def __init__(self, settings: dict, parent=None) -> None:
        super().__init__(parent)
        self.settings = settings
        self.pending: list[DownloadTask] = []
        self.driver: PlaywrightDriver | None = None
        self.tasks_received.connect(self._ingest_bridge_tasks)
        self._build_ui()

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setSpacing(10)

        nav = QHBoxLayout()
        self.url_input = QLineEdit()
        self.url_input.setPlaceholderText("輸入網址後按前往（需先啟動瀏覽器）")
        self.go_btn = QPushButton("前往")
        self.go_btn.clicked.connect(self._go)
        nav.addWidget(self.url_input, 1)
        nav.addWidget(self.go_btn)
        root.addLayout(nav)

        ctrl = QHBoxLayout()
        self.start_btn = QPushButton("啟動瀏覽器")
        self.start_btn.clicked.connect(self._start_browser)
        self.stop_btn = QPushButton("關閉瀏覽器")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self._stop_browser)
        self.status_label = QLabel("瀏覽器未啟動")
        self.status_label.setObjectName("muted")
        ctrl.addWidget(self.start_btn)
        ctrl.addWidget(self.stop_btn)
        ctrl.addStretch(1)
        ctrl.addWidget(self.status_label)
        root.addLayout(ctrl)

        body = QHBoxLayout()

        left = QFrame()
        left.setObjectName("card")
        left_layout = QVBoxLayout(left)
        left_layout.addWidget(QLabel("可下載清單"))
        self.resource_table = QTableWidget(0, 2)
        self.resource_table.setHorizontalHeaderLabels(["影片名稱", "解析度"])
        self.resource_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.resource_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Fixed)
        self.resource_table.setColumnWidth(1, 72)
        self.resource_table.verticalHeader().setVisible(False)
        self.resource_table.verticalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Fixed)
        self.resource_table.verticalHeader().setDefaultSectionSize(self._LIST_ROW_HEIGHT)
        self.resource_table.setShowGrid(False)
        self.resource_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.resource_table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.resource_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.resource_table.setAlternatingRowColors(True)
        self.resource_table.setSortingEnabled(True)
        self.resource_table.cellDoubleClicked.connect(self._on_row_double_clicked)
        left_layout.addWidget(self.resource_table, 1)
        btn_row = QHBoxLayout()
        for label, slot in (
            ("全部下載", self._download_all),
            ("下載", self._download_one),
            ("全部清除", self._clear_all),
            ("清除", self._clear_one),
            ("導出", self._export_pending),
            ("導入", self._import_pending),
        ):
            btn = QPushButton(label)
            btn.clicked.connect(slot)
            btn_row.addWidget(btn)
        left_layout.addLayout(btn_row)
        body.addWidget(left, 2)

        right = QFrame()
        right.setObjectName("card")
        right_layout = QVBoxLayout(right)
        right_layout.addWidget(QLabel("瀏覽器日誌"))
        self.log_area = QTextEdit()
        self.log_area.setReadOnly(True)
        right_layout.addWidget(self.log_area, 1)
        body.addWidget(right, 1)

        root.addLayout(body, 1)

    def _log(self, msg: str) -> None:
        self.log_area.append(msg)

    def _make_name_button(self, task: DownloadTask) -> QPushButton:
        name_btn = QPushButton(task.file_name)
        name_btn.setObjectName("copyNameBtn")
        name_btn.setToolTip("點擊複製名稱")
        name_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        name_btn.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        name = _copyable_name(task.file_name)
        name_btn.clicked.connect(lambda _checked=False, n=name: self._copy_video_name(n))
        return name_btn

    def _copy_video_name(self, name: str) -> None:
        QGuiApplication.clipboard().setText(name)
        self._log(f"已複製名稱：{name}")

    def _start_browser(self) -> None:
        if self.driver and self.driver.isRunning():
            return
        ext_urls = parse_extension_urls(self.settings.get("browserExtensionUrls") or "")
        profile = browser_profile_dir(self.settings)
        self.driver = PlaywrightDriver(profile, extension_urls=ext_urls)
        self.driver.browser_ready.connect(self._on_ready)
        self.driver.extensions_loaded.connect(self._on_extensions_loaded)
        self.driver.status_message.connect(self._log)
        self.driver.page_closed.connect(self._on_closed)
        self.driver.error_occurred.connect(self._on_error)
        self.driver.start()
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.status_label.setText("正在啟動…")
        self._log("正在啟動 Chrome（含 VDM 擴充）…")

    def _stop_browser(self) -> None:
        if self.driver and self.driver.isRunning():
            self.driver.stop_browser()
        self._on_closed()

    def _on_extensions_loaded(self, names: str) -> None:
        self._log(f"✅ 擴充已載入：{names}")
        self._log("請點 Chrome 工具列 VDM 圖示 → 選影片 →「添加至可下載清單」")

    def _on_ready(self) -> None:
        self.status_label.setText("瀏覽器就緒")
        self._log("✅ 瀏覽器已就緒，任務會出現於「可下載清單」")

    def _on_closed(self) -> None:
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.status_label.setText("瀏覽器未啟動")

    def _on_error(self, msg: str) -> None:
        self._log(f"⚠️ {msg}")
        if "chromedriver" in msg.lower() or "selenium" in msg.lower():
            self._log("擴充安裝元件異常（Chromedriver 版本不符），請重試或重新建置 EXE")
        elif "chrome" in msg.lower():
            self._log("Google Chrome 安裝失敗，請檢查網路後重試，或手動安裝 Chrome 瀏覽器")
        elif "vdm" in msg.lower() or "擴充" in msg:
            self._log("請重新執行 build_exe.ps1 以打包 VDM 擴充")

    def _go(self) -> None:
        url = self.url_input.text().strip()
        if not url:
            return
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        if self.driver and self.driver.isRunning():
            self.driver.navigate(url)
            self._log(f"導航：{url}")
        else:
            self._log("請先啟動瀏覽器")

    @pyqtSlot(list)
    def _ingest_bridge_tasks(self, raw_tasks: list) -> None:
        added = 0
        seen = {normalize_url(t.video.url) for t in self._list_tasks()}
        for snap in raw_tasks:
            task = _task_from_snap(snap if isinstance(snap, dict) else {})
            if not task:
                continue
            norm = normalize_url(task.video.url)
            if norm in seen:
                continue
            seen.add(norm)
            self._append_list_item(task)
            added += 1
        if added:
            self._log(f"擴充已加入 {added} 個任務至可下載清單")

    def _append_list_item(self, task: DownloadTask) -> None:
        sorting = self.resource_table.isSortingEnabled()
        self.resource_table.setSortingEnabled(False)
        row = self.resource_table.rowCount()
        self.resource_table.insertRow(row)
        name_item = QTableWidgetItem(task.file_name)
        name_item.setData(Qt.ItemDataRole.UserRole, task)
        quality = _resolution_quality(task)
        res_item = _ResolutionTableItem(_resolution_label(task), quality)
        res_item.setTextAlignment(
            Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignVCenter
        )
        self.resource_table.setItem(row, 0, name_item)
        self.resource_table.setCellWidget(row, 0, self._make_name_button(task))
        self.resource_table.setItem(row, 1, res_item)
        self.resource_table.setRowHeight(row, self._LIST_ROW_HEIGHT)
        self.resource_table.setSortingEnabled(sorting)
        self._rebuild_pending()

    def _rebuild_pending(self) -> None:
        self.pending = self._list_tasks()

    def _list_tasks(self) -> list[DownloadTask]:
        tasks: list[DownloadTask] = []
        for row in range(self.resource_table.rowCount()):
            task = self._resolve_row_task(row)
            if task:
                tasks.append(task)
        return tasks

    def _selected_row(self) -> int:
        rows = self.resource_table.selectionModel().selectedRows()
        if rows:
            return rows[0].row()
        current = self.resource_table.currentRow()
        return current if current >= 0 else -1

    def _resolve_row_task(self, row: int) -> DownloadTask | None:
        if row < 0:
            return None
        item = self.resource_table.item(row, 0)
        if not item:
            return None
        data = item.data(Qt.ItemDataRole.UserRole)
        if isinstance(data, DownloadTask):
            return data
        if isinstance(data, str):
            return self._find_task(data)
        return None

    def _on_row_double_clicked(self, row: int, _col: int) -> None:
        self.resource_table.selectRow(row)
        self._download_one()

    def _find_task(self, task_id: str) -> DownloadTask | None:
        for task in self.pending:
            if task.id == task_id:
                return task
        return None

    def _download_all(self) -> None:
        tasks = self._list_tasks()
        if not tasks:
            QMessageBox.information(self, "全部下載", "可下載清單為空。")
            return
        self._enqueue_tasks(tasks)

    def _download_one(self) -> None:
        row = self._selected_row()
        if row < 0:
            QMessageBox.information(self, "下載", "請先點選清單中的一筆影片。")
            return
        task = self._resolve_row_task(row)
        if not task:
            QMessageBox.warning(self, "下載", "無法讀取此項目，請重新從擴充加入。")
            return
        self._enqueue_tasks([task])

    def _enqueue_tasks(self, tasks: list[DownloadTask]) -> None:
        if not tasks:
            return
        added_ids: set[str] = set()
        for task in tasks:
            self.add_download.emit(task)
            added_ids.add(task.id)

        for row in range(self.resource_table.rowCount() - 1, -1, -1):
            task = self._resolve_row_task(row)
            if task and task.id in added_ids:
                self.resource_table.removeRow(row)

        self._rebuild_pending()
        self._log(f"已加入下載 {len(added_ids)} 個任務（請看「進行中」）")

    def _clear_all(self) -> None:
        if not self._list_tasks():
            QMessageBox.information(self, "全部清除", "可下載清單為空。")
            return
        self.pending.clear()
        self.resource_table.setRowCount(0)
        self._log("已清除可下載清單全部項目")

    def _clear_one(self) -> None:
        row = self._selected_row()
        if row < 0:
            QMessageBox.information(self, "清除", "請先點選清單中的一筆影片。")
            return
        task = self._resolve_row_task(row)
        if not task:
            QMessageBox.warning(self, "清除", "無法讀取此項目。")
            return
        self.resource_table.removeRow(row)
        self._rebuild_pending()
        self._log(f"已清除：{task.file_name.replace('.mp4', '')}")

    def _export_pending(self) -> None:
        tasks = self._list_tasks()
        if not tasks:
            QMessageBox.information(self, "導出", "可下載清單為空。")
            return
        path, _ = QFileDialog.getSaveFileName(self, "導出待下載任務", "vdm-pending.json", "JSON (*.json)")
        if not path:
            return
        payload = export_payload(tasks)
        Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _import_pending(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "導入待下載任務", "", "JSON (*.json)")
        if not path:
            return
        try:
            raw = parse_import_file(Path(path).read_text(encoding="utf-8"))
            seen = {normalize_url(t.video.url) for t in self._list_tasks()}
            added = 0
            skipped = 0
            for snap in raw:
                task = _task_from_snap(snap)
                if not task:
                    skipped += 1
                    continue
                norm = normalize_url(task.video.url)
                if norm in seen:
                    skipped += 1
                    continue
                seen.add(norm)
                self._append_list_item(task)
                added += 1
            QMessageBox.information(
                self,
                "導入完成",
                f"已導入 {added} 個任務（略過 {skipped} 個）",
            )
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "導入失敗", str(exc))
