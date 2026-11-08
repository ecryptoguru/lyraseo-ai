// Synthetic security-catalog rehearsal for the current (assembled) schema.
// Inserts no customer data. Proves the catalog in scripts/lib/full-backup.mjs
// is not a table/function list: triggers (including internal FK triggers),
// indexes, views, sequences, types, ACLs and role memberships all change it.
import { register } from "node:module";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
register(new URL("./privacy-ts-loader.mjs", import.meta.url), import.meta.url);
const { createLocalBackupLab, catalog } = await import("./lib/full-backup.mjs");
const lab = await createLocalBackupLab({ profile: "assembled" });
let first;
try {
  for (let round = 0; round < 2; round++) {
    const database = await lab.create({ purpose: "SYNTHETIC" });
    try {
      await lab.install(database);
      const client = await lab.connect(database);
      try {
        const baseline = await catalog(client);
        assert.equal(baseline.tables.length, 139);
        assert.equal(baseline.foreignTables.length, 0);
        assert.ok(baseline.triggers.some((t) => t.internal));
        assert.ok(baseline.types.some((t) => t.kind === "e"));
        if (first)
          assert.deepEqual(
            baseline,
            first,
            "catalog varies between owned databases",
          );
        else first = baseline;

        // Aggregate fingerprint (lyraseo_report.membership_hash shape).
        const aggregate = baseline.functions.find(
          (entry) =>
            entry.schema === "lyraseo_report" &&
            entry.name === "membership_hash",
        );
        assert.ok(aggregate, "pinned aggregate must be captured");
        await client.query(
          `CREATE AGGREGATE public.backup_catalog_fixture(bigint) (SFUNC=pg_catalog.int8pl, STYPE=bigint)`,
        );
        const one = await catalog(client);
        const definition = (shape) =>
          shape.functions.find(
            (entry) =>
              entry.schema === "public" &&
              entry.name === "backup_catalog_fixture",
          )?.definition;
        assert.match(definition(one), /^[0-9a-f]{64}$/);
        await client.query(
          "DROP AGGREGATE public.backup_catalog_fixture(bigint)",
        );
        await client.query(
          `CREATE AGGREGATE public.backup_catalog_fixture(bigint) (SFUNC=pg_catalog.int8larger, STYPE=bigint)`,
        );
        const two = await catalog(client);
        assert.notEqual(
          definition(two),
          definition(one),
          "changed aggregate must change fingerprint",
        );
        await client.query(
          "DROP AGGREGATE public.backup_catalog_fixture(bigint)",
        );
        assert.deepEqual(await catalog(client), baseline);

        // Internal FK trigger disable (stable identity, enabled state).
        const trigger = baseline.triggers.find((t) => t.internal);
        assert.ok(trigger);
        const full = (
          await client.query(
            `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE n.nspname=$1 AND c.relname=$2 AND k.conname=$3 ORDER BY t.tgfoid::regprocedure::text LIMIT 1`,
            [trigger.schema, trigger.table_, trigger.constraint_name],
          )
        ).rows[0];
        assert.ok(full?.tgname, "full internal trigger name must resolve");
        await client.query(
          `ALTER TABLE "${trigger.schema}"."${trigger.table_}" DISABLE TRIGGER "${full.tgname}"`,
        );
        const disabled = await catalog(client);
        assert.notDeepEqual(
          disabled.triggers,
          baseline.triggers,
          "disabled internal trigger must change catalog",
        );
        const disabledRow = disabled.triggers.find(
          (t) =>
            t.schema === trigger.schema &&
            t.table_ === trigger.table_ &&
            t.constraint_name === trigger.constraint_name &&
            t.function_name === trigger.function_name,
        );
        assert.ok(
          disabledRow && disabledRow.enabled !== "O",
          "disabled state must be captured, not just definitions",
        );
        // Re-enable restores catalog identity (proof is not definition-only).
        await client.query(
          `ALTER TABLE "${trigger.schema}"."${trigger.table_}" ENABLE TRIGGER "${full.tgname}"`,
        );
        assert.deepEqual(
          await catalog(client),
          baseline,
          "re-enabled trigger must restore catalog",
        );
        // Type change: add an enum value.
        await client.query(
          `CREATE TYPE backup_catalog_fixture_enum AS ENUM ('A')`,
        );
        const withType = await catalog(client);
        assert.notDeepEqual(
          withType.types,
          baseline.types,
          "new enum must change catalog",
        );
        await client.query(
          `ALTER TYPE backup_catalog_fixture_enum ADD VALUE 'B'`,
        );
        const withTypeB = await catalog(client);
        assert.notDeepEqual(
          withTypeB.types,
          withType.types,
          "added enum label must change catalog",
        );
        await client.query(`DROP TYPE backup_catalog_fixture_enum`);
        assert.deepEqual((await catalog(client)).types, baseline.types);

        // Index, view, sequence, schema-ACL and role-membership mutations.
        const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
        const role = `lyraseo_catalog_${suffix}`;
        await client.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);
        await client.query("CREATE SCHEMA backup_catalog_fixture");
        await client.query(
          "CREATE TABLE backup_catalog_fixture.example (id bigint)",
        );
        let shape = await catalog(client);
        await client.query(
          "CREATE INDEX fixture_index ON backup_catalog_fixture.example(id)",
        );
        let changed = await catalog(client);
        assert.notDeepEqual(
          changed.indexes,
          shape.indexes,
          "added index must change catalog",
        );
        shape = changed;
        await client.query(
          "CREATE VIEW backup_catalog_fixture.example_view AS SELECT id FROM backup_catalog_fixture.example",
        );
        changed = await catalog(client);
        assert.notDeepEqual(
          changed.views,
          shape.views,
          "added view must change catalog",
        );
        shape = changed;
        await client.query(
          "CREATE SEQUENCE backup_catalog_fixture.example_sequence",
        );
        changed = await catalog(client);
        assert.notDeepEqual(
          changed.sequences,
          shape.sequences,
          "added sequence must change catalog",
        );
        shape = changed;
        await client.query(
          `GRANT USAGE ON SCHEMA backup_catalog_fixture TO "${role}"`,
        );
        changed = await catalog(client);
        assert.notDeepEqual(
          changed.schemas,
          shape.schemas,
          "schema ACL must change catalog",
        );
        shape = changed;
        await client.query(`GRANT "lyraseo_runtime" TO "${role}"`);
        changed = await catalog(client);
        assert.ok(
          changed.memberships.some(
            (m) => m.member === role && m.role === "lyraseo_runtime",
          ),
          "indirect role membership must change catalog",
        );
        await client.query(`REVOKE "lyraseo_runtime" FROM "${role}"`);
        await client.query(
          `REVOKE USAGE ON SCHEMA backup_catalog_fixture FROM "${role}"`,
        );
        await client.query("DROP SCHEMA backup_catalog_fixture CASCADE");
        await client.query(`DROP ROLE "${role}"`);
        expectClean: {
          const restored = await catalog(client);
          assert.equal(restored.indexes.length, baseline.indexes.length);
          assert.equal(restored.views.length, baseline.views.length);
          assert.equal(restored.sequences.length, baseline.sequences.length);
          assert.equal(restored.schemas.length, baseline.schemas.length);
          assert.equal(
            restored.memberships.length,
            baseline.memberships.length,
          );
          assert.equal(restored.types.length, baseline.types.length);
        }
      } finally {
        await lab.close(client);
      }
    } finally {
      await lab.drop(database);
    }
  }
  console.log(
    "PASS current catalog: stable identities + trigger/type/index/view/sequence/ACL/membership mutations",
  );
} finally {
  await lab.cleanup();
}
