"""本機片段暫存、邊下邊合併與 FFmpeg 封裝。"""
from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path

from collections.abc import Callable

from vdm_pc.download.ffmpeg_util import concat_ts_to_mp4, probe_duration_sec

MERGED_RAW = "merged.ts"
MERGE_META = "merge.json"


def task_dir(cache_root: Path, video_id: str) -> Path:
    path = cache_root / video_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def seg_name(index: int) -> str:
    return f"{index:05d}.ts"


def write_segment(cache_root: Path, video_id: str, index: int, data: bytes) -> None:
    folder = task_dir(cache_root, video_id)
    part = folder / f"{seg_name(index)}.part"
    final = folder / seg_name(index)
    part.write_bytes(data)
    if final.exists():
        final.unlink()
    part.replace(final)


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


def buffered_count(cache_root: Path, video_id: str, total: int, merged_through: int = 0) -> int:
    """已緩衝片段數（mergedThrough + 磁碟上所有未合併 .ts，允許並行下載出現空洞）。"""
    folder = task_dir(cache_root, video_id)
    n = merged_through
    for i in range(merged_through, total):
        if (folder / seg_name(i)).is_file():
            n += 1
    return n


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
        if start > 0 and self._merged_path.is_file():
            self.merged_bytes = self._merged_path.stat().st_size

    def on_segment_written(self, on_progress=None) -> int:
        with self._lock:
            while self.next_append < self.total:
                seg = self._folder / seg_name(self.next_append)
                if not seg.is_file():
                    break
                mode = "ab" if self._merged_path.exists() else "wb"
                with self._merged_path.open(mode) as out, seg.open("rb") as src:
                    chunk = src.read()
                    out.write(chunk)
                    self.merged_bytes += len(chunk)
                seg.unlink(missing_ok=True)
                self.next_append += 1
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
