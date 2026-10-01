import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("real PostgreSQL migration enforces owner RLS, service-only writes, deduplication and account binding", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth, public to anon, authenticated, service_role;
      grant execute on function auth.uid() to anon, authenticated, service_role;
      create publication supabase_realtime;
    `);
    await db.exec(await readFile(new URL("../docs/009_create_avito_messenger.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../docs/010_verify_avito_messenger.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../docs/011_create_avito_oauth.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../docs/012_allow_local_avito_oauth_redirect.sql", import.meta.url), "utf8"));
    const rows = await db.query<{ count: number }>("select count(*)::integer from public.avito_messenger_messages");
    assert.equal(rows.rows[0].count, 0, "verification must roll back its fixtures");
    const publication = await db.query("select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='avito_messenger_messages'");
    assert.equal(publication.rows.length, 1);
    const oauthTables = await db.query<{ count: number }>("select count(*)::integer from information_schema.tables where table_schema='public' and table_name in ('avito_oauth_states','avito_oauth_tokens')");
    assert.equal(oauthTables.rows[0].count, 2);
  } finally { await db.close(); }
});
