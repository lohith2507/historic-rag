import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class MissingSupabaseConfigError extends Error {
  constructor() {
    super(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
    this.name = "MissingSupabaseConfigError";
  }
}

export function getServiceSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new MissingSupabaseConfigError();
  }

  return createClient(url, key, { auth: { persistSession: false } });
}
