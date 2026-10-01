import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { AvitoRequestError, createAvitoRepository, mergeAvitoMessages, type AvitoMessage } from "../src/lib/avito";

function fixture(response: () => Response) {
  const calls: unknown[] = [];
  const client = createClient("https://test.supabase.co", "sb_publishable_test", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (_input, init) => {
      assert.equal(init?.method, "POST");
      calls.push(JSON.parse(String(init?.body)));
      return response();
    } },
  });
  return { repository: createAvitoRepository(client), calls };
}

test("readChat requires explicit confirmation from the Edge function", async () => {
  const f = fixture(() => Response.json({ read: true }));
  await f.repository.readChat("main", "chat:1/2");
  assert.deepEqual(f.calls, [{ action: "read_chat", accountKey: "main", chatId: "chat:1/2" }]);
  for (const data of [{ read: false }, {}, null]) {
    const invalid = fixture(() => Response.json(data));
    await assert.rejects(invalid.repository.readChat("main", "chat-1"), (error: unknown) => error instanceof AvitoRequestError && error.code === "invalid_read_receipt");
  }
});

test("readChat distinguishes outdated deployment from a real Avito restriction", async () => {
  const outdated = fixture(() => Response.json({ error: "invalid_action", message: "Действие не поддерживается." }, { status: 400 }));
  await assert.rejects(outdated.repository.readChat("main", "chat-1"), (error: unknown) => error instanceof AvitoRequestError && error.status === 400 && /Обновите её/.test(error.message));
  const denied = fixture(() => Response.json({ error: "avito_subscription", message: "Авито отклонил доступ к Messenger API" }, { status: 402 }));
  await assert.rejects(denied.repository.readChat("main", "chat-1"), (error: unknown) => error instanceof AvitoRequestError && error.status === 402 && error.code === "avito_subscription" && error.message === "Авито отклонил доступ к Messenger API");
  assert.equal(denied.calls.length, 1);
});

test("readChat preserves gateway status without exposing its raw response", async () => {
  const gateway = fixture(() => new Response("<html>private gateway debug details</html>", { status: 502, headers: { "Content-Type": "text/html" } }));
  await assert.rejects(gateway.repository.readChat("main", "chat-1"), (error: unknown) => error instanceof AvitoRequestError && error.status === 502 && !error.message.includes("private"));
});

test("API snapshots, confirmed sends and webhook updates merge without duplicates or resurrecting deleted text", () => {
  const message: AvitoMessage = { id: "m1", text: "Hello", type: "text", direction: "in", created: 1, isRead: false };
  assert.equal(mergeAvitoMessages([message], [message], [message]).length, 1);
  const deleted = { ...message, text: "Сообщение удалено", type: "deleted", isRead: true };
  assert.deepEqual(mergeAvitoMessages([deleted], [message]), [deleted]);
  assert.deepEqual(mergeAvitoMessages([message], [deleted]), [deleted]);
  assert.equal(mergeAvitoMessages([{ ...message, isRead: true }], [message])[0].isRead, true);
});
