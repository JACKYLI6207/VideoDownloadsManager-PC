"""FFmpeg 工具（封裝 imageio-ffmpeg 內建二進位）。"""
from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import imageio_ffmpeg

from vdm_pc.cpu_limit import assign_child_to_job


def ffmpeg_exe() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def _win_subprocess_kwargs() -> dict:
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def probe_duration_sec(media: Path) -> float:
    """以 ffmpeg -i 解析媒體總時長（秒）。"""
    cmd = [ffmpeg_exe(), "-hide_banner", "-i", str(media)]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
        **_win_subprocess_kwargs(),
    )
    text = (proc.stderr or "") + (proc.stdout or "")
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def concat_ts_to_mp4(
    segment_paths: list[Path],
    out_mp4: Path,
    *,
    on_progress: Callable[[float], None] | None = None,
    duration_sec: float = 0.0,
) -> None:
    """用 concat demuxer 無損封裝成 MP4（隱藏 CMD 黑窗，可回報進度）。"""
    if not segment_paths:
        raise RuntimeError("沒有片段可合併")
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    list_file = out_mp4.with_suffix(".txt")
    try:
        lines = []
        for p in segment_paths:
            safe = str(p.resolve()).replace("'", "'\\''")
            lines.append(f"file '{safe}'")
        list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
        cmd = [
            ffmpeg_exe(),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_file),
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-progress",
            "pipe:1",
            "-nostats",
            str(out_mp4),
        ]
        if on_progress:
            on_progress(0.0)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            **_win_subprocess_kwargs(),
        )
        if proc.pid:
            assign_child_to_job(proc.pid)
        if proc.stdout:
            for line in proc.stdout:
                line = line.strip()
                if not line.startswith("out_time_us="):
                    continue
                try:
                    elapsed_us = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                if on_progress and duration_sec > 0:
                    pct = min(100.0, max(0.0, (elapsed_us / 1_000_000) / duration_sec * 100))
                    on_progress(pct)
        rc = proc.wait()
        if rc != 0:
            raise RuntimeError(f"FFmpeg 合併失敗（exit {rc}）")
        if on_progress:
            on_progress(100.0)
    finally:
        list_file.unlink(missing_ok=True)
