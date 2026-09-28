import assert from "node:assert/strict";
import test from "node:test";
import { createAvitoHandler } from "../supabase/functions/avito/handler";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://proaksenov.ru";
const SB = "https://test.supabase.co";
const SECRET = "test-client-secret-keep-on-server";
const TOKEN = "test-avito-token-keep-on-server";
const envDefaults: Record<string, string> = {
  SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  AVITO_CRM_OWNER_ID: OWNER, AVITO_CLIENT_ID: "test-client", AVITO_CLIENT_SECRET: SECRET,
};
const response = (body: unknown, status = 200) => Response.json(body, { status });
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
