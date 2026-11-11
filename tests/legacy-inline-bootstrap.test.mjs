import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createRunDirectory } from "../scripts/legacy-inline-receipt.mjs";
import { tmpdir } from "node:os";
import {
  readPinnedBaseline,
  verifyBaseline,
  requireVisibilityGuard,
  visibilityMigration,
  verifyApplicationSchema,
} from "../scripts/legacy-inline-baseline.mjs";

const root = resolve(import.meta.dirname, "..");
test("checked-in bootstrap and27 accepted migrations verify without Git", () => {
  const baseline = readPinnedBaseline(root);
  assert.equal(
    baseline.baselineCommit,
    "21c33b2413a7f1b627ee59bc9f79f2129e676af2",
  );
  verifyBaseline(resolve(root, "packages/db/prisma/migrations"), baseline);
});

test("migration28 always requires guard, including deleted or renamed marker", () => {
  assert.equal(requireVisibilityGuard([], ""), false);
  assert.equal(
    requireVisibilityGuard(
      [visibilityMigration],
      "RAISE EXCEPTION 'UNSAFE_LEGACY_BOOTSTRAP_GRANT'",
    ),
    true,
  );
  for (const text of ["", "RAISE EXCEPTION 'REMOVED_MARKER'"])
    assert.throws(
      () => requireVisibilityGuard([visibilityMigration], text),
      /Migration28 requires/,
    );
});

test("a changed baseline migration fails the pinned digest independently of current bytes", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "lyra-inline-baseline-"));
  try {
    const baseline = readPinnedBaseline(root);
    for (const [name] of baseline.migrations) {
      const directory = resolve(temporary, name);
      mkdirSync(directory);
      writeFileSync(
        resolve(directory, "migration.sql"),
        readFileSync(
          resolve(root, "packages/db/prisma/migrations", name, "migration.sql"),
        ),
      );
    }
    verifyBaseline(temporary, baseline);
    const target = resolve(
      temporary,
      baseline.migrations[0][0],
      "migration.sql",
    );
    writeFileSync(target, readFileSync(target, "utf8") + "\n-- drift\n");
    assert.throws(
      () => verifyBaseline(temporary, baseline),
      /Accepted baseline migration drift/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("changed pinned bootstrap or manifest is rejected", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "lyra-inline-bootstrap-"));
  try {
    const directory = resolve(temporary, "tests/fixtures/migrations");
    mkdirSync(directory, { recursive: true });
    for (const name of [
      "legacy-inline-baseline.json",
      "legacy-inline-baseline-bootstrap.sql",
    ])
      writeFileSync(
        resolve(directory, name),
        readFileSync(resolve(root, "tests/fixtures/migrations", name)),
      );
    readPinnedBaseline(temporary);
    const sql = resolve(directory, "legacy-inline-baseline-bootstrap.sql");
    writeFileSync(sql, readFileSync(sql, "utf8") + "\n");
    assert.throws(
      () => readPinnedBaseline(temporary),
      /Pinned bootstrap drift/,
    );
    const manifest = resolve(directory, "legacy-inline-baseline.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8") + "\n");
    assert.throws(
      () => readPinnedBaseline(temporary),
      /Pinned baseline manifest drift/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("current application schema must match assembled source before any SQL", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "lyra-inline-schema-"));
  try {
    mkdirSync(resolve(temporary, "packages/db/prisma"), { recursive: true });
    const original = readFileSync(
      resolve(root, "packages/db/prisma/schema.prisma"),
    );
    const destination = resolve(temporary, "packages/db/prisma/schema.prisma");
    writeFileSync(destination, original);
    verifyApplicationSchema(root, temporary);
    writeFileSync(destination, original + "\n// schema drift\n");
    assert.throws(
      () => verifyApplicationSchema(root, temporary),
      /ASSEMBLED_APPLICATION_SCHEMA_MISMATCH/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("overlapping receipt writers read only their own fresh report", async () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "lyra-inline-receipts-"));
  try {
    const directories = Array.from({ length: 2 }, () =>
      createRunDirectory(temporary),
    );
    const paths = directories.map((dir) =>
      resolve(dir, "required-service-results.json"),
    );
    await writeFile(paths[0], "first owned result");
    await assert.rejects(readFile(paths[1]), { code: "ENOENT" });
    await Promise.all(
      paths.map((path, index) => writeFile(path, String(index))),
    );
    // Both writers have finished before either verifier opens its own receipt.
    assert.deepEqual(
      await Promise.all(paths.map((path) => readFile(path, "utf8"))),
      ["0", "1"],
    );
    const reusedId = basename(directories[0]).slice("run-".length);
    assert.throws(() => createRunDirectory(temporary, reusedId), {
      code: "EEXIST",
    });
    assert.equal(await readFile(paths[0], "utf8"), "0");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
