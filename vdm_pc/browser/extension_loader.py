"""從 Chrome 線上商店下載並解壓擴充，供 Playwright --load-extension 使用。"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import urlparse

import httpx

VDM_PC_EXTENSION_ID = "anokolhjgbidjccbgmahcgdagmmdoddi"

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


def chrome_arg_path(path: Path) -> str:
    """Chrome 參數路徑須用絕對路徑且避免 Windows 反斜線被誤解析。"""
    return path.resolve().as_posix()


_KNOWN_EXT_LABELS = {
    "bgnkhhnnamicmpeenaelnjfhikgbkllg": "AdGuard",
    "ailoabdmgclmfmhdagmlohpjlbpffblp": "Surfshark",
    "lnemmogegmgllangfmlpclaomcknfnbp": "Hide Images",
    "cjpalhdlnbpafiamejdnhcphjbkeiagm": "uBlock Origin",
}


def _chrome_id_from_manifest_key(key_b64: str) -> str:
    der = base64.b64decode(key_b64.strip())
    digest = hashlib.sha256(der).digest()
    chars: list[str] = []
    for byte in digest[:16]:
        chars.append(chr(ord("a") + ((byte >> 4) & 0xF)))
        chars.append(chr(ord("a") + (byte & 0xF)))
    return "".join(chars)


def _read_manifest(path: Path) -> dict | None:
    manifest = path / "manifest.json"
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def extension_id_from_path(path: Path) -> str:
    """從解壓目錄名稱或 manifest key 推得擴充 ID。"""
    name = path.name
    if _EXT_ID_RE.fullmatch(name):
        return name
    data = _read_manifest(path)
    if data:
        ext_id = str(data.get("id") or "").strip()
        if _EXT_ID_RE.fullmatch(ext_id):
            return ext_id
        key = str(data.get("key") or "").strip()
        if key:
            try:
                return _chrome_id_from_manifest_key(key)
            except (ValueError, TypeError):
                pass
        if data.get("description") == "VDM_PC":
            return VDM_PC_EXTENSION_ID
    raise ValueError(f"無法解析擴充 ID：{path}")


def extension_label(path: Path) -> str:
    manifest = path / "manifest.json"
    if manifest.is_file():
        try:
            import json

            data = json.loads(manifest.read_text(encoding="utf-8"))
            name = str(data.get("name") or "").strip()
            if name and not name.startswith("__MSG"):
                return name
        except (OSError, json.JSONDecodeError):
            pass
    if path.name in _KNOWN_EXT_LABELS:
        return _KNOWN_EXT_LABELS[path.name]
    return path.name


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
