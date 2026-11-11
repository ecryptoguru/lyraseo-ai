import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  runDirectory,
  verifyRequiredServices,
} from "./legacy-inline-receipt.mjs";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Explicit, non-skipping guard-removal and history-independent full-gate controls.
// Only temporary source copies and the main runner's new owned DBs are mutated.
const root = resolve(import.meta.dirname, "..");
const assembledRoot = process.env.LYRA_INLINE_ASSEMBLED_ROOT ?? root;
assert(
  existsSync(
    resolve(
      assembledRoot,
      "packages/db/prisma/migrations/202611030006_legacy_visibility_retention",
    ),
  ),
  "Controls require assembled migration28",
);
const source = readFileSync(
  resolve(assembledRoot, "scripts/lib/local-grants.mjs"),
  "utf8",
);
assert(source.includes("UNSAFE_LEGACY_BOOTSTRAP_GRANT"));
const temporary = mkdtempSync(resolve(tmpdir(), "lyra-inline-controls-"));
try {
  const shim = resolve(temporary, "bin");
  mkdirSync(shim);
  const gitCalled = resolve(temporary, "git-called");
  writeFileSync(
    resolve(shim, "git"),
    `#!/bin/sh\nprintf git-called > '${gitCalled}'\nexit 97\n`,
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
  for (const [name, altered, error] of [
    [
      "missing-marker",
      source.replaceAll("UNSAFE_LEGACY_BOOTSTRAP_GRANT", "REMOVED_MARKER"),
      /Migration28 requires the current bootstrap visibility guard/,
    ],
    [
      "removed-guard-retained-marker",
      source.replace(
        /DO \$\$ BEGIN\s+IF has_column_privilege\('lyraseo_runtime','public\."VisibilityRun"'[\s\S]*?END \$\$;/,
        "-- UNSAFE_LEGACY_BOOTSTRAP_GRANT",
      ),
      /Expected denial: BEGIN;/,
    ],
  ]) {
    assert.notEqual(altered, source, `Mutation must actually change ${name}`);
    const copy = resolve(temporary, name);
    mkdirSync(resolve(copy, "packages/db/prisma"), { recursive: true });
    mkdirSync(resolve(copy, "scripts/lib"), { recursive: true });
    symlinkSync(
      resolve(assembledRoot, "packages/db/prisma/schema.prisma"),
      resolve(copy, "packages/db/prisma/schema.prisma"),
    );
    symlinkSync(
      resolve(assembledRoot, "packages/db/prisma/migrations"),
      resolve(copy, "packages/db/prisma/migrations"),
      "dir",
    );
    writeFileSync(resolve(copy, "scripts/lib/local-grants.mjs"), altered);
    const id = randomUUID();
    const result = spawnSync(
      process.execPath,
      ["scripts/test-legacy-inline.mjs", id],
      {
        cwd: root,
        env: { ...env, LYRA_INLINE_ASSEMBLED_ROOT: copy },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    writeFileSync(
      resolve(runDirectory(root, id), `bootstrap-r1-${name}.log`),
      result.stdout + result.stderr,
    );
    assert.notEqual(result.status, 0, `${name} must fail the real runner`);
    assert.match(result.stderr, error);
    console.log(`PASS non-skipping real-runner negative control: ${name}`);
  }
  console.log(
    "Running complete owned gate with Git disabled and current assembled source:",
    assembledRoot,
  );
  const id = randomUUID();
  const output = runDirectory(root, id);
  const full = spawnSync(
    process.execPath,
    ["scripts/test-legacy-inline.mjs", id],
    {
      cwd: root,
      env: {
        ...env,
        LYRA_INLINE_ASSEMBLED_ROOT: assembledRoot,
        LYRA_INLINE_R2_RED: "true",
      },
      stdio: "inherit",
    },
  );
  assert.equal(full.status, 0, "Full history-independent owned gate must pass");
  const serviceResults = JSON.parse(
    readFileSync(resolve(output, "required-service-results.json"), "utf8"),
  );
  const gate = JSON.parse(readFileSync(resolve(output, "gate.json"), "utf8"));
  assert.deepEqual(
    gate.requiredServices,
    verifyRequiredServices(serviceResults, root),
  );
  console.log(
    "PASS parent LYRA_INLINE_R2_RED=true: all six R2 and five issue-action security cases passed; zero required cases skipped",
  );
  for (const [label, path, error] of [
    [
      "R2",
      "tests/integration/legacy-inline-r2.test.ts",
      /Expected exactly the six named R2 security cases/,
    ],
    [
      "issue-action",
      "tests/integration/legacy-inline-issue-actions.test.ts",
      /Expected exactly the five named issue-action security cases/,
    ],
  ]) {
    for (const [name, mutate] of [
      [
        "replacement",
        (cases) => {
          cases[0].fullName += " replacement";
        },
      ],
      [
        "missing",
        (cases) => {
          cases.pop();
        },
      ],
      [
        "duplicate",
        (cases) => {
          cases[0].fullName = cases[1].fullName;
        },
      ],
    ]) {
      const altered = structuredClone(serviceResults);
      const file = altered.testResults.find(
        (file) => file.name === resolve(root, path),
      );
      mutate(file.assertionResults);
      assert.throws(() => verifyRequiredServices(altered, root), error);
      console.log(
        `PASS rejected ${name} ${label} identity in real receipt with unchanged 27 passed / zero pending totals`,
      );
    }
    const skipped = structuredClone(serviceResults);
    skipped.testResults.find(
      (file) => file.name === resolve(root, path),
    ).assertionResults[0].status = "pending";
    assert.throws(
      () => verifyRequiredServices(skipped, root),
      /security cases must pass/,
    );
    console.log(
      `PASS rejected ${label} non-passing assertion with unchanged passing totals`,
    );
  }
  const falseResult = structuredClone(serviceResults);
  falseResult.success = false;
  assert.throws(() => verifyRequiredServices(falseResult, root));
  console.log("PASS rejected false success receipt");
  assert(!existsSync(gitCalled), "No child process may invoke Git");
  console.log("PASS complete owned gate; Git invocations: zero");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
