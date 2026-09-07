from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small"
SOURCE_FILES = {
    "gita": "The Bhagavad Gita.pdf",
    "ramayana": "valmiki_ramayanam.pdf",
    "mahabharata": "Menon_Ramesh-The-Complete-Mahabharata_-Volume-1-12.pdf",
}
SOURCE_ORDER = ["gita", "ramayana", "mahabharata"]
TARGET_TOKENS = 600
OVERLAP_TOKENS = 120
EMBEDDING_DIMENSIONS = 1536
EMBED_BATCH_SIZE = 32
EMBED_MAX_ATTEMPTS = 3
INSERT_BATCH_SIZE = 10
INSERT_MAX_ATTEMPTS = 5


@dataclass(frozen=True)
class PageText:
    page: int
    text: str


@dataclass(frozen=True)
class Chunk:
    source: str
    content: str
    page: int
    heading: str | None = None


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def select_sources(source: str) -> list[str]:
    if source == "all":
        return SOURCE_ORDER.copy()

    return [source]


def chunk_text(text: str, encoding, target_tokens: int = TARGET_TOKENS, overlap_tokens: int = OVERLAP_TOKENS) -> list[str]:
    if target_tokens <= 0:
        raise ValueError("target_tokens must be positive")
    if overlap_tokens < 0:
        raise ValueError("overlap_tokens must be non-negative")
    if overlap_tokens >= target_tokens:
        raise ValueError("overlap_tokens must be smaller than target_tokens")

    tokens = encoding.encode(text)
    chunks: list[str] = []
    start = 0
    step = target_tokens - overlap_tokens

    while start < len(tokens):
        end = min(start + target_tokens, len(tokens))
        chunk = encoding.decode(tokens[start:end]).strip()

        if chunk:
            chunks.append(chunk)

        if end == len(tokens):
            break

        start += step

    return chunks


def batched(items: Sequence, batch_size: int) -> Iterable[Sequence]:
    for start in range(0, len(items), batch_size):
        yield items[start : start + batch_size]


def load_pages(pdf_path: Path) -> list[PageText]:
    import pymupdf

    if not pdf_path.exists():
        raise FileNotFoundError(f"Missing PDF: {pdf_path}")

    pages: list[PageText] = []
    ocr_used = 0

    with pymupdf.open(pdf_path) as document:
        for index, page in enumerate(document, start=1):
            text = " ".join(page.get_text("text").split())

            if not text:
                try:
                    text = " ".join(page.get_text("text", flags=pymupdf.TEXT_PRESERVE_WHITESPACE).split())
                except Exception:
                    text = ""

            if not text:
                try:
                    # Scanned PDFs (e.g. Ramayana) need OCR.
                    textpage = page.get_textpage_ocr(dpi=200, full=True)
                    text = " ".join(page.get_text("text", textpage=textpage).split())
                    if text:
                        ocr_used += 1
                except Exception as exc:
                    print(f"{pdf_path.name}: OCR failed on page {index}: {exc}")
                    text = ""

            if text:
                pages.append(PageText(page=index, text=text))

            if index % 25 == 0:
                print(f"{pdf_path.name}: scanned {index}/{len(document)} pages (ocr_pages={ocr_used}, text_pages={len(pages)})")

    if ocr_used:
        print(f"{pdf_path.name}: used OCR on {ocr_used} pages")

    return pages


def build_chunks(source: str, pages: Sequence[PageText]) -> list[Chunk]:
    import tiktoken

    encoding = tiktoken.get_encoding("cl100k_base")
    chunks: list[Chunk] = []

    for page in pages:
        for content in chunk_text(page.text, encoding):
            chunks.append(Chunk(source=source, content=content, page=page.page))

    return chunks


def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    import httpx

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENROUTER_API_KEY")

    model = os.environ.get("OPENROUTER_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)
    embeddings: list[list[float]] = []

    with httpx.Client(timeout=60) as client:
        for batch in batched(list(texts), EMBED_BATCH_SIZE):
            body = None

            for attempt in range(1, EMBED_MAX_ATTEMPTS + 1):
                response = client.post(
                    f"{OPENROUTER_BASE_URL}/embeddings",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={"model": model, "input": list(batch)},
                )

                try:
                    body = response.json()
                except ValueError:
                    body = {}

                if response.status_code == 429 or response.status_code >= 500:
                    if attempt < EMBED_MAX_ATTEMPTS:
                        time.sleep(2 ** (attempt - 1))
                        continue

                break

            if response.status_code >= 400:
                message = body.get("error", {}).get("message") if isinstance(body, dict) else None
                raise RuntimeError(message or f"OpenRouter embeddings request failed with {response.status_code}")

            data = body.get("data") if isinstance(body, dict) else None
            if not isinstance(data, list) or len(data) != len(batch):
                raise RuntimeError("OpenRouter embeddings response did not match the requested batch")

            indexed_data = []
            for item in data:
                index = item.get("index") if isinstance(item, dict) else None
                if type(index) is not int:
                    raise RuntimeError("OpenRouter embeddings response included invalid batch indices")
                indexed_data.append(item)

            sorted_data = sorted(indexed_data, key=lambda item: item["index"])
            indices = [item["index"] for item in sorted_data]
            if indices != list(range(len(batch))):
                raise RuntimeError("OpenRouter embeddings response included invalid batch indices")

            for item in sorted_data:
                embedding = item.get("embedding") if isinstance(item, dict) else None

                if not isinstance(embedding, list) or not all(isinstance(value, (int, float)) for value in embedding):
                    raise RuntimeError("OpenRouter embeddings response included an invalid embedding")

                if len(embedding) != EMBEDDING_DIMENSIONS:
                    raise RuntimeError(
                        f"OpenRouter embedding must be {EMBEDDING_DIMENSIONS} dimensions; received {len(embedding)}"
                    )

                embeddings.append([float(value) for value in embedding])

    return embeddings


def get_supabase_client():
    import httpx
    from supabase import create_client
    from supabase.lib.client_options import SyncClientOptions

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not url:
        raise RuntimeError("Missing SUPABASE_URL")
    if not key:
        raise RuntimeError("Missing SUPABASE_SERVICE_ROLE_KEY")

    # HTTP/2 + very large vector payloads can trigger intermittent SSL failures on Windows.
    http_client = httpx.Client(http2=False, timeout=120.0)
    return create_client(url, key, options=SyncClientOptions(httpx_client=http_client))


def _supabase_call_with_retry(label: str, action) -> None:
    last_error: Exception | None = None

    for attempt in range(1, INSERT_MAX_ATTEMPTS + 1):
        try:
            action()
            return
        except Exception as exc:  # noqa: BLE001 - retry transient network/SSL failures
            last_error = exc
            if attempt >= INSERT_MAX_ATTEMPTS:
                break
            sleep_for = min(2 ** attempt, 20)
            print(f"{label}: attempt {attempt} failed ({exc}); retrying in {sleep_for}s")
            time.sleep(sleep_for)

    assert last_error is not None
    raise last_error


def replace_source_chunks(source: str, chunks: Sequence[Chunk], embeddings: Sequence[Sequence[float]]) -> None:
    if len(chunks) != len(embeddings):
        raise ValueError("chunks and embeddings must have the same length")

    supabase = get_supabase_client()
    existing = supabase.table("chunks").select("id").eq("source", source).execute()
    existing_rows = existing.data if isinstance(existing.data, list) else []
    existing_ids = [row["id"] for row in existing_rows if isinstance(row, dict) and isinstance(row.get("id"), str)]

    rows = [
        {
            "source": chunk.source,
            "content": chunk.content,
            "embedding": list(embedding),
            "page": chunk.page,
            "heading": chunk.heading,
        }
        for chunk, embedding in zip(chunks, embeddings)
    ]

    for index, batch in enumerate(batched(rows, INSERT_BATCH_SIZE), start=1):
        batch_rows = list(batch)
        _supabase_call_with_retry(
            f"{source} insert batch {index}",
            lambda batch_rows=batch_rows: supabase.table("chunks").insert(batch_rows).execute(),
        )

    for index, id_batch in enumerate(batched(existing_ids, INSERT_BATCH_SIZE), start=1):
        ids = list(id_batch)
        _supabase_call_with_retry(
            f"{source} delete batch {index}",
            lambda ids=ids: supabase.table("chunks").delete().in_("id", ids).execute(),
        )


def ingest_source(source: str, dry_run: bool) -> tuple[int, int]:
    pdf_path = repo_root() / SOURCE_FILES[source]
    pages = load_pages(pdf_path)
    chunks = build_chunks(source, pages)

    print(f"{source}: pages={len(pages)} chunks={len(chunks)}")

    if dry_run:
        return len(pages), len(chunks)

    embeddings = embed_texts([chunk.content for chunk in chunks])
    replace_source_chunks(source, chunks, embeddings)
    print(f"{source}: inserted={len(chunks)}")

    return len(pages), len(chunks)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest historic India PDFs into Supabase chunks.")
    parser.add_argument("--source", required=True, choices=[*SOURCE_ORDER, "all"], help="PDF source to ingest")
    parser.add_argument("--dry-run", action="store_true", help="Extract and chunk PDFs without API calls")

    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    from dotenv import load_dotenv

    load_dotenv(repo_root() / ".env.local")
    load_dotenv(repo_root() / ".env")

    args = parse_args(argv or sys.argv[1:])

    for source in select_sources(args.source):
        ingest_source(source, args.dry_run)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
