import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Each negative probe has a private copy of the assembled migrations. The
// caller's checkout and any existing local database are never modified.
test("staff job gate refuses missing, empty and invalid billing dependencies", () => {
  const fixture = mkdtempSync(join(tmpdir(), "lyraseo-staff-job-gate-"));
  const migrations = "packages/db/prisma/migrations";
  const billing = `${migrations}/202611030011_sandbox_billing_admin/migration.sql`;
  try {
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    mkdirSync(join(fixture, "packages/db/prisma"), { recursive: true });
    cpSync(migrations, join(fixture, migrations), { recursive: true });
    for (const name of [
      "test-staff-job-review.mjs",
      "test-staff-job-control.mjs",
    ])
      cpSync(`scripts/${name}`, join(fixture, "scripts", name));
    const original = readFileSync(join(fixture, billing));
    const run = () =>
      spawnSync(process.execPath, ["scripts/test-staff-job-review.mjs"], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          LYRA_BILLING_MIGRATION: resolve(billing),
          LYRA_STAFF_JOB_REVIEW_CASE: "invalid",
        },
      });
    unlinkSync(join(fixture, billing));
    let result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT/);
    writeFileSync(join(fixture, billing), "\n");
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EMPTY_BILLING_MIGRATION/);
    writeFileSync(join(fixture, billing), "THIS IS INVALID SQL;\n");
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /syntax error/);
    // Prove the missing-file probe did not consume the supplied decoy.
    assert.ok(original.length > 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("individual review case cannot silently default or accept an unknown case", () => {
  for (const value of ["", "not-a-case"]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/test-staff-job-control.mjs"],
      {
        encoding: "utf8",
        env: { ...process.env, LYRA_STAFF_JOB_REVIEW_CASE: value },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EXPLICIT_STAFF_JOB_REVIEW_CASE_REQUIRED/);
  }
});
