import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { createInitialState, STORAGE_KEY } from "../src/lib/crm";
import { mockSupabase, OTHER_OWNER_EMAIL, OWNER_EMAIL, OWNER_ID, TEST_PASSWORD, type Row } from "./helpers/supabase-mock";

const productId = "33333333-3333-4333-8333-333333333333";
const buyerId = "44444444-4444-4444-8444-444444444444";

function productRow(): Row {
  return {
    id: productId,
    owner_id: OWNER_ID,
    title: "Личный товар первого владельца",
    description: "Кресло в хорошем состоянии",
    price: 8500,
    image_path: "/products/chair.jpg",
    stage: "new",
    category: "Мебель",
    views: 0,
    favorites: 0,
    created_at: "2026-09-01T00:00:00.000Z",
    sold_at: null,
  };
}

function buyerRow(): Row {
  return { id: buyerId, owner_id: OWNER_ID, name: "Покупатель первого владельца", phone: "", product_id: productId, status: "new", note: "", created_at: "2026-09-01T00:00:00.000Z" };
}

async function login(page: Page, email = OWNER_EMAIL) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
}

async function nav(page: Page, label: string) {
  await page.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: label, exact: true }).click();
}

test("cloud requires login, rejects invalid credentials and never seeds browser demo data", async ({ page }) => {
  const backend = await mockSupabase(page);
  const legacyData = JSON.stringify(createInitialState());
  await page.addInitScript(({ key, data }) => localStorage.setItem(key, data), { key: STORAGE_KEY, data: legacyData });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui/supabase-login.png", fullPage: true });
  await expect(page.locator(".product-card")).toHaveCount(0);
  expect(backend.requests.some((request) => request.path.startsWith("/rest/"))).toBe(false);
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Неверный email или пароль" })).toBeVisible();
  await login(page);
  await expect(page.locator(".product-card")).toHaveCount(0);
  await expect(page.locator(".kanban-column")).toHaveCount(5);
  expect(backend.rows.products).toEqual([]);
  expect(backend.rows.buyers).toEqual([]);
  expect(backend.rows.messages).toEqual([]);
  expect(backend.requests.filter((request) => request.path.startsWith("/rest/") && request.method !== "GET")).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(legacyData);
  expect(backend.unexpectedRequests).toEqual([]);
  expect(backend.pageErrors).toEqual([]);
});

test("cloud persists uploaded product, sale stage, buyer and CRM message after reload", async ({ page }) => {
  const backend = await mockSupabase(page);
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "Добавить товар", exact: true }).first().click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Попробовать на примере", exact: true }).click();
  await dialog.locator('input[type="file"]').setInputFiles(resolve("public/products/chair.jpg"));
  await dialog.getByRole("button", { name: "Сгенерировать объявление", exact: true }).click();
  await dialog.getByLabel("Заголовок").fill("Товар из Supabase");
  await dialog.getByRole("button", { name: "Добавить на доску", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".product-title").filter({ hasText: "Товар из Supabase" })).toBeVisible();
  expect(backend.rows.products).toHaveLength(1);
  const savedProduct = backend.rows.products[0];
  expect(savedProduct.owner_id).toBe(OWNER_ID);
  expect(savedProduct.image_path).toEqual(expect.stringContaining(OWNER_ID));
  expect(savedProduct.image_path).not.toMatch(/^(data:|https?:)/);
  expect(backend.storedObjects.size).toBe(1);
  await page.getByLabel("Этап: Товар из Supabase", { exact: true }).selectOption("sold");
  await expect.poll(() => backend.rows.products[0].stage).toBe("sold");
  expect(backend.rows.products[0].sold_at).toEqual(expect.any(String));

  await nav(page, "Покупатели");
  await page.getByRole("button", { name: "Добавить покупателя", exact: true }).first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Имя покупателя").fill("Анна из Supabase");
  await dialog.getByLabel("Интересующий товар").selectOption(savedProduct.id);
  await dialog.getByLabel("Заметка").fill("Самовывоз в субботу");
  await dialog.getByRole("button", { name: "Создать покупателя", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel("Статус покупателя Анна из Supabase").selectOption("negotiation");
  await expect.poll(() => backend.rows.buyers[0]?.status).toBe("negotiation");
  const buyerCard = page.locator("article").filter({ has: page.getByRole("heading", { name: "Анна из Supabase", exact: true }) });
  await buyerCard.getByRole("button", { name: /Написать|Открыть диалог/ }).click();
  await page.getByLabel("Текст сообщения").fill("Встреча подтверждена на субботу");
  await page.getByLabel("Текст сообщения").press("Enter");
  await expect(page.getByRole("log")).toContainText("Встреча подтверждена на субботу");
  await expect(page.getByLabel("Текст сообщения")).toHaveValue("");
  expect(backend.rows.messages).toHaveLength(1);
  expect(backend.rows.messages[0]).toMatchObject({ owner_id: OWNER_ID, buyer_id: backend.rows.buyers[0].id, text: "Встреча подтверждена на субботу" });

  await page.reload();
  await expect(page.locator('[data-stage="sold"] .product-title').filter({ hasText: "Товар из Supabase" })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui/supabase-board.png", fullPage: true });
  await nav(page, "Покупатели");
  await expect(page.getByLabel("Статус покупателя Анна из Supabase")).toHaveValue("negotiation");
  await expect(page.getByText("Самовывоз в субботу", { exact: true })).toBeVisible();
  await page.locator("article").filter({ has: page.getByRole("heading", { name: "Анна из Supabase", exact: true }) }).getByRole("button", { name: /Написать|Открыть диалог/ }).click();
  await expect(page.getByRole("log")).toContainText("Встреча подтверждена на субботу");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  expect(backend.unexpectedRequests).toEqual([]);
  expect(backend.pageErrors).toEqual([]);
});

test("failed cloud saves keep edited product and message draft available for retry", async ({ page }) => {
  const backend = await mockSupabase(page, { products: [productRow()], buyers: [buyerRow()] });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "Открыть товар: Личный товар первого владельца", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Заголовок").fill("Исправленное название");
  backend.failNextWrite("products");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Заголовок")).toHaveValue("Исправленное название");
  expect(backend.rows.products[0].title).toBe("Личный товар первого владельца");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(backend.rows.products[0].title).toBe("Исправленное название");

  await nav(page, "Покупатели");
  backend.failNextWrite("buyers");
  await page.getByLabel("Статус покупателя Покупатель первого владельца").selectOption("sale");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByLabel("Статус покупателя Покупатель первого владельца")).toHaveValue("new");
  expect(backend.rows.buyers[0].status).toBe("new");
  await page.getByRole("button", { name: "Редактировать покупателя Покупатель первого владельца", exact: true }).click();
  await dialog.getByLabel("Заметка").fill("Договорённости должны сохраниться");
  backend.failNextWrite("buyers");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Заметка")).toHaveValue("Договорённости должны сохраниться");
  expect(backend.rows.buyers[0].note).toBe("");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(backend.rows.buyers[0].note).toBe("Договорённости должны сохраниться");
  await page.locator("article").filter({ has: page.getByRole("heading", { name: "Покупатель первого владельца", exact: true }) }).getByRole("button", { name: /Написать|Открыть диалог/ }).click();
  await page.getByLabel("Текст сообщения").fill("Этот текст нельзя потерять");
  backend.failNextWrite("messages");
  const releaseMessage = backend.holdNextWrite("messages");
  await page.getByLabel("Текст сообщения").press("Enter");
  try {
    await expect(page.getByRole("navigation").getByRole("button", { name: "Товары", exact: true })).toBeDisabled();
  } finally { releaseMessage(); }
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByLabel("Текст сообщения")).toHaveValue("Этот текст нельзя потерять");
  expect(backend.rows.messages).toHaveLength(0);
  await page.getByLabel("Текст сообщения").press("Enter");
  await expect(page.getByRole("log")).toContainText("Этот текст нельзя потерять");
  await expect(page.getByLabel("Текст сообщения")).toHaveValue("");
  expect(backend.rows.messages).toHaveLength(1);
  const messageWrites = backend.requests.filter((request) => request.path === "/rest/v1/messages" && request.method === "POST");
  expect((messageWrites[0].body as Row).id).toBe((messageWrites[1].body as Row).id);
  expect(backend.unexpectedRequests).toEqual([]);
  expect(backend.pageErrors).toEqual([]);
});

test("signout removes private data and switching accounts does not reveal previous records", async ({ page }) => {
  const backend = await mockSupabase(page, { products: [productRow()], buyers: [buyerRow()] });
  await page.goto("/");
  await login(page);
  await expect(page.locator(".product-title")).toHaveText("Личный товар первого владельца");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  await expect(page.getByText("Личный товар первого владельца", { exact: true })).not.toBeAttached();
  await page.evaluate(() => {
    const state = window as typeof window & { leakedOwnerData?: boolean; ownerDataObserver?: MutationObserver };
    state.leakedOwnerData = false;
    state.ownerDataObserver = new MutationObserver(() => {
      if (document.body.textContent?.includes("Личный товар первого владельца")) state.leakedOwnerData = true;
    });
    state.ownerDataObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await login(page, OTHER_OWNER_EMAIL);
  await expect(page.locator(".kanban-column")).toHaveCount(5);
  await expect(page.locator(".product-card")).toHaveCount(0);
  await nav(page, "Покупатели");
  await expect(page.getByText("Покупатель первого владельца", { exact: true })).not.toBeAttached();
  expect(await page.evaluate(() => (window as typeof window & { leakedOwnerData?: boolean }).leakedOwnerData)).toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(0);
  expect(backend.rows.products).toHaveLength(1);
  expect(backend.unexpectedRequests).toEqual([]);
  expect(backend.pageErrors).toEqual([]);
});

test("cloud login and buyer editor fit a mobile viewport", async ({ page }) => {
  const backend = await mockSupabase(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await nav(page, "Покупатели");
  await page.getByRole("button", { name: "Добавить покупателя", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Имя покупателя").fill("Мобильный покупатель");
  backend.failNextWrite("buyers");
  await dialog.getByRole("button", { name: "Создать покупателя", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Имя покупателя")).toHaveValue("Мобильный покупатель");
  await dialog.getByRole("button", { name: "Создать покупателя", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Мобильный покупатель", exact: true })).toBeVisible();
  expect(backend.rows.buyers[0].product_id).toBeNull();
  const buyerWrites = backend.requests.filter((request) => request.path === "/rest/v1/buyers" && request.method === "POST");
  expect((buyerWrites[0].body as Row).id).toBe((buyerWrites[1].body as Row).id);
  await page.screenshot({ path: "artifacts/ui/supabase-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(backend.unexpectedRequests).toEqual([]);
  expect(backend.pageErrors).toEqual([]);
});

test("failed initial loading and stage change can be retried without showing saved success", async ({ page }) => {
  const backend = await mockSupabase(page, { products: [productRow()] });
  backend.setReadFailure("products", true);
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Не удалось загрузить CRM" })).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(0);
  backend.setReadFailure("products", false);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.locator(".product-title")).toHaveText("Личный товар первого владельца");
  backend.failNextWrite("products");
  const stage = page.getByLabel("Этап: Личный товар первого владельца", { exact: true });
  await stage.selectOption("sold");
  await expect(page.locator(".storage-warning")).toBeVisible();
  await expect(stage).toHaveValue("new");
  expect(backend.rows.products[0].sold_at).toBeNull();
  await stage.selectOption("sold");
  await expect(page.locator('[data-stage="sold"] .product-card')).toHaveCount(1);
  await expect(page.locator(".storage-warning")).not.toBeAttached();
  expect(backend.pageErrors).toEqual([]);
  expect(backend.unexpectedRequests).toEqual([]);
});
