import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import type { AvitoMessage } from "../src/lib/avito";
import { mockSupabase, OWNER_EMAIL, TEST_PASSWORD } from "./helpers/supabase-mock";

async function setup(page: Page) {
  const backend = await mockSupabase(page);
  const calls: Record<string, unknown>[] = [];
  const messages = [{ id: "m1", text: "Товар ещё продаётся?", type: "text", created: 1700000000, direction: "in", isRead: false }];
  let failSend = false;
  let failChats = false;
  let failHistory = false;
  let webhookEnabled = true;
  const cached: Array<{ account_key: string; chat_id: string; message: AvitoMessage }> = [];
  const channels = new Map<string, { socket: WebSocketRoute; joinRef: string; key: string }>();
  let leaves = 0;
  await page.routeWebSocket("wss://crm-test.supabase.co/realtime/v1/websocket*", (socket) => {
    socket.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      let response = {};
      if (event === "phx_join") {
        const filters = payload.config.postgres_changes;
        channels.set(topic, { socket, joinRef, key: String(filters[0].filter).replace("account_key=eq.", "") });
        response = { postgres_changes: filters.map((filter: object) => ({ ...filter, id: 1 })) };
      }
      if (event === "phx_leave") { channels.delete(topic); leaves++; }
      socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response }]));
    });
  });
  const deliver = (message: AvitoMessage, chatId = "chat-1", accountKey = "main", broadcast = true) => {
    const row = { account_key: accountKey, chat_id: chatId, message };
    const previous = cached.findIndex((entry) => entry.account_key === accountKey && entry.chat_id === chatId && entry.message.id === message.id);
    if (previous < 0) cached.push(row); else cached[previous] = row;
    for (const [topic, channel] of channels) if (broadcast && channel.key === accountKey) {
      channel.socket.send(JSON.stringify([channel.joinRef, null, topic, "postgres_changes", { ids: [1], data: { schema: "public", table: "avito_messenger_messages", type: previous < 0 ? "INSERT" : "UPDATE", commit_timestamp: new Date().toISOString(), columns: [{ name: "account_key", type: "text" }, { name: "chat_id", type: "text" }, { name: "message", type: "jsonb" }], record: row, old_record: {}, errors: null } }]));
    }
  };
  await page.route("https://crm-test.supabase.co/rest/v1/avito_messenger_messages*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const rows = cached.filter((row) => `eq.${row.account_key}` === params.get("account_key") && (!params.has("chat_id") || `eq.${row.chat_id}` === params.get("chat_id")));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(rows) });
  });
  await page.route("https://crm-test.supabase.co/rest/v1/rpc/avito_cached_chats", (route) => route.fulfill({ contentType: "application/json", body: "[]" }));
  let readReply = { body: { read: true } as unknown, status: 200 };
  let readWait: Promise<void> | undefined;
  await page.route("https://crm-test.supabase.co/functions/v1/avito", async (route) => {
    const body = route.request().postDataJSON(); calls.push(body);
    const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (body.action === "accounts") return reply({ accounts: [{ key: "main", name: "Основной" }, { key: "second", name: "Второй" }] });
    if (body.action === "enable_webhook") { webhookEnabled = true; return reply({ enabled: true, accountId: "12345", lastEventAt: null }); }
    if (body.action === "webhook_status") return reply({ enabled: webhookEnabled, accountId: "12345", lastEventAt: null });
    if (body.action === "chats") return failChats ? reply({ error: "avito_subscription", message: "Проверьте подписку Авито" }, 402) : reply({ chats: body.accountKey === "second" ? [] : [{ id: "chat-1", name: "Алексей", itemTitle: "Кресло", itemUrl: null, lastMessage: messages.at(-1) }], offset: body.offset, hasMore: false });
    if (body.action === "chat_messages") return failHistory ? reply({ error: "avito_subscription", message: "Авито отклонило запрос истории" }, 402) : reply({ messages, offset: body.offset, hasMore: false });
    if (body.action === "read_chat") {
      const result = readReply;
      await readWait;
      return reply(result.body, result.status);
    }
    if (body.action === "send_message") {
      if (failSend) return reply({ error: "send_uncertain", message: "Не удалось подтвердить отправку" }, 502);
      const message = { id: "sent-1", text: body.text, type: "text", created: 1700000001, direction: "out", isRead: true };
      messages.push(message); return reply({ message });
    }
    throw new Error(`Unexpected action: ${body.action}`);
  });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Сообщения", exact: true }).click();
  return { backend, calls, messages, deliver, channels, leaves: () => leaves, failHistory: () => { failHistory = true; }, failSend: () => { failSend = true; }, failChats: () => { failChats = true; }, setReadReply: (body: unknown, status = 200) => { readReply = { body, status }; }, holdRead: (wait: Promise<void>) => { readWait = wait; } };
}

test("messenger receives realtime updates without polling, deduplicates and cleans up account subscriptions", async ({ page }) => {
  await page.clock.install();
  const mock = await setup(page);
  await expect(page.getByText("Обновления CRM подключены", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Алексей/ }).click();
  const log = page.getByRole("log");
  await expect(log).toContainText("Товар ещё продаётся?");
  await expect.poll(() => mock.calls.some((call) => call.action === "read_chat")).toBe(true);
  const historyCalls = mock.calls.filter((call) => call.action === "chat_messages").length;
  const chatCalls = mock.calls.filter((call) => call.action === "chats").length;
  await page.getByLabel("Ответ в Авито", { exact: true }).fill("Да, в наличии");
  await page.getByRole("button", { name: "Отправить в Авито", exact: true }).click();
  await expect(log.getByText("Да, в наличии", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Ответ в Авито", { exact: true })).toHaveValue("");
  expect(mock.calls.filter((call) => call.action === "send_message")).toHaveLength(1);
  // Finishing a send must not reset either automatic refresh interval.
  expect(mock.calls.filter((call) => call.action === "chat_messages")).toHaveLength(historyCalls);
  expect(mock.calls.filter((call) => call.action === "chats")).toHaveLength(chatCalls);
  await page.getByRole("button", { name: "Обновить переписку", exact: true }).click();
  await expect(page.getByRole("button", { name: "Обновить переписку", exact: true })).toBeEnabled();
  expect(mock.calls.filter((call) => call.action === "read_chat")).toHaveLength(1);
  const beforeWait = mock.calls.length;
  await page.clock.fastForward(600000);
  expect(mock.calls).toHaveLength(beforeWait);
  await expect(log).not.toContainText("Когда можно забрать?");
  const incoming: AvitoMessage = { id: "new-2", text: "Когда можно забрать?", type: "text", created: 1700000002, direction: "in", isRead: false };
  mock.deliver(incoming); mock.deliver(incoming);
  await expect(log).toContainText("Когда можно забрать?");
  await expect(log.getByText("Когда можно забрать?", { exact: true })).toHaveCount(1);
  await expect.poll(() => mock.calls.filter((call) => call.action === "read_chat").length).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "artifacts/ui/messenger-mobile.png", fullPage: true });
  expect(mock.backend.pageErrors).toEqual([]);
  await page.getByLabel("Аккаунт для переписки").selectOption("second");
  await expect(page.getByRole("log")).not.toBeAttached();
  await expect(page.getByText("Диалогов на этой странице нет.")).toBeVisible();
  await expect.poll(mock.leaves).toBeGreaterThan(0);
  mock.deliver({ ...incoming, id: "late", text: "Не должно попасть во второй аккаунт" });
  await expect(page.getByText("Не должно попасть во второй аккаунт")).not.toBeAttached();
});

test("messenger keeps failed text, blocks automatic resend, isolates CRM drafts", async ({ page }) => {
  const mock = await setup(page);
  await page.getByRole("button", { name: /Алексей/ }).click();
  await expect(page.getByRole("log")).toContainText("Товар ещё продаётся?");
  mock.failSend();
  await page.getByLabel("Ответ в Авито", { exact: true }).fill("Проверочный ответ");
  await page.getByRole("button", { name: "Отправить в Авито", exact: true }).click();
  await expect(page.getByText(/Не удалось подтвердить отправку/)).toBeVisible();
  await expect(page.getByLabel("Ответ в Авито", { exact: true })).toHaveValue("Проверочный ответ");
  await expect(page.getByRole("button", { name: "Отправить в Авито", exact: true })).toBeDisabled();
  expect(mock.calls.filter((call) => call.action === "send_message")).toHaveLength(1);
  await page.getByRole("button", { name: "Черновики CRM", exact: true }).click();
  await expect(page.getByText(/Это черновики CRM/)).toBeVisible();
  expect(mock.backend.rows.messages).toHaveLength(0);
  expect(mock.backend.pageErrors).toEqual([]);
});

test("messenger reports API subscription restrictions", async ({ page }) => {
  await page.clock.install();
  const mock = await setup(page);
  await expect(page.getByRole("button", { name: /Алексей/ })).toBeVisible();
  mock.failChats();
  await page.getByRole("button", { name: "Обновить диалоги", exact: true }).click();
  await expect(page.getByText("Проверьте подписку Авито")).toBeVisible();
  const callsAfterError = mock.calls.length;
  await page.clock.fastForward(600000);
  expect(mock.calls).toHaveLength(callsAfterError);
});

test("messenger respects the interval on focus and refreshes once after a long hidden period", async ({ page }) => {
  await page.clock.install();
  const mock = await setup(page);
  await expect(page.getByRole("button", { name: /Алексей/ })).toBeVisible();
  const initialCalls = mock.calls.length;
  await page.clock.fastForward(1000);
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(mock.calls).toHaveLength(initialCalls);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(180000);
  expect(mock.calls).toHaveLength(initialCalls);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => mock.calls.length).toBe(initialCalls + 1);
  await expect(page.getByRole("button", { name: "Обновить диалоги", exact: true })).toBeEnabled();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.clock.fastForward(1000);
  expect(mock.calls).toHaveLength(initialCalls + 1);
});

test("webhook messages survive API history errors and a page reload; deleting a message removes its old text", async ({ page }) => {
  const mock = await setup(page);
  await expect(page.getByText("Обновления CRM подключены", { exact: true })).toBeVisible();
  mock.failHistory();
  const incoming: AvitoMessage = { id: "cached-1", text: "Получено через webhook", type: "text", created: 1700000002, direction: "in", isRead: false };
  mock.deliver(incoming);
  await page.getByRole("button", { name: /Алексей/ }).click();
  await expect(page.getByRole("log")).toContainText("Получено через webhook");
  await expect(page.getByText(/Показана сохранённая переписка/)).toBeVisible();
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "Сообщения", exact: true }).click();
  await expect(page.getByText("Обновления CRM подключены", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Алексей/ }).click();
  await expect(page.getByRole("log")).toContainText("Получено через webhook");
  mock.deliver({ ...incoming, type: "deleted", text: "Сообщение удалено" });
  await expect(page.getByRole("log")).not.toContainText("Получено через webhook");
  await expect(page.getByRole("log")).toContainText("Сообщение удалено");
});

test("realtime reconnect catches missed messages without periodic API polling", async ({ page }) => {
  await page.clock.install();
  const mock = await setup(page);
  await expect(page.getByText("Обновления CRM подключены", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Алексей/ }).click();
  await expect(page.getByRole("log")).toContainText("Товар ещё продаётся?");
  for (const channel of mock.channels.values()) channel.socket.close({ code: 1012, reason: "Test reconnect" });
  await expect(page.getByText(/Связь обновлений прервана/)).toBeVisible();
  mock.deliver({ id: "missed-1", text: "Сообщение во время разрыва связи", type: "text", created: 1700000003, direction: "in", isRead: false }, "chat-1", "main", false);
  await page.clock.fastForward(31000);
  await expect(page.getByText("Обновления CRM подключены", { exact: true })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("Сообщение во время разрыва связи");
  await expect.poll(() => mock.calls.filter((call) => call.action === "chat_messages").length).toBeGreaterThan(1);
  await expect(page.getByRole("button", { name: "Обновить переписку", exact: true })).toBeEnabled();
  const queries = () => mock.calls.filter((call) => ["chat_messages", "chats"].includes(String(call.action))).length;
  const count = queries();
  await page.clock.fastForward(600000);
  expect(queries()).toBe(count);
});

test("messenger does not mark already-read incoming or unread outgoing messages", async ({ page }) => {
  const mock = await setup(page);
  mock.messages[0].isRead = true;
  mock.messages.push({ id: "out-1", text: "Мой ответ", type: "text", created: 1700000001, direction: "out", isRead: false });
  mock.setReadReply({ error: "avito_subscription", message: "Прочтение недоступно" }, 402);
  await page.getByRole("button", { name: /Алексей/ }).click();
  await expect(page.getByRole("log")).toContainText("Мой ответ");
  await page.getByRole("button", { name: "Обновить переписку", exact: true }).click();
  await expect(page.getByRole("button", { name: "Обновить переписку", exact: true })).toBeEnabled();
  expect(mock.calls.filter((call) => call.action === "read_chat")).toHaveLength(0);
  await expect(page.getByText(/Авито не подтвердило прочтение/)).not.toBeAttached();
});

test("messenger preserves the read error and retries only the receipt without losing the chat or draft", async ({ page }) => {
  const mock = await setup(page);
  mock.setReadReply({ error: "avito_access", message: "Авито не разрешил этот запрос." }, 403);
  await page.getByRole("button", { name: /Алексей/ }).click();
  await expect(page.getByText(/Авито не разрешил этот запрос.*HTTP 403/)).toBeVisible();
  await expect(page.getByRole("log")).toContainText("Товар ещё продаётся?");
  await page.getByLabel("Ответ в Авито", { exact: true }).fill("Несохранённый черновик");
  const loaded = mock.calls.filter((call) => call.action === "chat_messages").length;
  mock.setReadReply({ read: true });
  await page.getByRole("button", { name: "Повторить отметку прочтения" }).click();
  await expect(page.getByText(/Авито не подтвердило прочтение/)).not.toBeAttached();
  await expect(page.getByLabel("Ответ в Авито", { exact: true })).toHaveValue("Несохранённый черновик");
  expect(mock.calls.filter((call) => call.action === "read_chat")).toHaveLength(2);
  expect(mock.calls.filter((call) => call.action === "chat_messages")).toHaveLength(loaded);
  expect(mock.calls.filter((call) => call.action === "send_message")).toHaveLength(0);
});

test("messenger explains an outdated function and clears the warning when Avito confirms messages already read", async ({ page }) => {
  const mock = await setup(page);
  mock.setReadReply({ error: "invalid_action", message: "Действие не поддерживается." }, 400);
  await page.getByRole("button", { name: /Алексей/ }).click();
  await expect(page.getByText(/Опубликованная функция avito не поддерживает отметку прочтения/)).toBeVisible();
  await page.getByRole("button", { name: "Обновить переписку", exact: true }).click();
  await expect(page.getByRole("button", { name: "Обновить переписку", exact: true })).toBeEnabled();
  expect(mock.calls.filter((call) => call.action === "read_chat")).toHaveLength(1);
  mock.messages[0].isRead = true;
  await page.getByRole("button", { name: "Обновить переписку", exact: true }).click();
  await expect(page.getByText(/Авито не подтвердило прочтение/)).not.toBeAttached();
  expect(mock.calls.filter((call) => call.action === "read_chat")).toHaveLength(1);
});

test("messenger serializes receipts when new messages arrive during an in-flight receipt", async ({ page }) => {
  const mock = await setup(page);
  let release!: () => void;
  mock.holdRead(new Promise<void>((resolve) => { release = resolve; }));
  await page.getByRole("button", { name: /Алексей/ }).click();
  await expect.poll(() => mock.calls.filter((call) => call.action === "read_chat").length).toBe(1);
  mock.messages.push({ id: "new-2", text: "Ещё вопрос", type: "text", created: 1700000002, direction: "in", isRead: false });
  await page.getByRole("button", { name: "Обновить переписку", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Ещё вопрос");
  expect(mock.calls.filter((call) => call.action === "read_chat")).toHaveLength(1);
  release();
  await expect.poll(() => mock.calls.filter((call) => call.action === "read_chat").length).toBe(2);
  await expect(page.getByText(/Авито не подтвердило прочтение/)).not.toBeAttached();
});
