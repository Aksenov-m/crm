import assert from "node:assert/strict";
import test from "node:test";
import { createImageWorker } from "../server/image-worker-app.ts";
import { imageProviderConfig, MAX_IMAGE_RESPONSE_BYTES, readImageResponse, requestImage } from "../server/image-provider.ts";

const TOKEN = "test-worker-token-".repeat(4);
const API_KEY = "test-openai-key";
const signal = () => new AbortController().signal;
const request = (input: unknown = { prompt: "A ceramic flower pot" }, token = TOKEN) => new Request("http://worker/v1/images/generations", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(input),
});

test("remote mode needs no OpenAI key and only sends the worker token to the worker", async () => {
  const config = imageProviderConfig({ IMAGE_WORKER_URL: "http://image-tunnel:3010", IMAGE_WORKER_TOKEN: TOKEN, OPENAI_API_KEY: API_KEY });
  assert.equal(config.remote, true);
  let calls = 0;
  await requestImage("product prompt", config, signal(), undefined, async (url, init) => {
    calls++;
    assert.equal(url, "http://image-tunnel:3010/v1/images/generations");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${TOKEN}`);
    assert.equal(init?.redirect, "error");
    assert.ok(!JSON.stringify(init).includes(API_KEY));
    return Response.json({ data: [] });
  });
  assert.equal(calls, 1);
  assert.equal(imageProviderConfig({ IMAGE_WORKER_URL: "http://image-tunnel:3010", IMAGE_WORKER_TOKEN: TOKEN }).remote, true);
});

test("bad remote configuration fails closed, even when a local OpenAI key exists", () => {
  const env = { OPENAI_API_KEY: API_KEY, IMAGE_WORKER_TOKEN: TOKEN };
  for (const url of ["http://132.243.28.106:3010", "https://user:password@example.com", "https://example.com/path", "https://example.com?key=secret"]) {
    assert.throws(() => imageProviderConfig({ ...env, IMAGE_WORKER_URL: url }));
  }
  assert.throws(() => imageProviderConfig({ OPENAI_API_KEY: API_KEY, IMAGE_WORKER_URL: "http://image-tunnel:3010" }));
  assert.equal(imageProviderConfig({ OPENAI_API_KEY: API_KEY }).url, "https://api.openai.com/v1/images/generations");
});

test("worker connection failure never retries directly against OpenAI", async () => {
  const config = imageProviderConfig({ IMAGE_WORKER_URL: "http://image-tunnel:3010", IMAGE_WORKER_TOKEN: TOKEN, OPENAI_API_KEY: API_KEY });
  let calls = 0;
  await assert.rejects(requestImage("prompt", config, signal(), undefined, async (url) => {
    calls++;
    assert.match(String(url), /image-tunnel/);
    throw new Error("connection refused");
  }));
  assert.equal(calls, 1);
});

test("worker rejects unauthorized and malformed requests before calling OpenAI", async () => {
  let calls = 0;
  const app = createImageWorker({ token: TOKEN, apiKey: API_KEY, fetch: async () => { calls++; return Response.json({}); } });
  assert.equal((await app.request(request({}, "wrong"))).status, 401);
  assert.equal((await app.request(request({}))).status, 400);
  assert.equal((await app.request(request({ prompt: " " }))).status, 400);
  assert.equal((await app.request(request({ prompt: "a".repeat(32_001) }))).status, 400);
  assert.equal((await app.request(request({ prompt: "a".repeat(140_000) }))).status, 413);
  assert.equal(calls, 0);
  assert.throws(() => createImageWorker({ token: "short", apiKey: API_KEY }));
  assert.throws(() => createImageWorker({ token: TOKEN, apiKey: "" }));
});

test("worker uses its own key and fixed generation settings, preserving image data", async () => {
  const image = { data: [{ b64_json: "/9j/2Q==" }] };
  let calls = 0;
  const app = createImageWorker({ token: TOKEN, apiKey: API_KEY, model: "gpt-image-2.5-flare", fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/images/generations");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${API_KEY}`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "gpt-image-2.5-flare", prompt: "Product description", size: "1024x1024", quality: "medium", output_format: "jpeg", output_compression: 80, n: 1,
    });
    return Response.json(image);
  } });
  const response = await app.request(request({ prompt: "Product description", model: "arbitrary", n: 100, quality: "max", url: "https://example.com" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), image);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(calls, 1);
});

test("worker strips upstream errors and keeps access and quota failures distinguishable", async () => {
  for (const [upstreamStatus, expected] of [[401, 403], [403, 403], [429, 429], [500, 502]]) {
    const app = createImageWorker({ token: TOKEN, apiKey: API_KEY, fetch: async () => Response.json({ error: `internal diagnostic ${API_KEY}` }, { status: upstreamStatus }) });
    const response = await app.request(request());
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes(API_KEY));
  }
});

test("worker enforces the five requests per minute limit", async () => {
  let calls = 0;
  const app = createImageWorker({ token: TOKEN, apiKey: API_KEY, fetch: async () => { calls++; return Response.json({ data: [] }); } });
  for (let index = 0; index < 5; index++) assert.equal((await app.request(request())).status, 200);
  assert.equal((await app.request(request())).status, 429);
  assert.equal(calls, 5);
});

test("worker allows at most two simultaneous generations and releases slots after failure", async () => {
  const finish: Array<(response: Response) => void> = [];
  const app = createImageWorker({ token: TOKEN, apiKey: API_KEY, fetch: async () => new Promise<Response>((resolve) => finish.push(resolve)) });
  const first = app.request(request());
  const second = app.request(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finish.length, 2);
  assert.equal((await app.request(request())).status, 429);
  finish[0](new Response(null, { status: 500 }));
  finish[1](Response.json({ data: [] }));
  assert.equal((await first).status, 502);
  assert.equal((await second).status, 200);
  const next = app.request(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finish.length, 3);
  finish[2](Response.json({ data: [] }));
  assert.equal((await next).status, 200);
});

test("response size is bounded for both content-length and chunked responses", async () => {
  await assert.rejects(readImageResponse(new Response("x", { headers: { "Content-Length": String(MAX_IMAGE_RESPONSE_BYTES + 1) } })));
  let cancelled = false;
  let count = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      count++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readImageResponse(new Response(stream)));
  assert.ok(cancelled);
  assert.ok(count <= 25);
});
