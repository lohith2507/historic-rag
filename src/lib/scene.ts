import { getSceneModel } from "./openrouter";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_VIEW_BOX = "0 0 640 360";
const DEFAULT_CAPTION = "Scene from the retrieved passages";
const MAX_SVG_LENGTH = 24_000;
const MAX_CAPTION_LENGTH = 120;
const MAX_CONTEXT_LENGTH = 2_600;

/** Elements that must never survive into markup we inject with dangerouslySetInnerHTML. */
const BANNED_ELEMENTS = ["script", "foreignObject", "image", "iframe", "audio", "video", "set"];

export type Scene = {
  svg: string;
  caption: string;
};

type SceneCompletion = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
};

function stripElement(svg: string, name: string): string {
  return svg
    .replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}\\s*>`, "gi"), "")
    .replace(new RegExp(`</?${name}\\b[^>]*/?>`, "gi"), "");
}

function stripEventHandlers(svg: string): string {
  return svg.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/** Keep only local fragment links; every other href could pull in or execute something remote. */
function stripExternalReferences(svg: string): string {
  return svg.replace(
    /\s(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (match, rawValue: string) => {
      const value = rawValue.replace(/^["']|["']$/g, "").trim();
      return value.startsWith("#") ? match : "";
    },
  );
}

function stripImports(svg: string): string {
  return svg.replace(/@import[^;<}]*;?/gi, "");
}

/** Drop fixed dimensions and guarantee a viewBox so the scene scales to its container. */
function normalizeRootTag(svg: string): string {
  const rootTag = svg.match(/^<svg\b[^>]*>/i)?.[0];

  if (!rootTag) {
    return svg;
  }

  let normalized = rootTag.replace(/\s(?:width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  if (!/\bviewBox\s*=/i.test(normalized)) {
    normalized = normalized.replace(/^<svg\b/i, `<svg viewBox="${DEFAULT_VIEW_BOX}"`);
  }

  return normalized + svg.slice(rootTag.length);
}

/**
 * Turn raw model output into SVG markup that is safe to inline, or null when it cannot be.
 * Returning null simply means the answer renders without a scene.
 */
export function sanitizeSvg(raw: string): string | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }

  const start = raw.search(/<svg\b/i);
  const end = raw.toLowerCase().lastIndexOf("</svg>");

  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  const extracted = raw.slice(start, end + "</svg>".length);

  if (extracted.length > MAX_SVG_LENGTH) {
    return null;
  }

  let svg = extracted.replace(/<!--[\s\S]*?-->/g, "");

  for (const element of BANNED_ELEMENTS) {
    svg = stripElement(svg, element);
  }

  svg = stripEventHandlers(svg);
  svg = stripExternalReferences(svg);
  svg = stripImports(svg);
  svg = normalizeRootTag(svg);

  if (!/^<svg\b/i.test(svg) || !/<\/svg>$/i.test(svg)) {
    return null;
  }

  return svg;
}

export function parseSceneResponse(raw: string): Scene | null {
  const svg = sanitizeSvg(raw);

  if (!svg) {
    return null;
  }

  const caption = raw.match(/^\s*CAPTION:\s*(.+)$/im)?.[1].trim();

  return {
    svg,
    caption: caption ? caption.slice(0, MAX_CAPTION_LENGTH) : DEFAULT_CAPTION,
  };
}

export function buildScenePrompt(question: string, context: string): string {
  return [
    "You illustrate scenes from the Indian epics as animated SVG.",
    "Draw only what the passages below support. Never invent events they do not describe.",
    "",
    `Question: ${question}`,
    "",
    "Output format — exactly two parts, nothing else:",
    "1. A single line starting with CAPTION: followed by a short phrase (under 12 words) naming the moment you drew.",
    "2. One self-contained <svg> element. No markdown fences, no explanation before or after.",
    "",
    "SVG rules:",
    '- Root must be <svg viewBox="0 0 640 360"> with no width or height attributes.',
    "- Grayscale only: #14202f, #3c4858, #7b8794, #b9c2cb, #e7e3da, #ffffff. No other colours.",
    "- Flat geometric shapes and silhouettes: chariots, bows, arrows, arcs, banners, figures. No text labels beyond 4 words.",
    "- It must move. Use SMIL <animate> and <animateTransform> with repeatCount=\"indefinite\" and a 3-5 second loop.",
    "- Animate meaningful things: arrows in flight, a sinking wheel, advancing ranks, a drawn bowstring, rising dust.",
    "- No <script>, <foreignObject>, <image>, external URLs, or embedded fonts.",
    "- Keep it under 300 elements so it stays readable.",
    "",
    "Passages:",
    context.slice(0, MAX_CONTEXT_LENGTH) || "No relevant passages were retrieved.",
  ].join("\n");
}

/**
 * Ask the model for a scene. Failures resolve to null rather than throwing, because a missing
 * illustration must never take down the answer that was already streamed.
 */
export async function generateScene(question: string, context: string): Promise<Scene | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
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
        temperature: 0.6,
        max_tokens: 2200,
        messages: [{ role: "user", content: buildScenePrompt(question, context) }],
      }),
    });

    const body = (await response.json().catch(() => ({}))) as SceneCompletion;

    if (!response.ok) {
      console.error("Scene generation failed", body.error?.message ?? response.status);
      return null;
    }

    const content = body.choices?.[0]?.message?.content;

    return typeof content === "string" ? parseSceneResponse(content) : null;
  } catch (error) {
    console.error("Scene generation failed", error);
    return null;
  }
}
