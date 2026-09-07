# Historic India RAG Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Vercel Next.js app with semantic search + chat Q&A over Mahabharata, Ramayana, and Bhagavad Gita, using offline ingest into Supabase pgvector and OpenRouter for embeddings/LLM.

**Architecture:** Offline Python ingest extracts/chunks/embeds PDFs into Supabase. Next.js API routes embed queries, run `match_chunks`, and stream OpenRouter chat. UI exposes Search and Chat modes.

**Tech Stack:** Next.js App Router, TypeScript, Supabase (pgvector), OpenRouter, Python 3.11+ (PyMuPDF, httpx, supabase-py)

**Spec:** `docs/superpowers/specs/2026-09-03-rag-pipeline-design.md`

## Global Constraints

- Never commit secrets; only `.env.example` with empty placeholders
- Embeddings: `openai/text-embedding-3-small` → `vector(1536)` unless env overrides
- Sources: `mahabharata` | `ramayana` | `gita` only
- Citations optional / best-effort; do not block on verse IDs
- Ingest runs locally only; Vercel handles query-time only
- Free Supabase target: keep chunks moderate (~500–800 tokens, ~100–150 overlap)

## File Structure

| Path | Responsibility |
|------|----------------|
| `supabase/migrations/001_chunks.sql` | extension, table, index, `match_chunks` RPC |
| `scripts/ingest.py` | PDF → chunks → embeddings → Supabase upsert |
| `scripts/requirements.txt` | Python ingest deps |
| `src/lib/openrouter.ts` | embed + chat helpers for Next.js |
| `src/lib/supabase.ts` | server Supabase client |
| `src/lib/rag.ts` | retrieve chunks shared by search/chat |
| `src/app/api/search/route.ts` | search API |
| `src/app/api/chat/route.ts` | chat API (streaming) |
| `src/app/page.tsx` | Search + Chat UI |
| `src/app/layout.tsx` | root layout |
| `.env.example` | env var names |
| `README.md` | setup, ingest, deploy |

---

### Task 1: Scaffold Next.js app and repo hygiene

**Files:**
- Create: Next.js app at repo root (or `web/` if create-next-app conflicts with PDFs — prefer root with PDFs left in place)
- Create: `.env.example`, `.gitignore`, `README.md` (minimal stub)
- Create: git repo if missing

**Interfaces:**
- Produces: runnable `npm run dev`; TypeScript App Router layout

- [ ] **Step 1: Initialize git if needed**

```powershell
cd C:\Users\lohit\personal\historic-india
if (-not (Test-Path .git)) { git init }
```

- [ ] **Step 2: Scaffold Next.js (TypeScript, App Router, ESLint, no src-dir conflict)**

Prefer `src/` directory. Keep existing PDFs at repo root.

```powershell
npx create-next-app@latest . --typescript --eslint --app --src-dir --tailwind --import-alias "@/*" --turbopack --yes
```

If create-next-app refuses non-empty dir, scaffold into temp and move `package.json`, `src`, `next.config.*`, `tsconfig.json`, etc. into root without deleting PDFs.

- [ ] **Step 3: Write `.gitignore` entries**

Ensure: `.env`, `.env.local`, `node_modules`, `.next`, `__pycache__`, `.venv`, `*.pyc`

- [ ] **Step 4: Write `.env.example`**

```
OPENROUTER_API_KEY=
OPENROUTER_CHAT_MODEL=openai/gpt-4o-mini
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 5: Verify build**

```powershell
npm run build
```

Expected: success (default Next page OK).

- [ ] **Step 6: Commit**

```powershell
git add .gitignore .env.example package.json package-lock.json src next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs README.md
git commit -m "chore: scaffold Next.js app for historic India RAG"
```

---

### Task 2: Supabase schema migration

**Files:**
- Create: `supabase/migrations/001_chunks.sql`

**Interfaces:**
- Produces: table `chunks`, RPC `match_chunks(query_embedding vector(1536), match_count int, filter_source text)`

- [ ] **Step 1: Write migration SQL**

```sql
create extension if not exists vector;

create table if not exists public.chunks (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('mahabharata', 'ramayana', 'gita')),
  content text not null,
  embedding vector(1536) not null,
  page int,
  heading text,
  created_at timestamptz not null default now()
);

create index if not exists chunks_embedding_hnsw
  on public.chunks
  using hnsw (embedding vector_cosine_ops);

create index if not exists chunks_source_idx on public.chunks (source);

create or replace function public.match_chunks(
  query_embedding vector(1536),
  match_count int default 8,
  filter_source text default null
)
returns table (
  id uuid,
  source text,
  content text,
  page int,
  heading text,
  similarity float
)
language sql
stable
as $$
  select
    c.id,
    c.source,
    c.content,
    c.page,
    c.heading,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.chunks c
  where (filter_source is null or c.source = filter_source)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
```

- [ ] **Step 2: Document in README how to run it**

In Supabase SQL Editor: paste and run `001_chunks.sql`. Enable no extra dashboard toggles beyond this script.

- [ ] **Step 3: Commit**

```powershell
git add supabase/migrations/001_chunks.sql README.md
git commit -m "feat: add Supabase pgvector chunks schema and match_chunks RPC"
```

---

### Task 3: Shared server libraries (OpenRouter + Supabase + retrieve)

**Files:**
- Create: `src/lib/openrouter.ts`
- Create: `src/lib/supabase.ts`
- Create: `src/lib/rag.ts`
- Create: `src/lib/types.ts`
- Test: `src/lib/rag.test.ts` (or Vitest) — prefer pure unit test for prompt/context builder if Vitest not present; otherwise a small Node assert script. For speed, add Vitest only if already easy; else test `buildContext` with a tiny exported pure function via `node --import tsx` or keep logic simple and test via API later.

**Interfaces:**
- Produces:
  - `embedText(text: string): Promise<number[]>`
  - `getServiceSupabase(): SupabaseClient`
  - `retrieveChunks(query: string, opts?: { source?: string; limit?: number }): Promise<ChunkMatch[]>`
  - `buildContext(chunks: ChunkMatch[]): string`
- Consumes: env vars from Global Constraints

- [ ] **Step 1: Add deps**

```powershell
npm install @supabase/supabase-js
```

- [ ] **Step 2: Implement `src/lib/types.ts`**

```ts
export type SourceId = "mahabharata" | "ramayana" | "gita";

export type ChunkMatch = {
  id: string;
  source: SourceId;
  content: string;
  page: number | null;
  heading: string | null;
  similarity: number;
};
```

- [ ] **Step 3: Implement `src/lib/supabase.ts`**

```ts
import { createClient } from "@supabase/supabase-js";

export function getServiceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}
```

- [ ] **Step 4: Implement `src/lib/openrouter.ts`**

- `OPENROUTER_BASE = "https://openrouter.ai/api/v1"`
- `embedText`: POST `/embeddings` with model from env
- Export chat model name helper `getChatModel()`

- [ ] **Step 5: Implement `src/lib/rag.ts`**

- `retrieveChunks`: embed query → `supabase.rpc("match_chunks", { query_embedding, match_count, filter_source })`
- `buildContext`: join chunks as `[source p.page] content` blocks

- [ ] **Step 6: Commit**

```powershell
git add src/lib package.json package-lock.json
git commit -m "feat: add OpenRouter, Supabase, and retrieve helpers"
```

---

### Task 4: Search API

**Files:**
- Create: `src/app/api/search/route.ts`

**Interfaces:**
- Consumes: `retrieveChunks`
- Produces: `POST` JSON `{ results: ChunkMatch[] }`

- [ ] **Step 1: Implement route**

Validate body: `query` non-empty string; optional `source` in allowlist; `limit` 1–20 default 8. Return 400 on bad input. Return `{ results }` on success.

- [ ] **Step 2: Manual smoke (optional if env not ready)**

Skip live call if env missing; ensure TypeScript compiles:

```powershell
npm run build
```

- [ ] **Step 3: Commit**

```powershell
git add src/app/api/search/route.ts
git commit -m "feat: add /api/search vector retrieval endpoint"
```

---

### Task 5: Chat API (streaming)

**Files:**
- Create: `src/app/api/chat/route.ts`

**Interfaces:**
- Consumes: `retrieveChunks`, `buildContext`, OpenRouter chat completions stream
- Produces: SSE or `ReadableStream` text response; include sources via custom header `X-Sources` (base64 JSON) or prepend a JSON line — prefer returning `text/event-stream` with final event `sources`

- [ ] **Step 1: Implement system prompt**

Exact intent: Answer using only the provided context from Indian epic texts. If context is insufficient, say you don't know. Be concise. Optionally mention book source when natural.

- [ ] **Step 2: Implement `POST` handler**

- Parse `{ messages: {role, content}[], source?: string }`
- Take last user message as retrieval query
- Retrieve top 6 chunks
- Call OpenRouter `chat/completions` with `stream: true`
- Stream tokens to client; after stream, send sources list

- [ ] **Step 3: Build check**

```powershell
npm run build
```

- [ ] **Step 4: Commit**

```powershell
git add src/app/api/chat/route.ts
git commit -m "feat: add streaming /api/chat RAG endpoint"
```

---

### Task 6: Search + Chat UI

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css` (minimal, match existing Tailwind)

**Interfaces:**
- Consumes: `/api/search`, `/api/chat`
- Produces: working dual-mode UI

- [ ] **Step 1: Layout metadata**

Title: `Historic India` — description mentioning epic search & Q&A.

- [ ] **Step 2: Build page with two modes**

- Toggle: Search | Chat
- Optional source filter select: All / Gita / Ramayana / Mahabharata
- Search: form → list passages with source + page + similarity
- Chat: message list; on send, stream assistant text; show collapsible Sources under last answer

Keep UI simple and readable; no purple-gradient AI cliché; use a warm manuscript-inspired palette without cream+terracotta+serif cliché from the design rule biases — e.g. deep ink blue text on soft stone background with a single ochre accent, or follow a clean editorial look with distinctive fonts via `next/font` (e.g. `Source_Serif_4` + `IBM_Plex_Sans`).

- [ ] **Step 3: Verify `npm run build`**

- [ ] **Step 4: Commit**

```powershell
git add src/app
git commit -m "feat: add search and chat UI for epic RAG"
```

---

### Task 7: Python ingest script

**Files:**
- Create: `scripts/requirements.txt`
- Create: `scripts/ingest.py`
- Create: `scripts/README.md` (how to run)

**Interfaces:**
- Consumes: PDFs at repo root; env `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Produces: rows in `chunks` for selected sources

- [ ] **Step 1: requirements.txt**

```
pymupdf
httpx
supabase
python-dotenv
tiktoken
```

- [ ] **Step 2: Implement ingest.py**

- Map:
  - `gita` → `The Bhagavad Gita.pdf`
  - `ramayana` → `valmiki_ramayanam.pdf`
  - `mahabharata` → `Menon_Ramesh-The-Complete-Mahabharata_-Volume-1-12.pdf`
- argparse `--source` with choices `gita|ramayana|mahabharata|all`
- For each source: delete existing rows for that source, extract pages, chunk with tiktoken (`cl100k_base`) target 600 tokens, overlap 120
- Batch embed (e.g. 32 texts) via OpenRouter embeddings API
- Insert rows into `chunks`

- [ ] **Step 3: Dry-run path**

Support `--dry-run` that prints chunk counts per source without calling APIs.

```powershell
python scripts/ingest.py --source gita --dry-run
```

Expected: prints page/chunk counts > 0.

- [ ] **Step 4: Commit**

```powershell
git add scripts
git commit -m "feat: add offline PDF ingest script for Supabase embeddings"
```

---

### Task 8: README finish + acceptance checklist

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document end-to-end setup**

1. Create Supabase project; run `supabase/migrations/001_chunks.sql`
2. Rotate OpenRouter key; set `.env.local` from `.env.example`
3. `npm install` && `npm run dev`
4. `pip install -r scripts/requirements.txt` && `python scripts/ingest.py --source all`
5. Deploy to Vercel; set same env vars; PDFs not required on Vercel after ingest

- [ ] **Step 2: Acceptance checklist in README**

- [ ] Search returns passages for a Gita-related query after ingest
- [ ] Chat streams an answer grounded in context
- [ ] No secrets in git
- [ ] `npm run build` passes

- [ ] **Step 3: Commit**

```powershell
git add README.md
git commit -m "docs: add setup, ingest, and deploy instructions"
```

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| Offline ingest | 7 |
| Supabase pgvector + match RPC | 2 |
| OpenRouter embeddings + chat | 3, 5, 7 |
| `/api/search` + `/api/chat` | 4, 5 |
| Search + Chat UI | 6 |
| All three sources | 7 mapping + UI filter |
| Env/secrets hygiene | 1, 8 |
| Vercel deploy notes | 8 |
| Citations optional | 5 prompt + 6 sources collapsible |

## Self-review notes

- No TBD placeholders
- Embedding dimension locked at 1536 across SQL, ingest, and app
- `SourceId` union consistent across TS and SQL check constraint
- Git may be initialized in Task 1; if user forbids commits, skip commit steps but keep code steps
