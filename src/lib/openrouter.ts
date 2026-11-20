const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_CHAT_MODEL = "openai/gpt-4o-mini";
// Must match the `vector(1536)` column width in the chunks migration; embedText rejects anything else.
const EMBEDDING_DIMENSIONS = 1536;

type EmbeddingResponse = {
  data?: Array<{
    embedding?: unknown;
  }>;
  error?: {
    message?: string;
  };
};

const GROQ_BASE = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_CHAT_MODEL = "openai/gpt-oss-120b";

export type CompletionProvider = {
  name: "Groq" | "OpenRouter";
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra request fields; spread into the completion body. */
  options: Record<string, unknown>;
};

/** gpt-oss reasoning tokens count against max_tokens, so short budgets need low effort to leave room for the answer. */
function groqOptions(model: string): Record<string, unknown> {
  return model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {};
}

/** OpenRouter model id for chat answers; set `OPENROUTER_CHAT_MODEL` to override the default. */
export function getChatModel(): string {
  return process.env.OPENROUTER_CHAT_MODEL || DEFAULT_CHAT_MODEL;
}

/** Scene drawing benefits from a stronger model, so it can be pointed elsewhere than the chat model. */
export function getSceneModel(): string {
  return process.env.OPENROUTER_SCENE_MODEL || getChatModel();
}

/**
 * Chat completions go to Groq when GROQ_API_KEY is set, otherwise OpenRouter.
 * Embeddings always stay on OpenRouter: Groq has no embeddings endpoint and the stored vectors are 1536-d.
 */
function getCompletionProvider(purpose: "chat" | "scene"): CompletionProvider | null {
  const groqKey = process.env.GROQ_API_KEY;

  if (groqKey) {
    const chatModel = process.env.GROQ_CHAT_MODEL || DEFAULT_GROQ_CHAT_MODEL;
    const model = purpose === "scene" ? process.env.GROQ_SCENE_MODEL || chatModel : chatModel;
    return {
      name: "Groq",
      baseUrl: GROQ_BASE,
      apiKey: groqKey,
      model,
      options: groqOptions(model),
    };
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;

  if (!openRouterKey) {
    return null;
  }

  return {
    name: "OpenRouter",
    baseUrl: OPENROUTER_BASE,
    apiKey: openRouterKey,
    model: purpose === "scene" ? getSceneModel() : getChatModel(),
    options: {},
  };
}

export function getChatProvider(): CompletionProvider | null {
  return getCompletionProvider("chat");
}

export function getSceneProvider(): CompletionProvider | null {
  return getCompletionProvider("scene");
}

/**
 * Embeds `text` via OpenRouter. The result must be exactly 1536 numbers to match the
 * `vector(1536)` columns in `supabase/migrations/001_chunks.sql`, so any
 * `OPENROUTER_EMBEDDING_MODEL` override has to produce the same dimensions.
 */
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
