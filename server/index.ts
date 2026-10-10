import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { pool } from "./db.js";
import { AppEnv, SESSION_COOKIE, SESSION_SECONDS, hashSessionToken, isValidEmail, newSessionToken, normalizeEmail, requireUser, sessionCookieOptions, verifyPassword } from "./auth.js";
import { migrate } from "./scripts/migrate.js";
import { crmRoutes } from "./crm-routes.js";
import { fileRoutes, publicFileRoutes } from "./storage-routes.js";
import { feedRoutes } from "./feed-routes.js";
import { avitoRoutes } from "./avito-routes.js";
import { webhookRoutes } from "./webhook-routes.js";
import { realtimeRoutes } from "./realtime-routes.js";

const app = new Hono<AppEnv>();
const configuredOrigins = (process.env.APP_ORIGINS || "http://127.0.0.1:3000,http://localhost:3000")
  .split(",").map((value) => value.trim()).filter(Boolean);
const loginAttempts = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();

app.use("/api/*", cors({
  origin: (origin) => configuredOrigins.includes(origin) ? origin : "",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type"],
  credentials: true,
  maxAge: 600,
}));

app.use("/api/*", async (context, next) => {
  const origin = context.req.header("origin");
  if (origin && !configuredOrigins.includes(origin)) return context.json({ error: "origin_forbidden", message: "Этот адрес не разрешён для CRM." }, 403);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method) && context.req.path !== "/api/avito/webhook") {
    if (!origin || !configuredOrigins.includes(origin)) return context.json({ error: "origin_required", message: "Повторите запрос из открытой CRM." }, 403);
  }
  await next();
});

app.get("/healthz", async (context) => {
  try {
    await pool.query("select 1");
    return context.json({ ok: true, database: "connected" });
  } catch {
    return context.json({ ok: false, database: "unavailable" }, 503);
  }
});

app.post("/api/auth/login", async (context) => {
  const ip = context.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.blockedUntil > now) return context.json({ error: "rate_limited", message: "Слишком много попыток входа. Подождите 15 минут." }, 429);
  let body: Record<string, unknown>;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!isValidEmail(email) || !password || password.length > 256) return context.json({ error: "invalid_credentials", message: "Неверный email или пароль." }, 401);
  const result = await pool.query<{ id: string; email: string; password_hash: string }>(
    "select id,email,password_hash from app_users where email = $1",
    [email],
  );
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    const updated = attempt && attempt.resetAt > now ? { ...attempt, count: attempt.count + 1 } : { count: 1, resetAt: now + 15 * 60_000, blockedUntil: 0 };
    if (updated.count >= 10) updated.blockedUntil = now + 15 * 60_000;
    loginAttempts.set(ip, updated);
    return context.json({ error: updated.blockedUntil ? "rate_limited" : "invalid_credentials", message: updated.blockedUntil ? "Слишком много попыток входа. Подождите 15 минут." : "Неверный email или пароль." }, updated.blockedUntil ? 429 : 401);
  }
  loginAttempts.delete(ip);
  const { token, hash } = newSessionToken();
  await pool.query("insert into app_sessions(token_hash,user_id,expires_at) values($1,$2,now() + interval '30 days')", [hash, user.id]);
  const cookie = sessionCookieOptions();
  context.header("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${cookie.path}; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax${cookie.secure ? "; Secure" : ""}`);
  return context.json({ user: { id: user.id, email: user.email } });
});

app.get("/api/auth/session", requireUser, (context) => context.json({ user: context.get("user") }));

app.post("/api/auth/logout", async (context) => {
  const cookie = context.req.header("cookie") ?? "";
  const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (value) {
    try { await pool.query("delete from app_sessions where token_hash = $1", [hashSessionToken(decodeURIComponent(value))]); } catch { /* Expire the browser cookie even if the database is temporarily unavailable. */ }
  }
  const secure = process.env.COOKIE_SECURE !== "false" ? "; Secure" : "";
  context.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  return context.json({ ok: true });
});

app.route("/api/crm", crmRoutes);
app.route("/api/files", fileRoutes);
app.route("/api/avito", avitoRoutes);
app.route("/api/avito", realtimeRoutes);
app.route("/public/avito/images", publicFileRoutes);
app.route("/feeds", feedRoutes);
app.route("/webhooks", webhookRoutes);

app.notFound((context) => context.json({ error: "not_found", message: "Адрес не найден." }, 404));
app.onError((error, context) => {
  console.error("Backend request failed:", error.message);
  return context.json({ error: "server_error", message: "Не удалось выполнить запрос. Повторите позже." }, 500);
});

const port = Number(process.env.PORT || 3001);
async function main() {
  await migrate();
  const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    console.info(`CRM backend listening on ${info.address}:${info.port}`);
  });
  const cleanup = setInterval(() => {
    void pool.query("delete from app_sessions where expires_at <= now()").catch(() => {});
  }, 60 * 60 * 1000);
  cleanup.unref();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      clearInterval(cleanup);
      server.close();
      void pool.end().finally(() => { process.exitCode = 0; });
    });
  }
}

void main().catch(async (error: unknown) => {
  console.error("CRM backend could not start:", error instanceof Error ? error.message : "unknown error");
  await pool.end();
  process.exitCode = 1;
});
