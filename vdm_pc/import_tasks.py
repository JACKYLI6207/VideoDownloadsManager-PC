"""擴充 vdm-active-tasks JSON 匯入/匯出。"""
from __future__ import annotations

import json
from typing import Any

from vdm_pc.models import DownloadTask, VideoMeta, new_id


def normalize_url(url: str) -> str:
    return (url or "").strip().split("#")[0]


def export_payload(tasks: list[DownloadTask]) -> dict[str, Any]:
    return {
        "format": "vdm-active-tasks",
        "version": 1,
        "source": "vdm-pc",
        "tasks": [t.snapshot() for t in tasks],
    }


def parse_import_file(text: str) -> list[dict[str, Any]]:
    data = json.loads(text)
    if isinstance(data, dict) and isinstance(data.get("tasks"), list):
        return data["tasks"]
    if isinstance(data, list):
        return data
    raise ValueError("匯入檔沒有任務列表")


def import_tasks(
    raw_tasks: list[dict[str, Any]],
    existing_urls: set[str] | None = None,
    *,
    reset_progress: bool = True,
) -> tuple[list[DownloadTask], int]:
    """從擴充導出 JSON 建立新任務（預設全部重頭下載）。"""
    seen = set(existing_urls or [])
    imported: list[DownloadTask] = []
    skipped = 0

    for snap in raw_tasks:
        video_raw = snap.get("video") if isinstance(snap, dict) else None
        if not isinstance(video_raw, dict) or not video_raw.get("url"):
            skipped += 1
            continue
        norm = normalize_url(str(video_raw["url"]))
        if norm in seen:
            skipped += 1
            continue
        seen.add(norm)

        video = VideoMeta.from_dict(video_raw)
        file_name = str(snap.get("fileName") or video.title or "video")
        task = DownloadTask.create(video, file_name)
        task.id = str(snap.get("id") or new_id())

        if reset_progress:
            task.status = "paused"
            task.error = "已匯入，可點「繼續」開始下載"
        else:
            task.status = str(snap.get("status") or "paused")
            task.progress = float(snap.get("progress") or 0)
            task.download_progress = float(snap.get("downloadProgress") or 0)
            task.merge_progress = float(snap.get("mergeProgress") or 0)
            task.merged = int(snap.get("merged") or 0)
            task.downloaded = int(snap.get("downloaded") or 0)
            task.total = int(snap.get("total") or 0)
            task.error = str(snap.get("error") or "")

        imported.append(task)

    return imported, skipped
