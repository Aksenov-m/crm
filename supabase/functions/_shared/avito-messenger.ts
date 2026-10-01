type MessengerEnv = (name: string) => string | undefined;
export type MessengerBinding = { ownerId: string; key: string; accountId: string; clientId: string };

function serviceKey(env: MessengerEnv): string {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    return keys && typeof keys.default === "string" ? keys.default : "";
  } catch { return ""; }
}

export function messengerStorageConfigured(env: MessengerEnv): boolean {
  return Boolean(env("SUPABASE_URL") && serviceKey(env));
}

export function webhookSecret(env: MessengerEnv): string {
  const secret = env("AVITO_WEBHOOK_SECRET") || "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("Webhook secret is not configured");
  return secret;
}

function webhookScope(binding: MessengerBinding) {
  return new TextEncoder().encode(JSON.stringify([binding.ownerId, binding.key, binding.accountId, binding.clientId]));
}

async function webhookKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signWebhook(secret: string, binding: MessengerBinding): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await webhookKey(secret), webhookScope(binding));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyWebhook(secret: string, binding: MessengerBinding, signature: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g)!, (byte) => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", await webhookKey(secret), bytes, webhookScope(binding));
}

// Service credentials never leave the functions. Browser clients have read-only RLS access.
export async function messengerStorage(env: MessengerEnv, fetcher: typeof fetch, path: string, init: RequestInit = {}, timeout = 8000): Promise<unknown> {
  const base = env("SUPABASE_URL")?.replace(/\/$/, "");
  const key = serviceKey(env);
  if (!base || !key) throw new Error("Messenger storage is not configured");
  const url = new URL(base);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "kong"].includes(url.hostname))) throw new Error("Invalid storage URL");
  const response = await fetcher(`${base}/rest/v1/${path}`, {
    ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
    redirect: "error", signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error("Messenger storage request failed");
  if (response.status === 204) return null;
  const body = await response.text();
  if (!body.trim()) return null;
  return JSON.parse(body);
}

export function cacheMessengerMessages(env: MessengerEnv, fetcher: typeof fetch, binding: MessengerBinding, chatId: string, messages: unknown[], webhook = false) {
  return messengerStorage(env, fetcher, "rpc/avito_cache_messages", {
    method: "POST", body: JSON.stringify({ p_owner: binding.ownerId, p_key: binding.key, p_account: binding.accountId, p_chat: chatId, p_messages: messages, p_webhook: webhook }),
  }, webhook ? 1500 : 8000);
}
