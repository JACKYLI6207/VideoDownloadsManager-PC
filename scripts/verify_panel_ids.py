"""Verify panel.js selectors exist in panel.html."""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
html = (root / "extension-chrome-src/sidepanel/panel.html").read_text(encoding="utf-8")
js = (root / "extension-chrome-src/sidepanel/panel.js").read_text(encoding="utf-8")

ids_in_html = set(re.findall(r'\bid="([^"]+)"', html))
missing = []
for m in re.finditer(r'\$\(["\']#([^"\']+)["\']\)\.addEventListener', js):
    eid = m.group(1)
    if eid not in ids_in_html:
        missing.append((eid, m.start()))

print("popoutBtn in html:", "popoutBtn" in ids_in_html)
print("Missing required IDs:", missing or "none")
