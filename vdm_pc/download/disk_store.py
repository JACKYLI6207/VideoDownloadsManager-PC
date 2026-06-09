"""本機片段暫存、邊下邊合併與 FFmpeg 封裝。"""
from __future__ import annotations

import json
import shutil
import threading
from collections.abc import Callable, Iterable
from pathlib import Path

from vdm_pc.download.ffmpeg_util import concat_ts_to_mp4, probe_duration_sec

MERGED_RAW = "merged.ts"
MERGE_META = "merge.json"
STREAM_CHUNK = 256 * 1024
MERGE_COPY_BUFSIZE = 1024 * 1024


def task_dir(cache_root: Path, video_id: str) -> Path:
    path = cache_root / video_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def seg_name(index: int) -> str:
    return f"{index:05d}.ts"


def write_segment(cache_root: Path, video_id: str, index: int, data: bytes) -> int:
    folder = task_dir(cache_root, video_id)
    part = folder / f"{seg_name(index)}.part"
    final = folder / seg_name(index)
    part.write_bytes(data)
    if final.exists():
        final.unlink()
    part.replace(final)
    return len(data)


def write_segment_stream(
    cache_root: Path,
    video_id: str,
    index: int,
    chunks: Iterable[bytes],
) -> int:
    """串流寫入片段（.part → .ts）。"""
    folder = task_dir(cache_root, video_id)
    part = folder / f"{seg_name(index)}.part"
    final = folder / seg_name(index)
    nbytes = 0
    with part.open("wb") as out:
        for chunk in chunks:
            if not chunk:
                continue
            out.write(chunk)
            nbytes += len(chunk)
    if final.exists():
        final.unlink()
    part.replace(final)
    return nbytes


def read_merge_meta(cache_root: Path, video_id: str) -> int:
    meta = task_dir(cache_root, video_id) / MERGE_META
    if not meta.is_file():
        return 0
    try:
        data = json.loads(meta.read_text(encoding="utf-8"))
        return int(data.get("mergedThrough") or 0)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return 0


def write_merge_meta(cache_root: Path, video_id: str, merged_through: int) -> None:
    meta = task_dir(cache_root, video_id) / MERGE_META
    meta.write_text(json.dumps({"mergedThrough": merged_through}), encoding="utf-8")


def count_on_disk_segments(folder: Path, merged_through: int, total: int) -> int:
    n = 0
    for i in range(merged_through, total):
        if (folder / seg_name(i)).is_file():
            n += 1
    return n


def buffered_count(cache_root: Path, video_id: str, total: int, merged_through: int = 0) -> int:
    """已緩衝片段數（僅任務啟動時掃描；執行中請用 StreamMerger.buffered_count）。"""
    folder = task_dir(cache_root, video_id)
    return merged_through + count_on_disk_segments(folder, merged_through, total)


class StreamMerger:
    """邊下邊合併（對應擴充 createOpfsStreamMerger）。"""

    def __init__(self, cache_root: Path, video_id: str, total: int, start: int = 0) -> None:
        self.cache_root = cache_root
        self.video_id = video_id
        self.total = total
        self.next_append = start
        self.merged_bytes = 0
        self._lock = threading.Lock()
        self._folder = task_dir(cache_root, video_id)
        self._merged_path = self._folder / MERGED_RAW
        self._on_disk = count_on_disk_segments(self._folder, start, total)
        if start > 0 and self._merged_path.is_file():
            self.merged_bytes = self._merged_path.stat().st_size

    @property
    def buffered_count(self) -> int:
        return self.next_append + self._on_disk

    def note_segment_written(self) -> None:
        self._on_disk += 1

    def on_segment_written(self, on_progress=None) -> int:
        with self._lock:
            while self.next_append < self.total:
                seg = self._folder / seg_name(self.next_append)
                if not seg.is_file():
                    break
                mode = "ab" if self._merged_path.exists() else "wb"
                seg_size = seg.stat().st_size
                with self._merged_path.open(mode) as out, seg.open("rb") as src:
                    shutil.copyfileobj(src, out, length=MERGE_COPY_BUFSIZE)
                    self.merged_bytes += seg_size
                seg.unlink(missing_ok=True)
                self.next_append += 1
                self._on_disk = max(0, self._on_disk - 1)
                write_merge_meta(self.cache_root, self.video_id, self.next_append)
                if on_progress:
                    on_progress(self.next_append, self.total, self.merged_bytes)
            return self.next_append

    def finish(self, on_progress=None) -> int:
        self.on_segment_written(on_progress)
        if self.next_append < self.total:
            raise RuntimeError(f"合併未完成：{self.next_append}/{self.total}")
        return self.merged_bytes


def finalize_mp4(
    cache_root: Path,
    video_id: str,
    out_mp4: Path,
    *,
    on_progress: Callable[[float], None] | None = None,
) -> None:
    """將 merged.ts 或殘留 .ts 封裝為 MP4。"""
    folder = task_dir(cache_root, video_id)
    merged = folder / MERGED_RAW
    segments: list[Path] = []
    if merged.is_file() and merged.stat().st_size > 0:
        segments = [merged]
    else:
        i = 0
        while (folder / seg_name(i)).is_file():
            segments.append(folder / seg_name(i))
            i += 1
    if not segments:
        raise RuntimeError("沒有可合併的片段")
    duration = probe_duration_sec(segments[0])
    concat_ts_to_mp4(segments, out_mp4, on_progress=on_progress, duration_sec=duration)
    shutil.rmtree(folder, ignore_errors=True)


def clear_task(cache_root: Path, video_id: str) -> None:
    shutil.rmtree(task_dir(cache_root, video_id), ignore_errors=True)
