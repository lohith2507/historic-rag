# PDF Ingest Script

Use `ingest.py` to extract, chunk, embed, and insert the local PDFs into the Supabase `chunks` table.

## Setup

Install the Python dependencies:

```powershell
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

## Sources

Place these gitignored PDFs at the repo root:

- `The Bhagavad Gita.pdf` for `gita`
- `Menon_Ramesh-The-Complete-Mahabharata_-Volume-1-12.pdf` for `mahabharata`

`ramayana` needs no PDF. The bundled `valmiki_ramayanam.pdf` is a 339-page illustrated
abridgement (~416K characters), so the script instead downloads Griffith's complete
*Rámáyan of Válmíki* from Project Gutenberg on first run — 2.35M characters, 493 cantos,
public domain — and caches it as the gitignored `ramayana_griffith.txt`.

## Headings

Chunks carry a `heading` so retrieval and the UI can cite structure, not just a page number:

| Source | Heading format | Coverage |
|--------|----------------|----------|
| `mahabharata` | `Canto 21: Astika Parva` | 7,633 / 7,647 |
| `ramayana` | `Book VI (Yuddhakánda), Canto CXXX: The Consecration` | 493 / 493 |
| `gita` | `Chapter 2` | 399 / 451 |

Headings print only on the page where a canto opens, so `build_chunks` carries the last
one forward across the pages that follow. `load_pages` captures it from the laid-out text
before whitespace is collapsed — collapsing first would destroy the line structure.

## Run

Dry-run extraction and chunk counts without API calls:

```powershell
python scripts/ingest.py --source gita --dry-run
```

Ingest one source:

```powershell
python scripts/ingest.py --source gita
```

Ingest all sources:

```powershell
python scripts/ingest.py --source all
```

Non-dry runs delete existing rows for each selected source, call OpenRouter embeddings in batches, and insert fresh rows into `chunks`.

## Tests

Run the ingest unit tests from the repo root:

```powershell
python -m unittest scripts.test_ingest
```
