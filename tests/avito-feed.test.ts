import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createAvitoFeedHandler } from "../supabase/functions/avito-feed/handler";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "33333333-3333-4333-8333-333333333333";
const SECRET = "ab".repeat(32);
const token = createHmac("sha256", SECRET).update(`${OWNER}|main`).digest("hex");
const response = (body: unknown, status = 200) => Response.json(body, { status });

test("Avito feed accepts only a signed account URL and emits the publication XML", async () => {
  const requests: string[] = [];
  const handler = createAvitoFeedHandler({
    env: (name) => ({ SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", AVITO_FEED_SECRET: SECRET }[name]),
    fetch: async (url) => {
      const href = String(url);
      requests.push(href);
      if (href.includes("avito_publications")) return response([{ product_id: PRODUCT, address: "Москва, улица Тестовая, 1", manager_name: "Михаил", contact_phone: "+7 900 000-00-00" }]);
      if (href.includes("products")) return response([{ id: PRODUCT, title: "Тестовый товар &", description: "Описание ]]> товара", price: 125, category: "Мебель и интерьер", image_path: null, stage: "ready" }]);
      throw new Error(`Unexpected request ${href}`);
    },
  });
  const result = await handler(new Request(`https://test.supabase.co/functions/v1/avito-feed?owner_id=${OWNER}&account_key=main&token=${token}`));
  assert.equal(result.status, 200);
  const body = await result.text();
  assert.match(body, /<Ads formatVersion="3" target="Avito\.ru">/);
  assert.match(body, /Тестовый товар &amp;/);
  assert.match(body, /Описание \]\]\]\]><!\[CDATA\[> товара/);
  assert.equal(requests.length, 2);
});

test("Avito feed rejects an invalid signature before reading CRM data", async () => {
  let called = false;
  const handler = createAvitoFeedHandler({
    env: (name) => ({ SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", AVITO_FEED_SECRET: SECRET }[name]),
    fetch: async () => { called = true; return response([]); },
  });
  const result = await handler(new Request(`https://test.supabase.co/functions/v1/avito-feed?owner_id=${OWNER}&account_key=main&token=${"00".repeat(32)}`));
  assert.equal(result.status, 404);
  assert.equal(called, false);
});
