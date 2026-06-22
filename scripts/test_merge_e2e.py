"""Test periodic auto-scan merge logic (no Qt GUI)."""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))

from vdm_pc.merge_local import (
    expected_output_mp4,
    folder_stable_for_merge,
    output_mp4_missing,
    scan_subfolders_with_segments,
)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        seg_root = base / "segments"
        out_dir = base / "output"
        seg_root.mkdir()
        out_dir.mkdir()

        folder = seg_root / "video-title"
        folder.mkdir()
        (folder / "00000.ts").write_bytes(b"x" * 400)
        (folder / "00001.ts").write_bytes(b"y" * 400)

        found = scan_subfolders_with_segments(seg_root)
        assert len(found) == 1, found
        assert output_mp4_missing(folder, out_dir), "output should be missing"
        out_mp4 = expected_output_mp4(folder, out_dir)
        assert out_mp4.name == "video-title.mp4", out_mp4.name

        # Recent writes should not be stable yet
        assert not folder_stable_for_merge(folder, idle_seconds=15.0)

        # Simulate finished download
        time.sleep(0.05)
        old = time.time() - 20
        for p in folder.glob("*.ts"):
            import os

            os.utime(p, (old, old))

        assert folder_stable_for_merge(folder, idle_seconds=15.0)

        out_mp4.write_bytes(b"fake")
        assert not output_mp4_missing(folder, out_dir), "existing mp4 should be skipped"

    print("E2E OK: auto-scan merge helpers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
