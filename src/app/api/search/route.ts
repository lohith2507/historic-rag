import { NextResponse } from "next/server";

import { retrieveChunks } from "@/lib/rag";
import { MissingSupabaseConfigError } from "@/lib/supabase";
import type { SourceId } from "@/lib/types";

const ALLOWED_SOURCES = new Set<SourceId>(["mahabharata", "ramayana", "gita"]);

type SearchBody = {
  query?: unknown;
  source?: unknown;
  limit?: unknown;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
  let body: SearchBody;

  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (typeof body.query !== "string" || body.query.trim() === "") {
    return badRequest("query must be a non-empty string");
  }

  if (body.source !== undefined) {
    if (typeof body.source !== "string" || !ALLOWED_SOURCES.has(body.source as SourceId)) {
      return badRequest("source must be one of: mahabharata, ramayana, gita");
    }
  }

  let limit = 8;

  if (body.limit !== undefined) {
    if (
      typeof body.limit !== "number" ||
      !Number.isInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > 20
    ) {
      return badRequest("limit must be an integer between 1 and 20");
    }

    limit = body.limit;
  }

  try {
    const results = await retrieveChunks(body.query.trim(), {
      source: typeof body.source === "string" ? body.source : undefined,
      limit,
    });

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Search failed", error);
    if (error instanceof MissingSupabaseConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
