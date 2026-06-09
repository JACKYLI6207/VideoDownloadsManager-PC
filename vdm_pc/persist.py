"""任務與日誌持久化。"""
from __future__ import annotations

import json
from pathlib import Path

from vdm_pc.models import DownloadTask, VideoMeta

_DATA_DIR = Path.home() / "AppData" / "Roaming" / "VideoDownloadsManager-PC"
_ACTIVE_FILE = _DATA_DIR / "active_tasks.json"
_COMPLETED_FILE = _DATA_DIR / "completed_tasks.json"


def _ensure() -> None:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)


def save_active(tasks: list[DownloadTask]) -> None:
    _ensure()
    payload = {
        "format": "vdm-active-tasks",
        "version": 1,
        "tasks": [t.snapshot() for t in tasks],
    }
    _ACTIVE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_active() -> list[DownloadTask]:
    if not _ACTIVE_FILE.is_file():
        return []
    try:
        data = json.loads(_ACTIVE_FILE.read_text(encoding="utf-8"))
        snaps = data.get("tasks") if isinstance(data, dict) else []
        if not isinstance(snaps, list):
            return []
    except (OSError, json.JSONDecodeError):
        return []

    out: list[DownloadTask] = []
    for snap in snaps:
        if not isinstance(snap, dict):
            continue
        video_raw = snap.get("video")
        if not isinstance(video_raw, dict) or not video_raw.get("url"):
            continue
        video = VideoMeta.from_dict(video_raw)
        file_name = str(snap.get("fileName") or video.title or "video.mp4")
        task = DownloadTask(
            id=str(snap.get("id") or video.id),
            video=video,
            file_name=file_name if file_name.lower().endswith(".mp4") else f"{file_name}.mp4",
            status="paused",
            progress=float(snap.get("progress") or 0),
            download_progress=float(snap.get("downloadProgress") or 0),
            merge_progress=float(snap.get("mergeProgress") or 0),
            merged=int(snap.get("merged") or 0),
            downloaded=int(snap.get("downloaded") or 0),
            total=int(snap.get("total") or 0),
            error="",
        )
        out.append(task)
    return out


def save_completed(tasks: list[DownloadTask]) -> None:
    _ensure()
    payload = {"tasks": [t.snapshot() for t in tasks[:200]]}
    _COMPLETED_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_completed() -> list[DownloadTask]:
    if not _COMPLETED_FILE.is_file():
        return []
    try:
        data = json.loads(_COMPLETED_FILE.read_text(encoding="utf-8"))
        snaps = data.get("tasks") if isinstance(data, dict) else []
        if not isinstance(snaps, list):
            return []
    except (OSError, json.JSONDecodeError):
        return []

    out: list[DownloadTask] = []
    for snap in snaps:
        if not isinstance(snap, dict):
            continue
        video_raw = snap.get("video")
        if not isinstance(video_raw, dict):
            continue
        video = VideoMeta.from_dict(video_raw)
        task = DownloadTask(
            id=str(snap.get("id") or video.id),
            video=video,
            file_name=str(snap.get("fileName") or "video.mp4"),
            status="completed",
            progress=100,
            download_progress=100,
            merge_progress=100,
        )
        out.append(task)
    return out
