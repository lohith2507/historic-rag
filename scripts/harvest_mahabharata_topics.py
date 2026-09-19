"""Extract Mahabharata chapter titles/descriptions from Gurukula (text only, no images)."""

from __future__ import annotations

import html
import json
import re
import urllib.request
from pathlib import Path

URL = "https://gurukula.com/en/mahabharata"
OUT = Path(__file__).resolve().parents[1] / "data" / "mahabharata-chapters.json"
USER_AGENT = "historic-rag/1.0 (offline topic harvest; text only)"

CHAPTER_RE = re.compile(
    r">(\d+)<!--\s*-->\.\s*<!--\s*-->([^<]+)<!--\s*-->\s*</a>"
    r'.*?<div class="content-inner">(.*?)</div>',
    re.S,
)


def main() -> None:
    req = urllib.request.Request(URL, headers={"User-Agent": USER_AGENT})
    raw = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", errors="replace")
    text = html.unescape(raw)

    chapters: list[dict] = []
    seen: set[int] = set()

    for match in CHAPTER_RE.finditer(text):
        chapter_id = int(match.group(1))
        if chapter_id in seen:
            continue
        seen.add(chapter_id)
        title = match.group(2).strip()
        description = re.sub(r"<[^>]+>", "", match.group(3))
        description = re.sub(r"\s+", " ", description).strip()
        chapters.append(
            {
                "id": chapter_id,
                "title": title,
                "description": description,
                "source": "mahabharata",
            }
        )

    chapters.sort(key=lambda row: row["id"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(chapters, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(chapters)} chapters -> {OUT}")


if __name__ == "__main__":
    main()
