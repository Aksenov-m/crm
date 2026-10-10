import { createAvitoFeedHandler } from "./handler.ts";

Deno.serve(createAvitoFeedHandler({ env: (name) => Deno.env.get(name), fetch }));
