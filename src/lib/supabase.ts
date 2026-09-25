import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

function configuration() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "",
  };
}

export function isSupabaseConfigured(): boolean {
  const { url, key } = configuration();
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && key.startsWith("sb_publishable_");
  } catch {
    return false;
  }
}

/** Called in the browser only after the public configuration has been checked. */
export function getSupabaseClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error("Подключение Supabase не настроено. Проверьте Project URL и Publishable key в переменных сборки.");
  }
  if (!client) {
    const { url, key } = configuration();
    client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}
