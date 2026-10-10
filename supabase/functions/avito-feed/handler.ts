import { messengerStorage } from "../_shared/avito-messenger.ts";

type Environment = (name: string) => string | undefined;
type Json = Record<string, unknown>;
type Dependencies = { env: Environment; fetch: typeof fetch };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function optionalObject(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function xml(value: unknown): string {
  return text(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}
function cdata(value: unknown): string { return text(value).replace(/\]\]>/gu, "]]]]><![CDATA[>"); }

async function validToken(secret: string, value: string, expected: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(value)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(expected));
}

async function signedImageUrl(env: Environment, fetcher: typeof fetch, path: string): Promise<string | null> {
  const base = text(env("SUPABASE_URL")).replace(/\/$/u, "");
  const key = text(env("SUPABASE_SERVICE_ROLE_KEY")) || (() => {
    try { const parsed = JSON.parse(text(env("SUPABASE_SECRET_KEYS")) || "{}"); return text(parsed.default); } catch { return ""; }
  })();
  if (!base || !key) return null;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetcher(`${base}/storage/v1/object/sign/product-images/${encodedPath}`, {
    method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 86400 }), redirect: "error", signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const body = optionalObject(await response.json().catch(() => null));
  const signed = text(body.signedURL) || text(body.signedUrl);
  if (!signed) return null;
  return signed.startsWith("http") ? signed : `${base}${signed.startsWith("/") ? "" : "/"}${signed}`;
}

export function createAvitoFeedHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
    try {
      const url = new URL(request.url);
      const ownerId = url.searchParams.get("owner_id") || "";
      const accountKey = url.searchParams.get("account_key") || "";
      const token = url.searchParams.get("token") || "";
      const secret = text(dependencies.env("AVITO_FEED_SECRET")) || text(dependencies.env("AVITO_WEBHOOK_SECRET"));
      if (!UUID.test(ownerId) || !/^[a-zA-Z0-9_-]{1,40}$/u.test(accountKey) || !/^[a-f0-9]{64}$/iu.test(secret) || !(await validToken(secret, token, `${ownerId}|${accountKey}`))) {
        return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      const publications = await messengerStorage(dependencies.env, dependencies.fetch, `avito_publications?select=product_id,address,manager_name,contact_phone&owner_id=eq.${encodeURIComponent(ownerId)}&account_key=eq.${encodeURIComponent(accountKey)}&status=in.(pending,active)&order=created_at.asc`);
      const publicationRows = Array.isArray(publications) ? publications.map(optionalObject) : [];
      const productIds = publicationRows.map((row) => text(row.product_id)).filter((id) => UUID.test(id));
      let products: unknown[] = [];
      if (productIds.length) {
        const rows = await messengerStorage(dependencies.env, dependencies.fetch, `products?select=id,title,description,price,category,image_path,stage&owner_id=eq.${encodeURIComponent(ownerId)}&id=in.(${productIds.map(encodeURIComponent).join(",")})`);
        products = Array.isArray(rows) ? rows : [];
      }
      const productById = new Map(products.map((value) => { const row = optionalObject(value); return [text(row.id), row] as const; }));
      const ads: string[] = [];
      for (const publication of publicationRows) {
        const product = productById.get(text(publication.product_id));
        if (!product || text(product.stage) === "sold") continue;
        const imagePath = text(product.image_path);
        const image = imagePath ? await signedImageUrl(dependencies.env, dependencies.fetch, imagePath) : null;
        ads.push([
          "<Ad>",
          `<Id>${xml(product.id)}</Id>`,
          `<Title>${xml(product.title)}</Title>`,
          `<Description><![CDATA[${cdata(product.description)}]]></Description>`,
          `<Category>${xml(product.category)}</Category>`,
          `<Price>${String(Math.round(Number(product.price)))}</Price>`,
          `<Address>${xml(publication.address)}</Address>`,
          `<ManagerName>${xml(publication.manager_name)}</ManagerName>`,
          `<ContactPhone>${xml(publication.contact_phone)}</ContactPhone>`,
          "<AllowEmail>Да</AllowEmail>",
          image ? `<Images><Image url="${xml(image)}"/></Images>` : "",
          "<AdStatus>Free</AdStatus>",
          "</Ad>",
        ].join(""));
      }
      const body = `<?xml version="1.0" encoding="UTF-8"?><Ads formatVersion="3" target="Avito.ru">${ads.join("")}</Ads>`;
      return new Response(body, { status: 200, headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" } });
    } catch {
      return new Response("Feed temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}
