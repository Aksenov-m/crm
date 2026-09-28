import { test, expect } from "@playwright/test";

test("demo edits, moves and resets products without calling real services", async ({ page }) => {
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      externalRequests.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/demo");
  await expect(page.getByRole("region", { name: "Деморежим", exact: true })).toBeVisible();
  const chairTitle = "Кресло в скандинавском стиле";
  await page.getByRole("button", { name: chairTitle, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Цена, ₽").fill("9999");
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel(`Этап: ${chairTitle}`, { exact: true }).selectOption("sold");
  await expect(page.locator('[data-stage="sold"]')).toContainText(chairTitle);
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Покупатели", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Покупатели", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Сообщения", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Сообщения", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Аналитика", exact: true }).click();
  await expect(page.getByText("Демонстрационные данные", { exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Авито", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Авито в деморежиме" })).toBeVisible();
  await page.getByRole("button", { name: "Сбросить демо" }).click();
  await expect(page.locator('[data-stage="new"]')).toContainText(chairTitle);
  await page.getByRole("button", { name: chairTitle, exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Цена, ₽")).toHaveValue("12500");
  expect(externalRequests).toEqual([]);
});

test("demo is linked from login and fits a mobile screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Попробовать демо без входа" })).toHaveAttribute("href", "/demo/");
  await page.getByRole("link", { name: "Попробовать демо без входа" }).click();
  await expect(page).toHaveURL(/\/demo\/?$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Сбросить демо" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
