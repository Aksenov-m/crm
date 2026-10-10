import { Hono } from "hono";
import { createAvitoHandler } from "./avito/handler.js";
import { AppEnv, requireUser, resolveUserFromCookie } from "./auth.js";
import { avitoApiAccountsForOwner, createAvitoApiAccount } from "./avito-credentials.js";
import { avitoCachedChats, avitoCachedMessages, avitoStorage, cacheAvitoMessages, connectAvitoItem } from "./avito-storage.js";
import { pool } from "./db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVITO_ID = /^[1-9][0-9]{0,18}$/;
const ACCOUNT_KEY = /^[a-zA-Z0-9_-]{1,40}$/;
type Input = Record<string, unknown>;
const credentialAttempts = new Map<string, { count: number; resetAt: number }>();

const environment = (name: string) => process.env[name];
const handler = createAvitoHandler({
  env: environment,
  fetch: globalThis.fetch.bind(globalThis),
  storage: avitoStorage,
  cacheMessages: cacheAvitoMessages,
  accountsForOwner: avitoApiAccountsForOwner,
  authenticate: async (request) => (await resolveUserFromCookie(request.headers.get("cookie") || ""))?.id || "",
});

export const avitoRoutes = new Hono<AppEnv>();
avitoRoutes.post("/accounts", requireUser, async (context) => {
  const ownerId = context.get("user").id;
  const attempt = credentialAttempts.get(ownerId);
  const now = Date.now();
  if (attempt && attempt.resetAt > now && attempt.count >= 5) return context.json({ error: "rate_limited", message: "Слишком много попыток. Попробуйте добавить ключи позже." }, 429);

  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Проверьте заполнение полей и повторите попытку." }, 400); }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)
    || !clientId || clientId.length > 500 || /[\u0000-\u001f\u007f]/.test(clientId)
    || !clientSecret || clientSecret.length > 500 || /[\u0000-\u001f\u007f]/.test(clientSecret)) {
    return context.json({ error: "invalid_request", message: "Укажите название, Client ID и Client Secret Авито." }, 400);
  }
  if (!/^[a-f0-9]{64}$/i.test(process.env.AVITO_CREDENTIALS_ENCRYPTION_KEY || "")) {
    return context.json({ error: "server_configuration", message: "Сервер ещё не настроен для безопасного хранения ключей Авито." }, 503);
  }
  try {
    if (attempt && attempt.resetAt > now) attempt.count += 1;
    else credentialAttempts.set(ownerId, { count: 1, resetAt: now + 60 * 60_000 });
    const { rows: countRows } = await pool.query<{ count: string }>("select count(*)::text as count from avito_api_accounts where owner_id=$1", [ownerId]);
    if (Number(countRows[0]?.count || 0) >= 10) return context.json({ error: "account_limit", message: "Можно подключить не больше 10 аккаунтов Авито." }, 409);

    const tokenResponse = await fetch("https://api.avito.ru/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    const tokenBody = await tokenResponse.json().catch(() => null) as { access_token?: unknown; error?: unknown } | null;
    const tokenError = typeof tokenBody?.error === "string" ? tokenBody.error : "";
    if (tokenError === "unauthorized_client") {
      return context.json({ error: "avito_client_credentials_unavailable", message: "У приложения Авито нет доступа к авторизации client_credentials. Проверьте, что это ключи Business API для вашего аккаунта и что доступ к API включён в кабинете Авито." }, 400);
    }
    if (tokenError === "invalid_client" || !tokenResponse.ok) {
      return context.json({ error: "invalid_avito_credentials", message: "Авито не приняло Client ID и Client Secret. Проверьте, что скопировали оба значения из настроек одного приложения." }, 400);
    }
    if (tokenError) {
      return context.json({ error: "avito_auth_rejected", message: "Авито отклонило авторизацию приложения. Проверьте настройки доступа к API в кабинете Авито." }, 400);
    }
    const accessToken = typeof tokenBody?.access_token === "string" ? tokenBody.access_token : "";
    if (!accessToken || accessToken.length > 8192) return context.json({ error: "invalid_avito_response", message: "Авито вернуло неожиданный ответ. Повторите попытку позже." }, 502);
    const profileResponse = await fetch("https://api.avito.ru/core/v1/accounts/self", {
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) return context.json({ error: "avito_access_denied", message: "Ключи приняты, но приложение не получило доступ к аккаунту Авито. Проверьте права приложения." }, 400);
    const profile = await profileResponse.json().catch(() => null) as { id?: unknown } | null;
    const avitoId = typeof profile?.id === "number" ? String(profile.id) : profile?.id;
    if (typeof avitoId !== "string" || !AVITO_ID.test(avitoId)) return context.json({ error: "invalid_avito_response", message: "Авито не вернуло ID аккаунта. Проверьте права приложения и повторите попытку." }, 502);

    const account = await createAvitoApiAccount(ownerId, name, clientId, clientSecret);
    credentialAttempts.delete(ownerId);
    return context.json({ account: { key: account.key, name: account.name } }, 201, { "Cache-Control": "no-store" });
  } catch {
    return context.json({ error: "avito_account_save_failed", message: "Не удалось сохранить ключи Авито. Повторите попытку позже." }, 503);
  }
});

avitoRoutes.post("/", requireUser, async (context) => handler(context.req.raw));

avitoRoutes.get("/callback", async (context) => {
  const user = await resolveUserFromCookie(context.req.header("cookie") || "");
  if (!user) return context.text("Войдите в CRM и повторите подключение Авито.", 401);
  const url = new URL(context.req.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const providerError = url.searchParams.get("error") || "";
  const frontendOrigin = (process.env.APP_ORIGINS || "https://proaksenov.ru").split(",").map((value) => value.trim()).find(Boolean) || "https://proaksenov.ru";
  const response = await handler(new Request("http://backend/api/avito", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": context.req.header("cookie") || "", "Origin": frontendOrigin },
    body: JSON.stringify({ action: "oauth_callback", code, state, ...(providerError ? { error: providerError } : {}) }),
  }));
  const result = await response.json().catch(() => ({})) as Input;
  if (!response.ok || result.connected !== true) {
    const errorUrl = new URL("/?avito=error", frontendOrigin);
    errorUrl.searchParams.set("avito_error", typeof result.message === "string" ? result.message.slice(0, 200) : "Подключение Авито не завершено.");
    return context.redirect(errorUrl.href, 303);
  }
  const returnOrigin = typeof result.returnOrigin === "string" && (process.env.APP_ORIGINS || "https://proaksenov.ru").split(",").map((value) => value.trim()).includes(result.returnOrigin) ? result.returnOrigin : frontendOrigin;
  const returnUrl = new URL("/", returnOrigin);
  returnUrl.searchParams.set("avito", "connected");
  returnUrl.searchParams.set("avito_account", String(result.accountKey));
  return context.redirect(returnUrl.href, 303);
});

avitoRoutes.get("/links", requireUser, async (context) => {
  const accountId = context.req.query("account_id") || "";
  const productId = context.req.query("product_id") || "";
  if ((!accountId && !productId) || (accountId && !AVITO_ID.test(accountId)) || (productId && !UUID.test(productId))) return context.json({ error: "invalid_account", message: "Некорректный аккаунт или товар Авито." }, 400);
  const { rows } = accountId
    ? await pool.query("select account_id,item_id,product_id from avito_item_links where owner_id=$1 and account_id=$2 order by item_id", [context.get("user").id,accountId])
    : await pool.query("select account_id,item_id,product_id from avito_item_links where owner_id=$1 and product_id=$2 order by item_id", [context.get("user").id,productId]);
  return context.json(rows);
});

avitoRoutes.post("/connect-item", requireUser, async (context) => {
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const item = body.item && typeof body.item === "object" && !Array.isArray(body.item) ? body.item as Input : null;
  const productId = typeof body.productId === "string" ? body.productId : null;
  if (!AVITO_ID.test(accountId) || !item || (productId && !UUID.test(productId))) return context.json({ error: "invalid_request", message: "Некорректные данные объявления." }, 400);
  try {
    const result = await connectAvitoItem(context.get("user").id, accountId, item, productId);
    return context.json({ productId: result });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "23503") return context.json({ error: "related_record", message: "Товар больше недоступен. Обновите CRM." }, 400);
    if (code === "23505" || (error instanceof Error && error.message.includes("another product"))) return context.json({ error: "duplicate_link", message: "Объявление уже связано с другим товаром." }, 409);
    return context.json({ error: "link_failed", message: "Не удалось связать объявление с товаром." }, 400);
  }
});

avitoRoutes.patch("/products/:id/description", requireUser, async (context) => {
  const id = context.req.param("id") || "";
  if (!UUID.test(id)) return context.json({ error: "invalid_id", message: "Некорректный товар." }, 400);
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const description = typeof body.description === "string" ? body.description.trim().slice(0,20_000) : "";
  const result = await pool.query("update products set description=$3 where owner_id=$1 and id=$2 returning id", [context.get("user").id,id,description]);
  return result.rowCount ? context.json({ ok: true }) : context.json({ error: "not_found", message: "Товар не найден." }, 404);
});

avitoRoutes.patch("/products/:id/image", requireUser, async (context) => {
  const id = context.req.param("id") || "";
  if (!UUID.test(id)) return context.json({ error: "invalid_id", message: "Некорректный товар." }, 400);
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const imagePath = typeof body.imagePath === "string" ? body.imagePath : "";
  if (!imagePath.startsWith(`${context.get("user").id}/${id}/`)) return context.json({ error: "invalid_image", message: "Некорректный путь фотографии." }, 400);
  const result = await pool.query("update products set image_path=$3 where owner_id=$1 and id=$2 returning id", [context.get("user").id,id,imagePath]);
  return result.rowCount ? context.json({ ok: true }) : context.json({ error: "not_found", message: "Товар не найден." }, 404);
});

avitoRoutes.get("/cached/chats", requireUser, async (context) => {
  const accountKey = context.req.query("account_key") || "";
  const offset = Number(context.req.query("offset") || 0);
  if (!ACCOUNT_KEY.test(accountKey) || !Number.isInteger(offset) || offset < 0 || offset > 1000) return context.json({ error: "invalid_request", message: "Некорректная страница переписки." }, 400);
  return context.json(await avitoCachedChats(context.get("user").id,accountKey,offset));
});

avitoRoutes.get("/cached/messages", requireUser, async (context) => {
  const accountKey = context.req.query("account_key") || "";
  const chatId = context.req.query("chat_id") || "";
  const offset = Number(context.req.query("offset") || 0);
  if (!ACCOUNT_KEY.test(accountKey) || !chatId || chatId.length > 200 || !Number.isInteger(offset) || offset < 0 || offset > 1000) return context.json({ error: "invalid_request", message: "Некорректная страница переписки." }, 400);
  return context.json(await avitoCachedMessages(context.get("user").id,accountKey,chatId,offset));
});
