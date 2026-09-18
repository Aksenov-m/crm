import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialState,
  generateListing,
  getStats,
  moveProduct,
  parseStoredState,
  STAGES,
  type DemoState,
} from "../src/lib/crm";

test("demo data covers every pipeline stage and can be restored", () => {
  const state = createInitialState();
  assert.deepEqual(new Set(state.products.map((product) => product.stage)), new Set(STAGES.map((stage) => stage.id)));
  assert.deepEqual(parseStoredState(JSON.stringify(state)), state);
  state.products[0].title = "Изменённый товар";
  assert.notEqual(createInitialState().products[0].title, "Изменённый товар");
});

test("listing generation preserves disclosed defects without inventing claims", () => {
  const description = "Продаю велосипед Trek FX 2. Царапина на раме, тормоза требуют настройки.\nВ комплекте только велосипед.";
  const input = { description, category: "Спорт и отдых", price: 18000 };
  const listing = generateListing(input);
  assert.equal(listing.title, "Велосипед Trek FX 2");
  assert.ok(listing.description.startsWith(description));
  assert.match(listing.description, /Царапина на раме, тормоза требуют настройки/);
  assert.match(listing.description, /Категория: Спорт и отдых/);
  assert.match(listing.description.replace(/\s/gu, ""), /Цена:18000₽/u);
  assert.doesNotMatch(listing.description, /идеальн|новый|гарантия|доставк/iu);
  assert.deepEqual(generateListing(input), listing);
});

test("listing validation rejects missing descriptions and unusable prices", () => {
  assert.throws(() => generateListing({ description: "  ", category: "Мебель", price: 100 }), /описание/);
  for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => generateListing({ description: "Стул", category: "Мебель", price }), /цену/);
  }
  assert.equal(generateListing({ description: "Отдам стул", category: "Мебель", price: 0 }).title, "Отдам стул");
});

test("a sale affects revenue once, reversing it removes revenue, and a later sale gets a fresh date", () => {
  const original = createInitialState();
  const before = getStats(original);
  const firstDate = "2026-09-17T13:00:00.000Z";
  const sold = moveProduct(original, "product-bike", "sold", firstDate);
  const bike = sold.products.find((product) => product.id === "product-bike")!;
  assert.equal(bike.soldAt, firstDate);
  assert.equal(getStats(sold).revenue, before.revenue + 28500);
  assert.equal(getStats(sold).soldCount, before.soldCount + 1);
  assert.equal(getStats(sold).activeListings, before.activeListings - 1);
  assert.equal(original.products.find((product) => product.id === "product-bike")!.stage, "published");
  assert.equal(moveProduct(sold, bike.id, "sold", "2026-09-18T14:00:00.000Z"), sold);

  const reopened = moveProduct(sold, bike.id, "published");
  assert.equal(reopened.products.find((product) => product.id === bike.id)!.soldAt, undefined);
  assert.equal(getStats(reopened).revenue, before.revenue);
  const secondDate = "2026-09-19T14:00:00.000Z";
  const resold = moveProduct(reopened, bike.id, "sold", secondDate);
  assert.equal(resold.products.find((product) => product.id === bike.id)!.soldAt, secondDate);
  assert.equal(getStats(resold).revenue, before.revenue + 28500);
  assert.deepEqual(parseStoredState(JSON.stringify(resold)), resold);
});

test("unknown products and unchanged stages leave the state intact", () => {
  const state = createInitialState();
  assert.equal(moveProduct(state, "missing", "sold"), state);
  assert.equal(moveProduct(state, "product-chair", "new"), state);
});

test("analytics calculate from records and ignore unread outgoing messages", () => {
  const state = createInitialState();
  state.messages.push({ id: "outgoing-unread", buyerId: "buyer-alex", text: "Сообщение", direction: "outgoing", createdAt: "2026-09-17T15:00:00.000Z", read: false });
  assert.deepEqual(getStats(state), { revenue: 40800, activeListings: 2, soldCount: 2, totalViews: 1870, unreadCount: 2, conversion: 25 });
  assert.deepEqual(getStats({ version: 1, products: [], buyers: [], messages: [] }), { revenue: 0, activeListings: 0, soldCount: 0, totalViews: 0, unreadCount: 0, conversion: 0 });
});

test("storage validation rejects corrupt shapes, unknown versions, invalid numbers and broken links", () => {
  for (const raw of ["", "undefined", "{", "null", "[]", "{}", '{"version":2,"products":[],"buyers":[],"messages":[]}']) {
    assert.equal(parseStoredState(raw), null, raw);
  }
  const changes: Array<[string, (state: Record<string, unknown>) => void]> = [
    ["invalid stage", (state) => { (state.products as Array<Record<string, unknown>>)[0].stage = "archived"; }],
    ["negative price", (state) => { (state.products as Array<Record<string, unknown>>)[0].price = -10; }],
    ["string price", (state) => { (state.products as Array<Record<string, unknown>>)[0].price = "100"; }],
    ["fractional views", (state) => { (state.products as Array<Record<string, unknown>>)[0].views = 1.5; }],
    ["invalid date", (state) => { (state.products as Array<Record<string, unknown>>)[0].createdAt = "yesterday"; }],
    ["impossible date", (state) => { (state.products as Array<Record<string, unknown>>)[0].createdAt = "2026-02-30T08:00:00.000Z"; }],
    ["external photo", (state) => { (state.products as Array<Record<string, unknown>>)[0].image = "https://example.com/photo.jpg"; }],
    ["blank title", (state) => { (state.products as Array<Record<string, unknown>>)[0].title = "   "; }],
    ["duplicate product", (state) => { const products = state.products as unknown[]; products.push(products[0]); }],
    ["invalid buyer status", (state) => { (state.buyers as Array<Record<string, unknown>>)[0].status = "waiting"; }],
    ["orphan buyer", (state) => { (state.buyers as Array<Record<string, unknown>>)[0].productId = "unknown"; }],
    ["orphan message", (state) => { (state.messages as Array<Record<string, unknown>>)[0].buyerId = "unknown"; }],
    ["invalid read flag", (state) => { (state.messages as Array<Record<string, unknown>>)[0].read = "false"; }],
    ["invalid direction", (state) => { (state.messages as Array<Record<string, unknown>>)[0].direction = "other"; }],
    ["missing messages", (state) => { delete state.messages; }],
  ];
  for (const [reason, change] of changes) {
    const state: Record<string, unknown> = JSON.parse(JSON.stringify(createInitialState()));
    change(state);
    assert.equal(parseStoredState(JSON.stringify(state)), null, reason);
  }
  const infinitePrice = JSON.stringify(createInitialState()).replace('"price":12500', '"price":1e999');
  assert.equal(parseStoredState(infinitePrice), null, "non-finite JSON numeric value");
});

test("an empty but valid saved workspace is preserved", () => {
  const empty: DemoState = { version: 1, products: [], buyers: [], messages: [] };
  assert.deepEqual(parseStoredState(JSON.stringify(empty)), empty);
});

test("buyers without linked products and uploaded photos survive restoration", () => {
  const state = createInitialState();
  state.buyers[0].productId = "";
  state.products[0].image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  assert.deepEqual(parseStoredState(JSON.stringify(state)), state);
});
