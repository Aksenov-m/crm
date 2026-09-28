import { createAvitoHandler } from "./handler.ts";

Deno.serve(createAvitoHandler({ env: (name) => Deno.env.get(name), fetch }));
