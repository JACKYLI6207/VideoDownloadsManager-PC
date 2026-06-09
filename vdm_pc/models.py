"""資料模型。"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def sanitize_filename(name: str) -> str:
    cleaned = "".join("_" if c in '<>:"/\\|?*' else c for c in (name or "video"))
    return cleaned.strip() or "video"


@dataclass
class VideoMeta:
    url: str
    id: str = ""
    page_url: str = ""
    referer: str = ""
    title: str = ""
    is_m3u8: bool = False
    request_headers: dict[str, str] = field(default_factory=dict)
    user_agent: str = ""

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> VideoMeta:
        headers = raw.get("requestHeaders") or raw.get("request_headers") or {}
        if not isinstance(headers, dict):
            headers = {}
        norm_headers = {str(k).lower(): str(v) for k, v in headers.items() if v}
        url = str(raw.get("url") or "")
        page_url = str(raw.get("pageUrl") or raw.get("page_url") or "")
        referer = str(raw.get("referer") or page_url or "")
        is_m3u8 = bool(raw.get("isM3u8")) or ".m3u8" in url.lower()
        return cls(
            url=url,
            id=str(raw.get("id") or new_id()),
            page_url=page_url,
            referer=referer,
            title=str(raw.get("title") or ""),
            is_m3u8=is_m3u8,
            request_headers=norm_headers,
            user_agent=str(raw.get("userAgent") or raw.get("user_agent") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "pageUrl": self.page_url,
            "referer": self.referer,
            "title": self.title,
            "isM3u8": self.is_m3u8,
            "requestHeaders": self.request_headers,
            "userAgent": self.user_agent,
        }


@dataclass
class DownloadTask:
    id: str
    video: VideoMeta
    file_name: str
    status: str = "pending"
    progress: float = 0.0
    download_progress: float = 0.0
    merge_progress: float = 0.0
    merged: int = 0
    downloaded: int = 0
    total: int = 0
    speed: float = 0.0
    error: str = ""
    started_at: float = field(default_factory=time.time)

    @classmethod
    def create(cls, video: VideoMeta, file_name: str) -> DownloadTask:
        base = sanitize_filename(file_name or video.title or "video")
        if not base.lower().endswith(".mp4"):
            base += ".mp4"
        return cls(id=new_id(), video=video, file_name=base)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "video": self.video.to_dict(),
            "fileName": self.file_name,
            "status": self.status,
            "progress": self.progress,
            "downloadProgress": self.download_progress,
            "mergeProgress": self.merge_progress,
            "merged": self.merged,
            "downloaded": self.downloaded,
            "total": self.total,
            "error": self.error,
            "startedAt": int(self.started_at * 1000),
        }


@dataclass
class LogEntry:
    level: str
    message: str
    detail: str = ""
    ts: float = field(default_factory=time.time)
