import { createAvitoWebhookHandler } from "./handler.ts";

Deno.serve(createAvitoWebhookHandler({ env: (name) => Deno.env.get(name), fetch }));
