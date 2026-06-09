"""從命令列安裝瀏覽器擴充：python scripts/install_extensions.py <網址> …"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from vdm_pc.browser.extension_loader import sync_extensions  # noqa: E402


def main() -> int:
    urls = [a for a in sys.argv[1:] if a.startswith("http")]
    if not urls:
        print("用法：python scripts/install_extensions.py <Chrome線上商店網址> …")
        return 1

    def log(msg: str) -> None:
        print(msg)

    paths = sync_extensions(urls, log=log)
    print(f"完成：{len(paths)} 個擴充已就緒")
    for p in paths:
        print(f"  {p}")
    return 0 if paths else 2


if __name__ == "__main__":
    raise SystemExit(main())
