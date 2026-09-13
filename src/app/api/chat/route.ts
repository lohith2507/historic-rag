import { NextResponse } from "next/server";

import {
  buildRetrievalQuery,
  detectAnswerMode,
  findAnchorQuestion,
  retrievalLimit,
  type AnswerMode,
} from "@/lib/chat-modes";
import { getChatModel } from "@/lib/openrouter";
import { retrieveArtwork } from "@/lib/artwork";
import { generateIllustration } from "@/lib/illustration";
import { buildContext, retrieveChunks } from "@/lib/rag";
import { generateScene } from "@/lib/scene";
import { MissingSupabaseConfigError } from "@/lib/supabase";
import type { ChunkMatch, SourceId } from "@/lib/types";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const ALLOWED_SOURCES = new Set<SourceId>(["mahabharata", "ramayana", "gita"]);
const ALLOWED_MESSAGE_ROLES = new Set(["user", "assistant"] as const);
const EMPTY_SCENE = { imageUrl: null, svg: null, caption: null, attribution: null, sourceUrl: null };

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

function scopeLine(scope: "all" | SourceId): string {
  return scope === "all"
    ? "Retrieved passages may come from the Mahabharata, Ramayana, and/or Bhagavad Gita. Synthesize across relevant books; note agreement or differences when they matter."
    : `Focus on passages from the ${scope}. If other books appear in Context, use them only if they clearly help.`;
}

function sharedRules(): string[] {
  return [
    "You are an analyst for Indian epic texts (Mahabharata, Ramayana, Bhagavad Gita).",
    "Use ONLY the Context passages. Do not invent plot, quotes, page numbers, or teachings.",
    "If Context is weak or off-topic, say you do not have enough support in the retrieved passages.",
    "Quotes must be short verbatim excerpts from Context, not paraphrases wrapped in quotation marks.",
    "Ignore OCR/encoding noise; reconstruct readable meaning when intent is clear.",
    "Do not repeat an earlier assistant answer. Add new detail demanded by the current request.",
  ];
}

function continueSection(): string[] {
  return [
    "## Continue",
    "End with exactly these three follow-up options:",
    "- More context: background, lineage, vows, curses, weapons, judgments",
    "- Full battle story: chronological duel narrative with who leads at each stage",
    "- More encounters: every clash in Context and who had the upper hand",
  ];
}

function buildDefaultPrompt(question: string, context: string, scope: "all" | SourceId): string {
  return [
    ...sharedRules(),
    scopeLine(scope),
    "",
    `Original question: ${question}`,
    "",
    "Write a detailed, explanatory answer. Assume the reader wants real substance, not a thin summary.",
    "",
    "If this is a comparison (who is stronger/more powerful/better, who wins, Karna vs Arjuna, etc.):",
    "- Open with a clear ## Verdict naming what the text supports.",
    "- Explain why, with concrete encounters, boasts, judgments, weapons, and divine support from Context.",
    "- Include nuance when Context conflicts (e.g. praise of Karna vs Arjuna's final victory).",
    "- Do NOT invent a win count. Say what Context shows and what is missing.",
    "",
    "Answer format:",
    "## Verdict",
    "One direct line answering the question.",
    "",
    "## Summary",
    "4–7 sentences that explain the verdict with names, events, and stakes from Context.",
    "",
    "## Background",
    "A short paragraph of relevant setup from Context (status, vows, weapons, allies, prior rivalry) that helps the reader understand the comparison.",
    "",
    "## Key points / Evidence",
    "5–8 bullets with concrete text-backed details (who had the upper hand, who is praised, outcomes).",
    "",
    "## Analysis",
    "One fuller paragraph connecting the evidence to the question and noting limits of the retrieved passages.",
    "",
    "## Quotes",
    "2–4 brief verbatim quotations from Context, each with source/page when available.",
    "",
    "## Sources",
    "List like: mahabharata p.4205; mahabharata p.3378",
    "",
    ...continueSection(),
    "",
    "Context:",
    context || "No relevant context was found.",
  ].join("\n");
}

function buildMoreContextPrompt(
  question: string,
  request: string,
  context: string,
  scope: "all" | SourceId,
): string {
  return [
    ...sharedRules(),
    scopeLine(scope),
    "",
    `Original question: ${question}`,
    `Current request: ${request}`,
    "",
    "Mode: MORE CONTEXT. Do not restate the previous verdict essay.",
    "Focus on deeper background that helps understand the original question:",
    "lineage/status, vows, curses, boons, weapons, charioteers, alliances, Krishna's counsel, reputation, and surrounding episodes from Context.",
    "It is fine to mention the overall outcome briefly, but most of the answer must be new background detail.",
    "",
    "Answer format:",
    "## Focus",
    "One line naming what background you are expanding for the original question.",
    "",
    "## Background narrative",
    "2–4 short paragraphs of explanatory background drawn only from Context.",
    "",
    "## Related judgments & omens",
    "Bullets of praises, warnings, vows, or divine assessments relevant to the rivals/topic.",
    "",
    "## What this adds",
    "A short paragraph explaining how this background changes or deepens understanding of the original question.",
    "",
    "## Quotes",
    "2–4 brief verbatim quotations from Context with source/page when available.",
    "",
    "## Sources",
    "List like: mahabharata p.4205; mahabharata p.3378",
    "",
    ...continueSection(),
    "",
    "Context:",
    context || "No relevant context was found.",
  ].join("\n");
}

function buildBattleStoryPrompt(
  question: string,
  request: string,
  context: string,
  scope: "all" | SourceId,
): string {
  return [
    ...sharedRules(),
    scopeLine(scope),
    "",
    `Original question: ${question}`,
    `Current request: ${request}`,
    "",
    "Mode: FULL BATTLE STORY. Do not reuse the comparison-essay structure.",
    "Tell a chronological story of the main duel(s) or battle sequence in Context that relate to the original question.",
    "Use staged narrative: opening, exchanges, shifts of advantage, climax, ending.",
    "At every major stage, state who had the upper hand according to Context.",
    "If Context only covers fragments, narrate those fragments in order and say what is missing.",
    "Do not invent intermediate stages that are not in Context.",
    "",
    "Answer format:",
    "## Battle focus",
    "Name the duel(s)/battle day(s) you can support from Context.",
    "",
    "## Step-by-step story",
    "Numbered stages (Stage 1, Stage 2, ...). Each stage: what happens, who leads, and a source/page citation when available.",
    "Write enough detail that a reader can follow the fight without reading the previous answer.",
    "",
    "## Turning points",
    "Bullets for moments where momentum shifts (weapons, chariot issues, counsel, wounds) if present in Context.",
    "",
    "## Ending",
    "How the fight ends in Context, and what that implies for the original question.",
    "",
    "## Quotes",
    "2–4 brief verbatim quotations from Context with source/page when available.",
    "",
    "## Sources",
    "List like: mahabharata p.4205; mahabharata p.3378",
    "",
    ...continueSection(),
    "",
    "Context:",
    context || "No relevant context was found.",
  ].join("\n");
}

function buildEncountersPrompt(
  question: string,
  request: string,
  context: string,
  scope: "all" | SourceId,
): string {
  return [
    ...sharedRules(),
    scopeLine(scope),
    "",
    `Original question: ${question}`,
    `Current request: ${request}`,
    "",
    "Mode: MORE ENCOUNTERS. Do not rewrite the previous essay.",
    "Inventory every distinct encounter, duel, clash, or direct comparison in Context that relates to the original question.",
    "For each item: where/when if known, what happens, who had the advantage, and citation.",
    "If two passages describe the same clash, merge them into one entry.",
    "If Context does not contain multiple encounters, say so and list only what is there.",
    "",
    "Answer format:",
    "## Encounter inventory",
    "A short line stating how many distinct encounters/comparisons Context supports.",
    "",
    "## Encounters",
    "Numbered list. Each entry must include:",
    "- Setting / reference (source/page if available)",
    "- What happens",
    "- Who had the upper hand (or \"unclear in Context\")",
    "",
    "## Scoreboard from Context only",
    "Brief tally of advantages implied by the listed encounters, without inventing missing fights.",
    "",
    "## Quotes",
    "1–3 brief verbatim quotations from Context with source/page when available.",
    "",
    "## Sources",
    "List like: mahabharata p.4205; mahabharata p.3378",
    "",
    ...continueSection(),
    "",
    "Context:",
    context || "No relevant context was found.",
  ].join("\n");
}

function buildSystemPrompt(
  mode: AnswerMode,
  question: string,
  request: string,
  context: string,
  scope: "all" | SourceId,
): string {
  switch (mode) {
    case "more-context":
      return buildMoreContextPrompt(question, request, context, scope);
    case "battle-story":
      return buildBattleStoryPrompt(question, request, context, scope);
    case "encounters":
      return buildEncountersPrompt(question, request, context, scope);
    default:
      return buildDefaultPrompt(question, context, scope);
  }
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
    const mode = detectAnswerMode(query);
    const anchorQuestion = findAnchorQuestion(messages) || query;
    const retrievalQuery = buildRetrievalQuery(mode, query, anchorQuestion);
    const chunks = await retrieveChunks(retrievalQuery, {
      source: filterSource,
      limit: retrievalLimit(mode, Boolean(filterSource)),
      minSimilarity: 0.2,
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
        temperature: mode === "default" ? 0.3 : 0.35,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(mode, anchorQuestion, query, context, filterSource ?? "all"),
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
        }

        // The scene is added after the answer so it never delays the text or the citations.
        // Preference order: a real public-domain painting that matches the question, then a
        // generated illustration, then the animated SVG. Each resolves to null on failure, so
        // the answer simply renders without a scene if every source is unavailable.
        try {
          controller.enqueue(encoder.encode(encodeSse("scene-pending", { pending: true })));

          const scene =
            (await retrieveArtwork(anchorQuestion, filterSource)) ??
            (await generateIllustration(anchorQuestion, context)) ??
            (await generateScene(anchorQuestion, context));

          controller.enqueue(encoder.encode(encodeSse("scene", scene ?? EMPTY_SCENE)));
        } catch (error) {
          console.error("Scene stage failed", error);
          controller.enqueue(encoder.encode(encodeSse("scene", EMPTY_SCENE)));
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
