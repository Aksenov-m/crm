import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { pool } from "./db.js";
import { createAvitoImageToken } from "./storage-routes.js";

const UUID = /^[0-9a-f-]{36}$/i;
const ACCOUNT_KEY = /^[a-zA-Z0-9_-]{1,40}$/;
const text = (value: unknown) => typeof value === "string" ? value : "";
const xml = (value: unknown) => text(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
const cdata = (value: unknown) => text(value).replace(/\]\]>/gu, "]]]]><![CDATA[>");

export const feedRoutes = new Hono();

feedRoutes.get("/avito", async (context) => {
  const ownerId = context.req.query("owner_id") || "";
  const accountKey = context.req.query("account_key") || "";
  const token = context.req.query("token") || "";
  const secret = process.env.AVITO_FEED_SECRET || "";
  if (!UUID.test(ownerId) || !ACCOUNT_KEY.test(accountKey) || !/^[a-f0-9]{64}$/i.test(secret) || !/^[a-f0-9]{64}$/i.test(token)) return context.text("Not Found", 404);
  const expected = createHmac("sha256", secret).update(`${ownerId}|${accountKey}`).digest();
  if (!timingSafeEqual(Buffer.from(token, "hex"), expected)) return context.text("Not Found", 404);

  try {
    const { rows } = await pool.query(
      `select p.id,p.title,p.description,p.price,p.category,p.image_path,p.stage,
              a.address,a.manager_name,a.contact_phone
         from avito_publications a join products p on p.id=a.product_id and p.owner_id=a.owner_id
        where a.owner_id=$1 and a.account_key=$2 and a.status in ('pending','active')
        order by a.created_at asc`,
      [ownerId, accountKey],
    );
    const baseUrl = process.env.PUBLIC_API_URL?.replace(/\/$/u, "");
    if (!baseUrl) return context.text("Feed temporarily unavailable", 503);
    const ads: string[] = [];
    for (const row of rows) {
      if (row.stage === "sold") continue;
      let image = "";
      if (typeof row.image_path === "string") {
        const [imageOwnerId, productId, fileName] = row.image_path.split("/");
        if (imageOwnerId === ownerId && productId === row.id && /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(fileName || "")) {
          const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
          const token = createAvitoImageToken(ownerId, String(row.id), fileName, expires);
          image = `${baseUrl}/public/avito/images/${ownerId}/${row.id}/${fileName}?expires=${expires}&token=${token}`;
        }
      }
      ads.push([
        "<Ad>", `<Id>${xml(row.id)}</Id>`, `<Title>${xml(row.title)}</Title>`,
        `<Description><![CDATA[${cdata(row.description)}]]></Description>`, `<Category>${xml(row.category)}</Category>`,
        `<Price>${String(Math.round(Number(row.price)))}</Price>`, `<Address>${xml(row.address)}</Address>`,
        `<ManagerName>${xml(row.manager_name)}</ManagerName>`, `<ContactPhone>${xml(row.contact_phone)}</ContactPhone>`,
        "<AllowEmail>Да</AllowEmail>", image ? `<Images><Image url="${xml(image)}"/></Images>` : "",
        "<AdStatus>Free</AdStatus>", "</Ad>",
      ].join(""));
    }
    return context.body(`<?xml version="1.0" encoding="UTF-8"?><Ads formatVersion="3" target="Avito.ru">${ads.join("")}</Ads>`, 200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
  } catch {
    return context.text("Feed temporarily unavailable", 503, { "Cache-Control": "no-store" });
  }
});
