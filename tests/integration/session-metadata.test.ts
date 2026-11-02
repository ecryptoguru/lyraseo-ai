import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { adminUrl } from "../helpers/database";
const { Client } = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
)("pg");
it("exposes only session metadata with invoker privileges and no browser access", async () => {
  // Fixed disposable loopback database only. All fixture DDL is rolled back.
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_migrator') THEN CREATE ROLE lyraseo_migrator NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA auth;
    REVOKE ALL ON SCHEMA auth FROM PUBLIC;
    CREATE TABLE auth.sessions(id uuid,user_id uuid,created_at timestamptz,refreshed_at timestamp,not_after timestamptz,refresh_token text);
    INSERT INTO auth.sessions VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','2026-10-23 10:00:00Z','2026-10-23 10:30:00',NULL,'private-token-fixture');`);
    await client.query(
      readFileSync(
        new URL(
          "../../scripts/sql/supabase-session-metadata.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await client.query("SET LOCAL ROLE lyraseo_identity");
    const { rows } = await client.query(
      "SELECT id::text,to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS created, to_char(refreshed_at,'YYYY-MM-DD HH24:MI:SS') AS refreshed FROM lyraseo_private.session_metadata",
    );
    expect(rows).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        created: "2026-10-23 10:00:00",
        refreshed: "2026-10-23 10:30:00",
      },
    ]);
    const {
      rows: [permissions],
    } =
      await client.query(`SELECT has_schema_privilege(current_user,'auth','USAGE') AS broad_schema,
      has_column_privilege(current_user,c.oid,'refresh_token','SELECT') AS token_read,
      has_column_privilege(current_user,c.oid,'id','SELECT') AS metadata_read
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND c.relname='sessions'`);
    expect(permissions).toEqual({
      broad_schema: false,
      token_read: false,
      metadata_read: true,
    });
    await client.query("RESET ROLE; SET LOCAL ROLE anon");
    await expect(
      client.query("SELECT * FROM lyraseo_private.session_metadata"),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
