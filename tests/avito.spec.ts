import { test, expect, type Page } from "@playwright/test";
import { mockSupabase, OWNER_EMAIL, OWNER_ID, TEST_PASSWORD } from "./helpers/supabase-mock";

async function mockAvito(page: Page) {
  const calls: Record<string, unknown>[] = [];
  let failure = "";
  await page.route("https://crm-test.supabase.co/functions/v1/avito", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json" };
    if (failure) return route.fulfill({ status: 403, headers, body: JSON.stringify({ error: "avito_access", message: failure }) });
    if (body.action === "image") return route.fulfill({ status: 200, headers: { ...headers, "content-type": "application/octet-stream", "x-image-content-type": "image/jpeg", "access-control-expose-headers": "X-Image-Content-Type, Content-Length" }, body: "image-bytes" });
    if (body.action === "update_price") return route.fulfill({ status: 200, headers, body: JSON.stringify({ updated: true, itemId: body.itemId, price: body.price }) });
    const result = body.action === "accounts" ? { accounts: [{ key: "main", name: "Основной магазин" }, { key: "second", name: "Второй магазин" }] }
      : body.action === "profile" ? { profile: { id: body.accountKey === "main" ? "1001" : "1002", name: body.accountKey === "main" ? "Магазин Авито" : "Второй аккаунт Авито", profileUrl: "https://www.avito.ru/user/example" } }
      : { items: body.accountKey === "main" ? [{ id: "2001", title: "Кресло с Авито", description: "Описание кресла с Авито", price: 2500, category: "Мебель", status: "active", url: "https://www.avito.ru/item/2001", imageUrl: "https://10.img.avito.ru/1/2/3.jpg" }, { id: "2002", title: "Стол с Авито", description: "", price: 1000, category: "Мебель", status: "removed", url: null, imageUrl: null }] : [], page: 1, hasMore: false, fetchedAt: new Date().toISOString() };
    await route.fulfill({ status: 200, headers, body: JSON.stringify(result) });
  });
  return { calls, fail: (message: string) => { failure = message; } };
}
async function openAvito(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Авито", exact: true }).click();
  await page.getByRole("button", { name: "Подключить аккаунт", exact: true }).click();
}

test("Avito authorization works independently of listing tables and shows the verified account", async ({ page }) => {
  const backend = await mockSupabase(page);
  backend.setReadFailure("avito_item_links", true);
  const avito = await mockAvito(page);
  await openAvito(page);
  await expect(page.getByText("Подключён:", { exact: true })).toBeVisible();
  await expect(page.getByText("Магазин Авито", { exact: true })).toBeVisible();
  await expect(page.getByText("· ID 1001", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Проверить подключение" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Объявления Авито", exact: true })).toBeVisible();
  await expect(page.locator(".form-error")).toContainText("Проверьте выполнение SQL-файла 007");
  // React Strict Mode can repeat the mount-time accounts lookup in development.
  expect(avito.calls.some((call) => call.action === "accounts")).toBe(true);
  expect(avito.calls.filter((call) => call.action !== "accounts").map((call) => call.action)).toEqual(["profile", "items"]);
  expect(backend.requests.some((request) => request.path.includes("connect_avito_item"))).toBe(false);
  expect(backend.pageErrors).toEqual([]);
  await page.screenshot({ path: "artifacts/ui/avito-authorized.png", fullPage: true });
});

test("Avito listings import automatically, is idempotent and preserves linked local details", async ({ page }) => {
  const backend = await mockSupabase(page, {
    products: [{ id: "33333333-3333-4333-8333-333333333333", owner_id: OWNER_ID, title: "Мой стол", description: "Мои заметки", price: 7000, category: "Другое", stage: "sold", sold_at: "2026-09-20T12:00:00.000Z", image_path: "/products/chair.jpg", created_at: "2026-09-01T00:00:00.000Z", views: 0, favorites: 0 }],
    avito_item_links: [{ id: "55555555-5555-4555-8555-555555555555", owner_id: OWNER_ID, account_id: "1001", item_id: "2002", product_id: "33333333-3333-4333-8333-333333333333", avito_title: "Старый заголовок", avito_status: "removed", avito_url: null, linked_at: "2026-09-01T00:00:00.000Z" }],
  });
  const avito = await mockAvito(page);
  await openAvito(page);
  await expect(page.getByText("Магазин Авито", { exact: true })).toBeVisible();
  const chair = page.locator("article").filter({ has: page.getByRole("heading", { name: "Кресло с Авито", exact: true }) });
  await expect(chair).toContainText("Связано:");
  expect(backend.rows.products).toHaveLength(2);
  expect(backend.rows.products[1]).toMatchObject({ title: "Кресло с Авито", description: "Описание кресла с Авито", price: 2500, stage: "published" });
  expect(backend.rows.products[1].image_path).toMatch(new RegExp(`^${OWNER_ID}/[^/]+/[^/]+\\.jpg$`));
  const table = page.locator("article").filter({ has: page.getByRole("heading", { name: "Стол с Авито", exact: true }) });
  await expect(table).toContainText("Связано: Мой стол");
  expect(backend.rows.products).toHaveLength(2);
  expect(backend.rows.products[0]).toMatchObject({ title: "Мой стол", description: "Мои заметки", price: 7000, stage: "sold" });
  await page.getByRole("button", { name: "Обновить объявления", exact: true }).click();
  await expect(chair).toContainText("Связано:");
  await expect(chair.getByRole("button", { name: "Добавить в CRM" })).not.toBeAttached();
  await page.screenshot({ path: "artifacts/ui/avito-connected.png", fullPage: true });
  await page.getByRole("navigation").getByRole("button", { name: "Товары", exact: true }).click();
  await expect(page.locator('[data-stage="published"] .product-title')).toHaveText("Кресло с Авито");
  await expect(page.locator('[data-stage="published"] .product-photo').first()).not.toHaveAttribute("src", /placeholder/);
  expect(avito.calls.every((call) => !JSON.stringify(call).includes("client_secret"))).toBe(true);
  expect(backend.unexpectedRequests).toEqual([]);
  expect(backend.pageErrors).toEqual([]);
});

test("editing a linked CRM product sends the changed price to Avito", async ({ page }) => {
  const backend = await mockSupabase(page, {
    products: [{ id: "33333333-3333-4333-8333-333333333333", owner_id: OWNER_ID, title: "Мой стол", description: "Мои заметки", price: 7000, category: "Другое", stage: "sold", sold_at: "2026-09-20T12:00:00.000Z", image_path: "/products/chair.jpg", created_at: "2026-09-01T00:00:00.000Z", views: 0, favorites: 0 }],
    avito_item_links: [{ id: "55555555-5555-4555-8555-555555555555", owner_id: OWNER_ID, account_id: "1001", item_id: "2002", product_id: "33333333-3333-4333-8333-333333333333", avito_title: "Стол", avito_status: "removed", avito_url: null, linked_at: "2026-09-01T00:00:00.000Z" }],
  });
  const avito = await mockAvito(page);
  await openAvito(page);
  await page.getByRole("navigation").getByRole("button", { name: "Товары", exact: true }).click();
  await page.locator(".product-title").filter({ hasText: "Мой стол" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Цена, ₽").fill("12345");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText("отправлена на Авито");
  await expect.poll(() => backend.rows.products[0].price).toBe(12345);
  expect(avito.calls).toContainEqual(expect.objectContaining({ action: "update_price", accountId: "1001", itemId: "2002", price: 12345 }));
  expect(backend.unexpectedRequests).toEqual([]);
  expect(backend.pageErrors).toEqual([]);
});

test("Avito errors allow retry and switching account removes previous listings", async ({ page }) => {
  const backend = await mockSupabase(page);
  const avito = await mockAvito(page);
  backend.failNextWrite("avito_item_links");
  await openAvito(page);
  await expect(page.getByRole("heading", { name: "Кресло с Авито" })).toBeVisible();
  const chair = page.locator("article").filter({ has: page.getByRole("heading", { name: "Кресло с Авито" }) });
  await expect(page.locator(".form-error")).toBeVisible();
  expect(backend.rows.products).toHaveLength(1);
  await page.getByRole("button", { name: "Обновить объявления", exact: true }).click();
  await expect(chair).toContainText("Связано:");
  expect(backend.rows.products).toHaveLength(2);
  await page.getByLabel("Аккаунт Авито", { exact: true }).selectOption("second");
  await expect(page.getByRole("heading", { name: "Кресло с Авито" })).not.toBeAttached();
  avito.fail("Авито не разрешил этот запрос.");
  await page.getByRole("button", { name: "Подключить аккаунт" }).click();
  await expect(page.getByText("Авито не разрешил этот запрос.", { exact: true })).toBeVisible();
  avito.fail("");
  await page.getByRole("button", { name: "Подключить аккаунт" }).click();
  await expect(page.getByText("Второй аккаунт Авито", { exact: true })).toBeVisible();
  await expect(page.getByText("На этой странице объявлений нет.")).toBeVisible();
  expect(backend.pageErrors).toEqual([]);
  expect(backend.unexpectedRequests).toEqual([]);
});

test("Avito connection fits mobile and shows a useful error when not configured", async ({ page }) => {
  const backend = await mockSupabase(page);
  const avito = await mockAvito(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openAvito(page);
  await expect(page.getByRole("heading", { name: "Кресло с Авито" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "artifacts/ui/avito-mobile.png", fullPage: true });
  await page.getByRole("navigation").getByRole("button", { name: "Товары", exact: true }).click();
  avito.fail("Подключение Авито ещё не настроено.");
  await page.getByRole("navigation").getByRole("button", { name: "Авито", exact: true }).click();
  await expect(page.getByText("Подключение Авито ещё не настроено.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить подключение" })).toBeEnabled();
  expect(backend.pageErrors).toEqual([]);
});
