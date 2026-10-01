import { cacheMessengerMessages, verifyWebhook, webhookSecret, type MessengerBinding } from "../_shared/avito-messenger.ts";

type WebhookDependencies = { env: (name: string) => string | undefined; fetch: typeof fetch };
class WebhookError extends Error {
  constructor(public status: number) { super("Webhook request rejected"); }
}
function webhookObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebhookError(400);
  return value as Record<string, unknown>;
}
function webhookId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  throw new WebhookError(400);
}
function webhookOpaqueId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new WebhookError(400);
  return value;
}
async function webhookBody(req: Request) {
  if (Number(req.headers.get("content-length")) > 65536) throw new WebhookError(413);
  const reader = req.body?.getReader();
  if (!reader) throw new WebhookError(400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) throw new WebhookError(413);
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return webhookObject(JSON.parse(new TextDecoder().decode(bytes))); }
    catch { throw new WebhookError(400); }
  };
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WebhookError(408)), 350); })]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

export function createAvitoWebhookHandler({ env, fetch: fetcher }: WebhookDependencies) {
  return async (req: Request): Promise<Response> => {
    const respond = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    if (req.method !== "POST") return respond(405, { error: "method_not_allowed" });
    try {
      // The URL is a per-account capability. No Avito signature header is documented.
      const parts = new URL(req.url).pathname.split("/avito-webhook/")[1]?.split("/");
      if (!parts || parts.length !== 3 || !/^[a-zA-Z0-9_-]{1,40}$/.test(parts[0])) throw new WebhookError(403);
      const [key, accountId, signature] = parts;
      webhookId(accountId);
      const accounts: unknown = env("AVITO_ACCOUNTS_JSON") ? JSON.parse(env("AVITO_ACCOUNTS_JSON")!) : [{ key: "main", ownerId: env("AVITO_CRM_OWNER_ID"), clientId: env("AVITO_CLIENT_ID") }];
      if (!Array.isArray(accounts)) throw new Error("Invalid account configuration");
      const account = accounts.find((value) => value?.key === key);
      if (!account || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account.ownerId) || typeof account.clientId !== "string") throw new WebhookError(403);
      const binding: MessengerBinding = { ownerId: account.ownerId, key, accountId, clientId: account.clientId };
      if (!await verifyWebhook(webhookSecret(env), binding, signature)) throw new WebhookError(403);
      const body = await webhookBody(req);
      // Avito's documented registration/health probe sends {}. It must not write a message.
      if (!Object.keys(body).length) return respond(200, { ok: true });
      const payload = webhookObject(body.payload);
      if (payload.type !== "message") return respond(200, { ok: true, ignored: true });
      const value = webhookObject(payload.value);
      if (webhookId(value.user_id) !== accountId) throw new WebhookError(403);
      const authorId = webhookId(value.author_id);
      const chatId = webhookOpaqueId(value.chat_id);
      const id = webhookOpaqueId(value.id);
      if (typeof value.created !== "number" || !Number.isSafeInteger(value.created) || value.created < 0 || value.created > 1e12) throw new WebhookError(400);
      if (typeof value.type !== "string" || !/^[a-zA-Z_]{1,40}$/.test(value.type)) throw new WebhookError(400);
      const content = value.content ? webhookObject(value.content) : {};
      const labels: Record<string, string> = { deleted: "Сообщение удалено", image: "Фотография — откройте в Авито", voice: "Голосовое сообщение — откройте в Авито", call: "Звонок", system: "Системное сообщение" };
      const linkText = content.link && typeof content.link === "object" ? (content.link as Record<string, unknown>).text : null;
      const text = value.type === "deleted" ? labels.deleted : typeof content.text === "string" ? content.text : typeof linkText === "string" ? linkText : labels[value.type] || "Вложение — откройте в Авито";
      if (text.length > 20000) throw new WebhookError(413);
      const message = { id, text, type: value.type, created: value.created, direction: authorId === accountId ? "out" : "in", isRead: authorId === accountId };
      // One bounded DB transaction; no calls to Avito or background work before ACK.
      await cacheMessengerMessages(env, fetcher, binding, chatId, [message], true);
      return respond(200, { ok: true });
    } catch (error) {
      return respond(error instanceof WebhookError ? error.status : 503, { error: error instanceof WebhookError ? "invalid_webhook" : "webhook_unavailable" });
    }
  };
}
