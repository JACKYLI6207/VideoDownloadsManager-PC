"""本機片段資料夾合併為 MP4。"""
from __future__ import annotations

import shutil
import time
from collections.abc import Callable
from pathlib import Path

from vdm_pc.download.disk_store import MERGE_COPY_BUFSIZE, MERGED_RAW, seg_name
from vdm_pc.download.ffmpeg_util import concat_ts_to_mp4, probe_duration_sec
from vdm_pc.models import sanitize_filename


def _collect_numbered(folder: Path) -> list[Path]:
    numbered: list[Path] = []
    i = 0
    while (folder / seg_name(i)).is_file():
        numbered.append(folder / seg_name(i))
        i += 1
    return numbered


def collect_segments(folder: Path) -> list[Path]:
    """掃描資料夾內可合併的 .ts 片段（支援 VDM 暫存命名或任意 .ts）。"""
    folder = folder.resolve()
    if not folder.is_dir():
        raise RuntimeError(f"資料夾不存在：{folder}")

    # 有編號片段時一律用全部片段（略過可能不完整的 merged.ts）
    numbered = _collect_numbered(folder)
    if numbered:
        return numbered

    merged = folder / MERGED_RAW
    if merged.is_file() and merged.stat().st_size > 0:
        return [merged]

    ts_files = sorted(
        (p for p in folder.glob("*.ts") if p.name.lower() != MERGED_RAW.lower()),
        key=lambda p: p.name.lower(),
    )
    if ts_files:
        return ts_files

    raise RuntimeError("資料夾內沒有找到 .ts 片段")


def folder_has_segments(folder: Path) -> bool:
    try:
        collect_segments(folder)
        return True
    except RuntimeError:
        return False


def folder_segments_complete(folder: Path, expected_total: int) -> bool:
    """片段資料夾是否已下載齊全（00000.ts … expected_total-1）。"""
    if expected_total <= 0:
        return False
    folder = folder.resolve()
    for i in range(expected_total):
        if not (folder / seg_name(i)).is_file():
            return False
    return True


def scan_subfolders_with_segments(parent: Path) -> list[Path]:
    """掃描父資料夾下含片段的直接子資料夾。"""
    parent = parent.resolve()
    if not parent.is_dir():
        return []
    found: list[Path] = []
    for child in sorted(parent.iterdir()):
        if child.is_dir() and folder_has_segments(child):
            found.append(child)
    return found


def expected_output_mp4(folder: Path, output_dir: Path) -> Path:
    """與 add_local_merge 相同規則的輸出 MP4 路徑。"""
    name = folder.name
    if not name.lower().endswith(".mp4"):
        name = sanitize_filename(name) + ".mp4"
    return output_dir / name


def output_mp4_missing(folder: Path, output_dir: Path) -> bool:
    """輸出目的地尚無對應 MP4（或檔案為空）。"""
    out_mp4 = expected_output_mp4(folder, output_dir)
    return not (out_mp4.is_file() and out_mp4.stat().st_size > 0)


def folder_stable_for_merge(folder: Path, idle_seconds: float = 15.0) -> bool:
    """片段資料夾最近一段時間未再寫入（避免合併進行中下載）。"""
    numbered = _collect_numbered(folder.resolve())
    if not numbered:
        return False
    newest = max(p.stat().st_mtime for p in numbered)
    return (time.time() - newest) >= idle_seconds


def merge_segments_to_mp4(
    segments: list[Path],
    out_mp4: Path,
    *,
    on_progress: Callable[[float], None] | None = None,
) -> None:
    """先二進位串接全部片段，再 FFmpeg 封裝 MP4（進度 0–94% 串接，94–100% 封裝）。"""
    if not segments:
        raise RuntimeError("沒有片段可合併")

    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    def report(pct: float) -> None:
        if on_progress:
            on_progress(min(100.0, max(0.0, pct)))

    if len(segments) == 1:
        report(0.0)
        duration = probe_duration_sec(segments[0])

        def on_ffmpeg(pct: float) -> None:
            report(94.0 + pct * 0.06)

        concat_ts_to_mp4(segments, out_mp4, on_progress=on_ffmpeg, duration_sec=duration)
        report(100.0)
        return

    temp_ts = out_mp4.with_suffix(".merge.tmp.ts")
    total = len(segments)
    try:
        report(0.0)
        with temp_ts.open("wb") as out:
            for idx, seg in enumerate(segments):
                with seg.open("rb") as src:
                    shutil.copyfileobj(src, out, length=MERGE_COPY_BUFSIZE)
                report((idx + 1) / total * 94.0)

        duration = probe_duration_sec(temp_ts)

        def on_ffmpeg(pct: float) -> None:
            report(94.0 + pct * 0.06)

        concat_ts_to_mp4([temp_ts], out_mp4, on_progress=on_ffmpeg, duration_sec=duration)
        report(100.0)
    finally:
        temp_ts.unlink(missing_ok=True)
