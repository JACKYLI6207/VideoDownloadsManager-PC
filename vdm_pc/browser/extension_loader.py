"""從 Chrome 線上商店下載並解壓擴充，供 Playwright --load-extension 使用。"""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from urllib.parse import urlparse

import httpx

_EXT_ID_RE = re.compile(r"[a-p]{32}")
_CRX_URL = (
    "https://clients2.google.com/service/update2/crx"
    "?response=redirect&prodversion=131.0"
    "&acceptformat=crx2,crx3&x=id%3D{id}%26uc"
)


def extensions_root() -> Path:
    root = Path.home() / "AppData" / "Local" / "VideoDownloadsManager-PC" / "extensions"
    root.mkdir(parents=True, exist_ok=True)
    return root


def parse_extension_urls(text: str) -> list[str]:
    entries: list[str] = []
    for line in re.split(r"[\r\n,]+", text or ""):
        line = line.strip()
        if not line:
            continue
        if line.startswith("http://") or line.startswith("https://"):
            entries.append(line)
        elif Path(line).exists():
            entries.append(line)
    return entries


def _resolve_local_entry(entry: str) -> Path | None:
    path = Path(entry).expanduser().resolve()
    if path.is_dir() and (path / "manifest.json").is_file():
        return path
    if path.is_file() and path.suffix.lower() == ".crx":
        dest = extensions_root() / f"local_{path.stem}"
        _extract_crx(path.read_bytes(), dest)
        return dest
    return None


def extension_id_from_url(url: str) -> str:
    parsed = urlparse(url.strip())
    path = parsed.path.rstrip("/")
    for part in reversed(path.split("/")):
        match = _EXT_ID_RE.fullmatch(part)
        if match:
            return match.group(0)
    query = parsed.query or ""
    match = re.search(r"(?:^|&)id=([a-p]{32})", query)
    if match:
        return match.group(1)
    raise ValueError(f"無法從網址解析擴充 ID：{url}")


def _extract_crx(crx_data: bytes, dest: Path) -> None:
    marker = b"PK\x03\x04"
    idx = crx_data.find(marker)
    if idx < 0:
        raise RuntimeError("CRX 格式無效")
    if dest.exists():
        import shutil

        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(crx_data[idx:])) as zf:
        zf.extractall(dest)
    manifest = dest / "manifest.json"
    if not manifest.is_file():
        raise RuntimeError("解壓後找不到 manifest.json")


def download_extension(ext_id: str, dest: Path) -> Path:
    """下載並解壓單一擴充，回傳解壓目錄。"""
    url = _CRX_URL.format(id=ext_id)
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        res = client.get(url)
        res.raise_for_status()
        data = res.content
    if len(data) < 1024:
        raise RuntimeError(f"下載失敗或檔案過小（{ext_id}）")
    _extract_crx(data, dest)
    return dest


def sync_extensions(urls: list[str], *, log=None) -> list[Path]:
    """依網址清單確保擴充已下載，回傳可載入的資料夾路徑。"""
    loaded: list[Path] = []
    root = extensions_root()
    for raw in urls:
        if not raw.startswith("http"):
            local = _resolve_local_entry(raw)
            if local:
                loaded.append(local)
                if log:
                    log(f"OK local: {local}")
            elif log:
                log(f"SKIP invalid local path: {raw}")
            continue
        try:
            ext_id = extension_id_from_url(raw)
        except ValueError as exc:
            if log:
                log(str(exc))
            continue
        dest = root / ext_id
        manifest = dest / "manifest.json"
        if not manifest.is_file():
            try:
                if log:
                    log(f"DOWNLOAD {ext_id} ...")
                download_extension(ext_id, dest)
                if log:
                    log(f"OK {ext_id}")
            except Exception as exc:  # noqa: BLE001
                if log:
                    log(f"FAIL {ext_id}: {exc}")
                    log("  (部分擴充 Google 不提供自動下載，可改貼本機 .crx 或解壓資料夾路徑)")
                continue
        loaded.append(dest.resolve())
    return loaded
