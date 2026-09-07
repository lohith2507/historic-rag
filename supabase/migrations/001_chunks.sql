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

alter table public.chunks enable row level security;

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
