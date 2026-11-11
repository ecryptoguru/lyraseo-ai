import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestSha256 =
  "675d7b72f77de71b9252b2a2f720e6d503afffc1660988b5b870effa05961f03";
export const visibilityMigration = "202611030006_legacy_visibility_retention";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function readPinnedBaseline(root) {
  const fixtureRoot = resolve(root, "tests/fixtures/migrations");
  const bytes = readFileSync(
    resolve(fixtureRoot, "legacy-inline-baseline.json"),
  );
  assert.equal(hash(bytes), manifestSha256, "Pinned baseline manifest drift");
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.migrations.length, 27);
  const bootstrap = readFileSync(
    resolve(fixtureRoot, "legacy-inline-baseline-bootstrap.sql"),
    "utf8",
  );
  assert.equal(
    hash(bootstrap),
    manifest.bootstrapSha256,
    "Pinned bootstrap drift",
  );
  return { ...manifest, bootstrap, manifestSha256 };
}

export function verifyBaseline(migrationRoot, manifest) {
  for (const [name, expected] of manifest.migrations)
    assert.equal(
      hash(readFileSync(resolve(migrationRoot, name, "migration.sql"))),
      expected,
      `Accepted baseline migration drift: ${name}`,
    );
}

export function requireVisibilityGuard(migrations, bootstrap) {
  const required = migrations.includes(visibilityMigration);
  const marked = bootstrap.includes("UNSAFE_LEGACY_BOOTSTRAP_GRANT");
  assert(
    !required || marked,
    "Migration28 requires the current bootstrap visibility guard",
  );
  assert(
    !marked || required,
    "Visibility bootstrap guard requires migration28",
  );
  // Callers key SQL negative controls on the migration, never on guard text.
  return required;
}

export function verifyApplicationSchema(root, assembledRoot) {
  const schemaPath = "packages/db/prisma/schema.prisma";
  const actual = hash(readFileSync(resolve(root, schemaPath)));
  assert.equal(
    actual,
    hash(readFileSync(resolve(assembledRoot, schemaPath))),
    "ASSEMBLED_APPLICATION_SCHEMA_MISMATCH: run current sources and Prisma against their assembled migrations",
  );
  return actual;
}
