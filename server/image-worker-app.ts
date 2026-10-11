import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { readImageResponse, requestImage } from "./image-provider.js";

export function createImageWorker(options: { token: string; apiKey: string; model?: string; fetch?: typeof fetch }) {
  const token = options.token.trim();
  const apiKey = options.apiKey.trim();
  if (token.length < 32 || !apiKey) throw new Error("Configure IMAGE_WORKER_TOKEN (32+ characters) and OPENAI_API_KEY");
  const authorization = Buffer.from(`Bearer ${token}`);
  const app = new Hono();
  let active = 0;
  let requests: number[] = [];

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("/v1/*", async (c, next) => {
    const supplied = Buffer.from(c.req.header("authorization") || "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.post("/v1/images/generations", bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: "request_too_large" }, 413),
  }), async (c) => {
    let prompt: string;
    try {
      const input: unknown = await c.req.json();
      if (!input || typeof input !== "object" || !("prompt" in input) || typeof input.prompt !== "string") throw new Error();
      prompt = input.prompt.trim();
      if (!prompt || prompt.length > 32_000) throw new Error();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const now = Date.now();
    requests = requests.filter((time) => now - time < 60_000);
    if (active >= 2 || requests.length >= 5) return c.json({ error: "image_worker_busy" }, 429);
    requests.push(now);
    active += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, 120_000);
    c.req.raw.signal.addEventListener("abort", abort, { once: true });
    if (c.req.raw.signal.aborted) abort();
    try {
      // Only this fixed OpenAI endpoint is callable; the client cannot choose a URL,
      // model, image count, or quality. The OpenAI key belongs to this worker.
      const upstream = await requestImage(prompt, {
        url: "https://api.openai.com/v1/images/generations", token: apiKey, remote: false,
      }, controller.signal, options.model, options.fetch);
      if (!upstream.ok) {
        console.warn("Image worker: OpenAI status", upstream.status);
        await upstream.body?.cancel();
        const status = upstream.status === 401 || upstream.status === 403 ? 403 : upstream.status === 429 ? 429 : 502;
        return c.json({ error: "openai_image_generation_failed" }, status);
      }
      const bytes = await readImageResponse(upstream);
      return new Response(bytes as unknown as BodyInit, {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch {
      return c.json({ error: controller.signal.aborted ? "image_generation_timeout" : "openai_unavailable" }, controller.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(timeout);
      c.req.raw.signal.removeEventListener("abort", abort);
      active -= 1;
    }
  });
  app.onError((_error, c) => c.json({ error: "image_worker_error" }, 500));
  return app;
}
