import { embedText } from "./openrouter";
import { getServiceSupabase } from "./supabase";
import type { ChunkMatch, SourceId } from "./types";

type RetrieveOptions = {
  source?: string;
  limit?: number;
  minSimilarity?: number;
};

type MatchChunkRow = {
  id: string;
  source: string;
  content: string;
  page: number | null;
  heading: string | null;
  similarity: number;
};

const sourceIds = new Set<string>(["mahabharata", "ramayana", "gita"]);

function toSourceId(source: string): SourceId {
  if (!sourceIds.has(source)) {
    throw new Error(`Invalid source: ${source}`);
  }

  return source as SourceId;
}

export async function retrieveChunks(query: string, opts: RetrieveOptions = {}): Promise<ChunkMatch[]> {
  const queryEmbedding = await embedText(query);
  const matchCount = opts.limit ?? 8;
  const filterSource = opts.source ? toSourceId(opts.source) : null;
  const minSimilarity = opts.minSimilarity ?? 0;

  // When searching all books, pull matches per source then merge so one epic cannot crowd out the others.
  if (!filterSource) {
    const perSource = Math.max(4, Math.ceil(matchCount / 3));
    const batches = await Promise.all(
      (["gita", "ramayana", "mahabharata"] as const).map(async (source) => {
        const { data, error } = await getServiceSupabase().rpc("match_chunks", {
          query_embedding: queryEmbedding,
          match_count: perSource,
          filter_source: source,
        });

        if (error) {
          throw new Error(`Failed to retrieve chunks: ${error.message}`);
        }

        return ((data ?? []) as MatchChunkRow[])
          .filter((chunk) => chunk.similarity >= minSimilarity)
          .map((chunk) => ({
            id: chunk.id,
            source: toSourceId(chunk.source),
            content: chunk.content,
            page: chunk.page,
            heading: chunk.heading,
            similarity: chunk.similarity,
          }));
      }),
    );

    return batches
      .flat()
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, matchCount);
  }

  const { data, error } = await getServiceSupabase().rpc("match_chunks", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    filter_source: filterSource,
  });

  if (error) {
    throw new Error(`Failed to retrieve chunks: ${error.message}`);
  }

  return ((data ?? []) as MatchChunkRow[])
    .filter((chunk) => chunk.similarity >= minSimilarity)
    .map((chunk) => ({
      id: chunk.id,
      source: toSourceId(chunk.source),
      content: chunk.content,
      page: chunk.page,
      heading: chunk.heading,
      similarity: chunk.similarity,
    }));
}

export function buildContext(chunks: ChunkMatch[]): string {
  if (chunks.length === 0) {
    return "No relevant passages were retrieved.";
  }

  return chunks
    .map((chunk, index) => {
      const page = chunk.page === null ? "" : ` p.${chunk.page}`;
      const score = Number.isFinite(chunk.similarity) ? ` relevance=${chunk.similarity.toFixed(3)}` : "";

      return `Passage ${index + 1} [${chunk.source}${page}${score}]\n${chunk.content}`;
    })
    .join("\n\n");
}
