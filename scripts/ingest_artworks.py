"""Harvest public-domain epic paintings from Wikimedia Commons into Supabase.

Mirrors scripts/ingest.py: the same OpenRouter embedding model and the same batched,
retrying Supabase writes. Only public-domain and CC0 files are kept, so the app never
carries an attribution or share-alike obligation it cannot honour.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Sequence

from ingest import (  # reuse the proven embedding + Supabase plumbing
    EMBED_BATCH_SIZE,
    INSERT_BATCH_SIZE,
    _supabase_call_with_retry,
    batched,
    embed_texts,
    get_supabase_client,
    repo_root,
)

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "historic-rag/1.0 (https://github.com/; offline ingest)"
THUMB_WIDTH = 1024
RESULTS_PER_TERM = 40

# Only these licences are accepted. Anything else is skipped.
ALLOWED_LICENCE_PATTERNS = (
    re.compile(r"^public domain", re.I),
    re.compile(r"^pd", re.I),
    re.compile(r"^cc0", re.I),
)

SEARCH_TERMS: dict[str, list[str]] = {
    "mahabharata": [
        "Mahabharata painting",
        "Mahabharata illustration manuscript",
        "Kurukshetra war painting",
        "Arjuna Krishna chariot painting",
        "Karna Mahabharata painting",
        "Bhima Duryodhana mace duel painting",
        "Draupadi vastraharan painting",
        "Pandavas exile painting",
        "Bhishma arrows painting",
        "Razmnama illustration",
    ],
    "ramayana": [
        "Ramayana painting",
        "Ramayana illustration manuscript",
        "Rama Ravana battle painting",
        "Hanuman Lanka painting",
        "Sita Rama forest exile painting",
        "Rama bow Janaka painting",
        "Valmiki Ramayana manuscript folio",
    ],
    "gita": [
        "Bhagavad Gita painting",
        "Krishna Arjuna discourse painting",
        "Vishvarupa Krishna universal form painting",
        "Krishna charioteer Arjuna manuscript",
    ],
}


@dataclass(frozen=True)
class Artwork:
    commons_id: str
    source: str
    title: str
    description: str
    image_url: str
    page_url: str
    artist: str | None
    credit: str | None
    license: str
    date_text: str | None


def strip_markup(value: str | None) -> str:
    if not value:
        return ""

    text = re.sub(r"<[^>]*>", " ", value)
    text = text.replace("&amp;", "&").replace("&quot;", '"').replace("&#039;", "'")

    return " ".join(text.split())


def is_allowed_licence(licence: str) -> bool:
    return any(pattern.match(licence) for pattern in ALLOWED_LICENCE_PATTERNS)


def build_description(title: str, meta: dict, categories: Sequence[str]) -> str:
    """The text that gets embedded. Richer descriptions retrieve better."""
    parts = [
        title,
        strip_markup(meta.get("ImageDescription", {}).get("value")),
        strip_markup(meta.get("ObjectName", {}).get("value")),
        strip_markup(meta.get("Artist", {}).get("value")),
        strip_markup(meta.get("DateTimeOriginal", {}).get("value")),
        " ".join(category.replace("Category:", "") for category in categories),
    ]

    return " ".join(part for part in parts if part)[:2000]


def fetch_term(client, term: str, source: str) -> list[Artwork]:
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"{term} filetype:bitmap",
        "gsrnamespace": "6",
        "gsrlimit": str(RESULTS_PER_TERM),
        "prop": "imageinfo|categories",
        "iiprop": "url|extmetadata",
        "iiurlwidth": str(THUMB_WIDTH),
        "cllimit": "20",
    }

    response = client.get(COMMONS_API, params=params, headers={"User-Agent": USER_AGENT})
    response.raise_for_status()
    pages = (response.json().get("query") or {}).get("pages") or {}

    artworks: list[Artwork] = []

    for page in pages.values():
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata") or {}
        licence = strip_markup(meta.get("LicenseShortName", {}).get("value"))

        if not licence or not is_allowed_licence(licence):
            continue

        image_url = info.get("thumburl") or info.get("url")

        if not image_url:
            continue

        title = page.get("title", "").replace("File:", "")
        categories = [category.get("title", "") for category in page.get("categories") or []]
        description = build_description(title, meta, categories)

        if len(description) < 20:
            continue

        artworks.append(
            Artwork(
                commons_id=page.get("title", ""),
                source=source,
                title=title,
                description=description,
                image_url=image_url,
                page_url=info.get("descriptionurl", ""),
                artist=strip_markup(meta.get("Artist", {}).get("value")) or None,
                credit=strip_markup(meta.get("Credit", {}).get("value")) or None,
                license=licence,
                date_text=strip_markup(meta.get("DateTimeOriginal", {}).get("value")) or None,
            )
        )

    return artworks


def harvest(sources: Sequence[str]) -> list[Artwork]:
    import httpx

    seen: set[str] = set()
    collected: list[Artwork] = []

    with httpx.Client(timeout=60) as client:
        for source in sources:
            for term in SEARCH_TERMS[source]:
                try:
                    found = fetch_term(client, term, source)
                except Exception as exc:  # noqa: BLE001 - one bad term must not abort the run
                    print(f"{source}: term '{term}' failed ({exc})")
                    continue

                fresh = [art for art in found if art.commons_id not in seen]
                seen.update(art.commons_id for art in fresh)
                collected.extend(fresh)

                print(f"{source}: '{term}' -> {len(found)} licensed, {len(fresh)} new (total {len(collected)})")
                time.sleep(0.5)  # be polite to the Commons API

    return collected


def replace_artworks(artworks: Sequence[Artwork], embeddings: Sequence[Sequence[float]]) -> None:
    if len(artworks) != len(embeddings):
        raise ValueError("artworks and embeddings must have the same length")

    supabase = get_supabase_client()
    rows = [
        {**asdict(artwork), "embedding": list(embedding)}
        for artwork, embedding in zip(artworks, embeddings)
    ]

    for index, batch in enumerate(batched(rows, INSERT_BATCH_SIZE), start=1):
        batch_rows = list(batch)
        _supabase_call_with_retry(
            f"artworks upsert batch {index}",
            lambda batch_rows=batch_rows: supabase.table("artworks")
            .upsert(batch_rows, on_conflict="commons_id")
            .execute(),
        )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest public-domain epic artwork from Wikimedia Commons.")
    parser.add_argument("--source", default="all", choices=[*SEARCH_TERMS, "all"], help="Epic to harvest")
    parser.add_argument("--dry-run", action="store_true", help="Harvest metadata without embedding or writing")
    parser.add_argument("--out", help="Write harvested metadata to this JSON file")

    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    from dotenv import load_dotenv

    load_dotenv(repo_root() / ".env.local")
    load_dotenv(repo_root() / ".env")

    args = parse_args(argv or sys.argv[1:])
    sources = list(SEARCH_TERMS) if args.source == "all" else [args.source]
    artworks = harvest(sources)

    print(f"\nharvested {len(artworks)} unique public-domain artworks")

    if args.out:
        Path(args.out).write_text(
            json.dumps([asdict(artwork) for artwork in artworks], indent=1, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"wrote {args.out}")

    if args.dry_run:
        return 0

    embeddings = embed_texts([artwork.description for artwork in artworks])
    replace_artworks(artworks, embeddings)
    print(f"upserted {len(artworks)} artworks")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
