import { NextResponse } from "next/server";

import { getChatModel } from "@/lib/openrouter";
import { buildContext, retrieveChunks } from "@/lib/rag";
import { MissingSupabaseConfigError } from "@/lib/supabase";
import type { ChunkMatch, SourceId } from "@/lib/types";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const ALLOWED_SOURCES = new Set<SourceId>(["mahabharata", "ramayana", "gita"]);
const ALLOWED_MESSAGE_ROLES = new Set(["user", "assistant"] as const);

type ChatRole = "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type ChatBody = {
  messages?: unknown;
  source?: unknown;
};

type OpenRouterChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
};

type Source = {
  id: string;
  source: SourceId;
  page: number | null;
  heading: string | null;
  similarity: number;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function validateMessages(messages: unknown): ChatMessage[] | string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "messages must be a non-empty array";
  }

  const validMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      return "messages must contain objects with role and content";
    }

    const { role, content } = message as { role?: unknown; content?: unknown };

    if (typeof role !== "string" || !ALLOWED_MESSAGE_ROLES.has(role as ChatRole)) {
      return "message role must be user or assistant";
    }

    if (typeof content !== "string" || content.trim() === "") {
      return "message content must be a non-empty string";
    }

    validMessages.push({ role: role as ChatRole, content });
  }

  return validMessages;
}

function findLastUserMessage(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "user") {
      return message.content.trim();
    }
  }

  return null;
}

function buildSystemPrompt(question: string, context: string, scope: "all" | SourceId): string {
  const scopeLine =
    scope === "all"
      ? "Retrieved passages may come from the Mahabharata, Ramayana, and/or Bhagavad Gita. Synthesize one coherent answer across all relevant books; note agreement or differences when they matter."
      : `Focus on passages from the ${scope}. If other books appear in Context, use them only if they clearly help.`;

  return [
    "You are an analyst for Indian epic texts (Mahabharata, Ramayana, Bhagavad Gita).",
    "Workflow: (1) read the Question, (2) gather related facts only from Context, (3) analyze, (4) answer in the format below.",
    "Use ONLY the Context passages (retrieved via embeddings). Do not invent plot, quotes, or teachings.",
    "If Context is weak or off-topic, say you do not have enough support in the retrieved passages.",
    scopeLine,
    "",
    `Question: ${question}`,
    "",
    "If the Question is a comparison (who is stronger/more powerful/better, who wins, Karna vs Arjuna, etc.):",
    "- Start with a one-line ## Verdict that names a clear answer when the text supports one (e.g. \"Arjuna is presented as the one who can defeat Karna\" or \"The text treats them as near-equals, with Arjuna winning the final duel\").",
    "- In ## Evidence, list concrete encounters, boasts, or judgments from Context (who had the upper hand, who Krishna praises, who wins).",
    "- Do NOT invent a win count. If the Context does not list every battle, say what it does show and what is missing.",
    "- Include nuance when Context conflicts (e.g. Krishna calling Karna equal/superior vs Arjuna's victory).",
    "- Keep the medium structure below, but put Verdict first.",
    "",
    "Answer format (always follow this structure):",
    "## Verdict",
    "One clear line that answers the Question directly (especially for comparisons).",
    "",
    "## Summary",
    "2–4 sentences that explain that verdict using Context.",
    "",
    "## Key points / Evidence",
    "3–6 short bullets with concrete text-backed details (battles, judgments, outcomes).",
    "",
    "## Analysis",
    "One short paragraph connecting the evidence to the Question.",
    "",
    "## Quotes",
    "1–3 brief quotations from Context (in quotation marks), each with source/page when available.",
    "Balance summary and quotes.",
    "",
    "## Sources",
    "List like: mahabharata p.4205; mahabharata p.3378",
    "",
    "## Continue",
    "End with exactly these three follow-up options as a short list:",
    "- More context: ask for deeper background from the same theme",
    "- Full battle story: ask for a step-by-step story of the main duel(s) in Context",
    "- More encounters: ask for every clash mentioned in Context and who had the upper hand",
    "",
    "Frame every section around the Question. Prefer concrete names, events, and teachings from Context.",
    "Ignore OCR/encoding noise; reconstruct readable meaning when intent is clear.",
    "",
    "Context:",
    context || "No relevant context was found.",
  ].join("\n");
}

function buildSources(chunks: ChunkMatch[]): Source[] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    source: chunk.source,
    page: chunk.page,
    heading: chunk.heading,
    similarity: chunk.similarity,
  }));
}

async function streamOpenRouter(response: Response, controller: ReadableStreamDefaultController<Uint8Array>) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("OpenRouter chat response did not include a stream");
  }

  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const dataLines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      for (const data of dataLines) {
        if (data === "[DONE]") {
          continue;
        }

        const parsed = JSON.parse(data) as OpenRouterChunk;

        if (parsed.error?.message) {
          console.error("OpenRouter chat stream error", parsed.error.message);
          controller.enqueue(encoder.encode(encodeSse("error", { error: "Chat stream failed" })));
          continue;
        }

        const content = parsed.choices?.[0]?.delta?.content;

        if (typeof content === "string" && content.length > 0) {
          controller.enqueue(encoder.encode(encodeSse("token", { content })));
        }
      }
    }
  }
}

export async function POST(request: Request) {
  let body: ChatBody;

  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const messages = validateMessages(body.messages);

  if (typeof messages === "string") {
    return badRequest(messages);
  }

  if (body.source !== undefined) {
    if (typeof body.source !== "string" || !ALLOWED_SOURCES.has(body.source as SourceId)) {
      return badRequest("source must be one of: mahabharata, ramayana, gita");
    }
  }

  const query = findLastUserMessage(messages);

  if (!query) {
    return badRequest("messages must include at least one user message");
  }

  try {
    const filterSource = typeof body.source === "string" ? (body.source as SourceId) : undefined;
    // All-books mode: pull more embedding matches so the model can synthesize across epics.
    const chunks = await retrieveChunks(query, {
      source: filterSource,
      limit: filterSource ? 12 : 18,
      minSimilarity: 0.22,
    });
    const context = buildContext(chunks);
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      throw new Error("Missing OPENROUTER_API_KEY");
    }

    const openRouterResponse = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getChatModel(),
        stream: true,
        temperature: 0.25,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(query, context, filterSource ?? "all"),
          },
          ...messages,
        ],
      }),
    });

    if (!openRouterResponse.ok) {
      const errorBody = (await openRouterResponse.json().catch(() => ({}))) as OpenRouterChunk;
      throw new Error(errorBody.error?.message || `OpenRouter chat request failed with ${openRouterResponse.status}`);
    }

    const sources = buildSources(chunks);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          await streamOpenRouter(openRouterResponse, controller);
          controller.enqueue(encoder.encode(encodeSse("sources", sources)));
        } catch (error) {
          console.error("Chat stream failed", error);
          controller.enqueue(encoder.encode(encodeSse("error", { error: "Chat stream failed" })));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("Chat failed", error);
    if (error instanceof MissingSupabaseConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "Chat failed" }, { status: 500 });
  }
}
