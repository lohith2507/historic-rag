# Historic India RAG Pipeline — Design Spec

**Date:** 2026-09-03  
**Status:** Approved in conversation; awaiting final review before implementation

## Goal

Build a Vercel-hosted app that supports **semantic search** and **chat Q&A** over three epic PDFs (Mahabharata, Ramayana, Bhagavad Gita), with embeddings stored in **Supabase pgvector** and generation via **OpenRouter**.

## Non-goals (v1)

- Perfect verse-level citations (optional / best-effort only)
- Auth, user accounts, or chat history persistence
- On-Vercel PDF parsing or embedding of the full corpus
- Multi-language UI or Sanskrit-specific NLP

## Architecture

```
PDFs (repo root)
    ↓  offline ingest script
text → chunks → OpenRouter embeddings
    ↓
Supabase Postgres + pgvector
    ↑
Next.js (App Router) on Vercel
  POST /api/search  → embed query → similarity search → passages
  POST /api/chat    → retrieve top-k → OpenRouter chat (stream) → answer
    ↑
UI: Search mode + Chat mode
```

**Runtime split**

| Phase | Where | What |
|--------|--------|------|
| Ingest | Developer machine | PDF extract, chunk, embed, upsert |
| Query | Vercel serverless | Query embed, vector search, LLM |

## Corpus

| File | `source` id |
|------|-------------|
| `Menon_Ramesh-The-Complete-Mahabharata_-Volume-1-12.pdf` | `mahabharata` |
| `valmiki_ramayanam.pdf` | `ramayana` |
| `The Bhagavad Gita.pdf` | `gita` |

All three are in scope for v1.

## Data model (Supabase)

Enable extension: `vector`.

Table `chunks`:

| Column | Type | Notes |
|--------|------|--------|
| `id` | `uuid` PK | default `gen_random_uuid()` |
| `source` | `text` | `mahabharata` \| `ramayana` \| `gita` |
| `content` | `text` | chunk text |
| `embedding` | `vector(1536)` | matches `text-embedding-3-small` |
| `page` | `int` nullable | PDF page if available |
| `heading` | `text` nullable | nearest heading if detected |
| `created_at` | `timestamptz` | default now() |

Index: HNSW (or IVFFlat if preferred) on `embedding` using cosine distance.

RPC: `match_chunks(query_embedding vector(1536), match_count int, filter_source text default null)` returning similar rows with `similarity`.

Re-ingest strategy: delete rows for a given `source`, then insert fresh chunks for that book.

## Ingest pipeline

**Location:** `scripts/ingest.py` (Python)

**Steps:**

1. Load PDF with PyMuPDF (or pdfplumber fallback)
2. Extract plain text per page; light cleanup (collapse excess whitespace)
3. Chunk ~500–800 tokens with ~100–150 token overlap; attach `source`, `page`, optional `heading`
4. Embed batches via OpenRouter (`openai/text-embedding-3-small`)
5. Upsert into Supabase using service role key

**CLI:** support `--source gita|ramayana|mahabharata|all` for partial re-runs.

**Cost/size note:** Free Supabase (~500 MB DB) is the target; prefer 1536-d small embeddings and moderate chunk counts. If storage pressure appears, reduce overlap or use a smaller embedding model in a later iteration.

## Application

**Stack:** Next.js (App Router), TypeScript, deployed on Vercel.

### APIs

**`POST /api/search`**

- Body: `{ query: string, source?: string, limit?: number }`
- Embed query via OpenRouter → `match_chunks` → return passages (`content`, `source`, `page`, `similarity`)

**`POST /api/chat`**

- Body: `{ messages: { role, content }[], source?: string }`
- Retrieve top-k chunks for the latest user message
- Call OpenRouter chat with a system prompt: answer only from provided context; if unknown, say so; optionally mention source when natural
- Stream the response; attach retrieved passages as optional sources in the JSON/stream metadata or a follow-up field

Default chat model: a capable, cost-effective OpenRouter model (e.g. `openai/gpt-4o-mini` or similar); configurable via env `OPENROUTER_CHAT_MODEL`.

### UI

- Single page with **Search** and **Chat** modes
- Search: input + ranked passage list (source + page badge)
- Chat: message list, streaming assistant reply, optional collapsed “Sources” under the last answer
- Keep layout simple; no auth in v1

## Configuration & secrets

Never commit secrets. Use `.env.local` and Vercel project env:

| Variable | Used by |
|----------|---------|
| `OPENROUTER_API_KEY` | ingest + app |
| `OPENROUTER_CHAT_MODEL` | app (optional default) |
| `OPENROUTER_EMBEDDING_MODEL` | ingest + app (default `openai/text-embedding-3-small`) |
| `SUPABASE_URL` | ingest + app |
| `SUPABASE_SERVICE_ROLE_KEY` | ingest + server routes only |

Provide `.env.example` with empty placeholders. Document that any key pasted in chat must be rotated.

## Deployment

1. Create free Supabase project; run SQL migration (extension + table + RPC + index)
2. Set Vercel env vars; deploy Next.js app
3. Run `scripts/ingest.py --source all` locally once
4. Verify `/api/search` and `/api/chat` against the live DB

## Testing / acceptance

- Ingest completes for all three sources without crashing
- Search returns relevant passages for queries like “What does Krishna say about duty?”
- Chat answers are grounded in retrieved context and refuse when context is empty/irrelevant
- No API keys in the repo
- App builds and deploys on Vercel

## Out of scope follow-ups

- Better structural parsing (parva / kanda / chapter / shloka IDs)
- Hybrid BM25 + vector search
- Auth and saved chats
- OCR for scanned pages if extraction quality is poor
