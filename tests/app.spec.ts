import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { createInitialState, STORAGE_KEY, type DemoState } from "../src/lib/crm";

const failures = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  failures.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname)) errors.push(`External request: ${request.url()}`);
  });
});
test.afterEach(async ({ page }) => { expect(failures.get(page)).toEqual([]); });

async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Сохранено в браузере", { exact: true })).toBeAttached();
}
async function stored(page: Page): Promise<DemoState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
}
async function nav(page: Page, label: string) {
  await page.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: label, exact: true }).click();
}

test("initial HTML, five columns, local photos and desktop visual", async ({ page, request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("Мои товары");
  expect(html).toContain("Кресло в скандинавском стиле");
  await open(page);
  await expect(page.locator(".kanban-column")).toHaveCount(5);
  await expect(page.locator(".product-card")).toHaveCount(8);
  await expect.poll(() => page.locator(".product-photo").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: "artifacts/ui/desktop.png", fullPage: true });
});

test("drag a product to sold, calculate revenue once and restore after reload", async ({ page }) => {
  await open(page);
  const card = page.locator('[data-product-id="product-chair"]');
  await card.dragTo(page.locator('[data-stage="sold"]'), { targetPosition: { x: 70, y: 45 } });
  await expect(page.locator('[data-stage="sold"] [data-product-id="product-chair"]')).toBeVisible();
  await expect(page.locator(".stat-value").first()).toContainText("53 300");
  await expect.poll(async () => (await stored(page)).products.find((product) => product.id === "product-chair")?.stage).toBe("sold");
  await page.reload();
  await expect(page.locator('[data-stage="sold"] [data-product-id="product-chair"]')).toBeVisible();
  await page.getByLabel("Этап: Кресло в скандинавском стиле", { exact: true }).selectOption("new");
  await expect(page.locator(".stat-value").first()).toContainText("40 800");
});

test("photo upload, input-based generation, edit and saved product", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Добавить товар", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Сгенерировать объявление", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles(resolve("public/products/chair.jpg"));
  await expect(dialog.getByAltText("Фотография товара")).toBeVisible();
  await dialog.getByLabel("Расскажите о товаре").fill("Продаю кресло Тестовое. Есть царапина на ножке.");
  await dialog.getByLabel("Цена, ₽").fill("4567");
  await dialog.getByLabel("Категория").selectOption("Мебель");
  await dialog.getByRole("button", { name: "Сгенерировать объявление", exact: true }).click();
  await expect(dialog.getByLabel("Заголовок")).toHaveValue("Кресло Тестовое");
  await expect(dialog.getByLabel("Описание объявления")).toHaveValue(/Есть царапина/);
  await dialog.getByLabel("Заголовок").fill("Тестовое кресло с фото");
  await page.screenshot({ path: "artifacts/ui/editor.png", fullPage: true });
  await dialog.getByRole("button", { name: "Добавить на доску", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".product-title").filter({ hasText: "Тестовое кресло с фото" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".product-title").filter({ hasText: "Тестовое кресло с фото" })).toBeVisible();
  const product = (await stored(page)).products.find((item) => item.title === "Тестовое кресло с фото");
  expect(product?.image).toMatch(/^data:image\/jpeg;base64,/);
  expect(product?.price).toBe(4567);
  await page.getByRole("button", { name: "Открыть товар: Тестовое кресло с фото", exact: true }).click();
  await dialog.getByLabel("Цена, ₽").fill("100000000000000000000");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Цена слишком большая");
  expect((await stored(page)).products.find((item) => item.id === product?.id)?.price).toBe(4567);
  await dialog.getByLabel("Цена, ₽").fill("7890");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await page.reload();
  await expect(page.locator(".product-title").filter({ hasText: "Тестовое кресло с фото" })).toBeVisible();
  expect((await stored(page)).products.find((item) => item.id === product?.id)?.price).toBe(7890);
});

test("create buyer, use four statuses, receive and send messages", async ({ page }) => {
  await open(page);
  await nav(page, "Покупатели");
  await page.getByRole("button", { name: "Добавить покупателя", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Имя покупателя").fill("Тестовый покупатель");
  await dialog.getByLabel("Интересующий товар").selectOption("product-chair");
  await dialog.getByLabel("Заметка").fill("Встреча завтра");
  await dialog.getByRole("button", { name: "Создать покупателя" }).click();
  const buyerCard = page.locator("article").filter({ has: page.getByRole("heading", { name: "Тестовый покупатель" }) });
  for (const status of ["negotiation", "sale", "rejected", "new"]) {
    await buyerCard.getByLabel("Статус покупателя Тестовый покупатель").selectOption(status);
    await expect.poll(async () => (await stored(page)).buyers.find((buyer) => buyer.name === "Тестовый покупатель")?.status).toBe(status);
  }
  await page.screenshot({ path: "artifacts/ui/buyers.png", fullPage: true });
  await buyerCard.getByRole("button", { name: "Написать" }).click();
  await page.getByLabel("Текст сообщения").fill("Здравствуйте! Кресло можно забрать завтра.");
  await page.getByLabel("Текст сообщения").press("Enter");
  await expect(page.getByRole("log")).toContainText("Кресло можно забрать завтра.");
  await expect(page.getByLabel("Текст сообщения")).toHaveValue("");
  await nav(page, "Товары");
  await page.getByRole("button", { name: /Уведомления:/ }).click();
  await page.getByRole("button", { name: "Получить демо-сообщение" }).click();
  await expect(page.getByRole("button", { name: /Уведомления: 3/ })).toBeVisible();
  await page.locator(".notification-entry").filter({ hasText: "Тестовый покупатель" }).click();
  await expect(page.getByRole("log")).toContainText("Товар ещё в продаже?");
  await expect(page.getByRole("button", { name: /Уведомления: 2/ })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui/messages.png", fullPage: true });
  await nav(page, "Аналитика");
  await expect(page.getByRole("heading", { name: "Завершённые продажи" })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui/analytics.png", fullPage: true });
});

test("search, filters, list view and simulated listing statistics", async ({ page }) => {
  await open(page);
  await page.getByLabel("Поиск товаров").fill("Несуществующийтовар");
  await expect(page.locator(".product-card")).toHaveCount(0);
  await page.getByRole("tab", { name: "Все объявления" }).click();
  await expect(page.getByRole("heading", { name: "Таких товаров пока нет" })).toBeVisible();
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  await expect(page.locator(".listing-row")).toHaveCount(8);
  await page.getByLabel("Категория товаров").selectOption("Мебель");
  await expect(page.locator(".listing-row")).toHaveCount(1);
  await page.getByLabel("Категория товаров").selectOption("all");
  await page.getByRole("button", { name: "Обновить демо-статистику" }).click();
  await expect.poll(async () => (await stored(page)).products.find((product) => product.id === "product-bike")?.views).toBe(360);
});

test("mobile layout and accessible stage control", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByLabel("Этап: Кресло в скандинавском стиле", { exact: true }).selectOption("sold");
  await expect.poll(async () => (await stored(page)).products.find((product) => product.id === "product-chair")?.stage).toBe("sold");
  await page.screenshot({ path: "artifacts/ui/mobile.png", fullPage: true });
  await nav(page, "Покупатели");
  await expect(page.getByRole("heading", { name: "Ваши покупатели" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("empty and corrupted local storage recover without broken controls", async ({ page }) => {
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({ version: 1, products: [], buyers: [], messages: [] })), { key: STORAGE_KEY });
  await open(page);
  await expect(page.locator(".product-card")).toHaveCount(0);
  await expect(page.locator(".column-empty")).toHaveCount(5);
  await nav(page, "Аналитика");
  await expect(page.getByRole("heading", { name: "Первая продажа впереди" })).toBeVisible();
});

test("invalid storage loads seed and reports recovery", async ({ page }) => {
  await page.addInitScript(({ key }) => localStorage.setItem(key, "invalid-json"), { key: STORAGE_KEY });
  await open(page);
  await expect(page.locator(".product-card")).toHaveCount(createInitialState().products.length);
  await expect(page.getByRole("status")).toContainText("повреждены");
});
