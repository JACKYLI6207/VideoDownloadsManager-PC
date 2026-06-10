"""影片 URL 偵測（對齊擴充 lib/detector.js）。"""
from __future__ import annotations

import re
from urllib.parse import urlparse

VIDEO_EXTENSIONS = frozenset({
    "mp4", "webm", "mkv", "mov", "avi", "flv", "m4v", "3gp", "ts", "m3u8", "mpd",
})

AD_URL_PATTERNS = (
    re.compile(r"(?:^|[/._-])ads?(?:[./_-]|$)", re.I),
    re.compile(r"advert", re.I),
    re.compile(r"preroll", re.I),
    re.compile(r"midroll", re.I),
    re.compile(r"postroll", re.I),
    re.compile(r"vast", re.I),
    re.compile(r"doubleclick", re.I),
    re.compile(r"googlesyndication", re.I),
    re.compile(r"adserver", re.I),
    re.compile(r"/ad/", re.I),
    re.compile(r"creative", re.I),
    re.compile(r"promo", re.I),
    re.compile(r"imasdk", re.I),
    re.compile(r"gampad", re.I),
    re.compile(r"pubads", re.I),
)


def extension_from_url(url: str) -> str:
    try:
        path = urlparse(url).path.lower()
        dot = path.rfind(".")
        return path[dot + 1 :] if dot >= 0 else ""
    except Exception:
        return ""


def is_likely_ad_url(url: str) -> bool:
    return any(pat.search(url or "") for pat in AD_URL_PATTERNS)


def is_video_url(url: str) -> bool:
    if not url or re.match(r"^(data:|blob:|javascript:|about:)", url, re.I):
        return False
    lower = url.lower()
    if re.search(r"\.m3u8(?:\?|$)", lower):
        return True
    if re.search(r"\.mpd(?:\?|$)", lower):
        return True
    ext = extension_from_url(url)
    if ext in VIDEO_EXTENSIONS:
        return True
    return bool(re.search(r"/video/|videoplayback|mime=video|type=video", lower))
