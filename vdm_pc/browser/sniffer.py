"""嗅探到的媒體資源。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable

from vdm_pc.download.m3u8 import is_video_url


@dataclass
class SniffedResource:
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    page_url: str = ""
    page_title: str = ""
    score: int = 0
    ts: datetime = field(default_factory=datetime.now)

    @property
    def title(self) -> str:
        if self.page_title:
            return self.page_title
        path = self.url.split("?")[0].rstrip("/")
        return path.split("/")[-1] or self.url


class MediaSniffer:
    def __init__(self) -> None:
        self.resources: list[SniffedResource] = []
        self._seen: set[str] = set()
        self.on_found: Callable[[SniffedResource], None] | None = None

    def add(self, url: str, headers: dict, page_url: str, page_title: str = "") -> SniffedResource | None:
        if not url or not is_video_url(url):
            return None
        norm_headers = {str(k).lower(): str(v) for k, v in (headers or {}).items() if v}
        if page_url and not norm_headers.get("referer"):
            norm_headers["referer"] = page_url
        if not norm_headers.get("user-agent"):
            norm_headers["user-agent"] = (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )

        if url in self._seen:
            for r in self.resources:
                if r.url == url:
                    if page_title and not r.page_title:
                        r.page_title = page_title
                    for k in ("cookie", "authorization", "referer"):
                        if norm_headers.get(k):
                            r.headers[k] = norm_headers[k]
                    return r
            return None

        score = 0
        lower = url.lower()
        if ".m3u8" in lower:
            score += 50
        if norm_headers.get("cookie"):
            score += 25
        if norm_headers.get("referer"):
            score += 15

        res = SniffedResource(url=url, headers=norm_headers, page_url=page_url, page_title=page_title, score=score)
        self.resources.append(res)
        self._seen.add(url)
        if self.on_found:
            self.on_found(res)
        return res

    def clear(self) -> None:
        self.resources.clear()
        self._seen.clear()
