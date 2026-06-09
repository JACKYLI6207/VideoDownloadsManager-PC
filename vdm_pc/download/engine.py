"""下載引擎（對應擴充 DownloadEngine）。"""
from __future__ import annotations

import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx
from PyQt6.QtCore import QObject, Qt, QTimer, pyqtSignal

from vdm_pc.config import build_output_path, cache_root
from vdm_pc.download import disk_store, m3u8 as m3u8_lib
from vdm_pc.log_bus import LogBus
from vdm_pc.models import DownloadTask, VideoMeta
from vdm_pc import persist

_AUTO_RETRY_SEC = 10


class FetchBlockedError(RuntimeError):
    pass


class DownloadEngine(QObject):
    task_changed = pyqtSignal(str)
    task_completed = pyqtSignal(object)
    stats_changed = pyqtSignal(dict)
    ui_coalesce_request = pyqtSignal()

    def __init__(self, settings: dict, log_bus: LogBus) -> None:
        super().__init__()
        self.settings = settings
        self.log_bus = log_bus
        self.tasks: dict[str, DownloadTask] = {}
        self.completed: list[DownloadTask] = []
        self._paused: set[str] = set()
        self._cancelled: set[str] = set()
        self._wait_queue: list[str] = []
        self._running = 0
        self._lock = threading.Lock()
        self._slot_lock = threading.Lock()
        self._slot_used = 0
        self._shutdown = threading.Event()
        self._persist_timer: threading.Timer | None = None
        self._error_retry_timers: dict[str, threading.Timer] = {}
        self._pending_emit: set[str] = set()
        self._flush_now = False
        self._emit_lock = threading.Lock()
        self.ui_coalesce_request.connect(self._on_ui_coalesce, Qt.ConnectionType.QueuedConnection)
        self._emit_timer = QTimer(self)
        self._emit_timer.setSingleShot(True)
        self._emit_timer.setInterval(80)
        self._emit_timer.timeout.connect(self._flush_emits)
        self._task_gen: dict[str, int] = {}
        self._worker_active: set[str] = set()
        self._restore_persisted()

    def _invalidate_workers(self, task_id: str) -> None:
        self._task_gen[task_id] = self._task_gen.get(task_id, 0) + 1

    def _alive(self, task_id: str, gen: int) -> bool:
        if task_id not in self.tasks or task_id in self._cancelled:
            return False
        return self._task_gen.get(task_id, 0) == gen

    def _global_limit(self) -> int:
        tasks = max(1, min(6, int(self.settings.get("maxConcurrentTasks") or 2)))
        conn = max(1, min(18, int(self.settings.get("maxConnections") or 3)))
        return min(108, tasks * conn)

    def _worker_limit(self) -> int:
        return max(1, min(18, int(self.settings.get("maxConnections") or 3)))

    def _max_concurrent_tasks(self) -> int:
        return max(1, min(6, int(self.settings.get("maxConcurrentTasks") or 2)))

    def _restore_persisted(self) -> None:
        for task in persist.load_active():
            self.tasks[task.id] = task
            self._paused.add(task.id)
        self.completed = persist.load_completed()
        self._emit_stats()

    def update_settings(self, settings: dict) -> None:
        self.settings = settings

    def add_task(self, task: DownloadTask, *, auto_start: bool = False) -> None:
        self.tasks[task.id] = task
        self._schedule_persist()
        self._emit_stats()
        self.task_changed.emit(task.id)
        if auto_start:
            self.enqueue(task.id)

    def list_active(self) -> list[DownloadTask]:
        return [
            t
            for t in self.tasks.values()
            if t.status in {"pending", "downloading", "merging", "paused", "failed"}
        ]

    def enqueue(self, task_id: str) -> None:
        if task_id not in self.tasks:
            return
        if task_id in self._paused:
            return
        if task_id not in self._wait_queue:
            self._wait_queue.append(task_id)
        self._pump()

    def _cancel_auto_retry(self, task_id: str) -> None:
        timer = self._error_retry_timers.pop(task_id, None)
        if timer:
            timer.cancel()

    def pause(self, task_id: str) -> None:
        task = self.tasks.get(task_id)
        if not task or task.status not in {"pending", "downloading", "merging"}:
            return
        self._cancel_auto_retry(task_id)
        self._invalidate_workers(task_id)
        self._paused.add(task_id)
        self._wait_queue = [x for x in self._wait_queue if x != task_id]
        task.status = "paused"
        task.error = ""
        self._schedule_persist()
        self._emit(task_id, immediate=True)

    def resume(self, task_id: str) -> None:
        task = self.tasks.get(task_id)
        if not task or task.status not in {"paused", "failed", "pending"}:
            return
        self._cancel_auto_retry(task_id)
        self._invalidate_workers(task_id)
        self._paused.discard(task_id)
        self._cancelled.discard(task_id)
        task.error = ""
        task.status = "pending"
        self.enqueue(task_id)
        self._emit(task_id, immediate=True)

    def retry(self, task_id: str) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return
        self._cancel_auto_retry(task_id)
        self._invalidate_workers(task_id)
        disk_store.clear_task(cache_root(self.settings), task.video.id)
        task.status = "pending"
        task.progress = 0
        task.download_progress = 0
        task.merge_progress = 0
        task.merged = 0
        task.downloaded = 0
        task.total = 0
        task.speed = 0
        task.error = ""
        self._paused.discard(task_id)
        self._cancelled.discard(task_id)
        self._wait_queue = [x for x in self._wait_queue if x != task_id]
        self.enqueue(task_id)
        self._emit(task_id, immediate=True)

    def cancel(self, task_id: str) -> None:
        self._cancel_auto_retry(task_id)
        self._invalidate_workers(task_id)
        self._cancelled.add(task_id)
        self._paused.discard(task_id)
        self._wait_queue = [x for x in self._wait_queue if x != task_id]
        task = self.tasks.pop(task_id, None)
        if task:
            disk_store.clear_task(cache_root(self.settings), task.video.id)
            task.status = "cancelled"
            self._schedule_persist()
            self.task_changed.emit(task_id)
            self._emit_stats()

    def bulk(self, action: str, task_ids: list[str]) -> None:
        for tid in task_ids:
            if action == "pause":
                self.pause(tid)
            elif action == "resume":
                self.resume(tid)
            elif action == "retry":
                self.retry(tid)
            elif action == "cancel":
                self.cancel(tid)

    def shutdown(self) -> None:
        self._shutdown.set()
        for tid in list(self._error_retry_timers):
            self._cancel_auto_retry(tid)
        if self._persist_timer:
            self._persist_timer.cancel()
        persist.save_active(self.list_active())
        persist.save_completed(self.completed)

    def _schedule_persist(self) -> None:
        if self._persist_timer:
            self._persist_timer.cancel()

        def _save() -> None:
            persist.save_active(self.list_active())
            persist.save_completed(self.completed)

        self._persist_timer = threading.Timer(0.8, _save)
        self._persist_timer.daemon = True
        self._persist_timer.start()

    def _acquire_slot(self, task: DownloadTask, gen: int) -> None:
        while True:
            if not self._alive(task.id, gen) or self._shutdown.is_set():
                raise RuntimeError("cancelled")
            while task.id in self._paused:
                if not self._alive(task.id, gen):
                    raise RuntimeError("cancelled")
                time.sleep(0.25)
            with self._slot_lock:
                if self._slot_used < self._global_limit():
                    self._slot_used += 1
                    return
            time.sleep(0.05)

    def _release_slot(self) -> None:
        with self._slot_lock:
            self._slot_used = max(0, self._slot_used - 1)

    def _emit(self, task_id: str, *, immediate: bool = False) -> None:
        with self._emit_lock:
            self._pending_emit.add(task_id)
            if immediate:
                self._flush_now = True
        self.ui_coalesce_request.emit()

    def _on_ui_coalesce(self) -> None:
        with self._emit_lock:
            immediate = self._flush_now
            if immediate:
                self._flush_now = False
        if immediate:
            self._emit_timer.stop()
            self._flush_emits()
            return
        if not self._emit_timer.isActive():
            self._emit_timer.start()

    def _flush_emits(self) -> None:
        with self._emit_lock:
            pending = self._pending_emit
            self._pending_emit = set()
        for task_id in pending:
            self.task_changed.emit(task_id)
        self._emit_stats()

    def _emit_stats(self) -> None:
        active = self.list_active()
        running = sum(1 for t in active if t.status in {"downloading", "merging"})
        queued = sum(1 for t in active if t.status in {"pending", "paused"})
        total_speed = sum(t.speed for t in active if t.status in {"downloading", "merging"})
        self.stats_changed.emit(
            {
                "total": len(active),
                "running": running,
                "queued": max(0, queued),
                "maxConcurrent": self._max_concurrent_tasks(),
                "totalSpeed": total_speed,
            }
        )

    def _run_task(self, task_id: str) -> None:
        my_gen = self._task_gen.get(task_id, 0)
        try:
            with self._lock:
                if task_id in self._worker_active:
                    return
                self._worker_active.add(task_id)
            try:
                task = self.tasks.get(task_id)
                if not task or not self._alive(task_id, my_gen) or task_id in self._paused:
                    return
                task.status = "downloading"
                task.error = ""
                self._emit(task_id, immediate=True)
                try:
                    if task.video.is_m3u8 or ".m3u8" in task.video.url.lower():
                        self._download_hls(task, my_gen)
                    else:
                        self._download_http(task, my_gen)
                    if task_id in self._cancelled:
                        return
                    if task_id in self._paused:
                        task.status = "paused"
                    else:
                        task.status = "completed"
                        task.progress = 100
                        self.completed.insert(0, task)
                        self.tasks.pop(task_id, None)
                        self.task_completed.emit(task)
                        self.log_bus.push("info", f"下載完成：{task.file_name}")
                        self._schedule_persist()
                except FetchBlockedError as exc:
                    if task_id not in self._cancelled:
                        self._pause_on_error(task, str(exc))
                except Exception as exc:  # noqa: BLE001
                    if task_id in self._cancelled:
                        return
                    if task_id in self._paused:
                        task.status = "paused"
                    elif "cancelled" in str(exc).lower():
                        return
                    else:
                        self._pause_on_error(task, str(exc))
                        self.log_bus.push("error", f"下載失敗：{task.file_name}", str(exc))
                finally:
                    self._emit(task_id, immediate=True)
            finally:
                with self._lock:
                    self._worker_active.discard(task_id)
        finally:
            with self._lock:
                self._running = max(0, self._running - 1)
            self._pump()

    def _pause_on_error(self, task: DownloadTask, msg: str) -> None:
        self._invalidate_workers(task.id)
        self._cancel_auto_retry(task.id)
        self._paused.add(task.id)
        task.status = "paused"
        task.error = f"{msg}（{_AUTO_RETRY_SEC} 秒後自動繼續）"
        self._schedule_persist()
        self._emit(task.id, immediate=True)
        self.log_bus.push("warn", f"下載暫停：{task.file_name}", msg)

        task_id = task.id

        def _auto_resume() -> None:
            self._error_retry_timers.pop(task_id, None)
            if task_id not in self.tasks or task_id in self._cancelled:
                return
            if task_id not in self._paused:
                return
            self._paused.discard(task_id)
            task.error = ""
            task.status = "pending"
            self.log_bus.push("info", f"自動繼續：{task.file_name}")
            self.enqueue(task_id)
            self._emit(task_id, immediate=True)

        timer = threading.Timer(_AUTO_RETRY_SEC, _auto_resume)
        timer.daemon = True
        self._error_retry_timers[task_id] = timer
        timer.start()

    def _pump(self) -> None:
        with self._lock:
            while self._running < self._max_concurrent_tasks() and self._wait_queue:
                task_id = self._wait_queue.pop(0)
                if task_id not in self.tasks or task_id in self._paused:
                    continue
                if task_id in self._worker_active:
                    self._wait_queue.append(task_id)
                    break
                self._running += 1
                threading.Thread(target=self._run_task, args=(task_id,), daemon=True).start()

    def _build_headers(self, video: VideoMeta, target_url: str) -> dict[str, str]:
        headers = {k.lower(): str(v) for k, v in (video.request_headers or {}).items() if v}
        referer = headers.get("referer") or video.referer or video.page_url or ""
        if referer:
            headers["referer"] = referer
            if "origin" not in headers:
                try:
                    from urllib.parse import urlparse

                    p = urlparse(referer)
                    if p.scheme and p.netloc:
                        headers["origin"] = f"{p.scheme}://{p.netloc}"
                except ValueError:
                    pass
        if video.user_agent:
            headers["user-agent"] = video.user_agent
        headers.setdefault("accept", "*/*")
        return headers

    def _check_response(self, res: httpx.Response) -> None:
        if res.status_code in {401, 403, 429}:
            raise FetchBlockedError(f"HTTP {res.status_code}（連線被拒/限速，請降低並行數或稍後再試）")
        res.raise_for_status()

    def _make_client(self, workers: int = 1) -> httpx.Client:
        pool = max(workers, self._worker_limit())
        limits = httpx.Limits(
            max_connections=min(108, pool),
            max_keepalive_connections=min(108, pool),
        )
        return httpx.Client(timeout=120, follow_redirects=True, limits=limits)

    def _fetch_text(self, client: httpx.Client, url: str, headers: dict[str, str]) -> str:
        res = client.get(url, headers=headers)
        self._check_response(res)
        return res.text

    def _fetch_segment_stream(
        self,
        client: httpx.Client,
        url: str,
        headers: dict[str, str],
        cache: Path,
        video_id: str,
        index: int,
    ) -> int:
        with client.stream("GET", url, headers=headers) as res:
            self._check_response(res)
            return disk_store.write_segment_stream(
                cache,
                video_id,
                index,
                res.iter_bytes(chunk_size=disk_store.STREAM_CHUNK),
            )

    def _stream_to_file(self, client: httpx.Client, url: str, headers: dict[str, str], out: Path) -> int:
        nbytes = 0
        with client.stream("GET", url, headers=headers) as res:
            self._check_response(res)
            with out.open("wb") as f:
                for chunk in res.iter_bytes(chunk_size=disk_store.STREAM_CHUNK):
                    f.write(chunk)
                    nbytes += len(chunk)
        return nbytes

    def _download_hls(self, task: DownloadTask, gen: int) -> None:
        video = task.video
        headers = self._build_headers(video, video.url)
        cache = cache_root(self.settings)
        out = build_output_path(self.settings, task.file_name)
        workers = self._worker_limit()

        with self._make_client(workers) as client:
            playlist = m3u8_lib.parse_m3u8(self._fetch_text(client, video.url, headers), video.url)
            if playlist.is_variant:
                variant_url = m3u8_lib.pick_best_variant(playlist)
                if not variant_url:
                    raise RuntimeError("M3U8 沒有可用變體")
                playlist = m3u8_lib.parse_m3u8(self._fetch_text(client, variant_url, headers), variant_url)

        segments = playlist.segments
        if not segments:
            raise RuntimeError("M3U8 沒有片段")

        task.total = len(segments)
        merged_through = disk_store.read_merge_meta(cache, video.id)
        if task.merged == 0 and merged_through == 0 and task.downloaded == 0:
            disk_store.clear_task(cache, video.id)
            merged_through = 0

        merger = disk_store.StreamMerger(cache, video.id, len(segments), start=merged_through)
        task.merged = merged_through
        task.downloaded = merger.buffered_count
        task.download_progress = self._seg_pct(task.downloaded, len(segments))
        task.merge_progress = self._merge_seg_pct(task.merged, len(segments))

        need = list(range(merger.next_append, len(segments)))
        if not need and merger.next_append >= len(segments):
            self._finalize_hls_mp4(task, cache, video.id, out, gen)
            return

        downloaded_bytes = 0
        speed_state = {"t": time.time(), "b": 0}
        pool_workers = min(workers, max(1, len(need)))

        def on_merge(done: int, total: int, nbytes: int) -> None:
            nonlocal downloaded_bytes
            downloaded_bytes = nbytes
            task.merged = done
            task.merge_progress = self._merge_seg_pct(done, total)
            task.progress = max(task.download_progress * 0.5, task.merge_progress * 0.5)
            self._update_speed(task, downloaded_bytes, speed_state)
            self._emit(task.id)

        def work(client: httpx.Client, idx: int) -> int:
            if not self._alive(task.id, gen):
                raise RuntimeError("cancelled")
            self._acquire_slot(task, gen)
            try:
                size = self._fetch_segment_stream(
                    client, segments[idx].url, headers, cache, video.id, idx
                )
                if not self._alive(task.id, gen):
                    raise RuntimeError("cancelled")
                merger.note_segment_written()
                return size
            finally:
                self._release_slot()

        with self._make_client(pool_workers) as client, ThreadPoolExecutor(max_workers=pool_workers) as pool:
            futures = {pool.submit(work, client, i): i for i in need}
            for fut in as_completed(futures):
                if not self._alive(task.id, gen):
                    raise RuntimeError("cancelled")
                size = fut.result()
                downloaded_bytes += size
                task.downloaded = merger.buffered_count
                task.download_progress = self._seg_pct(task.downloaded, len(segments))
                merger.on_segment_written(on_merge)
                self._update_speed(task, downloaded_bytes, speed_state)
                self._emit(task.id)

        merger.finish(on_merge)
        self._finalize_hls_mp4(task, cache, video.id, out, gen)

    def _download_http(self, task: DownloadTask, gen: int) -> None:
        if not self._alive(task.id, gen):
            raise RuntimeError("cancelled")
        video = task.video
        headers = self._build_headers(video, video.url)
        out = build_output_path(self.settings, task.file_name)
        out.parent.mkdir(parents=True, exist_ok=True)

        with self._make_client() as client:
            res = client.head(video.url, headers=headers)
            if res.status_code == 405:
                res = client.get(video.url, headers=headers)
            self._check_response(res)
            total = int(res.headers.get("content-length") or 0)
            accept_ranges = (res.headers.get("accept-ranges") or "").lower() == "bytes"
            task.total = total

            if total > 1_048_576 and accept_ranges:
                self._download_ranges(client, task, video.url, headers, total, out, gen)
                return

            nbytes = self._stream_to_file(client, video.url, headers, out)
            task.downloaded = nbytes
            task.total = nbytes or task.downloaded
            task.download_progress = 100
            task.merge_progress = 100
            task.progress = 99

    def _download_ranges(
        self,
        client: httpx.Client,
        task: DownloadTask,
        url: str,
        headers: dict,
        total: int,
        out: Path,
        gen: int,
    ) -> None:
        connections = self._worker_limit()
        if total < 10_485_760:
            connections = min(2, connections)
        elif total < 52_428_800:
            connections = min(4, connections)
        chunk = total // connections
        parts = []
        for i in range(connections):
            start = i * chunk
            end = total - 1 if i == connections - 1 else start + chunk - 1
            parts.append((start, end, i))

        part_files: dict[int, Path] = {}
        downloaded = 0
        speed_state = {"t": time.time(), "b": 0}
        tmp_dir = out.parent / f".{out.stem}.parts"
        tmp_dir.mkdir(parents=True, exist_ok=True)

        def work(start: int, end: int, index: int) -> int:
            if not self._alive(task.id, gen):
                raise RuntimeError("cancelled")
            self._acquire_slot(task, gen)
            try:
                h = dict(headers)
                h["range"] = f"bytes={start}-{end}"
                part_path = tmp_dir / f"part_{index:02d}"
                with client.stream("GET", url, headers=h) as res:
                    self._check_response(res)
                    nbytes = 0
                    with part_path.open("wb") as f:
                        for data in res.iter_bytes(chunk_size=disk_store.STREAM_CHUNK):
                            f.write(data)
                            nbytes += len(data)
                return nbytes
            finally:
                self._release_slot()

        try:
            with ThreadPoolExecutor(max_workers=connections) as pool:
                futs = {pool.submit(work, s, e, idx): idx for s, e, idx in parts}
                for fut in as_completed(futs):
                    if not self._alive(task.id, gen):
                        raise RuntimeError("cancelled")
                    idx = futs[fut]
                    size = fut.result()
                    part_files[idx] = tmp_dir / f"part_{idx:02d}"
                    downloaded += size
                    task.downloaded = downloaded
                    task.progress = min(95.0, downloaded * 95.0 / total)
                    task.download_progress = task.progress
                    self._update_speed(task, downloaded, speed_state)
                    self._emit(task.id)

            with out.open("wb") as f:
                for i in range(connections):
                    part_path = part_files[i]
                    with part_path.open("rb") as src:
                        shutil.copyfileobj(src, f, length=disk_store.MERGE_COPY_BUFSIZE)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        task.download_progress = 100
        task.merge_progress = 100
        task.progress = 99

    @staticmethod
    def _seg_pct(done: int, total: int) -> float:
        if not total:
            return 0.0
        pct = done * 100.0 / total
        return min(100.0, max(1.0, pct)) if 0 < pct < 1 else min(100.0, pct)

    def _merge_seg_pct(self, done: int, total: int) -> float:
        """片段合併進度（保留 94% 給 MP4 封裝階段）。"""
        return min(94.0, self._seg_pct(done, total))

    def _finalize_hls_mp4(self, task: DownloadTask, cache: Path, video_id: str, out: Path, gen: int) -> None:
        task.status = "merging"
        task.merge_progress = max(task.merge_progress, 94.0)
        self._emit(task.id, immediate=True)

        def on_ffmpeg(pct: float) -> None:
            if not self._alive(task.id, gen):
                raise RuntimeError("cancelled")
            task.merge_progress = 94.0 + min(100.0, pct) * 0.06
            self._emit(task.id)

        disk_store.finalize_mp4(cache, video_id, out, on_progress=on_ffmpeg)
        task.merge_progress = 100
        task.download_progress = 100
        task.progress = 99

    def _update_speed(self, task: DownloadTask, downloaded: int, state: dict) -> None:
        now = time.time()
        if now - state["t"] >= 0.4:
            elapsed = now - state["t"]
            if elapsed > 0:
                task.speed = max(0.0, (downloaded - state["b"]) / elapsed)
            state["t"] = now
            state["b"] = downloaded
