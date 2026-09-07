export type SourceId = "mahabharata" | "ramayana" | "gita";

export type ChunkMatch = {
  id: string;
  source: SourceId;
  content: string;
  page: number | null;
  heading: string | null;
  similarity: number;
};
