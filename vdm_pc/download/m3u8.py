"""M3U8 解析（移植自擴充 lib/m3u8.js）。"""
from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urljoin, urlparse


@dataclass
class Segment:
    url: str
    duration: float = 0.0


@dataclass
class Playlist:
    is_variant: bool
    playlists: list[dict]
    segments: list[Segment]


def resolve_url(base: str, ref: str) -> str:
    return urljoin(base, ref)


def parse_m3u8(text: str, base_url: str) -> Playlist:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    playlists: list[dict] = []
    segments: list[Segment] = []
    bandwidth = 0
    resolution = 0

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF"):
            bw = _match_int(line, r"BANDWIDTH=(\d+)")
            bandwidth = bw or 0
            res = _match_int(line, r"RESOLUTION=\d+x(\d+)")
            resolution = res or 0
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if nxt and not nxt.startswith("#"):
                playlists.append(
                    {
                        "url": resolve_url(base_url, nxt),
                        "bandwidth": bandwidth,
                        "resolution": resolution,
                    }
                )
                i += 1
        elif line.startswith("#EXTINF"):
            dur = _match_float(line, r"#EXTINF:([\d.]+)") or 0.0
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if nxt and not nxt.startswith("#"):
                segments.append(Segment(url=resolve_url(base_url, nxt), duration=dur))
                i += 1
        i += 1

    return Playlist(is_variant=bool(playlists), playlists=playlists, segments=segments)


def pick_best_variant(playlist: Playlist) -> str:
    if not playlist.playlists:
        return ""
    best = max(playlist.playlists, key=lambda p: (p.get("resolution") or 0, p.get("bandwidth") or 0))
    return str(best.get("url") or "")


def _match_int(text: str, pattern: str) -> int | None:
    import re

    m = re.search(pattern, text, re.I)
    return int(m.group(1)) if m else None


def _match_float(text: str, pattern: str) -> float | None:
    import re

    m = re.search(pattern, text, re.I)
    return float(m.group(1)) if m else None


def is_video_url(url: str) -> bool:
    from vdm_pc.browser.detector import is_likely_ad_url, is_video_url as _detect

    return _detect(url) and not is_likely_ad_url(url)
