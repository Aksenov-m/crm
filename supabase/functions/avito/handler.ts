type Environment = (name: string) => string | undefined;
type Account = { key: string; name: string; ownerId: string; clientId: string; clientSecret: string };
type Json = Record<string, unknown>;
type Dependencies = { env: Environment; fetch: typeof fetch; now?: () => number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API = "https://api.avito.ru";
const TIMEOUT = 15000;

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "invalid_response", "Сервис вернул неожиданный ответ. Повторите запрос позже.");
  return value as Json;
}
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
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
    accounts = json ? JSON.parse(json) : [{ key: "main", name: "Мой аккаунт Авито", ownerId: env("AVITO_CRM_OWNER_ID"), clientId: env("AVITO_CLIENT_ID"), clientSecret: env("AVITO_CLIENT_SECRET") }];
  } catch { throw new ApiError(503, "not_configured", "Проверьте настройки подключения Авито на сервере."); }
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 20) throw new ApiError(503, "not_configured", "Подключение Авито ещё не настроено.");
  const keys = new Set<string>();
  for (const entry of accounts) {
    const value = object(entry);
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(text(value.key)) || !UUID.test(text(value.ownerId)) || !text(value.clientId).trim() || !text(value.clientSecret).trim() || !text(value.name).trim() || keys.has(text(value.key))) {
      throw new ApiError(503, "not_configured", "Подключение Авито ещё не настроено. Проверьте ключи и владельца CRM в настройках функции.");
    }
    keys.add(text(value.key));
  }
  return accounts as Account[];
}

export function createAvitoHandler(dependencies: Dependencies) {
  const { env } = dependencies;
  const now = dependencies.now ?? Date.now;
  const tokens = new Map<string, { value: string; expiresAt: number }>();
  const pendingTokens = new Map<string, Promise<string>>();

  async function request(url: string, init: RequestInit): Promise<Response> {
    try { return await dependencies.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT) }); }
    catch { throw new ApiError(502, "network_error", "Сервис недоступен или не ответил вовремя. Проверьте подключение и повторите запрос."); }
  }
  async function json(response: Response): Promise<Json> {
    try { return object(await response.json()); }
    catch { throw new ApiError(502, "invalid_response", "Сервис вернул неожиданный ответ. Повторите запрос позже."); }
  }
  function cacheKey(account: Account) { return `${account.key}:${account.clientId}:${account.clientSecret}`; }
  function avitoError(status: number): ApiError {
    if (status === 401) return new ApiError(502, "avito_auth", "Авито отклонил авторизацию. Проверьте Client ID, Client Secret и тип доступа приложения.");
    if (status === 403) return new ApiError(403, "avito_access", "Авито не разрешил этот запрос. Проверьте права API и условия доступа вашего аккаунта.");
    if (status === 429) return new ApiError(429, "avito_rate_limit", "Достигнут лимит запросов Авито. Подождите и повторите позже.");
    return new ApiError(502, "avito_error", "Авито не выполнил запрос. Повторите позже; если ошибка сохраняется, проверьте доступ к API.");
  }
  async function accessToken(account: Account): Promise<string> {
    const key = cacheKey(account);
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const pending = pendingTokens.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const response = await request(`${API}/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: account.clientId, client_secret: account.clientSecret }),
      });
      if (!response.ok) throw response.status === 400 ? avitoError(401) : avitoError(response.status);
      const data = await json(response);
      const expires = Number(data.expires_in);
      if (!text(data.access_token) || !Number.isFinite(expires) || expires <= 0 || text(data.token_type).toLowerCase() !== "bearer") throw new ApiError(502, "invalid_token", "Авито вернул некорректный ответ авторизации.");
      if (tokens.size > 40) tokens.clear();
      tokens.set(key, { value: text(data.access_token), expiresAt: now() + Math.max(0, Math.min(expires, 86400) - 60) * 1000 });
      return text(data.access_token);
    })();
    pendingTokens.set(key, promise);
    try { return await promise; } finally { pendingTokens.delete(key); }
  }
  async function avitoGet(account: Account, path: string): Promise<Json> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(account);
      const response = await request(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (response.status === 401 && attempt === 0) { tokens.delete(cacheKey(account)); continue; }
      if (!response.ok) throw avitoError(response.status);
      return json(response);
    }
    throw avitoError(401);
  }
  async function avitoPost(account: Account, path: string, body: Json): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(account);
      const response = await request(`${API}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 401 && attempt === 0) { tokens.delete(cacheKey(account)); continue; }
      if (!response.ok) throw avitoError(response.status);
      return;
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
  function supabaseConfiguration() {
    const url = env("SUPABASE_URL")?.replace(/\/$/, "");
    let key = env("SUPABASE_PUBLISHABLE_KEY") || env("SUPABASE_ANON_KEY");
    try { key ||= JSON.parse(env("SUPABASE_PUBLISHABLE_KEYS") || "{}").default; } catch { /* Fail closed below. */ }
    if (!url || !key) throw new ApiError(503, "server_configuration", "Не настроена авторизация серверной функции.");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "kong"].includes(parsed.hostname))) throw new ApiError(503, "server_configuration", "Неверный адрес Supabase.");
    return { url, key };
  }
  async function signedInUser(authorization: string, config: ReturnType<typeof supabaseConfiguration>): Promise<string> {
    if (!/^Bearer [^\s]+$/.test(authorization)) throw new ApiError(401, "sign_in_required", "Войдите в CRM заново.");
    const response = await request(`${config.url}/auth/v1/user`, { headers: { Authorization: authorization, apikey: config.key } });
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) throw new ApiError(503, "auth_unavailable", "Сервис входа временно недоступен. Повторите позже.");
      throw new ApiError(401, "sign_in_required", "Сеанс закончился. Войдите в CRM заново.");
    }
    const user = await json(response);
    if (!UUID.test(text(user.id)) || user.is_anonymous === true) throw new ApiError(403, "forbidden", "Для подключения Авито нужен личный аккаунт CRM.");
    return text(user.id);
  }

  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const allowedOrigins = (env("AVITO_ALLOWED_ORIGINS") || "https://proaksenov.ru").split(",").map((value) => value.trim());
    const cors: Record<string, string> = { "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin", "Cache-Control": "no-store" };
    if (origin && allowedOrigins.includes(origin)) cors["Access-Control-Allow-Origin"] = origin;
    const respond = (status: number, data: unknown) => Response.json(data, { status, headers: cors });
    if (origin && !allowedOrigins.includes(origin)) return respond(403, { error: "origin_forbidden", message: "Этот адрес CRM не разрешён в настройках подключения." });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return respond(405, { error: "method_not_allowed", message: "Метод не поддерживается." });
    try {
      const config = supabaseConfiguration();
      const authorization = req.headers.get("authorization") || "";
      const ownerId = await signedInUser(authorization, config);
      const accounts = accountsFromEnv(env).filter((account) => account.ownerId === ownerId);
      if (!accounts.length) throw new ApiError(403, "account_not_allowed", "Для этого пользователя CRM не настроен аккаунт Авито.");
      const bodyText = await req.text();
      if (bodyText.length > 4096) throw new ApiError(413, "invalid_request", "Запрос слишком большой.");
      let input: Json;
      try { input = object(JSON.parse(bodyText)); } catch { throw new ApiError(400, "invalid_request", "Некорректный запрос."); }
      if (input.action === "accounts") return respond(200, { accounts: accounts.map(({ key, name }) => ({ key, name })) });
      const account = input.action === "update_price"
        ? await accountByAvitoId(accounts, identifier(input.accountId))
        : accounts.find(({ key }) => key === input.accountKey);
      if (!account) throw new ApiError(403, "account_not_allowed", "Аккаунт Авито недоступен этому пользователю.");
      if (input.action === "profile") {
        const data = await avitoGet(account, "/core/v1/accounts/self");
        return respond(200, { profile: { id: identifier(data.id), name: text(data.name, account.name), profileUrl: avitoUrl(data.profile_url) } });
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
