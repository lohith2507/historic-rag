import assert from "node:assert/strict";
import test from "node:test";

import { embedText } from "./openrouter";
import { buildContext } from "./rag";
import type { ChunkMatch } from "./types";

test("buildContext formats chunks as cited context blocks", () => {
  const chunks: ChunkMatch[] = [
    {
      id: "chunk-1",
      source: "mahabharata",
      content: "Dharma is discussed in the epic.",
      page: 42,
      heading: "Dharma",
      similarity: 0.91,
    },
    {
      id: "chunk-2",
      source: "gita",
      content: "Krishna teaches Arjuna.",
      page: null,
      heading: null,
      similarity: 0.88,
    },
  ];

  assert.equal(
    buildContext(chunks),
    [
      "Passage 1 [mahabharata p.42 relevance=0.910]",
      "Dharma is discussed in the epic.",
      "",
      "Passage 2 [gita relevance=0.880]",
      "Krishna teaches Arjuna.",
    ].join("\n"),
  );
});

test("embedText rejects embeddings that are not 1536 dimensions", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;

  process.env.OPENROUTER_API_KEY = "test-key";
  globalThis.fetch = async () =>
    ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    }) as Response;

  try {
    await assert.rejects(() => embedText("dharma"), /1536 dimensions/);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  }
});
