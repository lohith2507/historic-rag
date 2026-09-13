import { createHmac, timingSafeEqual } from "node:crypto";

import { getSceneModel } from "./openrouter";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";
const IMAGE_WIDTH = 1024;
const IMAGE_HEIGHT = 576;
const MAX_PROMPT_LENGTH = 320;
const MAX_CAPTION_LENGTH = 120;
const MAX_CONTEXT_LENGTH = 2_600;

/** Locks every illustration to one aesthetic so the panel reads as a consistent plate. */
const STYLE_SUFFIX =
  "monochrome ink wash painting, grayscale, textured handmade paper, classical Indian epic art, " +
  "dramatic chiaroscuro, fine brushwork, no text, no lettering, no watermark, no signature";

export type Illustration = {
  imageUrl: string;
  caption: string;
  alt: string;
};

type Completion = {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: string };
};

export function buildDistillPrompt(question: string, context: string): string {
  return [
    "You turn passages from the Indian epics into a prompt for an image generator.",
    "Describe only a scene the passages actually support. Never invent events they do not contain.",
    "",
    `Question: ${question}`,
    "",
    "Reply with exactly two lines and nothing else:",
    "PROMPT: <one vivid visual sentence, under 40 words, describing the single most striking moment in the passages. Name concrete subjects, action, and setting. No style words, no artist names, no text-in-image instructions.>",
    "CAPTION: <under 10 words naming that moment for a reader>",
    "",
    "Passages:",
    context.slice(0, MAX_CONTEXT_LENGTH) || "No relevant passages were retrieved.",
  ].join("\n");
}

function readLabelledLine(raw: string, label: string): string | null {
  const match = raw.match(new RegExp(`^[\\s>*_#-]*\\*{0,2}${label}\\*{0,2}\\s*:\\s*(.+)$`, "im"));

  if (!match) {
    return null;
  }

  // Strip markdown emphasis the model may wrap the value in.
  const value = match[1].replace(/\*\*/g, "").replace(/^["'`]|["'`]$/g, "").trim();

  return value === "" ? null : value;
}

export function parseDistillResponse(raw: string): { prompt: string; caption: string } | null {
  if (typeof raw !== "string") {
    return null;
  }

  const prompt = readLabelledLine(raw, "PROMPT");

  if (!prompt) {
    return null;
  }

  const caption = readLabelledLine(raw, "CAPTION");

  return {
    prompt: prompt.slice(0, MAX_PROMPT_LENGTH),
    caption: (caption ?? "Scene from the retrieved passages").slice(0, MAX_CAPTION_LENGTH),
  };
}

/** Deterministic seed so the same answer always renders the same illustration. */
export function deriveSeed(prompt: string): number {
  const digest = createHmac("sha256", "seed").update(prompt).digest();

  return digest.readUInt32BE(0);
}

export function buildPollinationsUrl(prompt: string, seed: number): string {
  const url = new URL(`${POLLINATIONS_BASE}/${encodeURIComponent(`${prompt}. ${STYLE_SUFFIX}`)}`);

  url.searchParams.set("width", String(IMAGE_WIDTH));
  url.searchParams.set("height", String(IMAGE_HEIGHT));
  url.searchParams.set("seed", String(seed));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("private", "true");
  url.searchParams.set("safe", "true");

  const token = process.env.POLLINATIONS_TOKEN;

  if (token) {
    url.searchParams.set("token", token);
  }

  return url.toString();
}

export function signIllustration(prompt: string, seed: number, secret: string): string {
  return createHmac("sha256", secret).update(`${prompt}|${seed}`).digest("hex").slice(0, 32);
}

export function verifyIllustration(
  prompt: string,
  seed: number,
  signature: string,
  secret: string,
): boolean {
  const expected = signIllustration(prompt, seed, secret);

  if (typeof signature !== "string" || signature.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * The browser loads illustrations through our own route, never Pollinations directly, so the
 * optional account token stays server-side. The signature stops the route being an open proxy.
 */
export function buildProxyPath(prompt: string, seed: number, secret: string): string {
  const params = new URLSearchParams({
    prompt,
    seed: String(seed),
    sig: signIllustration(prompt, seed, secret),
  });

  return `/api/illustration?${params.toString()}`;
}

export function getIllustrationSecret(): string {
  return process.env.ILLUSTRATION_SECRET || process.env.OPENROUTER_API_KEY || "";
}

/**
 * Distil the passages into a visual prompt, then hand back a proxied image URL.
 * Resolves to null on any failure; the answer simply renders without an illustration.
 */
export async function generateIllustration(
  question: string,
  context: string,
): Promise<Illustration | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const secret = getIllustrationSecret();

  if (!apiKey || !secret) {
    return null;
  }

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getSceneModel(),
        temperature: 0.5,
        max_tokens: 160,
        messages: [{ role: "user", content: buildDistillPrompt(question, context) }],
      }),
    });

    const body = (await response.json().catch(() => ({}))) as Completion;

    if (!response.ok) {
      console.error("Illustration prompt failed", body.error?.message ?? response.status);
      return null;
    }

    const content = body.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? parseDistillResponse(content) : null;

    if (!parsed) {
      return null;
    }

    const seed = deriveSeed(parsed.prompt);

    return {
      imageUrl: buildProxyPath(parsed.prompt, seed, secret),
      caption: parsed.caption,
      alt: parsed.prompt,
    };
  } catch (error) {
    console.error("Illustration generation failed", error);
    return null;
  }
}
