import assert from "node:assert/strict";
import test from "node:test";
import { createAvitoHandler } from "../server/avito/handler.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://proaksenov.ru";
const ACCOUNT = { key: "main", name: "Account", ownerId: OWNER, clientId: "client", clientSecret: "secret" };
const MESSAGE = { id: "m1", type: "text", content: { text: "Hello" }, direction: "in", created: 1700000000, is_read: false };
const denied = () => Response.json({ error: { message: "Перейдите на подписку с API мессенджера" } }, { status: 402 });

function fixture(upstream: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const cached: unknown[][] = [];
  let saved: Record<string, unknown> | null = null;
  const handler = createAvitoHandler({
    env: (name) => name === "PUBLIC_API_URL" ? "https://api.proaksenov.ru" : undefined,
    authenticate: async () => OWNER,
    accountsForOwner: async () => [ACCOUNT],
    storage: async (path, init) => {
      if (path.startsWith("avito_oauth_tokens")) {
        if (init?.method === "POST") { saved = JSON.parse(String(init.body)); return null; }
        return saved ? [saved] : [];
      }
      if (path === "rpc/avito_consume_oauth_state") return [{ account_key: ACCOUNT.key, redirect_uri: `${ORIGIN}/api/avito/callback,` }];
      throw new Error(`Unexpected storage request: ${path}`);
    },
    cacheMessages: async (_binding, _chatId, messages) => { cached.push(messages); },
    fetch: async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/token")) {
        const grant = new URLSearchParams(String(init.body)).get("grant_type");
        return Response.json(grant === "authorization_code"
          ? { access_token: "oauth-token", refresh_token: "refresh-token", token_type: "Bearer", expires_in: 3600 }
          : { access_token: "client-token", token_type: "Bearer", expires_in: 86400 });
      }
      if (url.endsWith("/accounts/self")) return Response.json({ id: 12345 });
      return upstream(url, init);
    },
  });
  return {
    requests, cached,
    call: (input: Record<string, unknown>) => handler(new Request("https://api.proaksenov.ru/api/avito", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ accountKey: ACCOUNT.key, ...input }),
    })),
    messengerRequests: () => requests.filter(({ url }) => url.includes("/messenger/")),
  };
}

test("a transient Messenger 402 recovers on the first CRM request using the same token", async () => {
  let reads = 0;
  const f = fixture(() => ++reads === 1 ? denied() : Response.json([MESSAGE]));
  const result = await f.call({ action: "chat_messages", chatId: "chat-1" });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).messages[0].id, "m1");
  assert.equal(f.messengerRequests().length, 2);
  assert.ok(f.messengerRequests().every(({ init }) => new Headers(init.headers).get("Authorization") === "Bearer client-token"));
  assert.equal(f.requests.filter(({ url }) => url.endsWith("/token")).length, 1);
  assert.equal(f.cached.length, 1);
});

test("a persistent Messenger 402 stops after one retry and preserves the subscription error", async () => {
  const f = fixture(denied);
  const result = await f.call({ action: "chat_messages", chatId: "chat-1" });
  assert.equal(result.status, 402);
  const data = await result.json();
  assert.equal(data.error, "avito_subscription");
  assert.match(data.message, /Перейдите на подписку/);
  assert.equal(f.messengerRequests().length, 2);
  assert.equal(f.cached.length, 0);
});

test("successful history loads without an extra request", async () => {
  const f = fixture(() => Response.json([MESSAGE]));
  assert.equal((await f.call({ action: "chat_messages", chatId: "chat-1" })).status, 200);
  assert.equal(f.messengerRequests().length, 1);
});

test("Messenger 402 does not repeat sends, deletions or read receipts", async () => {
  for (const input of [
    { action: "send_message", chatId: "chat-1", text: "Hello" },
    { action: "delete_message", chatId: "chat-1", messageId: "m1" },
    { action: "read_chat", chatId: "chat-1" },
  ]) {
    const f = fixture(denied);
    assert.equal((await f.call(input)).status, 402);
    assert.equal(f.messengerRequests().length, 1, input.action);
    assert.equal(f.messengerRequests()[0].init.method, "POST");
  }
});

test("completing OAuth replaces the previously cached client token for the next chat request", async () => {
  const f = fixture(() => Response.json([MESSAGE]));
  assert.equal((await f.call({ action: "chat_messages", chatId: "chat-1" })).status, 200);
  assert.equal((await f.call({ action: "oauth_callback", state: "A".repeat(43), code: "code" })).status, 200);
  assert.equal((await f.call({ action: "chat_messages", chatId: "chat-1" })).status, 200);
  const requests = f.messengerRequests();
  assert.equal(new Headers(requests[0].init.headers).get("Authorization"), "Bearer client-token");
  assert.equal(new Headers(requests[1].init.headers).get("Authorization"), "Bearer oauth-token");
});
