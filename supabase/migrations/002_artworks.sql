create extension if not exists vector;

-- Public-domain epic paintings harvested from Wikimedia Commons by scripts/ingest_artworks.py.
-- Retrieved the same way passages are, so each answer can show art that matches its context.
create table if not exists public.artworks (
  id uuid primary key default gen_random_uuid(),
  commons_id text not null unique,
  source text not null check (source in ('mahabharata', 'ramayana', 'gita')),
  title text not null,
  description text not null,
  image_url text not null,
  page_url text not null,
  artist text,
  credit text,
  license text not null,
  date_text text,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

alter table public.artworks enable row level security;

create index if not exists artworks_embedding_hnsw
  on public.artworks
  using hnsw (embedding vector_cosine_ops);

create index if not exists artworks_source_idx on public.artworks (source);

create or replace function public.match_artworks(
  query_embedding vector(1536),
  match_count int default 1,
  filter_source text default null
)
returns table (
  id uuid,
  source text,
  title text,
  image_url text,
  page_url text,
  artist text,
  license text,
  date_text text,
  similarity float
)
language sql
stable
as $$
  select
    a.id,
    a.source,
    a.title,
    a.image_url,
    a.page_url,
    a.artist,
    a.license,
    a.date_text,
    1 - (a.embedding <=> query_embedding) as similarity
  from public.artworks a
  where (filter_source is null or a.source = filter_source)
  order by a.embedding <=> query_embedding
  limit match_count;
$$;
