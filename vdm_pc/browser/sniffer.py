"""嗅探到的媒體資源（對齊擴充 background handleSniff / parseAndStoreM3u8）。"""

from __future__ import annotations



import re

from dataclasses import dataclass, field

from datetime import datetime

from typing import Callable



import httpx



from vdm_pc.browser.detector import is_likely_ad_url, is_video_url

from vdm_pc.download.m3u8 import parse_m3u8





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

        self._m3u8_pending: set[str] = set()

        self.on_found: Callable[[SniffedResource], None] | None = None



    def add(self, url: str, headers: dict, page_url: str, page_title: str = "") -> SniffedResource | None:

        if not url or not is_video_url(url) or is_likely_ad_url(url):

            return None

        if re.search(r"\.ts(?:\?|$)", url, re.I):

            return None



        norm_headers = self._normalize_headers(headers, page_url)



        if ".m3u8" in url.lower():

            return self._add_m3u8(url, norm_headers, page_url, page_title)



        return self._store(url, norm_headers, page_url, page_title)



    @staticmethod

    def _normalize_headers(headers: dict, page_url: str) -> dict[str, str]:

        norm = {str(k).lower(): str(v) for k, v in (headers or {}).items() if v}

        if page_url and not norm.get("referer"):

            norm["referer"] = page_url

        if not norm.get("user-agent"):

            norm["user-agent"] = (

                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "

                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

            )

        return norm



    def _add_m3u8(

        self, url: str, headers: dict[str, str], page_url: str, page_title: str

    ) -> SniffedResource | None:

        key = f"{page_url}:{url}"

        if key in self._m3u8_pending:

            return None

        self._m3u8_pending.add(key)

        try:

            req_headers = {k.title(): v for k, v in headers.items() if k in ("referer", "user-agent", "cookie")}

            with httpx.Client(timeout=20, follow_redirects=True) as client:

                res = client.get(url, headers=req_headers)

                res.raise_for_status()

                playlist = parse_m3u8(res.text, url)



            last: SniffedResource | None = None

            if playlist.is_variant:

                variants = [

                    v

                    for v in playlist.playlists

                    if not is_likely_ad_url(v.get("url") or "")

                    and (not v.get("bandwidth") or v.get("bandwidth", 0) >= 400_000)

                    and (not v.get("resolution") or v.get("resolution", 0) >= 360)

                ]

                variants.sort(

                    key=lambda v: (v.get("bandwidth") or 0, v.get("resolution") or 0),

                    reverse=True,

                )

                for variant in variants[:4]:

                    vurl = str(variant.get("url") or "")

                    res_label = variant.get("resolution") or 0

                    title = page_title or "HLS"

                    if res_label:

                        title = f"{title} {res_label}p"

                    item = self._store(vurl, headers, page_url, title.strip())

                    if item:

                        last = item

            else:

                if len(playlist.segments) > 2:

                    last = self._store(url, headers, page_url, page_title)

            if not last:

                last = self._store(url, headers, page_url, page_title or "HLS")

            return last

        except Exception:

            return self._store(url, headers, page_url, page_title or "HLS")

        finally:

            self._m3u8_pending.discard(key)



    def _store(

        self, url: str, headers: dict[str, str], page_url: str, page_title: str

    ) -> SniffedResource | None:

        if url in self._seen:

            for r in self.resources:

                if r.url == url:

                    if page_title and not r.page_title:

                        r.page_title = page_title

                    for k in ("cookie", "authorization", "referer"):

                        if headers.get(k):

                            r.headers[k] = headers[k]

                    return r

            return None



        score = 0

        lower = url.lower()

        if ".m3u8" in lower:

            score += 50

        if headers.get("cookie"):

            score += 25

        if headers.get("referer"):

            score += 15



        res = SniffedResource(

            url=url,

            headers=dict(headers),

            page_url=page_url,

            page_title=page_title,

            score=score,

        )

        self.resources.append(res)

        self._seen.add(url)

        if self.on_found:

            self.on_found(res)

        return res



    def clear(self) -> None:

        self.resources.clear()

        self._seen.clear()

        self._m3u8_pending.clear()

