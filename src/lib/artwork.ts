import { embedText } from "./openrouter";
import { getServiceSupabase } from "./supabase";
import type { SourceId } from "./types";

/** Below this cosine similarity the painting is more distracting than illustrative. */
export const ARTWORK_MIN_SIMILARITY = 0.42;

export type ArtworkRow = {
  id: string;
  source: SourceId;
  title: string;
  image_url: string;
  page_url: string;
  artist: string | null;
  license: string;
  date_text: string | null;
  similarity: number;
};

export type ArtworkScene = {
  kind: "artwork";
  imageUrl: string;
  caption: string;
  alt: string;
  attribution: string;
  sourceUrl: string;
  similarity: number;
};

export function buildAttribution(row: Pick<ArtworkRow, "artist" | "date_text" | "license">): string {
  const who = [row.artist, row.date_text].filter(Boolean).join(", ") || "Unknown artist";

  return `${who} · ${row.license}`;
}

function cleanTitle(title: string): string {
  return title.replace(/\.(jpe?g|tiff?|png|webp)$/i, "").replace(/_/g, " ").trim();
}

export function toArtworkScene(row: ArtworkRow): ArtworkScene | null {
  if (row.similarity < ARTWORK_MIN_SIMILARITY) {
    return null;
  }

  // Commons serves over https; anything else is not something we want in an <img src>.
  if (!row.image_url || !row.image_url.startsWith("https://")) {
    return null;
  }

  const caption = cleanTitle(row.title);

  return {
    kind: "artwork",
    imageUrl: row.image_url,
    caption,
    alt: caption,
    attribution: buildAttribution(row),
    sourceUrl: row.page_url,
    similarity: row.similarity,
  };
}

/**
 * Find the public-domain painting that best matches the question.
 * Resolves to null when nothing is close enough, so the caller can fall back to generation.
 */
export async function retrieveArtwork(
  question: string,
  source?: SourceId,
): Promise<ArtworkScene | null> {
  try {
    const queryEmbedding = await embedText(question);
    const { data, error } = await getServiceSupabase().rpc("match_artworks", {
      query_embedding: queryEmbedding,
      match_count: 1,
      filter_source: source ?? null,
    });

    if (error) {
      console.error("Artwork retrieval failed", error.message);
      return null;
    }

    const row = ((data ?? []) as ArtworkRow[])[0];

    return row ? toArtworkScene(row) : null;
  } catch (error) {
    console.error("Artwork retrieval failed", error);
    return null;
  }
}
