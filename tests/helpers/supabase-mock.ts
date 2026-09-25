import { randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";

export const SUPABASE_TEST_URL = "https://crm-test.supabase.co";
export const OWNER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_OWNER_ID = "22222222-2222-4222-8222-222222222222";
export const OWNER_EMAIL = "owner@example.com";
export const OTHER_OWNER_EMAIL = "other@example.com";
export const TEST_PASSWORD = "test-password-123";

type Table = "products" | "buyers" | "messages";
export type Row = Record<string, unknown> & { id: string; owner_id: string };
type RequestRecord = { method: string; path: string; ownerId?: string; body?: unknown };
const tables: Table[] = ["products", "buyers", "messages"];

function user(ownerId: string) {
  return {
    id: ownerId,
    aud: "authenticated",
    role: "authenticated",
    email: ownerId === OWNER_ID ? OWNER_EMAIL : OTHER_OWNER_EMAIL,
    email_confirmed_at: "2026-09-01T00:00:00.000Z",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

function session(ownerId: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: ownerId, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 })).toString("base64url");
  return {
    access_token: `${header}.${payload}.test-signature`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: `refresh-${ownerId}`,
    user: user(ownerId),
  };
}

function requestOwner(authorization: string | undefined) {
  try {
    const token = authorization?.replace(/^Bearer /i, "") ?? "";
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload.sub === OWNER_ID || payload.sub === OTHER_OWNER_ID ? payload.sub as string : undefined;
  } catch {
    return undefined;
  }
}

/** In-memory HTTP fixture; browser tests never contact or mutate a real project. */
export async function mockSupabase(page: Page, seed: Partial<Record<Table, Row[]>> = {}) {
  const rows: Record<Table, Row[]> = {
    products: structuredClone(seed.products ?? []),
    buyers: structuredClone(seed.buyers ?? []),
    messages: structuredClone(seed.messages ?? []),
  };
  const requests: RequestRecord[] = [];
  const unexpectedRequests: string[] = [];
  const storedObjects = new Set<string>();
  const failedWrites = new Set<Table>();
  const failedReads = new Set<Table>();
  let heldWrite: { table: Table; promise: Promise<void> } | undefined;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (["127.0.0.1", "localhost"].includes(url.hostname)) return route.continue();
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    if (url.origin !== SUPABASE_TEST_URL) {
      unexpectedRequests.push(request.url());
      return route.abort();
    }

    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "content-type": "application/json",
    };
    const fulfill = (status: number, body: unknown) => route.fulfill({ status, headers, body: status === 204 ? "" : JSON.stringify(body) });
    if (request.method() === "OPTIONS") return fulfill(204, null);
    let body: unknown;
    if (request.postData() && request.headers()["content-type"]?.includes("application/json")) body = request.postDataJSON();
    const ownerId = requestOwner(request.headers().authorization);
    requests.push({ method: request.method(), path: url.pathname, ownerId, body });

    if (url.pathname === "/auth/v1/token") {
      const input = body as { email?: string; password?: string; refresh_token?: string };
      if (url.searchParams.get("grant_type") === "refresh_token") {
        return fulfill(200, session(input.refresh_token === `refresh-${OTHER_OWNER_ID}` ? OTHER_OWNER_ID : OWNER_ID));
      }
      if (![OWNER_EMAIL, OTHER_OWNER_EMAIL].includes(input.email ?? "") || input.password !== TEST_PASSWORD) {
        return fulfill(400, { code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" });
      }
      return fulfill(200, session(input.email === OTHER_OWNER_EMAIL ? OTHER_OWNER_ID : OWNER_ID));
    }
    if (url.pathname === "/auth/v1/user") return ownerId ? fulfill(200, user(ownerId)) : fulfill(401, { msg: "Invalid JWT" });
    if (url.pathname === "/auth/v1/logout") return fulfill(204, null);

    const tableName = url.pathname.replace("/rest/v1/", "") as Table;
    if (tables.includes(tableName)) {
      if (!ownerId) return fulfill(401, { code: "42501", message: "Authentication required" });
      const matches = (row: Row) => row.owner_id === ownerId && [...url.searchParams].every(([column, filter]) => {
        if (["select", "order", "limit", "offset", "on_conflict"].includes(column)) return true;
        if (filter.startsWith("eq.")) return String(row[column]) === filter.slice(3);
        if (filter.startsWith("gt.")) return String(row[column]) > filter.slice(3);
        if (filter.startsWith("in.(")) return filter.slice(4, -1).split(",").includes(String(row[column]));
        return true;
      });
      if (request.method() === "GET") {
        if (failedReads.has(tableName)) return fulfill(403, { code: "42501", message: "Could not load data" });
        const result = rows[tableName].filter(matches).sort((first, second) => first.id.localeCompare(second.id));
        return fulfill(200, result.slice(0, Number(url.searchParams.get("limit")) || result.length));
      }
      if (heldWrite?.table === tableName) {
        const promise = heldWrite.promise;
        heldWrite = undefined;
        await promise;
      }
      if (failedWrites.delete(tableName)) return fulfill(500, { code: "TEST_WRITE_ERROR", message: "Could not save data" });
      let result: Row[];
      if (request.method() === "POST") {
        const input = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
        if (input.some((row) => rows[tableName].some((existing) => existing.id === row.id))) return fulfill(409, { code: "23505", message: "Duplicate primary key" });
        if (input.some((row) => row.owner_id && row.owner_id !== ownerId)) return fulfill(403, { code: "42501", message: "Owner mismatch" });
        result = input.map((row) => ({ id: randomUUID(), owner_id: ownerId, created_at: new Date().toISOString(), ...row } as Row));
        for (const row of result) {
          const index = rows[tableName].findIndex((existing) => existing.id === row.id);
          if (index < 0) rows[tableName].push(row); else rows[tableName][index] = { ...rows[tableName][index], ...row };
        }
      } else if (request.method() === "PATCH") {
        result = rows[tableName].filter(matches).map((row) => Object.assign(row, body));
      } else if (request.method() === "DELETE") {
        result = rows[tableName].filter(matches);
        rows[tableName] = rows[tableName].filter((row) => !matches(row));
      } else {
        unexpectedRequests.push(`${request.method()} ${request.url()}`);
        return fulfill(405, {});
      }
      if (!request.headers().prefer?.includes("return=representation")) return fulfill(204, null);
      const single = request.headers().accept?.includes("application/vnd.pgrst.object+json");
      return fulfill(request.method() === "POST" ? 201 : 200, single ? result[0] ?? null : result);
    }

    if (url.pathname.startsWith("/storage/v1/object/sign/") && request.method() === "POST") {
      const objectPath = url.pathname.replace("/storage/v1/object/sign/", "");
      if ((body as { paths?: string[] })?.paths) {
        return fulfill(200, (body as { paths: string[] }).paths.map((path) => ({ path, signedURL: `/object/sign/${objectPath}/${path}?token=test`, error: null })));
      }
      return fulfill(200, { signedURL: `/object/sign/${objectPath}?token=test` });
    }
    if (url.pathname.startsWith("/storage/v1/object/") && ["POST", "PUT"].includes(request.method())) {
      if (!ownerId) return fulfill(401, { message: "Authentication required" });
      const objectPath = url.pathname.replace("/storage/v1/object/", "");
      storedObjects.add(objectPath);
      return fulfill(200, { Key: objectPath, Id: randomUUID() });
    }
    if (url.pathname.startsWith("/storage/v1/object/") && request.method() === "DELETE") return fulfill(200, []);
    if (url.pathname.startsWith("/storage/v1/object/") && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBfoAAAAASUVORK5CYII=", "base64") });
    }
    unexpectedRequests.push(`${request.method()} ${request.url()}`);
    return fulfill(404, { message: "Unexpected mock endpoint" });
  });

  return {
    rows, requests, unexpectedRequests, pageErrors, storedObjects,
    failNextWrite: (table: Table) => failedWrites.add(table),
    setReadFailure: (table: Table, enabled: boolean) => enabled ? failedReads.add(table) : failedReads.delete(table),
    holdNextWrite(table: Table) {
      let release!: () => void;
      heldWrite = { table, promise: new Promise<void>((resolve) => { release = resolve; }) };
      return release;
    },
  };
}
