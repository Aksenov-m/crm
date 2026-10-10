import { signWebhook, webhookSecret, type MessengerBinding } from "./messenger.ts";
import type { AvitoApiAccount } from "../avito-credentials.js";

type Environment = (name: string) => string | undefined;
type Account = AvitoApiAccount;
type Json = Record<string, unknown>;
type Dependencies = {
  env: Environment;
  fetch: typeof fetch;
  now?: () => number;
  storage?: (path: string, init?: RequestInit, timeout?: number) => Promise<unknown>;
  cacheMessages?: (binding: MessengerBinding, chatId: string, messages: unknown[], webhook?: boolean) => Promise<unknown>;
  authenticate?: (request: Request) => Promise<string>;
  accountsForOwner?: (ownerId: string) => Promise<Account[]>;
};
type StoredOAuthToken = { accessToken: string; refreshToken: string; expiresAt: number; tokenType: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API = "https://api.avito.ru";
const TIMEOUT = 15000;
const PRODUCTION_OAUTH_REDIRECT_URI = "https://proaksenov.ru/api/avito/callback,";
const PRODUCTION_APP_ORIGIN = "https://proaksenov.ru";
const LOCAL_APP_ORIGIN = "http://127.0.0.1:3000";
const OAUTH_SCOPES = ["items:info", "messenger:read", "messenger:write", "user:read"];

function oauthReturnOriginForOrigin(origin: string | null, allowedOrigins: string[]): string {
  return origin && allowedOrigins.includes(origin) ? origin : allowedOrigins.find((value) => value.startsWith("https://")) || PRODUCTION_APP_ORIGIN;
}

function isOAuthRedirectUri(value: string, env: Environment): boolean {
  return value === (env("AVITO_CALLBACK_URL") || PRODUCTION_OAUTH_REDIRECT_URI);
}

function oauthState(returnOrigin: string): string {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  return base64Url(new TextEncoder().encode(JSON.stringify({ nonce: base64Url(nonce), return_origin: returnOrigin })));
}

function oauthReturnOriginFromState(state: string, allowedOrigins: string[]): string {
  try {
    const padded = state.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (state.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const payload = optionalObject(JSON.parse(new TextDecoder().decode(bytes)));
    const candidate = text(payload.return_origin);
    return allowedOrigins.includes(candidate) ? candidate : allowedOrigins.find((value) => value.startsWith("https://")) || PRODUCTION_APP_ORIGIN;
  } catch {
    return PRODUCTION_APP_ORIGIN;
  }
}

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "invalid_response", "Сервис вернул неожиданный ответ. Повторите запрос позже.");
  return value as Json;
}
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function optionalObject(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function hex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
async function sha256(value: string): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function chatIdentifier(value: unknown): string {
  // Avito documents chat_id as an opaque string. Do not restrict it to a
  // guessed alphabet: real IDs may contain separators such as `:` or `/`.
  // It is encoded only when inserted into the upstream URL below.
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError(400, "invalid_request", "Некорректный идентификатор чата.");
  }
  return value;
}
function messengerMessage(value: unknown) {
  const row = object(value);
  if (!text(row.id) || !Number.isFinite(row.created) || !["in", "out"].includes(text(row.direction))) throw new ApiError(502, "invalid_response", "Авито вернуло некорректное сообщение.");
  const content = optionalObject(row.content);
  const type = text(row.type, "unknown");
  const labels: Record<string, string> = { image: "Фотография — откройте в Авито", voice: "Голосовое сообщение — откройте в Авито", deleted: "Сообщение удалено", call: "Звонок", location: "Геолокация", item: "Объявление", system: "Системное сообщение" };
  return { id: text(row.id), text: type === "deleted" ? labels.deleted : text(content.text) || text(optionalObject(content.link).text) || labels[type] || "Вложение — откройте в Авито", type, created: Number(row.created), direction: text(row.direction) as "in" | "out", isRead: row.is_read === true };
}
function descriptionText(value: unknown): string { return typeof value === "string" ? value.trim().slice(0, 20000) : ""; }
function identifier(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  throw new ApiError(502, "invalid_response", "Авито вернул некорректный идентификатор.");
}
function avitoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === "avito.ru" || url.hostname.endsWith(".avito.ru")) ? url.href : null;
  } catch { return null; }
}
function avitoImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === "avito.ru" || host.endsWith(".avito.ru") || host === "avito.st" || host.endsWith(".avito.st");
    return url.protocol === "https:" && !url.username && !url.password && !url.port && allowedHost ? url.href : null;
  } catch { return null; }
}
const IMAGE_KEYS = ["1280x960", "1024x768", "640x480", "450x338", "300x225", "140x105", "original", "default", "main", "url", "src", "href", "image_url", "imageUrl", "image", "file", "photo", "photos", "images", "urls", "sizes"];
function imageUrl(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof value === "string") return avitoImageUrl(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = imageUrl(entry, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Json;
  for (const key of IMAGE_KEYS) {
    const result = imageUrl(row[key], depth + 1);
    if (result) return result;
  }
  // Avito occasionally returns image sizes under arbitrary numeric keys or a
  // wrapper that is not named in the public examples. JSON responses cannot
  // contain cycles, so bounded traversal is enough here.
  for (const entry of Object.values(row)) {
    const result = imageUrl(entry, depth + 1);
    if (result) return result;
  }
  return null;
}
function itemImageUrl(row: Json): string | null {
  for (const key of ["image_url", "imageUrl", "images", "image", "photos", "photo", "main_image", "mainImage"]) {
    const result = imageUrl(row[key]);
    if (result) return result;
  }
  return null;
}
function accountsFromEnv(env: Environment): Account[] {
  const json = env("AVITO_ACCOUNTS_JSON");
  let accounts: unknown;
  try {
    accounts = json ? JSON.parse(json) : env("AVITO_CRM_OWNER_ID") && env("AVITO_CLIENT_ID") && env("AVITO_CLIENT_SECRET")
      ? [{ key: "main", name: "Мой аккаунт Авито", ownerId: env("AVITO_CRM_OWNER_ID"), clientId: env("AVITO_CLIENT_ID"), clientSecret: env("AVITO_CLIENT_SECRET") }]
      : [];
  } catch { return []; }
  if (!Array.isArray(accounts) || accounts.length > 20) return [];
  const keys = new Set<string>();
  const valid: Account[] = [];
  for (const entry of accounts) {
    const value = optionalObject(entry);
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(text(value.key)) || !UUID.test(text(value.ownerId)) || !text(value.clientId).trim() || !text(value.clientSecret).trim() || !text(value.name).trim() || keys.has(text(value.key))) continue;
    keys.add(text(value.key));
    valid.push(value as Account);
  }
  return valid;
}

function productIdentifier(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "invalid_request", "Некорректный идентификатор товара.");
  return value;
}

function feedSecret(env: Environment): string {
  const secret = env("AVITO_FEED_SECRET") || "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new ApiError(503, "feed_configuration", "Добавьте AVITO_FEED_SECRET (64 случайных шестнадцатеричных символа) в конфигурацию backend.");
  return secret;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

export function createAvitoHandler(dependencies: Dependencies) {
  const { env } = dependencies;
  const now = dependencies.now ?? Date.now;
  const tokens = new Map<string, { value: string; expiresAt: number }>();
  const pendingTokens = new Map<string, Promise<string>>();
  const storage = dependencies.storage || (async () => { throw new Error("CRM database adapter is not configured"); });
  const cacheMessages = dependencies.cacheMessages || (async () => { throw new Error("CRM message cache is not configured"); });
  const storageConfigured = () => Boolean(dependencies.storage);

  async function request(url: string, init: RequestInit, timeout = TIMEOUT): Promise<Response> {
    try { return await dependencies.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) }); }
    catch { throw new ApiError(502, "network_error", "Сервис недоступен или не ответил вовремя. Проверьте подключение и повторите запрос."); }
  }
  async function json(response: Response): Promise<Json> {
    try { return object(await response.json()); }
    catch { throw new ApiError(502, "invalid_response", "Сервис вернул неожиданный ответ. Повторите запрос позже."); }
  }
  function cacheKey(account: Account) { return `${account.key}:${account.clientId}:${account.clientSecret}`; }
  function avitoError(status: number, upstreamMessage = ""): ApiError {
    const detail = upstreamMessage.trim().slice(0, 300);
    if (status === 402) return new ApiError(402, "avito_subscription", detail ? `Авито отклонил доступ к Messenger API: ${detail}` : "Для переписки нужен доступ к Messenger API в подписке Авито. Проверьте тариф основного аккаунта.");
    if (status === 401) return new ApiError(502, "avito_auth", "Авито отклонил авторизацию. Проверьте Client ID, Client Secret и тип доступа приложения.");
    if (status === 403) return new ApiError(403, "avito_access", "Авито не разрешил этот запрос. Проверьте права API и условия доступа вашего аккаунта.");
    if (status === 404) return new ApiError(404, "not_found", "Авито не нашло запрошенный ресурс.");
    if (status === 429) return new ApiError(429, "avito_rate_limit", "Достигнут лимит запросов Авито. Подождите и повторите позже.");
    return new ApiError(502, "avito_error", "Авито не выполнил запрос. Повторите позже; если ошибка сохраняется, проверьте доступ к API.");
  }
  async function upstreamError(response: Response): Promise<ApiError> {
    let message = "";
    try {
      const body = optionalObject(await response.clone().json());
      const nested = optionalObject(body.error);
      const candidate = text(nested.message) || text(body.message);
      if (candidate && !/access[_ -]?token|client[_ -]?secret|authorization/i.test(candidate)) message = candidate;
    } catch { /* Use the safe status-based message below. */ }
    return avitoError(response.status, message);
  }
  async function storedOAuthToken(account: Account): Promise<StoredOAuthToken | null> {
    if (!storageConfigured()) return null;
    try {
      const rows = await storage(`avito_oauth_tokens?owner_id=eq.${account.ownerId}&account_key=eq.${account.key}&select=access_token,refresh_token,expires_at,token_type`);
      const row = Array.isArray(rows) ? optionalObject(rows[0]) : {};
      const expiresAt = Date.parse(text(row.expires_at));
      if (!text(row.access_token) || !text(row.refresh_token) || !Number.isFinite(expiresAt)) return null;
      return { accessToken: text(row.access_token), refreshToken: text(row.refresh_token), expiresAt, tokenType: text(row.token_type, "Bearer") };
    } catch {
      // Continue with the client credentials token when no saved OAuth token is available.
      return null;
    }
  }
  async function saveOAuthToken(account: Account, data: Json, previousRefreshToken = ""): Promise<StoredOAuthToken> {
    const accessToken = text(data.access_token);
    const refreshToken = text(data.refresh_token, previousRefreshToken);
    const tokenType = text(data.token_type, "Bearer");
    const expiresIn = Number(data.expires_in);
    if (!accessToken || !refreshToken || tokenType.toLowerCase() !== "bearer" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new ApiError(502, "avito_auth", "Авито вернул неполный OAuth-токен. Подключите аккаунт ещё раз.");
    }
    const token: StoredOAuthToken = { accessToken, refreshToken, expiresAt: now() + expiresIn * 1000, tokenType };
    await storage("avito_oauth_tokens?on_conflict=owner_id,account_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ owner_id: account.ownerId, account_key: account.key, access_token: token.accessToken, refresh_token: token.refreshToken, token_type: token.tokenType, expires_at: new Date(token.expiresAt).toISOString(), scope: text(data.scope) || null }),
    });
    return token;
  }
  async function oauthTokenError(response: Response): Promise<ApiError> {
    let detail = "";
    try {
      const body = optionalObject(await response.clone().json());
      const value = text(body.error_description) || text(body.error);
      if (value && !/access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization/i.test(value)) detail = value;
    } catch { /* Use the safe generic message below. */ }
    return new ApiError(502, "avito_auth", detail ? `Авито не подтвердило OAuth-подключение: ${detail}` : "Авито не подтвердило OAuth-подключение. Запустите подключение ещё раз.");
  }
  async function refreshOAuthToken(account: Account, token: StoredOAuthToken): Promise<string> {
    const response = await request(`${API}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: account.clientId, client_secret: account.clientSecret, refresh_token: token.refreshToken }),
    });
    if (!response.ok) throw await oauthTokenError(response);
    const data = await json(response);
    if (text(data.error)) throw await oauthTokenError(response);
    const refreshed = await saveOAuthToken(account, data, token.refreshToken);
    tokens.set(cacheKey(account), { value: refreshed.accessToken, expiresAt: Math.max(now(), refreshed.expiresAt - 60000) });
    return refreshed.accessToken;
  }
  async function beginOAuth(account: Account, returnOrigin: string) {
    if (!storageConfigured()) throw new ApiError(503, "oauth_storage", "Не настроено постоянное хранилище OAuth на сервере.");
    const state = oauthState(returnOrigin);
    const redirectUri = env("AVITO_CALLBACK_URL") || PRODUCTION_OAUTH_REDIRECT_URI;
    const stateHash = await sha256(state);
    try {
      await storage(`avito_oauth_states?expires_at=lt.${encodeURIComponent(new Date(now()).toISOString())}`, { method: "DELETE" });
      await storage("avito_oauth_states", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ owner_id: account.ownerId, account_key: account.key, state_hash: stateHash, redirect_uri: redirectUri, expires_at: new Date(now() + 10 * 60 * 1000).toISOString() }),
      });
    } catch { throw new ApiError(503, "oauth_storage", "Не удалось сохранить состояние OAuth в базе данных. Повторите подключение."); }
    const url = new URL("https://avito.ru/oauth");
    url.searchParams.set("client_id", account.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("pro_users_flow", "true");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", OAUTH_SCOPES.join(","));
    url.searchParams.set("state", state);
    return { authorizeUrl: url.href, redirectUri };
  }
  async function consumeOAuthState(ownerId: string, state: string): Promise<{ accountKey: string; redirectUri: string; returnOrigin: string }> {
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(state)) throw new ApiError(400, "oauth_state", "Некорректное состояние OAuth. Запустите подключение Авито ещё раз.");
    try {
      const rows = await storage("rpc/avito_consume_oauth_state", { method: "POST", body: JSON.stringify({ p_owner: ownerId, p_state_hash: await sha256(state) }) });
      const row = Array.isArray(rows) ? optionalObject(rows[0]) : {};
      const accountKey = text(row.account_key);
      const redirectUri = text(row.redirect_uri);
      if (!accountKey || !isOAuthRedirectUri(redirectUri, env)) throw new ApiError(400, "oauth_state", "Ссылка OAuth устарела. Запустите подключение Авито ещё раз.");
      const allowedOrigins = (env("AVITO_ALLOWED_ORIGINS") || PRODUCTION_APP_ORIGIN).split(",").map((value) => value.trim());
      return { accountKey, redirectUri, returnOrigin: oauthReturnOriginFromState(state, allowedOrigins) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "oauth_storage", "Не удалось проверить состояние OAuth в базе данных. Повторите подключение.");
    }
  }
  async function completeOAuth(account: Account, code: string, redirectUri: string): Promise<void> {
    if (!code || code.length > 4096) throw new ApiError(400, "oauth_code", "Авито вернул некорректный код авторизации.");
    const response = await request(`${API}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: account.clientId, client_secret: account.clientSecret, code, redirect_uri: redirectUri }),
    });
    if (!response.ok) throw await oauthTokenError(response);
    const data = await json(response);
    if (text(data.error)) throw new ApiError(502, "avito_auth", "Авито не подтвердило OAuth-подключение. Запустите подключение ещё раз.");
    try {
      const token = await saveOAuthToken(account, data);
      tokens.set(cacheKey(account), { value: token.accessToken, expiresAt: Math.max(now(), token.expiresAt - 60000) });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "oauth_storage", "Авито подтвердило доступ, но сохранить токены не удалось. Проверьте базу данных.");
    }
  }
  async function accessToken(account: Account, mode: "auto" | "client" = "auto"): Promise<string> {
    const key = `${mode}:${cacheKey(account)}`;
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const pending = pendingTokens.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const oauth = mode === "auto" ? await storedOAuthToken(account) : null;
      if (oauth) {
        if (oauth.expiresAt > now() + 60000) {
          tokens.set(key, { value: oauth.accessToken, expiresAt: oauth.expiresAt - 60000 });
          return oauth.accessToken;
        }
        return refreshOAuthToken(account, oauth);
      }
      const response = await request(`${API}/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: account.clientId, client_secret: account.clientSecret }),
      });
      if (!response.ok) throw response.status === 400 ? avitoError(401) : avitoError(response.status);
      const data = await json(response);
      if (text(data.error)) {
        // Avito can return OAuth errors with HTTP 200. Do not turn that into
        // a misleading "invalid token" response or silently serve one cache row.
        throw new ApiError(502, "avito_auth", "Приложение Авито не разрешает авторизацию client_credentials. Проверьте тип доступа приложения и ключи Авито.");
      }
      const expires = Number(data.expires_in);
      if (!text(data.access_token) || !Number.isFinite(expires) || expires <= 0 || text(data.token_type).toLowerCase() !== "bearer") throw new ApiError(502, "invalid_token", "Авито вернул некорректный ответ авторизации.");
      if (tokens.size > 40) tokens.clear();
      tokens.set(key, { value: text(data.access_token), expiresAt: now() + Math.max(0, Math.min(expires, 86400) - 60) * 1000 });
      return text(data.access_token);
    })();
    pendingTokens.set(key, promise);
    try { return await promise; } finally { pendingTokens.delete(key); }
  }
  async function avitoGet(account: Account, path: string, mode: "auto" | "client" = "auto"): Promise<Json> {
    return object(await avitoGetValue(account, path, mode));
  }
  async function avitoGetValue(account: Account, path: string, mode: "auto" | "client" = "auto"): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(account, mode);
      const response = await request(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (response.status === 401 && attempt === 0) { tokens.delete(`${mode}:${cacheKey(account)}`); continue; }
      if (!response.ok) throw await upstreamError(response);
      try { return await response.json(); }
      catch { throw new ApiError(502, "invalid_response", "Авито вернуло некорректный ответ."); }
    }
    throw avitoError(401);
  }
  async function avitoPost(account: Account, path: string, body?: Json, mode: "auto" | "client" = "auto"): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(account, mode);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      const init: RequestInit = { method: "POST", headers };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await request(`${API}${path}`, {
        ...init,
      });
      if (response.status === 401 && attempt === 0) { tokens.delete(`${mode}:${cacheKey(account)}`); continue; }
      if (!response.ok) throw await upstreamError(response);
      return response;
    }
    throw avitoError(401);
  }
  async function accountByAvitoId(accounts: Account[], accountId: string): Promise<Account> {
    for (const candidate of accounts) {
      const profile = await avitoGet(candidate, "/core/v1/accounts/self");
      if (identifier(profile.id) === accountId) return candidate;
    }
    throw new ApiError(403, "account_not_allowed", "Связанный аккаунт Авито больше не доступен этому пользователю CRM.");
  }
  async function cacheHistory(binding: MessengerBinding, chatId: string, messages: unknown[]): Promise<string | undefined> {
    if (!storageConfigured()) return "Не настроено сохранение переписки на сервере.";
    try { await cacheMessages(binding, chatId, messages); }
    catch { return "Сообщения получены из Авито, но копия в CRM не сохранена. Проверьте подключение к базе данных."; }
  }
  async function boundedImageBody(response: Response): Promise<Uint8Array> {
    const maxBytes = 5 * 1024 * 1024;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new ApiError(413, "image_too_large", "Фотография объявления слишком большая.");
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new ApiError(413, "image_too_large", "Фотография объявления слишком большая.");
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maxBytes) throw new ApiError(413, "image_too_large", "Фотография объявления слишком большая.");
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  function serviceConfiguration() {
    const url = env("PUBLIC_API_URL")?.replace(/\/$/, "");
    if (!url) throw new ApiError(503, "server_configuration", "Не настроен публичный адрес API.");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) throw new ApiError(503, "server_configuration", "Публичный адрес API должен использовать HTTPS.");
    return { url, key: "" };
  }

  function cleanPublicationText(value: unknown, max: number, label: string): string {
    const result = text(value).trim();
    if (!result || result.length > max) throw new ApiError(400, "invalid_request", `${label} должно содержать от 1 до ${max} символов.`);
    return result;
  }

  async function publicationProduct(ownerId: string, productId: string): Promise<Json> {
    const rows = await storage(`products?select=id,title,description,price,image_path,category,stage&owner_id=eq.${encodeURIComponent(ownerId)}&id=eq.${encodeURIComponent(productId)}`);
    const row = Array.isArray(rows) ? optionalObject(rows[0]) : {};
    if (!text(row.id)) throw new ApiError(404, "product_not_found", "Товар не найден в CRM или недоступен этому пользователю.");
    return row;
  }

  async function publishItem(account: Account, ownerId: string, input: Json, config: ReturnType<typeof serviceConfiguration>): Promise<Json> {
    const productId = productIdentifier(input.productId);
    const product = await publicationProduct(ownerId, productId);
    const title = cleanPublicationText(product.title, 120, "Название объявления");
    const description = cleanPublicationText(product.description, 5000, "Описание объявления");
    const category = cleanPublicationText(product.category, 300, "Категория");
    const price = Number(product.price);
    if (!Number.isSafeInteger(price) || price <= 0 || price >= 1e12) throw new ApiError(400, "invalid_request", "Для публикации нужна целая цена в рублях больше нуля.");
    const imagePath = text(product.image_path);
    if (!imagePath || !imagePath.startsWith(`${ownerId}/${productId}/`)) throw new ApiError(400, "publication_image", "Перед публикацией загрузите фотографию товара в CRM. Встроенное демо-фото не подходит для Авито.");
    if (text(product.stage) === "sold") throw new ApiError(400, "invalid_request", "Проданный товар нельзя публиковать на Авито.");
    const address = cleanPublicationText(input.address, 500, "Адрес");
    const managerName = cleanPublicationText(input.managerName, 120, "Имя продавца");
    const contactPhone = cleanPublicationText(input.contactPhone, 40, "Телефон");
    const reportEmail = text(input.reportEmail).trim();
    if (reportEmail && (!/^\S+@\S+\.\S+$/u.test(reportEmail) || reportEmail.length > 200)) throw new ApiError(400, "invalid_request", "Укажите корректную почту для отчётов Авито.");
    const agreement = input.acceptAgreement === true;
    const feedUrl = new URL(`${config.url}/feeds/avito`);
    feedUrl.searchParams.set("owner_id", ownerId);
    feedUrl.searchParams.set("account_key", account.key);
    feedUrl.searchParams.set("token", await hmacHex(feedSecret(env), `${ownerId}|${account.key}`));
    const publication = { owner_id: ownerId, account_key: account.key, product_id: productId, status: "pending", address, manager_name: managerName, contact_phone: contactPhone, ...(reportEmail ? { report_email: reportEmail } : {}), last_error: null };
    try {
      await storage("avito_publications?on_conflict=owner_id%2Caccount_key%2Cproduct_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(publication) });
    } catch { throw new ApiError(503, "publication_storage", "Не удалось сохранить публикацию в базе данных. Повторите действие позже."); }

    let profile: Json | null = null;
    try { profile = await avitoGet(account, "/autoload/v2/profile", "client"); }
    catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    const existingFeeds = Array.isArray(profile?.feeds_data) ? profile.feeds_data.map(optionalObject).filter((feed) => text(feed.feed_url).startsWith("http")) : [];
    const feeds = existingFeeds.filter((feed) => text(feed.feed_name) !== "prolot");
    feeds.push({ feed_name: "prolot", feed_url: feedUrl.href });
    const email = reportEmail || text(profile?.report_email) || text(env("AVITO_AUTOLOAD_REPORT_EMAIL"));
    if (!/^\S+@\S+\.\S+$/u.test(email) || email.length > 200) throw new ApiError(400, "autoload_profile", "Укажите почту для отчётов Авито: она нужна для создания профиля автозагрузки.");
    const schedule = Array.isArray(profile?.schedule) && profile.schedule.length ? profile.schedule : [{ rate: 1, weekdays: [0, 1, 2, 3, 4, 5, 6], time_slots: [0] }];
    const profileBody: Json = { autoload_enabled: true, report_email: email, schedule, feeds_data: feeds };
    if (!profile && !agreement) throw new ApiError(400, "autoload_agreement", "Подтвердите согласие с правилами Авито Автозагрузки.");
    if (!profile) profileBody.agreement = true;
    try {
      await avitoPost(account, "/autoload/v2/profile", profileBody, "client");
      await avitoPost(account, "/autoload/v1/upload", undefined, "client");
    } catch (error) {
      try { await storage(`avito_publications?owner_id=eq.${encodeURIComponent(ownerId)}&account_key=eq.${encodeURIComponent(account.key)}&product_id=eq.${encodeURIComponent(productId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "error", last_error: error instanceof Error ? error.message.slice(0, 500) : "Не удалось запустить автозагрузку." }) }); } catch { /* Preserve the original Avito error. */ }
      throw error;
    }
    return { submitted: true, productId, feedUrl: feedUrl.href, message: "Объявление передано в Авито Автозагрузку. Авито обработает фид и вернёт ссылку после модерации." };
  }
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const allowedOrigins = (env("AVITO_ALLOWED_ORIGINS") || "https://proaksenov.ru").split(",").map((value) => value.trim());
    const oauthReturnOrigin = oauthReturnOriginForOrigin(origin, allowedOrigins);
    const cors: Record<string, string> = { "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin", "Cache-Control": "no-store" };
    if (origin && allowedOrigins.includes(origin)) cors["Access-Control-Allow-Origin"] = origin;
    const respond = (status: number, data: unknown) => Response.json(data, { status, headers: cors });
    if (origin && !allowedOrigins.includes(origin)) return respond(403, { error: "origin_forbidden", message: "Этот адрес CRM не разрешён в настройках подключения." });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return respond(405, { error: "method_not_allowed", message: "Метод не поддерживается." });
    try {
      const config = serviceConfiguration();
      if (!dependencies.authenticate) throw new ApiError(503, "server_configuration", "Не настроена проверка сессии CRM.");
      const ownerId = await dependencies.authenticate(req);
      const bodyText = await req.text();
      if (bodyText.length > 65536) throw new ApiError(413, "invalid_request", "Запрос слишком большой.");
      let input: Json;
      try { input = object(JSON.parse(bodyText)); } catch { throw new ApiError(400, "invalid_request", "Некорректный запрос."); }
      const databaseAccounts = await dependencies.accountsForOwner?.(ownerId) || [];
      const accounts = [...databaseAccounts.filter((account) => account.ownerId === ownerId), ...accountsFromEnv(env).filter((account) => account.ownerId === ownerId)];
      if (input.action === "accounts") return respond(200, { accounts: accounts.map(({ key, name }) => ({ key, name })) });
      if (!accounts.length) throw new ApiError(403, "account_not_allowed", "Сначала добавьте Client ID и Client Secret Авито в этом разделе.");
      if (input.action === "oauth_callback") {
        const callbackState = await consumeOAuthState(ownerId, text(input.state));
        if (text(input.error)) throw new ApiError(400, "oauth_denied", "Подключение Авито отменено. Разрешите доступ и повторите подключение.");
        const account = accounts.find(({ key }) => key === callbackState.accountKey);
        if (!account) throw new ApiError(403, "account_not_allowed", "Аккаунт Авито больше не настроен для этого пользователя CRM.");
        await completeOAuth(account, text(input.code), callbackState.redirectUri);
        return respond(200, { connected: true, accountKey: account.key, returnOrigin: callbackState.returnOrigin });
      }
      const account = input.action === "update_price"
        ? await accountByAvitoId(accounts, identifier(input.accountId))
        : accounts.find(({ key }) => key === input.accountKey);
      if (!account) throw new ApiError(403, "account_not_allowed", "Аккаунт Авито недоступен этому пользователю.");
      if (input.action === "oauth_start") return respond(200, await beginOAuth(account, oauthReturnOrigin));
      if (input.action === "profile") {
        const data = await avitoGet(account, "/core/v1/accounts/self");
        return respond(200, { profile: { id: identifier(data.id), name: text(data.name, account.name), profileUrl: avitoUrl(data.profile_url) } });
      }
      if (["webhook_status", "enable_webhook"].includes(text(input.action))) {
        let secret: string;
        try { secret = webhookSecret(env); }
        catch { throw new ApiError(503, "webhook_configuration", "Добавьте AVITO_WEBHOOK_SECRET (64 шестнадцатеричных символа) в настройки backend."); }
        const profile = await avitoGet(account, "/core/v1/accounts/self");
        const accountId = identifier(profile.id);
        const binding = { ...account, accountId };
        const filter = new URLSearchParams({ owner_id: `eq.${ownerId}`, account_key: `eq.${account.key}`, avito_user_id: `eq.${accountId}` });
        if (input.action === "enable_webhook") {
          // Establish the binding BEFORE Avito can deliver an event or a probe.
          try { await cacheMessages(binding, "_registration", []); }
          catch { throw new ApiError(503, "webhook_storage", "Не готова база данных для переписки Авито."); }
          const token = await signWebhook(secret, binding);
          const callback = `${config.url}/webhooks/avito/${account.key}/${accountId}/${token}`;
          const probe = await request(callback, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 2000);
          const probeBody: unknown = await probe.json().catch(() => null);
          if (!probe.ok || optionalObject(probeBody).ok !== true) throw new ApiError(503, "webhook_unavailable", "Приёмник webhook недоступен. Проверьте доступность backend.");
          const subscriptions = await json(await avitoPost(account, "/messenger/v1/subscriptions"));
          if (!Array.isArray(subscriptions.subscriptions)) throw new ApiError(502, "invalid_response", "Авито не подтвердило список webhook-подписок.");
          const exists = subscriptions.subscriptions.some((value) => { const row = optionalObject(value); return row.url === callback && String(row.version) === "3"; });
          if (!exists) {
            const registration = await json(await avitoPost(account, "/messenger/v3/webhook", { url: callback }));
            if (registration.ok !== true) throw new ApiError(502, "webhook_registration", "Авито не подтвердило регистрацию webhook.");
          }
          try {
            await storage(`avito_messenger_accounts?${filter}`, { method: "PATCH", body: JSON.stringify({ webhook_enabled: true, registered_at: new Date(now()).toISOString() }), headers: { Prefer: "return=minimal" } });
          } catch { throw new ApiError(503, "webhook_storage", "Webhook зарегистрирован, но статус не сохранён. Повторите подключение: существующая подписка будет проверена."); }
        }
        try {
          const rows = await storage(`avito_messenger_accounts?${filter}&select=webhook_enabled,last_event_at`);
          const row = Array.isArray(rows) ? optionalObject(rows[0]) : {};
          return respond(200, { enabled: row.webhook_enabled === true, accountId, lastEventAt: typeof row.last_event_at === "string" ? row.last_event_at : null });
        } catch { throw new ApiError(503, "webhook_storage", "Не удалось проверить webhook в базе данных."); }
      }
      if (["chats", "chat_messages", "send_message", "read_chat", "delete_message"].includes(text(input.action))) {
        const offset = input.offset ?? 0;
        if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 1000) throw new ApiError(400, "invalid_request", "Некорректная страница переписки.");
        const chatId = input.action === "chats" ? "" : chatIdentifier(input.chatId);
        const messageText = text(input.text).trim();
        const readIds = input.messageIds ?? [];
        const deleteMessageId = input.action === "delete_message" ? chatIdentifier(input.messageId) : "";
        if (input.action === "read_chat" && (!Array.isArray(readIds) || readIds.length > 100 || readIds.some((id) => typeof id !== "string" || !id || id.length > 200))) throw new ApiError(400, "invalid_request", "Некорректные идентификаторы прочитанных сообщений.");
        if (input.action === "send_message" && (!messageText || messageText.length > 1000)) throw new ApiError(400, "invalid_request", "Сообщение должно содержать от 1 до 1000 символов.");
        // Never trust an account ID supplied by the browser.
        const profile = await avitoGet(account, "/core/v1/accounts/self");
        const accountId = identifier(profile.id);
        const binding = { ...account, accountId };
        const path = `/messenger/v1/accounts/${accountId}/chats/${encodeURIComponent(chatId)}`;
        if (input.action === "chats") {
          const data = await avitoGet(account, `/messenger/v2/accounts/${accountId}/chats?limit=50&offset=${offset}&chat_types=u2i,u2u`);
          if (!Array.isArray(data.chats)) throw new ApiError(502, "invalid_response", "Авито вернуло некорректный список чатов.");
          const chats = data.chats.flatMap((value) => {
            const row = optionalObject(value);
            const id = text(row.id);
            // One malformed preview must not hide all other dialogs. Avito's
            // last_message is optional and can vary for system/legacy chats.
            if (!id) return [];
            const users = Array.isArray(row.users) ? row.users.map(optionalObject).filter((user) => String(user.id) !== accountId) : [];
            const context = optionalObject(optionalObject(row.context).value);
            let lastMessage: ReturnType<typeof messengerMessage> | null = null;
            if (row.last_message) {
              try { lastMessage = messengerMessage(row.last_message); } catch { /* Keep the chat; preview text is optional. */ }
            }
            return [{ id, name: users.map((user) => text(user.name)).filter(Boolean).join(", ") || "Собеседник Авито", itemTitle: text(context.title), itemUrl: avitoUrl(context.url), lastMessage }];
          });
          return respond(200, { chats, offset, hasMore: chats.length === 50 && Number(offset) < 1000 });
        }
        if (input.action === "chat_messages") {
          const data = await avitoGetValue(account, `/messenger/v3/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/?limit=50&offset=${offset}`);
          const wrapper = optionalObject(data);
          const messages = Array.isArray(data) ? data
            : Array.isArray(wrapper.messages) ? wrapper.messages
            : Array.isArray(wrapper.resources) ? wrapper.resources
            : Array.isArray(wrapper.items) ? wrapper.items
            : Array.isArray(wrapper.data) ? wrapper.data
            : null;
          if (!messages) {
            const keys = Object.keys(wrapper).filter((key) => /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)).slice(0, 8);
            const suffix = keys.length ? ` Формат ответа содержит поля: ${keys.join(", ")}.` : "";
            throw new ApiError(502, "invalid_response", `Авито вернуло некорректную историю сообщений.${suffix}`);
          }
          const normalized = messages.map(messengerMessage);
          const warning = await cacheHistory(binding, chatId, normalized);
          return respond(200, { messages: normalized, offset, hasMore: messages.length === 50 && Number(offset) < 1000, ...(warning ? { warning } : {}) });
        }
        if (input.action === "read_chat") {
          // chatRead has no request body in the Avito contract.
          try {
            await avitoPost(account, `${path}/read`);
          } catch (error) {
            // Reading history and marking it read are separate Avito permissions.
            // Keep that distinction in the response so a read-receipt denial does
            // not look like a failure to load the conversation.
            if (error instanceof ApiError && ["avito_subscription", "avito_access"].includes(error.code)) {
              throw new ApiError(error.status, "avito_read_access", "Авито не разрешило отметить чат прочитанным. История сообщений при этом доступна; проверьте доступ к Messenger API.");
            }
            throw error;
          }
          if (storageConfigured() && Array.isArray(readIds) && readIds.length) {
            try {
              await storage("rpc/avito_mark_cached_read", { method: "POST", body: JSON.stringify({ p_owner: ownerId, p_key: account.key, p_account: accountId, p_chat: chatId, p_ids: readIds }) });
            } catch { /* Avito already confirmed the receipt; do not turn it into a false failure. */ }
          }
          return respond(200, { read: true });
        }
        if (input.action === "delete_message") {
          const messageId = deleteMessageId;
          const created = typeof input.created === "number" && Number.isSafeInteger(input.created) && input.created >= 0 && input.created <= 1e12 ? input.created : Math.floor(now() / 1000);
          try {
            // Avito changes the message to type=deleted instead of removing it.
            await avitoPost(account, `${path}/messages/${encodeURIComponent(messageId)}`);
          } catch (error) {
            if (error instanceof ApiError && error.status === 502) throw new ApiError(502, "delete_uncertain", "Авито могло удалить сообщение, но ответ не подтверждён. Обновите переписку перед повтором.");
            throw error;
          }
          const message = { id: messageId, text: "Сообщение удалено", type: "deleted", created, direction: "out" as const, isRead: true };
          const warning = await cacheHistory(binding, chatId, [message]);
          return respond(200, { deleted: true, messageId, message, ...(warning ? { warning } : {}) });
        }
        // Do not retry a send: a timeout can mean the message was already accepted.
        const token = await accessToken(account);
        let response: Response;
        try {
          response = await request(`${API}${path}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ type: "text", message: { text: messageText } }) });
        } catch { throw new ApiError(502, "send_uncertain", "Не удалось подтвердить отправку. Обновите переписку и проверьте сообщение в Авито перед повтором."); }
        if (response.status === 401) tokens.delete(`auto:${cacheKey(account)}`);
        if (!response.ok) {
          if (response.status >= 500) throw new ApiError(502, "send_uncertain", "Авито не подтвердило отправку. Проверьте переписку перед повтором.");
          throw await upstreamError(response);
        }
        let message: ReturnType<typeof messengerMessage>;
        try { message = messengerMessage(await response.json()); }
        catch { throw new ApiError(502, "send_uncertain", "Сообщение могло отправиться, но ответ не распознан. Проверьте переписку перед повтором."); }
        const warning = await cacheHistory(binding, chatId, [message]);
        return respond(200, { message, ...(warning ? { warning } : {}) });
      }
      if (input.action === "image") {
        const source = avitoImageUrl(input.imageUrl);
        if (!source) throw new ApiError(400, "invalid_request", "Ссылка на фотографию Авито недействительна.");
        const response = await request(source, { headers: { Accept: "image/jpeg,image/png,image/webp" } });
        if (!response.ok) throw new ApiError(502, "image_unavailable", "Авито не вернуло фотографию объявления.");
        const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (!(contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp")) throw new ApiError(502, "invalid_image", "Авито вернуло неподдерживаемый формат фотографии.");
        const bytes = await boundedImageBody(response);
        return new Response(bytes as unknown as BodyInit, { status: 200, headers: { ...cors, "Content-Type": "application/octet-stream", "X-Image-Content-Type": contentType, "Access-Control-Expose-Headers": "X-Image-Content-Type, Content-Length", "Content-Length": String(bytes.byteLength), "Cache-Control": "private, max-age=3600" } });
      }
      if (input.action === "update_price") {
        const itemId = identifier(input.itemId);
        const price = input.price;
        if (typeof price !== "number" || !Number.isSafeInteger(price) || price <= 0 || price >= 1e12) {
          throw new ApiError(400, "invalid_request", "Для Авито укажите целую цену в рублях больше нуля.");
        }
        await avitoPost(account, `/core/v1/items/${itemId}/update_price`, { price });
        return respond(200, { updated: true, itemId, price });
      }
      if (input.action === "publish_item") {
        return respond(200, await publishItem(account, ownerId, input, config));
      }
      if (input.action === "items") {
        const page = input.page ?? 1;
        if (!Number.isInteger(page) || Number(page) < 1 || Number(page) > 1000) throw new ApiError(400, "invalid_request", "Некорректная страница объявлений.");
        const data = await avitoGet(account, `/core/v1/items?per_page=50&page=${page}`);
        if (!Array.isArray(data.resources)) throw new ApiError(502, "invalid_response", "Авито вернул неожиданный список объявлений.");
        const mappedItems = data.resources.map((value) => {
          const row = object(value);
          const price = typeof row.price === "number" && Number.isFinite(row.price) && row.price >= 0 && row.price < 1e12 ? row.price : null;
          const category = row.category && typeof row.category === "object" ? text((row.category as Json).name) : "";
          return { id: identifier(row.id), title: text(row.title, "Без названия"), description: descriptionText(row.description), price, category, status: text(row.status, "unknown"), url: avitoUrl(row.url), imageUrl: itemImageUrl(row) };
        });
        const missingDetailIds = mappedItems.filter((item) => !item.imageUrl || !item.description).map((item) => item.id);
        const detailedItems = new Map<string, { imageUrl: string | null; description: string }>();
        if (missingDetailIds.length) {
          try {
            const accountProfile = await avitoGet(account, "/core/v1/accounts/self");
            const avitoAccountId = identifier(accountProfile.id);
            for (let offset = 0; offset < missingDetailIds.length; offset += 5) {
              const batch = missingDetailIds.slice(offset, offset + 5);
              const details = await Promise.all(batch.map(async (itemId) => {
                try {
                  const detail = await avitoGet(account, `/core/v1/accounts/${avitoAccountId}/items/${itemId}/`);
                  return [itemId, { imageUrl: itemImageUrl(detail), description: descriptionText(detail.description) }] as const;
                } catch { return [itemId, null] as const; }
              }));
              for (const [itemId, detail] of details) if (detail) detailedItems.set(itemId, detail);
            }
          } catch { /* Listing data remains usable when a detail photo is unavailable. */ }
        }
        const items = mappedItems.map((item) => {
          const detail = detailedItems.get(item.id);
          return { ...item, description: item.description || detail?.description || "", imageUrl: item.imageUrl || detail?.imageUrl || null };
        });
        return respond(200, { items, page, hasMore: items.length === 50, fetchedAt: new Date(now()).toISOString() });
      }
      throw new ApiError(400, "invalid_action", "Действие не поддерживается.");
    } catch (error) {
      if (error instanceof ApiError) return respond(error.status, { error: error.code, message: error.message });
      return respond(500, { error: "internal_error", message: "Не удалось выполнить запрос. Проверьте настройки серверной функции." });
    }
  };
}
