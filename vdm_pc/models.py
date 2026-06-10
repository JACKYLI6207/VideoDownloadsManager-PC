"""資料模型。"""
from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def sanitize_filename(name: str) -> str:
    cleaned = "".join("_" if c in '<>:"/\\|?*' else c for c in (name or "video"))
    return cleaned.strip() or "video"


def guess_quality(text: str) -> int:
    """從 URL / 標題推斷畫質（對齊擴充 detector.guessQuality）。"""
    combined = str(text or "")
    m = re.search(r"(\d{3,4})[pP]|RESOLUTION=(\d+)x(\d+)", combined, re.I)
    if m:
        for g in m.groups():
            if g:
                val = int(g)
                if val >= 240:
                    return min(val, 4320)
    m = re.search(r"(\d{3,4})x(\d{3,4})", combined, re.I)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
        return min(w, h)
    if re.search(r"2160|4[kK]", combined):
        return 2160
    if re.search(r"1440", combined):
        return 1440
    if re.search(r"1080", combined):
        return 1080
    if re.search(r"720", combined):
        return 720
    if re.search(r"480", combined):
        return 480
    if re.search(r"360", combined):
        return 360
    return 0


def format_resolution(quality: int) -> str:
    if quality <= 0:
        return "—"
    if quality >= 2160:
        return "2160"
    if quality >= 1440:
        return "1440"
    if quality >= 1080:
        return "1080"
    if quality >= 720:
        return "720"
    if quality >= 480:
        return "480"
    if quality >= 360:
        return "360"
    return str(quality)


def resolve_quality(*texts: str, quality: int = 0) -> int:
    if quality > 0:
        return quality
    for text in texts:
        q = guess_quality(text)
        if q > 0:
            return q
    return 0


@dataclass
class VideoMeta:
    url: str
    id: str = ""
    page_url: str = ""
    referer: str = ""
    title: str = ""
    quality: int = 0
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
        quality_raw = raw.get("quality")
        try:
            quality = int(quality_raw) if quality_raw else 0
        except (TypeError, ValueError):
            quality = 0
        title = str(raw.get("title") or "")
        if not quality:
            quality = guess_quality(url)
        if not quality:
            quality = guess_quality(title)
        return cls(
            url=url,
            id=str(raw.get("id") or new_id()),
            page_url=page_url,
            referer=referer,
            title=title,
            quality=max(0, quality),
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
            "quality": self.quality,
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
