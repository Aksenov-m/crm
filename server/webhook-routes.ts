import { Hono } from "hono";
import { createAvitoWebhookHandler } from "./avito/webhook-handler.js";
import { avitoApiAccountByKey } from "./avito-credentials.js";
import { cacheAvitoMessages } from "./avito-storage.js";

const webhook = createAvitoWebhookHandler({
  env: (name) => process.env[name],
  fetch: globalThis.fetch.bind(globalThis),
  cacheMessages: cacheAvitoMessages,
  accountByKey: async (key) => {
    const account = await avitoApiAccountByKey(key);
    return account ? { ownerId: account.ownerId, clientId: account.clientId } : null;
  },
});

export const webhookRoutes = new Hono();
webhookRoutes.post("/avito/:key/:accountId/:signature", (context) => webhook(context.req.raw));
