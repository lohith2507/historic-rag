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

## Source PDFs

Place these gitignored PDFs at the repo root:

- `The Bhagavad Gita.pdf` for `gita`
- `valmiki_ramayanam.pdf` for `ramayana`
- `Menon_Ramesh-The-Complete-Mahabharata_-Volume-1-12.pdf` for `mahabharata`

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
