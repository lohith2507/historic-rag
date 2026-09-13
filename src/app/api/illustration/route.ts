import { NextResponse } from "next/server";

import {
  buildPollinationsUrl,
  getIllustrationSecret,
  verifyIllustration,
} from "@/lib/illustration";

const MAX_PROMPT_LENGTH = 320;
const UPSTREAM_TIMEOUT_MS = 90_000;

/**
 * Proxies generated illustrations so the optional Pollinations account token never reaches the
 * browser. Only prompts this server signed are accepted, which keeps it from being an open proxy.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const prompt = searchParams.get("prompt");
  const seedParam = searchParams.get("seed");
  const signature = searchParams.get("sig");

  if (!prompt || !seedParam || !signature) {
    return NextResponse.json({ error: "prompt, seed, and sig are required" }, { status: 400 });
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json({ error: "prompt is too long" }, { status: 400 });
  }

  const seed = Number(seedParam);

  if (!Number.isInteger(seed) || seed < 0) {
    return NextResponse.json({ error: "seed must be a non-negative integer" }, { status: 400 });
  }

  const secret = getIllustrationSecret();

  if (!secret || !verifyIllustration(prompt, seed, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  try {
    const upstream = await fetch(buildPollinationsUrl(prompt, seed), {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok || !upstream.body) {
      console.error("Illustration upstream failed", upstream.status);
      return NextResponse.json({ error: "Illustration unavailable" }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") ?? "";

    if (!contentType.startsWith("image/")) {
      console.error("Illustration upstream returned non-image", contentType);
      return NextResponse.json({ error: "Illustration unavailable" }, { status: 502 });
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": contentType,
        // The seed is derived from the prompt, so a given URL always yields the same image.
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Illustration proxy failed", error);
    return NextResponse.json({ error: "Illustration unavailable" }, { status: 502 });
  }
}
