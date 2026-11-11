// Real PostgreSQL negative control; only this lab's freshly created DB is used.
import { register } from "node:module";
import assert from "node:assert/strict";
register(new URL("./privacy-ts-loader.mjs", import.meta.url), import.meta.url);
const { createLocalBackupLab, validateBackupForeignKeys } =
  await import("./lib/full-backup.mjs");
const lab = await createLocalBackupLab();
try {
  const database = await lab.create({ purpose: "SYNTHETIC" });
  await lab.install(database);
  const client = await lab.connect(database);
  try {
    await client.query(`CREATE TABLE public.backup_integrity_parent (id integer PRIMARY KEY);
      CREATE TABLE public.backup_integrity_child (id integer PRIMARY KEY, parent_id integer REFERENCES public.backup_integrity_parent(id));
      INSERT INTO public.backup_integrity_parent VALUES (1);
      INSERT INTO public.backup_integrity_child VALUES (1,1)`);
    await validateBackupForeignKeys(client);
    await client.query(
      "BEGIN; SET LOCAL session_replication_role=replica; INSERT INTO public.backup_integrity_child VALUES (2,99); COMMIT",
    );
    await assert.rejects(
      validateBackupForeignKeys(client),
      (error) => error.receipt?.code === "23503",
    );
    // A failed validation must roll back constraint changes, not lose enforcement.
    await assert.rejects(
      client.query("INSERT INTO public.backup_integrity_child VALUES (3,100)"),
      (error) => error.code === "23503",
    );
    await client.query("DELETE FROM public.backup_integrity_child WHERE id=2");
    await validateBackupForeignKeys(client);
    console.log(
      "PASS: valid projected FKs accepted; dangling FKs reject before archive publication; enforcement survives failure",
    );
  } finally {
    await lab.close(client);
  }
} finally {
  await lab.cleanup();
}
