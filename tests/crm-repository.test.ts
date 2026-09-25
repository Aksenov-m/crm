import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createCrmRepository, getCrmErrorMessage, mapBuyerRow, mapMessageRow, mapProductRow,
  PRODUCT_IMAGE_PLACEHOLDER, type BuyerRow, type MessageRow, type ProductRow,
} from "../src/lib/crm-repository";

const OWNER = "10000000-0000-4000-8000-000000000001";
const PRODUCT = "20000000-0000-4000-8000-000000000001";
const BUYER = "30000000-0000-4000-8000-000000000001";
const MESSAGE = "40000000-0000-4000-8000-000000000001";
const OLD_PATH = `${OWNER}/${PRODUCT}/50000000-0000-4000-8000-000000000001.jpg`;
const JPEG = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 255, 217]).toString("base64")}`;

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: PRODUCT, owner_id: OWNER, title: "Кресло", description: "Есть потёртость", price: "12500.50",
    image_path: "/products/chair.jpg", stage: "new", category: "Мебель", views: 0, favorites: 0,
    created_at: "2026-09-24T13:00:00+03:00", sold_at: null, ...overrides,
  };
}
const buyerRow: BuyerRow = { id: BUYER, owner_id: OWNER, name: "Покупатель", phone: "", product_id: null, status: "new", note: "Заметка" };
const messageRow: MessageRow = { id: MESSAGE, owner_id: OWNER, buyer_id: BUYER, text: "Здравствуйте", direction: "incoming", created_at: "2026-09-24T13:10:00+03:00", read: false };

type Row = Record<string, unknown>;
interface QueryLog { table: string; operation: string; payload?: Row; filters: Array<[string, unknown]>; after?: string; }

/** A PostgREST-shaped fake tests query filters and actual pagination, without a network or user data. */
function fakeClient(options: { rows?: Record<string, object[]>; cap?: number; dbError?: object; signingFails?: boolean } = {}) {
  const calls: QueryLog[] = [];
  const uploads: Array<{ path: string; file: Blob }> = [];
  const removed: string[] = [];
  const signed: Array<{ path: string; expires: number }> = [];
  class Query implements PromiseLike<{ data: Row[] | null; error: object | null }> {
    log: QueryLog;
    count = 500;
    constructor(table: string) { this.log = { table, operation: "select", filters: [] }; }
    select() { return this; }
    order() { return this; }
    limit(count: number) { this.count = count; return this; }
    eq(column: string, value: unknown) { this.log.filters.push([column, value]); return this; }
    gt(_column: string, value: string) { this.log.after = value; return this; }
    insert(payload: Row) { this.log.operation = "insert"; this.log.payload = payload; return this; }
    update(payload: Row) { this.log.operation = "update"; this.log.payload = payload; return this; }
    result() {
      calls.push(this.log);
      if (this.log.operation !== "select" && options.dbError) return { data: null, error: options.dbError };
      if (this.log.operation !== "select") {
        const baseline = options.rows?.[this.log.table]?.[0] ?? (this.log.table === "products" ? productRow() : this.log.table === "buyers" ? buyerRow : messageRow);
        return { data: [{ ...baseline, ...this.log.payload }] as Row[], error: null };
      }
      const rows = (options.rows?.[this.log.table] ?? []) as Row[];
      return {
        data: rows.filter((row) => this.log.filters.every(([column, value]) => row[column] === value))
          .filter((row) => !this.log.after || String(row.id) > this.log.after)
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .slice(0, Math.min(this.count, options.cap ?? 500)), error: null,
      };
    }
    async single() { const result = this.result(); return { data: result.data?.[0] ?? null, error: result.error }; }
    then<TResult1 = { data: Row[] | null; error: object | null }, TResult2 = never>(
      onfulfilled?: ((value: { data: Row[] | null; error: object | null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> { return Promise.resolve(this.result()).then(onfulfilled, onrejected); }
  }
  const client = {
    from: (table: string) => new Query(table),
    storage: { from: (bucket: string) => {
      assert.equal(bucket, "product-images");
      return {
        async upload(path: string, file: Blob, settings: { upsert: boolean; contentType: string }) {
          assert.deepEqual(settings, { contentType: "image/jpeg", upsert: false });
          uploads.push({ path, file });
          return { data: { path }, error: null };
        },
        async createSignedUrl(path: string, expires: number) {
          signed.push({ path, expires });
          return options.signingFails ? { data: null, error: { status: 503 } } : { data: { signedUrl: `https://example.supabase.co/storage/v1/object/sign/product-images/${path}?token=temporary` }, error: null };
        },
        async remove(paths: string[]) { removed.push(...paths); return { error: null }; },
      };
    } },
  } as unknown as SupabaseClient;
  return { client, calls, uploads, removed, signed };
}

test("row mapping converts decimals, timestamp offsets and nullable links without persisting temporary URLs", () => {
  const product = mapProductRow(productRow());
  assert.equal(product.price, 12500.5);
  assert.equal(product.createdAt, "2026-09-24T10:00:00.000Z");
  assert.equal(product.image, "/products/chair.jpg");
  assert.equal(product.imagePath, "/products/chair.jpg");
  assert.equal(product.soldAt, undefined);
  assert.equal(mapBuyerRow(buyerRow).productId, "");
  assert.equal(mapMessageRow(messageRow).createdAt, "2026-09-24T10:10:00.000Z");
  const withoutPhoto = mapProductRow(productRow({ image_path: null }));
  assert.equal(withoutPhoto.image, PRODUCT_IMAGE_PLACEHOLDER);
  assert.equal(withoutPhoto.imagePath, undefined);
});

test("mapping rejects legacy IDs, inconsistent sale dates and foreign/external image paths", () => {
  assert.throws(() => mapProductRow(productRow({ id: "product-chair" })), /идентификатор/);
  assert.throws(() => mapProductRow(productRow({ stage: "sold", sold_at: null })), /дата продажи/);
  assert.throws(() => mapProductRow(productRow({ sold_at: "2026-09-24T10:00:00Z" })), /этапу товара/);
  for (const image_path of ["https://example.test/photo.jpg", "/products/../../secret.jpg", OLD_PATH.replace(OWNER, BUYER)]) {
    assert.throws(() => mapProductRow(productRow({ image_path })), /путь фотографии/);
  }
});

test("loading fetches more than 1000 owner records even when the API caps pages below requested size", async () => {
  const rows = Array.from({ length: 1003 }, (_, index) => productRow({ id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
  rows.push(productRow({ id: "20000000-0000-4000-8000-000000002000", owner_id: BUYER }));
  const fake = fakeClient({ rows: { products: rows, buyers: [buyerRow], messages: [messageRow] }, cap: 200 });
  const state = await createCrmRepository(fake.client, OWNER).load();
  assert.equal(state.products.length, 1003);
  assert.equal(new Set(state.products.map((product) => product.id)).size, 1003);
  assert.equal(state.buyers.length, 1);
  assert.equal(state.messages.length, 1);
  assert.equal(fake.calls.filter((call) => call.table === "products").length, 7);
  assert.ok(fake.calls.every((call) => call.filters.some(([column, value]) => column === "owner_id" && value === OWNER)));
  const empty = await createCrmRepository(fakeClient().client, OWNER).load();
  assert.deepEqual(empty, { version: 1, products: [], buyers: [], messages: [] });
});

test("editing a signed-photo product preserves its durable path and scopes the update to its owner and ID", async () => {
  const fake = fakeClient();
  const product = mapProductRow(productRow({ image_path: OLD_PATH }), "https://example.supabase.co/signed?token=temporary");
  const saved = await createCrmRepository(fake.client, OWNER).saveProduct({ ...product, title: "Новое название" }, true);
  assert.equal(saved.title, "Новое название");
  assert.equal(fake.calls[0].operation, "update");
  assert.equal(fake.calls[0].payload?.image_path, OLD_PATH);
  assert.deepEqual(fake.calls[0].filters, [["owner_id", OWNER], ["id", PRODUCT]]);
  assert.equal(fake.uploads.length, 0);
  assert.equal(fake.removed.length, 0);
  assert.doesNotMatch(JSON.stringify(fake.calls[0].payload), /token=|https:/);
});

test("a new photo uploads as JPEG under owner/product UUIDs and uses a one-hour signed display URL", async () => {
  const fake = fakeClient();
  const saved = await createCrmRepository(fake.client, OWNER).saveProduct({ ...mapProductRow(productRow()), image: JPEG }, false);
  assert.equal(fake.calls[0].operation, "insert");
  assert.equal(fake.uploads.length, 1);
  const path = fake.uploads[0].path;
  assert.match(path, new RegExp(`^${OWNER}/${PRODUCT}/[0-9a-f-]{36}\\.jpg$`));
  assert.equal(fake.uploads[0].file.type, "image/jpeg");
  assert.equal(fake.calls[0].payload?.image_path, path);
  assert.equal(saved.imagePath, path);
  assert.match(saved.image, /token=temporary$/);
  assert.deepEqual(fake.signed, [{ path, expires: 3600 }]);
});

test("invalid photo and product input are rejected before network mutations", async () => {
  const fake = fakeClient();
  const repository = createCrmRepository(fake.client, OWNER);
  for (const image of ["https://other.test/photo.jpg", "data:image/jpeg;base64,bm90IGFuIGltYWdl", "data:image/png;base64,aGVsbG8="]) {
    await assert.rejects(repository.saveProduct({ ...mapProductRow(productRow()), image, imagePath: undefined }, false));
  }
  await assert.rejects(repository.saveProduct({ ...mapProductRow(productRow()), price: -1 }, false), /цену/);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.uploads.length, 0);
});

test("definitive DB rejection cleans only the new upload; ambiguous failures never delete possibly committed photos", async () => {
  const product = { ...mapProductRow(productRow({ image_path: OLD_PATH })), image: JPEG };
  const rejected = fakeClient({ dbError: { code: "23514", message: "private server details" } });
  await assert.rejects(createCrmRepository(rejected.client, OWNER).saveProduct(product, true), /заполненные поля/);
  assert.deepEqual(rejected.removed, [rejected.uploads[0].path]);
  assert.ok(!rejected.removed.includes(OLD_PATH));

  const ambiguous = fakeClient({ dbError: { message: "Failed to fetch private URL" } });
  await assert.rejects(createCrmRepository(ambiguous.client, OWNER).saveProduct(product, true), /Проверьте соединение/);
  assert.deepEqual(ambiguous.removed, []);

  const failedSigning = fakeClient({ signingFails: true });
  await assert.rejects(createCrmRepository(failedSigning.client, OWNER).saveProduct(product, true));
  assert.equal(failedSigning.calls.length, 0);
  assert.deepEqual(failedSigning.removed, [failedSigning.uploads[0].path]);
});

test("a temporary signing failure retains the original path when the placeholder is saved", async () => {
  const fake = fakeClient({ signingFails: true, rows: { products: [productRow({ image_path: OLD_PATH })] } });
  const repository = createCrmRepository(fake.client, OWNER);
  const state = await repository.load();
  assert.equal(state.products[0].image, PRODUCT_IMAGE_PLACEHOLDER);
  assert.equal(state.products[0].imagePath, OLD_PATH);
  await repository.saveProduct(state.products[0], true);
  assert.equal(fake.calls.find((call) => call.operation === "update")?.payload?.image_path, OLD_PATH);
});

test("stage and buyer status changes only update their own fields", async () => {
  const fake = fakeClient();
  const repository = createCrmRepository(fake.client, OWNER);
  const sold = await repository.changeProductStage(PRODUCT, "sold", "2026-09-24T11:00:00Z");
  assert.equal(sold.soldAt, "2026-09-24T11:00:00.000Z");
  assert.deepEqual(fake.calls[0].payload, { stage: "sold", sold_at: "2026-09-24T11:00:00.000Z" });
  await repository.changeProductStage(PRODUCT, "ready");
  assert.deepEqual(fake.calls[1].payload, { stage: "ready", sold_at: null });
  await repository.updateBuyerStatus(BUYER, "negotiation");
  assert.deepEqual(fake.calls[2].payload, { status: "negotiation" });
  assert.ok(fake.calls.every((call) => call.filters[0][0] === "owner_id" && call.filters[0][1] === OWNER));
});

test("buyer/message inserts map relationships and read updates only affect this owner's unread incoming messages", async () => {
  const fake = fakeClient();
  const repository = createCrmRepository(fake.client, OWNER);
  await repository.saveBuyer(mapBuyerRow(buyerRow), false);
  assert.equal(fake.calls[0].operation, "insert");
  assert.equal(fake.calls[0].payload?.product_id, null);
  await repository.addMessage(mapMessageRow(messageRow));
  assert.equal(fake.calls[1].payload?.owner_id, OWNER);
  assert.equal(fake.calls[1].payload?.buyer_id, BUYER);
  await repository.markBuyerMessagesRead(BUYER);
  assert.deepEqual(fake.calls[2].payload, { read: true });
  assert.deepEqual(fake.calls[2].filters, [["owner_id", OWNER], ["buyer_id", BUYER], ["direction", "incoming"], ["read", false]]);
});

test("public error messages never expose raw server details or tokens", () => {
  for (const error of [new Error("secret token"), { code: "23505", message: "secret token" }, { status: 403, details: "secret token" }]) {
    assert.doesNotMatch(getCrmErrorMessage(error), /secret|token/);
  }
});
