import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { AppEnv, requireUser } from "./auth.js";
import { pool } from "./db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;
const MAX_BYTES = 5 * 1024 * 1024;
const root = resolve(process.env.FILE_STORAGE_DIR || "./data/uploads");
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

function imageExtension(bytes: Uint8Array): "jpg" | "png" | "webp" | null {
  if (bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "jpg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

function diskPath(ownerId: string, productId: string, fileName: string): string {
  const path = resolve(root, ownerId, productId, fileName);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Invalid file path");
  return path;
}

function publicFileResponse(bytes: Buffer, extension: string, privateFile: boolean): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": MIME[extension] || "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": privateFile ? "private, max-age=300" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

function signedImagePayload(ownerId: string, productId: string, fileName: string, expiry: string): string {
  return `${ownerId}|${productId}|${fileName}|${expiry}`;
}

export function createAvitoImageToken(ownerId: string, productId: string, fileName: string, expiresAt: number): string {
  const secret = process.env.AVITO_FEED_SECRET || "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("AVITO_FEED_SECRET is not configured");
  const expiry = String(expiresAt);
  return createHmac("sha256", secret).update(signedImagePayload(ownerId, productId, fileName, expiry)).digest("hex");
}

export const fileRoutes = new Hono<AppEnv>();
fileRoutes.use("*", requireUser);

fileRoutes.post("/upload", async (context) => {
  const contentLength = Number(context.req.header("content-length") || 0);
  if (contentLength > MAX_BYTES + 128 * 1024) return context.json({ error: "file_too_large", message: "Фотография должна быть не больше 5 МБ." }, 413);
  let form: FormData;
  try { form = await context.req.formData(); } catch { return context.json({ error: "invalid_upload", message: "Не удалось прочитать фотографию." }, 400); }
  const productId = String(form.get("productId") || "");
  const file = form.get("file");
  if (!UUID.test(productId) || !(file instanceof File)) return context.json({ error: "invalid_upload", message: "Выберите фотографию товара." }, 400);
  if (!file.size || file.size > MAX_BYTES) return context.json({ error: "file_too_large", message: "Фотография должна быть не больше 5 МБ." }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = imageExtension(bytes);
  if (!extension) return context.json({ error: "invalid_image", message: "Поддерживаются только корректные JPEG, PNG и WebP фотографии." }, 415);
  const ownerId = context.get("user").id;
  const fileName = `${crypto.randomUUID()}.${extension}`;
  const imagePath = `${ownerId}/${productId}/${fileName}`;
  try {
    const path = diskPath(ownerId, productId, fileName);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    return context.json({ error: "storage_unavailable", message: "Не удалось сохранить фотографию на сервере." }, 503);
  }
  return context.json({ path: imagePath, url: `/api/files/${imagePath}` }, 201);
});

fileRoutes.get("/:ownerId/:productId/:fileName", async (context) => {
  const { ownerId, productId, fileName } = context.req.param();
  const userId = context.get("user").id;
  if (ownerId !== userId || !UUID.test(productId) || !NAME.test(fileName)) return context.json({ error: "not_found", message: "Фотография не найдена." }, 404);
  const imagePath = `${ownerId}/${productId}/${fileName}`;
  const product = await pool.query("select 1 from products where owner_id=$1 and id=$2 and image_path=$3", [ownerId, productId, imagePath]);
  if (!product.rowCount) return context.json({ error: "not_found", message: "Фотография не найдена." }, 404);
  try { return publicFileResponse(await readFile(diskPath(ownerId, productId, fileName)), extname(fileName).slice(1), true); }
  catch { return context.json({ error: "file_missing", message: "Фотография временно недоступна." }, 404); }
});

fileRoutes.delete("/:ownerId/:productId/:fileName", async (context) => {
  const { ownerId, productId, fileName } = context.req.param();
  if (ownerId !== context.get("user").id || !UUID.test(productId) || !NAME.test(fileName)) return context.json({ error: "not_found", message: "Фотография не найдена." }, 404);
  try { await unlink(diskPath(ownerId, productId, fileName)); } catch { /* Idempotent cleanup. */ }
  return context.json({ ok: true });
});

export const publicFileRoutes = new Hono();
publicFileRoutes.get("/:ownerId/:productId/:fileName", async (context) => {
  const { ownerId, productId, fileName } = context.req.param();
  const expiry = context.req.query("expires") || "";
  const token = context.req.query("token") || "";
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!UUID.test(ownerId) || !UUID.test(productId) || !NAME.test(fileName) || !/^\d{10}$/.test(expiry) || Number(expiry) < nowSeconds || Number(expiry) > nowSeconds + 48 * 60 * 60 || !/^[a-f0-9]{64}$/i.test(token)) {
    return context.text("Not Found", 404);
  }
  let expected: string;
  try { expected = createAvitoImageToken(ownerId, productId, fileName, Number(expiry)); } catch { return context.text("Not Found", 404); }
  if (!timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"))) return context.text("Not Found", 404);
  const imagePath = `${ownerId}/${productId}/${fileName}`;
  const product = await pool.query("select 1 from products where owner_id=$1 and id=$2 and image_path=$3", [ownerId, productId, imagePath]);
  if (!product.rowCount) return context.text("Not Found", 404);
  try { return publicFileResponse(await readFile(diskPath(ownerId, productId, fileName)), extname(fileName).slice(1), false); }
  catch { return context.text("Not Found", 404); }
});
