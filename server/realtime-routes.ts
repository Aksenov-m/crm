import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AppEnv, requireUser } from "./auth.js";
import { pool } from "./db.js";

const ACCOUNT_KEY = /^[a-zA-Z0-9_-]{1,40}$/;
type EventPayload = { owner_id?: string; account_key?: string; chat_id?: string };

export const realtimeRoutes = new Hono<AppEnv>();

realtimeRoutes.get("/events", requireUser, async (context) => {
  const ownerId = context.get("user").id;
  const accountKey = context.req.query("account_key") || "";
  if (!ACCOUNT_KEY.test(accountKey)) return context.json({ error: "invalid_account", message: "Некорректный аккаунт Авито." }, 400);
  const client = await pool.connect();
  try { await client.query("LISTEN crm_messenger"); }
  catch {
    client.release();
    return context.json({ error: "realtime_unavailable", message: "Не удалось подключить обновления переписки." }, 503);
  }

  context.header("Cache-Control", "no-cache, no-transform");
  context.header("X-Accel-Buffering", "no");
  return streamSSE(context, async (stream) => {
    let active = true;
    let queue = Promise.resolve();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let close = () => {};
    const onNotification = (notification: { payload?: string }) => {
      if (!active || !notification.payload) return;
      let event: EventPayload;
      try { event = JSON.parse(notification.payload) as EventPayload; } catch { return; }
      if (event.owner_id !== ownerId || event.account_key !== accountKey || !event.chat_id) return;
      queue = queue.then(async () => {
        if (!active) return;
        const { rows } = await pool.query(
          `select chat_id,message from avito_messenger_messages where owner_id=$1 and account_key=$2 and chat_id=$3
            order by created desc,message_id desc limit 100`,
          [ownerId,accountKey,event.chat_id],
        );
        for (const row of rows.reverse()) await stream.writeSSE({ event: "message", data: JSON.stringify({ chatId: row.chat_id, message: row.message }) });
      }).catch(close);
    };
    close = () => {
      if (!active) return;
      active = false;
      if (heartbeat) clearInterval(heartbeat);
      client.removeListener("notification", onNotification);
      void client.query("UNLISTEN crm_messenger").finally(() => client.release());
    };
    client.on("notification", onNotification);
    stream.onAbort(close);

    try {
      // LISTEN is active before the snapshot so an event cannot fall between them.
      const { rows } = await pool.query(
        `select chat_id,message from avito_messenger_messages where owner_id=$1 and account_key=$2
          order by created desc,message_id desc limit 200`,
        [ownerId,accountKey],
      );
      for (const row of rows.reverse()) await stream.writeSSE({ event: "message", data: JSON.stringify({ chatId: row.chat_id, message: row.message }) });
      heartbeat = setInterval(() => {
        if (active) void stream.writeSSE({ event: "ping", data: "{}" }).catch(close);
      }, 20_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    } finally { close(); }
  });
});
