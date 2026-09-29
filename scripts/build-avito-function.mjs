import { mkdir, readFile, writeFile } from "node:fs/promises";

// Self-contained Dashboard files. No env files or credentials are read.
const shared = (await readFile(new URL("../supabase/functions/_shared/avito-messenger.ts", import.meta.url), "utf8")).replace(/^export /gm, "");
for (const [name, entry, directoryName] of [["avito", "createAvitoHandler", "avito-function"], ["avito-webhook", "createAvitoWebhookHandler", "avito-webhook-function"]]) {
  const source = await readFile(new URL(`../supabase/functions/${name}/handler.ts`, import.meta.url), "utf8");
  if (!source.includes(`export function ${entry}`)) throw new Error(`Missing entry: ${entry}`);
  const standalone = source.replace(/^import .*from "\.\.\/_shared\/avito-messenger\.ts";\r?\n/m, "").replace(`export function ${entry}`, `function ${entry}`);
  const output = shared + "\n" + standalone + `\nDeno.serve(${entry}({ env: (name) => Deno.env.get(name), fetch }));\n`;
  const directory = new URL(`../artifacts/${directoryName}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("index.ts", directory), output, "utf8");
  console.log(`Supabase Dashboard file ready: artifacts/${directoryName}/index.ts (no credentials included)`);
}
