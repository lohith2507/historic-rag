const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_CHAT_MODEL = "openai/gpt-4o-mini";
const EMBEDDING_DIMENSIONS = 1536;

type EmbeddingResponse = {
  data?: Array<{
    embedding?: unknown;
  }>;
  error?: {
    message?: string;
  };
};

export function getChatModel(): string {
  return process.env.OPENROUTER_CHAT_MODEL || DEFAULT_CHAT_MODEL;
}

/** Scene drawing benefits from a stronger model, so it can be pointed elsewhere than the chat model. */
export function getSceneModel(): string {
  return process.env.OPENROUTER_SCENE_MODEL || getChatModel();
}

export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const response = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      input: text,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as EmbeddingResponse;

  if (!response.ok) {
    throw new Error(body.error?.message || `OpenRouter embeddings request failed with ${response.status}`);
  }

  const embedding = body.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
    throw new Error("OpenRouter embeddings response did not include a numeric embedding");
  }

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`OpenRouter embedding must be ${EMBEDDING_DIMENSIONS} dimensions; received ${embedding.length}`);
  }

  return embedding;
}
