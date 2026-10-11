import { serve } from "@hono/node-server";
import { createImageWorker } from "./image-worker-app.js";

const app = createImageWorker({
  token: process.env.IMAGE_WORKER_TOKEN || "",
  apiKey: process.env.OPENAI_API_KEY || "",
  model: process.env.OPENAI_IMAGE_MODEL,
});
const server = serve({ fetch: app.fetch, port: 3010, hostname: "0.0.0.0" }, () => {
  console.info("Image worker listening on port 3010");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { server.close(); });
}
