import { mkdir, readFile, writeFile } from "node:fs/promises";

// Produces one self-contained file for Supabase Dashboard's editor. No env files are read.
const source = await readFile(new URL("../supabase/functions/avito/handler.ts", import.meta.url), "utf8");
if (!source.includes("export function createAvitoHandler")) throw new Error("Avito function entry was not found");
const output = source.replace("export function createAvitoHandler", "function createAvitoHandler")
  + '\nDeno.serve(createAvitoHandler({ env: (name) => Deno.env.get(name), fetch }));\n';
const directory = new URL("../artifacts/avito-function/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("index.ts", directory), output, "utf8");
console.log("Supabase Dashboard file ready: artifacts/avito-function/index.ts (no credentials included)");
