# Ingest Scripts

Offline helpers that fill Supabase before the Next.js app can search or illustrate.

## Setup

Install the Python dependencies:

```bash
python -m pip install -r scripts/requirements.txt
```

Create `.env.local` or `.env` at the repo root with:

```env
OPENROUTER_API_KEY=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
```

`OPENROUTER_EMBEDDING_MODEL` is optional and defaults to `openai/text-embedding-3-small`.

## PDF / text ingest (`ingest.py`)

Use `ingest.py` to extract, chunk, embed, and insert the local PDFs into the Supabase `chunks` table.

### Sources

Place these gitignored PDFs at the repo root:

- `The Bhagavad Gita.pdf` for `gita`
- `Menon_Ramesh-The-Complete-Mahabharata_-Volume-1-12.pdf` for `mahabharata`

`ramayana` needs no PDF. The bundled `valmiki_ramayanam.pdf` is a 339-page illustrated
abridgement (~416K characters), so the script instead downloads Griffith's complete
*Rámáyan of Válmíki* from Project Gutenberg on first run — 2.35M characters, 493 cantos,
public domain — and caches it as the gitignored `ramayana_griffith.txt`.

### Headings

Chunks carry a `heading` so retrieval and the UI can cite structure, not just a page number:

| Source | Heading format | Coverage |
|--------|----------------|----------|
| `mahabharata` | `Canto 21: Astika Parva` | 7,633 / 7,647 |
| `ramayana` | `Book VI (Yuddhakánda), Canto CXXX: The Consecration` | 493 / 493 |
| `gita` | `Chapter 2` | 399 / 451 |

Headings print only on the page where a canto opens, so `build_chunks` carries the last
one forward across the pages that follow. `load_pages` captures it from the laid-out text
before whitespace is collapsed — collapsing first would destroy the line structure.

### Run

Dry-run extraction and chunk counts without API calls:

```bash
python scripts/ingest.py --source gita --dry-run
```

Ingest one source:

```bash
python scripts/ingest.py --source gita
```

Ingest all sources:

```bash
python scripts/ingest.py --source all
```

Non-dry runs delete existing rows for each selected source, call OpenRouter embeddings in batches, and insert fresh rows into `chunks`.

### Tests

Run the ingest unit tests from the repo root:

```bash
python -m unittest scripts.test_ingest
```

## Artwork ingest (`ingest_artworks.py`)

Optional. Harvests **public-domain and CC0** epic paintings from Wikimedia Commons into the
`artworks` table (requires [`supabase/migrations/002_artworks.sql`](../supabase/migrations/002_artworks.sql)).
Chat uses matched artworks to illustrate answers; if the table is empty, it falls back to a
generated image, then an animated SVG.

```bash
python scripts/ingest_artworks.py --source all
```

Useful flags:

- `--source gita|ramayana|mahabharata|all` — epic to harvest (default `all`)
- `--dry-run` — collect metadata without embedding or writing
- `--out artworks.json` — write harvested metadata to a JSON file (often paired with `--dry-run`)

Example dry-run:

```bash
python scripts/ingest_artworks.py --source gita --dry-run --out artworks.json
```
## Topic harvest (`harvest_mahabharata_topics.py`)

Offline helper that refreshes [`data/mahabharata-chapters.json`](../data/mahabharata-chapters.json) from Gurukula chapter titles and descriptions (text only, no images). The JSON powers full-color chat scene context.

No API keys required. Run from the repo root:

```bash
python scripts/harvest_mahabharata_topics.py
```

The script overwrites `data/mahabharata-chapters.json` with the harvested chapter list.
