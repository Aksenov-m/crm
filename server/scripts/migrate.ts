import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "../db.js";

const migration = "015_create_self_hosted_backend_schema.sql";

export async function migrate(): Promise<void> {
  const ledger = await pool.query("select to_regclass('public.crm_schema_migrations') as name");
  if (ledger.rows[0]?.name) {
    const applied = await pool.query("select 1 from crm_schema_migrations where name = $1", [migration]);
    if (applied.rowCount) return;
  }
  const sql = await readFile(resolve(process.cwd(), "docs", migration), "utf8");
  await pool.query(sql);
  await pool.query("insert into crm_schema_migrations(name) values ($1) on conflict do nothing", [migration]);
  console.info(`Applied ${migration}`);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/server/scripts/migrate.ts")) {
  migrate().then(() => pool.end()).catch(async (error: unknown) => {
    console.error("Database migration failed:", error instanceof Error ? error.message : "unknown error");
    await pool.end();
    process.exitCode = 1;
  });
}
