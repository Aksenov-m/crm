import assert from "node:assert/strict";
import test from "node:test";
import { createAvitoWebhookHandler } from "../supabase/functions/avito-webhook/handler";
import { signWebhook } from "../supabase/functions/_shared/avito-messenger";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SECRET = "ab".repeat(32);
const binding = { ownerId: OWNER, key: "main", accountId: "12345", clientId: "client" };
const event = { id: "delivery-1", version: "v1.1", timestamp: 1700000001, payload: { type: "message", value: { id: "message-1", user_id: 12345, author_id: 42, chat_id: "chat:a/1", created: 1700000000, type: "text", content: { text: "Здравствуйте" } } } };

async function fixture(storage: (init: RequestInit) => Response | Promise<Response> = () => Response.json(null)) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const env: Record<string, string> = { SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "private-service-key", AVITO_CRM_OWNER_ID: OWNER, AVITO_CLIENT_ID: "client", AVITO_WEBHOOK_SECRET: SECRET };
  const handler = createAvitoWebhookHandler({ env: (key) => env[key], fetch: (async (input, init = {}) => {
    requests.push({ url: String(input), init });
    assert.equal(String(input), "https://test.supabase.co/rest/v1/rpc/avito_cache_messages");
    return storage(init);
  }) as typeof fetch });
  const url = `https://test.supabase.co/functions/v1/avito-webhook/main/12345/${await signWebhook(SECRET, binding)}`;
  const call = (body: unknown, customUrl = url, headers: Record<string, string> = {}) => handler(new Request(customUrl, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { handler, call, requests, url, env };
}

test("webhook persists a normalized message before ACK and never calls Avito", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async () => { await wait; return Response.json(null); });
  let completed = false;
  const pending = f.call(event).then((response) => { completed = true; return response; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completed, false);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(JSON.parse(String(f.requests[0].init.body)), { p_owner: OWNER, p_key: "main", p_account: "12345", p_chat: "chat:a/1", p_messages: [{ id: "message-1", text: "Здравствуйте", type: "text", created: 1700000000, direction: "in", isRead: false }], p_webhook: true });
});

test("webhook validates secret, account and recipient before storage; an authenticated probe is write-free", async () => {
  const f = await fixture();
  assert.equal((await f.call({})).status, 200);
  assert.equal((await f.call(event, f.url.slice(0, -64) + "0".repeat(64))).status, 403);
  assert.equal((await f.call(event, f.url.replace("/main/", "/other/"))).status, 403);
  assert.equal((await f.call(event, f.url.replace("/12345/", "/99999/"))).status, 403);
  assert.equal((await f.call({ ...event, payload: { ...event.payload, value: { ...event.payload.value, user_id: 99999 } } })).status, 403);
  assert.equal(f.requests.length, 0);
  f.env.AVITO_WEBHOOK_SECRET = "cd".repeat(32);
  assert.equal((await f.call(event)).status, 403);
});

test("webhook errors never ACK unsaved messages or leak private data", async () => {
  const f = await fixture(() => Response.json({ private: "database details" }, { status: 500 }));
  const response = await f.call(event);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"webhook_unavailable"}');
  assert.equal((await f.call(event, f.url, { "content-length": "70000" })).status, 413);
  assert.equal((await f.call({ ...event, padding: "x".repeat(70000) })).status, 413);
  assert.equal((await f.call({ payload: { type: "message", value: {} } })).status, 400);
});

test("webhook maps outgoing and deleted messages without retaining deleted text or raw payload", async () => {
  const f = await fixture();
  await f.call({ ...event, payload: { type: "message", value: { ...event.payload.value, author_id: 12345, type: "deleted", content: { text: "private removed text", secret: "attachment secret" } } } });
  const body = JSON.parse(String(f.requests[0].init.body));
  assert.equal(body.p_messages[0].text, "Сообщение удалено");
  assert.equal(body.p_messages[0].direction, "out");
  assert.equal(body.p_messages[0].isRead, true);
  assert.ok(!JSON.stringify(body).includes("private removed text"));
  assert.ok(!JSON.stringify(body).includes("attachment secret"));
});
