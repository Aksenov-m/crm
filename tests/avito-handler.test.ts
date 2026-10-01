import assert from "node:assert/strict";
import test from "node:test";
import { createAvitoHandler } from "../supabase/functions/avito/handler";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://proaksenov.ru";
const LOCAL_ORIGIN = "http://127.0.0.1:3000";
const SB = "https://test.supabase.co";
const SECRET = "test-client-secret-keep-on-server";
const TOKEN = "test-avito-token-keep-on-server";
const encodedOAuthState = (returnOrigin: string) => Buffer.from(JSON.stringify({ nonce: "test-nonce", return_origin: returnOrigin })).toString("base64url");
const envDefaults: Record<string, string> = {
  SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  AVITO_CRM_OWNER_ID: OWNER, AVITO_CLIENT_ID: "test-client", AVITO_CLIENT_SECRET: SECRET,
};
const response = (body: unknown, status = 200) => Response.json(body, { status });
const chatMessage = { id: "msg-1", type: "text", content: { text: "Здравствуйте" }, direction: "in", created: 1700000000, is_read: false };
function messengerFixture(api: (url: string, init: RequestInit) => Response | Promise<Response>, options: { owner?: string } = {}) {
  return fixture({ ...options, api: (url, init) => {
    if (url.endsWith("/token")) return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
    if (url.endsWith("/accounts/self")) return response({ id: 12345 });
    return api(url, init);
  } });
}

test("messenger reads the V3 array, scopes account server-side and maps deleted/unknown content", async () => {
  const f = messengerFixture((url) => {
    assert.equal(url, "https://api.avito.ru/messenger/v3/accounts/12345/chats/chat%3Aabc%2F123/messages/?limit=50&offset=50");
    return response([chatMessage, { ...chatMessage, id: "deleted", type: "deleted", content: { text: "Do not show deleted content" } }, { ...chatMessage, id: "voice", type: "voice", content: {} }]);
  });
  const result = await f.call({ action: "chat_messages", accountKey: "main", accountId: "99999", chatId: "chat:abc/123", offset: 50 });
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.messages[0].text, "Здравствуйте");
  assert.equal(data.messages[0].isRead, false);
  assert.equal(data.messages[1].text, "Сообщение удалено");
  assert.match(data.messages[2].text, /Голосовое/);
  assert.equal(data.hasMore, false);
  assert.equal(f.requests.filter(({ url }) => url.endsWith("/read")).length, 0);
});

test("messenger also accepts the wrapped history shape returned by some Avito responses", async () => {
  const f = messengerFixture((url) => {
    assert.match(url, /messenger\/v3\/accounts\/12345\/chats\/chat-1\/messages/);
    return response({ messages: [chatMessage] });
  });
  const result = await f.call({ action: "chat_messages", accountKey: "main", chatId: "chat-1" });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).messages[0].text, "Здравствуйте");
});

test("messenger accepts an items wrapper and reports only safe response keys for an unknown shape", async () => {
  const wrapped = messengerFixture(() => response({ items: [chatMessage] }));
  assert.equal((await wrapped.call({ action: "chat_messages", accountKey: "main", chatId: "chat-1" })).status, 200);
  const unknown = messengerFixture(() => response({ result: { secret: "hidden" }, trace_id: "trace-1" }));
  const result = await unknown.call({ action: "chat_messages", accountKey: "main", chatId: "chat-1" });
  assert.equal(result.status, 502);
  const body = await result.json();
  assert.match(body.message, /result, trace_id/);
  assert.ok(!body.message.includes("hidden"));
});

test("messenger chat list omits own profile and unsafe links", async () => {
  const f = messengerFixture((url) => {
    assert.match(url, /messenger\/v2\/accounts\/12345\/chats\?limit=50&offset=0&chat_types=u2i,u2u$/);
    return response({ chats: [{ id: "chat-1", users: [{ id: 12345, name: "Я" }, { id: 42, name: "Покупатель" }], context: { value: { title: "Стол", url: "javascript:alert(1)" } }, last_message: chatMessage }] });
  });
  const data = await (await f.call({ action: "chats", accountKey: "main" })).json();
  assert.equal(data.chats[0].name, "Покупатель");
  assert.equal(data.chats[0].itemTitle, "Стол");
  assert.equal(data.chats[0].itemUrl, null);
});

test("one malformed chat preview does not hide the other dialogs", async () => {
  const f = messengerFixture(() => response({ chats: [
    { id: "chat-bad", users: [{ id: 42, name: "Покупатель 1" }], last_message: { id: "broken" } },
    { id: "chat-good", users: [{ id: 43, name: "Покупатель 2" }], last_message: chatMessage },
  ] }));
  const result = await f.call({ action: "chats", accountKey: "main" });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).chats.map((chat: { id: string }) => chat.id), ["chat-bad", "chat-good"]);
});

test("messenger sends text once, returns the confirmed message and reads via separate POST", async () => {
  const f = messengerFixture((url, init) => {
    assert.equal(init.method, "POST");
    if (url.endsWith("/read")) return response({ ok: true });
    assert.equal(url, "https://api.avito.ru/messenger/v1/accounts/12345/chats/chat-1/messages");
    assert.deepEqual(JSON.parse(String(init.body)), { type: "text", message: { text: "Да, в наличии" } });
    return response({ ...chatMessage, direction: "out", content: { text: "Да, в наличии" } });
  });
  const result = await f.call({ action: "send_message", accountKey: "main", chatId: "chat-1", text: " Да, в наличии " });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).message.direction, "out");
  assert.equal((await f.call({ action: "read_chat", accountKey: "main", chatId: "chat-1" })).status, 200);
  const readRequest = f.requests.find(({ url }) => url.endsWith("/read"));
  assert.equal(readRequest?.init.body, undefined);
  assert.equal((readRequest?.init.headers as Record<string, string>)["Content-Type"], undefined);
  assert.equal(f.requests.filter(({ url }) => url.endsWith("/messages")).length, 1);
});

test("messenger validates payloads before calling Avito and denies other owners", async () => {
  const f = messengerFixture(() => { throw new Error("No API calls expected"); });
  for (const body of [
    { action: "send_message", chatId: "chat-1", text: " " },
    { action: "send_message", chatId: "chat-1", text: "x".repeat(1001) },
    { action: "chat_messages", chatId: "\u0000" },
    { action: "chats", offset: 1001 },
    { action: "chats", offset: -1 },
  ]) assert.equal((await f.call({ ...body, accountKey: "main" })).status, 400);
  assert.ok(f.requests.every(({ url }) => url.startsWith(SB)));
  const other = messengerFixture(() => { throw new Error("Must not call Avito"); }, { owner: OTHER });
  assert.equal((await other.call({ action: "send_message", accountKey: "main", chatId: "chat-1", text: "Hi" })).status, 403);
});

test("owner registers a webhook only after storage and receiver checks; repeat registration preserves other subscriptions", async () => {
  let callback = "";
  let enabled = false;
  let registrations = 0;
  const secret = "ab".repeat(32);
  const f = fixture({ env: { AVITO_WEBHOOK_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: "service-secret" }, api: (url, init) => {
    if (url.endsWith("/token")) return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
    if (url.endsWith("/accounts/self")) return response({ id: 12345 });
    if (url.endsWith("/rpc/avito_cache_messages")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.p_owner, OWNER); assert.equal(body.p_account, "12345");
      return response(null);
    }
    if (url.includes("/functions/v1/avito-webhook/")) { callback = url; return response({ ok: true }); }
    if (url.endsWith("/messenger/v1/subscriptions")) {
      assert.equal(init.method, "POST");
      return response({ subscriptions: [{ url: "https://other-crm.example/hook", version: "3" }, ...(enabled ? [{ url: callback, version: "3" }] : [])] });
    }
    if (url.endsWith("/messenger/v3/webhook")) {
      registrations++;
      assert.deepEqual(JSON.parse(String(init.body)), { url: callback });
      assert.ok(callback.startsWith(`${SB}/functions/v1/avito-webhook/main/12345/`));
      return response({ ok: true });
    }
    if (url.includes("/rest/v1/avito_messenger_accounts")) {
      if (init.method === "PATCH") { enabled = true; return new Response(null, { status: 204 }); }
      return response([{ webhook_enabled: enabled, last_event_at: null }]);
    }
    throw new Error("Unexpected request");
  } });
  for (let i = 0; i < 2; i++) {
    const result = await f.call({ action: "enable_webhook", accountKey: "main", accountId: "99999", url: "https://evil.example/hook" });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { enabled: true, accountId: "12345", lastEventAt: null });
  }
  assert.equal(registrations, 1);
  assert.ok(f.requests.every(({ url }) => !url.includes("unsubscribe") && !url.includes("evil.example")));
  assert.equal((await fixture().call({ action: "enable_webhook", accountKey: "main" })).status, 503);
});

test("webhook registration rejects non-owners and stops before Avito when receiver or storage is not ready", async () => {
  const denied = fixture({ owner: OTHER });
  assert.equal((await denied.call({ action: "enable_webhook", accountKey: "main" })).status, 403);
  assert.equal(denied.requests.length, 1);
  for (const mode of ["storage", "probe-error", "probe-html", "probe-unconfirmed"]) {
    const f = fixture({ env: { AVITO_WEBHOOK_SECRET: "ab".repeat(32), SUPABASE_SERVICE_ROLE_KEY: "service-secret" }, api: (url) => {
      if (url.endsWith("/token")) return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
      if (url.endsWith("/accounts/self")) return response({ id: 12345 });
      if (url.endsWith("/rpc/avito_cache_messages")) return response(null, mode === "storage" ? 404 : 200);
      if (url.includes("/functions/v1/avito-webhook/")) return mode === "probe-html" ? new Response("<html>Wrong deployment</html>") : response({}, mode === "probe-error" ? 401 : 200);
      throw new Error("Must not register an unavailable receiver");
    } });
    const result = await f.call({ action: "enable_webhook", accountKey: "main" });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error, mode === "storage" ? "webhook_storage" : "webhook_unavailable");
    assert.equal(f.requests.filter(({ url }) => url.includes("/messenger/")).length, 0);
  }
});

test("cache failure does not turn a confirmed Avito send into an uncertain send", async () => {
  let sends = 0;
  const f = fixture({ env: { SUPABASE_SERVICE_ROLE_KEY: "service-secret" }, api: (url) => {
    if (url.endsWith("/token")) return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
    if (url.endsWith("/accounts/self")) return response({ id: 12345 });
    if (url.endsWith("/messages")) { sends++; return response({ ...chatMessage, direction: "out" }); }
    return response({}, 503);
  } });
  const result = await f.call({ action: "send_message", accountKey: "main", chatId: "chat-1", text: "Hi" });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.message.direction, "out");
  assert.match(body.warning, /не сохранена/);
  assert.equal(sends, 1);
});

test("chatRead uses the documented bodyless POST with encoded ID and confirms only a successful status", async () => {
  for (const status of [200, 402, 403, 429, 500]) {
    const f = messengerFixture((url, init) => {
      assert.equal(url, "https://api.avito.ru/messenger/v1/accounts/12345/chats/chat%3Aabc%2F123/read");
      assert.equal(init.method, "POST");
      assert.equal(init.body, undefined);
      assert.equal(new Headers(init.headers).has("Content-Type"), false);
      return status === 200 ? response({ ok: true }) : response({ code: status, message: "Отказ API" }, status);
    });
    const result = await f.call({ action: "read_chat", accountKey: "main", chatId: "chat:abc/123" });
    const body = await result.json();
    if (status === 200) assert.deepEqual(body, { read: true });
    else {
      assert.equal(result.status, status === 500 ? 502 : status);
      assert.equal(body.read, undefined);
      assert.ok(body.error);
      if (status === 402 || status === 403) {
        assert.equal(body.error, "avito_read_access");
        assert.match(body.message, /История сообщений при этом доступна/);
      }
    }
    assert.equal(f.requests.filter(({ url }) => url.endsWith("/read")).length, 1);
  }
});

test("chatRead refreshes an expired token once before retrying the idempotent receipt", async () => {
  let reads = 0;
  const f = messengerFixture(() => ++reads === 1 ? response({}, 401) : response({ ok: true }));
  const result = await f.call({ action: "read_chat", accountKey: "main", chatId: "chat-1" });
  assert.deepEqual(await result.json(), { read: true });
  assert.equal(reads, 2);
  assert.equal(f.requests.filter(({ url }) => url.endsWith("/token")).length, 2);
});

test("messenger surfaces subscription errors and never retries uncertain sends", async () => {
  const denied = messengerFixture(() => response({ error: { code: 402, message: "Messenger API недоступен для текущей подписки" } }, 402));
  assert.equal((await denied.call({ action: "chats", accountKey: "main" })).status, 402);
  assert.match(await (await denied.call({ action: "chats", accountKey: "main" })).text(), /Messenger API недоступен/);
  for (const mode of ["network", "server", "malformed", "unauthorized"]) {
    const f = messengerFixture(() => {
      if (mode === "network") throw new Error("Disconnected");
      return response({}, mode === "server" ? 500 : mode === "unauthorized" ? 401 : 200);
    });
    const result = await f.call({ action: "send_message", accountKey: "main", chatId: "chat-1", text: "Hi" });
    assert.equal(result.status, 502);
    assert.equal(f.requests.filter(({ url }) => url.endsWith("/messages")).length, 1);
    if (mode !== "unauthorized") assert.equal((await result.json()).error, "send_uncertain");
  }
});
function fixture(options: { owner?: string; status?: number; env?: Record<string, string>; api?: (url: string, init: RequestInit) => Response | Promise<Response>; now?: () => number } = {}) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const handler = createAvitoHandler({
    env: (name) => ({ ...envDefaults, ...options.env })[name], now: options.now,
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === `${SB}/auth/v1/user`) return response({ id: options.owner ?? OWNER }, options.status ?? 200);
      if (options.api) return options.api(url, init);
      if (url.endsWith("/token")) return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
      if (url.endsWith("/accounts/self")) return response({ id: 12345, name: "Мой магазин", email: "private@example.com", phone: "+79999999999", profile_url: "https://www.avito.ru/user/test" });
      if (url.includes("/core/v1/items")) return response({ resources: [{ id: 98765, title: "Кресло", price: 2500, category: { name: "Мебель" }, status: "active", url: "https://www.avito.ru/items/98765" }] });
      throw new Error("Unexpected request");
    }) as typeof fetch,
  });
  const call = (body: unknown, headers: Record<string, string> = {}) => handler(new Request(`${SB}/functions/v1/avito`, { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer user-jwt", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { handler, requests, call };
}

test("rejects missing/invalid authentication and another CRM owner before calling Avito", async () => {
  for (const options of [{ status: 401 }, { owner: OTHER }]) {
    const f = fixture(options);
    const result = await f.call({ action: "profile", accountKey: "main" });
    assert.ok([401, 403].includes(result.status));
    assert.equal(f.requests.length, 1);
    assert.ok(f.requests.every(({ url }) => url.startsWith(SB)));
  }
  const f = fixture();
  assert.equal((await f.call({ action: "accounts" }, { authorization: "" })).status, 401);
  assert.equal(f.requests.length, 0);
});

test("CORS is restricted to configured origins; preflight does not call Auth or Avito", async () => {
  const f = fixture();
  const preflight = await f.handler(new Request(SB, { method: "OPTIONS", headers: { origin: ORIGIN } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  const denied = await f.call({ action: "accounts" }, { origin: "https://evil.example" });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  assert.equal(f.requests.length, 0);
});

test("lists only the caller's configured accounts and never exposes credentials", async () => {
  const f = fixture({ env: { AVITO_ACCOUNTS_JSON: JSON.stringify([
    { key: "mine", name: "Мой", ownerId: OWNER, clientId: "id", clientSecret: SECRET },
    { key: "other", name: "Чужой", ownerId: OTHER, clientId: "other", clientSecret: "other-secret" },
  ]) } });
  const result = await f.call({ action: "accounts" });
  assert.deepEqual(await result.json(), { accounts: [{ key: "mine", name: "Мой" }] });
  assert.equal((await f.call({ action: "profile", accountKey: "other" })).status, 403);
  assert.equal(f.requests.filter(({ url }) => url.startsWith("https://api.avito.ru")).length, 0);
});

test("profile uses form-encoded client credentials, caches token and omits private contact fields", async () => {
  const f = fixture();
  const first = await f.call({ action: "profile", accountKey: "main" });
  const body = await first.text();
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(body), { profile: { id: "12345", name: "Мой магазин", profileUrl: "https://www.avito.ru/user/test" } });
  for (const secret of [SECRET, TOKEN, "private@example.com", "+79999999999"]) assert.ok(!body.includes(secret));
  await f.call({ action: "profile", accountKey: "main" });
  const tokens = f.requests.filter(({ url }) => url.endsWith("/token"));
  assert.equal(tokens.length, 1);
  assert.equal(new URLSearchParams(String(tokens[0].init.body)).get("client_secret"), SECRET);
  assert.equal(new URLSearchParams(String(tokens[0].init.body)).get("grant_type"), "client_credentials");
  assert.equal(tokens[0].init.redirect, "error");
  assert.equal(first.headers.get("cache-control"), "no-store");
});

test("concurrent requests share token acquisition; expired tokens refresh", async () => {
  let clock = 0;
  const f = fixture({ now: () => clock });
  await Promise.all([f.call({ action: "profile", accountKey: "main" }), f.call({ action: "profile", accountKey: "main" })]);
  assert.equal(f.requests.filter(({ url }) => url.endsWith("/token")).length, 1);
  clock = 86400000;
  await f.call({ action: "profile", accountKey: "main" });
  assert.equal(f.requests.filter(({ url }) => url.endsWith("/token")).length, 2);
});

test("one retry on Avito 401 refreshes token and never loops indefinitely", async () => {
  let calls = 0;
  const f = fixture({ api: (url) => {
    if (url.endsWith("/token")) return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
    calls += 1;
    return calls === 1 ? response({}, 401) : response({ id: 12, name: "Профиль" });
  } });
  assert.equal((await f.call({ action: "profile", accountKey: "main" })).status, 200);
  assert.equal(calls, 2);
  const denied = fixture({ api: (url) => url.endsWith("/token") ? response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 }) : response({}, 401) });
  assert.equal((await denied.call({ action: "profile", accountKey: "main" })).status, 502);
  assert.equal(denied.requests.filter(({ url }) => url.endsWith("/accounts/self")).length, 2);
});

test("updates the linked listing price through the Avito Core API without exposing credentials", async () => {
  const f = fixture({ api: (url) => {
    if (url.endsWith("/token")) return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
    if (url.endsWith("/accounts/self")) return response({ id: 12345, name: "Мой магазин" });
    if (url.endsWith("/items/98765/update_price")) return response({ updated: true });
    throw new Error(`Unexpected request: ${url}`);
  } });
  const result = await f.call({ action: "update_price", accountId: "12345", itemId: "98765", price: 3200 });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { updated: true, itemId: "98765", price: 3200 });
  const update = f.requests.find(({ url }) => url.endsWith("/items/98765/update_price"));
  assert.equal(update?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(update?.init.body)), { price: 3200 });
  assert.ok(!JSON.stringify(update).includes(SECRET));
});

test("rejects decimal or unsafe price updates before changing an Avito listing", async () => {
  const f = fixture({ api: (url) => {
    if (url.endsWith("/token")) return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
    if (url.endsWith("/accounts/self")) return response({ id: 12345 });
    throw new Error(`Unexpected request: ${url}`);
  } });
  assert.equal((await f.call({ action: "update_price", accountId: "12345", itemId: "98765", price: 3200.5 })).status, 400);
  assert.equal((await f.call({ action: "update_price", accountId: "12345", itemId: "98765", price: 0 })).status, 400);
  assert.equal(f.requests.filter(({ url }) => url.endsWith("/update_price")).length, 0);
});

test("listing response maps only allowed fields and does not treat unsafe URLs as links", async () => {
  const f = fixture({ api: (url) => url.endsWith("/token") ? response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 }) : response({ resources: [{ id: "9007199254740993", title: "Товар", status: "removed", url: "https://avito.ru.evil.example/", price: null, secret: SECRET }] }) });
  const result = await f.call({ action: "items", accountKey: "main", page: 2 });
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.deepEqual(body.items, [{ id: "9007199254740993", title: "Товар", status: "removed", url: null, price: null, category: "", description: "", imageUrl: null }]);
  assert.equal(body.hasMore, false);
  assert.ok(f.requests.some(({ url }) => url.endsWith("?per_page=50&page=2")));
});

test("returns only a safe Avito image URL and proxies image bytes", async () => {
  const image = "https://10.img.avito.ru/1/2/3.jpg";
  const nestedImage = "https://00.img.avito.st/image/1/2/3/640x480.jpg";
  const f = fixture({ api: (url) => {
    if (url.includes("/core/v1/items")) return response({ resources: [{ id: 77, title: "Фото", image_url: image }, { id: 78, title: "Фото 2" }] });
    if (url.endsWith("/accounts/self")) return response({ id: 12345 });
    if (url.includes("/accounts/12345/items/77/")) return response({ description: "Подробное описание товара" });
    if (url.includes("/accounts/12345/items/78/")) return response({ images: [{ urls: { "640x480": nestedImage } }], description: "Описание 2" });
    if (url === image) return new Response("image-bytes", { headers: { "content-type": "image/jpeg" } });
    return response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
  } });
  const listed = await f.call({ action: "items", accountKey: "main", page: 1 });
  const listedBody = await listed.json();
  assert.equal(listedBody.items[0].imageUrl, image);
  assert.equal(listedBody.items[0].description, "Подробное описание товара");
  assert.equal(listedBody.items[1].imageUrl, nestedImage);
  const proxied = await f.call({ action: "image", accountKey: "main", imageUrl: image });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers.get("content-type"), "application/octet-stream");
  assert.equal(proxied.headers.get("x-image-content-type"), "image/jpeg");
  assert.equal(await proxied.text(), "image-bytes");
  assert.equal((await f.call({ action: "image", accountKey: "main", imageUrl: "https://evil.example/photo.jpg" })).status, 400);
  assert.equal(f.requests.filter(({ url }) => url === "https://evil.example/photo.jpg").length, 0);
});

test("invalid pages/actions are rejected and unsafe numeric IDs fail explicitly", async () => {
  const f = fixture();
  for (const page of [0, -1, 1.5, 1001, "1&token=bad"]) assert.equal((await f.call({ action: "items", accountKey: "main", page })).status, 400);
  assert.equal((await f.call({ action: "proxy", accountKey: "main", url: "https://evil.example" })).status, 400);
  assert.equal(f.requests.filter(({ url }) => url.startsWith("https://api.avito.ru")).length, 0);
  const unsafe = fixture({ api: (url) => url.endsWith("/token") ? response({ access_token: TOKEN, token_type: "Bearer", expires_in: 86400 }) : response({ id: Number.MAX_SAFE_INTEGER + 1 }) });
  assert.equal((await unsafe.call({ action: "profile", accountKey: "main" })).status, 502);
});

test("upstream errors and invalid settings do not leak response bodies or credentials", async () => {
  for (const status of [400, 403, 429, 500]) {
    const f = fixture({ api: () => response({ client_secret: SECRET, access_token: TOKEN }, status) });
    const result = await f.call({ action: "profile", accountKey: "main" });
    assert.ok(result.status >= 400);
    const body = await result.text();
    assert.ok(!body.includes(SECRET) && !body.includes(TOKEN));
  }
  const f = fixture({ env: { AVITO_CLIENT_SECRET: "" } });
  assert.equal((await f.call({ action: "accounts" })).status, 503);
});

test("handles Avito OAuth errors returned with HTTP 200", async () => {
  const f = fixture({ api: (url) => url.endsWith("/token")
    ? response({ error: "unauthorized_client", error_description: "private OAuth details" })
    : response({ id: 12345 }) });
  const result = await f.call({ action: "chats", accountKey: "main" });
  assert.equal(result.status, 502);
  const body = await result.json();
  assert.equal(body.error, "avito_auth");
  assert.match(body.message, /client_credentials/);
  assert.ok(!JSON.stringify(body).includes("private OAuth details"));
});

test("OAuth start stores only a hash of state and builds the registered Avito redirect", async () => {
  let stateBody: Record<string, unknown> | undefined;
  const f = fixture({ env: { SUPABASE_SERVICE_ROLE_KEY: "service-secret" }, api: (url, init) => {
    if (url.includes("/rest/v1/avito_oauth_states?expires_at=")) return new Response(null, { status: 204 });
    if (url.endsWith("/rest/v1/avito_oauth_states")) {
      assert.equal(init.method, "POST");
      stateBody = JSON.parse(String(init.body));
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  } });
  const result = await f.call({ action: "oauth_start", accountKey: "main" });
  assert.equal(result.status, 200);
  const body = await result.json();
  const url = new URL(body.authorizeUrl);
  assert.equal(url.origin, "https://avito.ru");
  assert.equal(url.pathname, "/oauth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://proaksenov.ru/api/avito/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "items:info messenger:read messenger:write user:read");
  const state = url.searchParams.get("state")!;
  assert.match(state, /^[A-Za-z0-9_-]{32,200}$/);
  const savedState = stateBody as Record<string, unknown>;
  assert.equal(savedState.account_key, "main");
  assert.equal(String(savedState.state_hash).length, 64);
  assert.notEqual(savedState.state_hash, state);
  assert.ok(!JSON.stringify(body).includes(SECRET));
});

test("OAuth start keeps the single registered redirect for the local dev origin", async () => {
  let stateBody: Record<string, unknown> | undefined;
  const f = fixture({
    env: { SUPABASE_SERVICE_ROLE_KEY: "service-secret", AVITO_ALLOWED_ORIGINS: `${ORIGIN},${LOCAL_ORIGIN}` },
    api: (url, init) => {
      if (url.includes("/rest/v1/avito_oauth_states?expires_at=")) return new Response(null, { status: 204 });
      if (url.endsWith("/rest/v1/avito_oauth_states")) {
        stateBody = JSON.parse(String(init.body));
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const result = await f.call({ action: "oauth_start", accountKey: "main" }, { origin: LOCAL_ORIGIN });
  assert.equal(result.status, 200);
  const body = await result.json();
  const url = new URL(body.authorizeUrl);
  assert.equal(url.searchParams.get("redirect_uri"), "https://proaksenov.ru/api/avito/callback");
  assert.equal(body.redirectUri, "https://proaksenov.ru/api/avito/callback");
  assert.equal((stateBody as Record<string, unknown>).redirect_uri, "https://proaksenov.ru/api/avito/callback");
});

test("OAuth callback exchanges the code server-side and stores refreshable tokens", async () => {
  let tokenRequest: URLSearchParams | undefined;
  let stored: Record<string, unknown> | undefined;
  const f = fixture({ env: { SUPABASE_SERVICE_ROLE_KEY: "service-secret" }, api: (url, init) => {
    if (url.endsWith("/rest/v1/rpc/avito_consume_oauth_state")) return response([{ account_key: "main", redirect_uri: "https://proaksenov.ru/api/avito/callback" }]);
    if (url.endsWith("/token")) {
      tokenRequest = new URLSearchParams(String(init.body));
      return response({ access_token: "oauth-access-token", refresh_token: "oauth-refresh-token", token_type: "Bearer", expires_in: 3600, scope: "items:info messenger:read messenger:write user:read" });
    }
    if (url.includes("/rest/v1/avito_oauth_tokens?on_conflict=")) {
      stored = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  } });
  const result = await f.call({ action: "oauth_callback", state: "A".repeat(43), code: "one-time-code" });
  assert.equal(result.status, 200);
  const resultBody = await result.json();
  assert.deepEqual(resultBody, { connected: true, accountKey: "main", returnOrigin: ORIGIN });
  const form = tokenRequest as URLSearchParams;
  const savedToken = stored as Record<string, unknown>;
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "one-time-code");
  assert.equal(form.get("redirect_uri"), "https://proaksenov.ru/api/avito/callback");
  assert.equal(savedToken.refresh_token, "oauth-refresh-token");
  assert.ok(!JSON.stringify(resultBody).includes("oauth-access-token"));
});

test("OAuth callback returns the local origin while exchanging through the single production redirect", async () => {
  let tokenRequest: URLSearchParams | undefined;
  const f = fixture({
    env: { SUPABASE_SERVICE_ROLE_KEY: "service-secret", AVITO_ALLOWED_ORIGINS: `${ORIGIN},${LOCAL_ORIGIN}` },
    api: (url, init) => {
      if (url.endsWith("/rest/v1/rpc/avito_consume_oauth_state")) return response([{ account_key: "main", redirect_uri: "https://proaksenov.ru/api/avito/callback" }]);
      if (url.endsWith("/token")) {
        tokenRequest = new URLSearchParams(String(init.body));
        return response({ access_token: "oauth-access-token", refresh_token: "oauth-refresh-token", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.includes("/rest/v1/avito_oauth_tokens?on_conflict=")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const result = await f.call({ action: "oauth_callback", state: encodedOAuthState(LOCAL_ORIGIN), code: "local-code" }, { origin: LOCAL_ORIGIN });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { connected: true, accountKey: "main", returnOrigin: LOCAL_ORIGIN });
  assert.equal((tokenRequest as URLSearchParams).get("redirect_uri"), "https://proaksenov.ru/api/avito/callback");
});
