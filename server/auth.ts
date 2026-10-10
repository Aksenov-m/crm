import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { pool } from "./db.js";

export type AppUser = { id: string; email: string };
export type AppEnv = { Variables: { user: AppUser } };
export const SESSION_COOKIE = "crm_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 30;

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const key = scryptSync(password, salt, 64, { N: 16_384 }).toString("hex");
  return `scrypt$16384$${salt}$${key}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, cost, salt, expectedHex] = encoded.split("$");
  if (algorithm !== "scrypt" || cost !== "16384" || !/^[a-f0-9]{32}$/.test(salt ?? "") || !/^[a-f0-9]{128}$/.test(expectedHex ?? "")) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length, { N: 16_384 });
  return timingSafeEqual(actual, expected);
}

export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function resolveUserFromCookie(cookieHeader: string): Promise<AppUser | null> {
  const encoded = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!encoded || encoded.length > 200) return null;
  let token: string;
  try { token = decodeURIComponent(encoded); } catch { return null; }
  const result = await pool.query<{ id: string; email: string }>(
    `select u.id, u.email from app_sessions s join app_users u on u.id=s.user_id
      where s.token_hash=$1 and s.expires_at>now()`,
    [hashSessionToken(token)],
  );
  return result.rows[0] || null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true as const,
    secure: process.env.COOKIE_SECURE !== "false",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_SECONDS,
  };
}

export async function requireUser(context: Context<AppEnv>, next: Next): Promise<Response | void> {
  const user = await resolveUserFromCookie(context.req.header("cookie") ?? "");
  if (!user) {
    return context.json({ error: "sign_in_required", message: "Сеанс закончился. Войдите в CRM снова." }, 401);
  }
  context.set("user", user);
  await next();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}
