import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { selectPrivacyBootstrap } from "../../scripts/lib/privacy-bootstrap.mjs";
import { readPinnedBaseline } from "../../scripts/legacy-inline-baseline.mjs";
import { LOCAL_GRANT_BOOTSTRAP } from "../../scripts/lib/local-grants.mjs";

const root = resolve(import.meta.dirname, "../..");
const migrationRoot = resolve(root, "packages/db/prisma/migrations");
const pinned = readPinnedBaseline(root);
const baseline = pinned.migrations.map(([name]: [string, string]) => name);
const privacy = "202611030010_privacy_recovery";
const team = "202611030009_agency_team";
const visibility = "202611030006_legacy_visibility_retention";
const report = "202611030013_legacy_saved_evidence";
const auditGuard = "202611030018_audit_admission_guard";
const names = readdirSync(migrationRoot)
  .filter((name) => existsSync(resolve(migrationRoot, name, "migration.sql")))
  .sort();
const records = (items: string[]) =>
  items.map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(resolve(migrationRoot, name, "migration.sql")))
      .digest("hex"),
  ]);

it("selects only the immutable historical grants for exact qualified privacy profiles", () => {
  expect(selectPrivacyBootstrap(root, records([...baseline, privacy]))).toBe(
    pinned.bootstrap,
  );
  expect(
    selectPrivacyBootstrap(root, records([...baseline, team, privacy])),
  ).toBe(pinned.bootstrap);
  expect(pinned.bootstrap).not.toContain("UNSAFE_LEGACY_BOOTSTRAP_GRANT");
});

it("uses current authoritative grants only for the exact qualified assembled profile", () => {
  expect(names).toContain(visibility);
  expect(names).toContain(privacy);
  expect(names).toContain(auditGuard);
  expect(selectPrivacyBootstrap(root, records(names))).toBe(
    LOCAL_GRANT_BOOTSTRAP,
  );
  expect(LOCAL_GRANT_BOOTSTRAP).toContain("UNSAFE_LEGACY_BOOTSTRAP_GRANT");
});

it("rejects absent, extra, reordered, duplicated and unqualified migration profiles", () => {
  const invalid = [
    records(baseline),
    records([...baseline, privacy, report]),
    records([...baseline.slice(1), privacy]),
    records([...baseline, privacy, privacy]),
    records(names.filter((name) => name !== team)),
    records(names.filter((name) => name !== auditGuard)),
    [
      ...records(names),
      ["202611030017_privacy_issuer_and_batches", "0".repeat(64)],
    ],
    [...records(names)].reverse(),
  ];
  for (const profile of invalid)
    expect(() => selectPrivacyBootstrap(root, profile)).toThrow(
      "PRIVACY_MIGRATION_SET_UNQUALIFIED",
    );
});

it("rejects altered visibility, privacy and other assembled migration bytes", () => {
  for (const name of [visibility, privacy, report, auditGuard]) {
    const changed = records(names).map((entry) =>
      entry[0] === name ? [name, "0".repeat(64)] : entry,
    );
    expect(() => selectPrivacyBootstrap(root, changed)).toThrow(
      "PRIVACY_MIGRATION_SET_UNQUALIFIED",
    );
  }
});

it("rejects changed current grants even if their visibility marker remains", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "lyra-privacy-grants-"));
  try {
    const directory = resolve(temporary, "scripts/lib");
    mkdirSync(directory, { recursive: true });
    cpSync(
      resolve(root, "scripts/lib/privacy-bootstrap.mjs"),
      resolve(directory, "privacy-bootstrap.mjs"),
    );
    cpSync(
      resolve(root, "scripts/legacy-inline-baseline.mjs"),
      resolve(temporary, "scripts/legacy-inline-baseline.mjs"),
    );
    writeFileSync(
      resolve(directory, "local-grants.mjs"),
      `export const LOCAL_GRANT_BOOTSTRAP = ${JSON.stringify(LOCAL_GRANT_BOOTSTRAP + "\n-- drift\n")};\n`,
    );
    const program = `import {selectPrivacyBootstrap} from ${JSON.stringify(pathToFileURL(resolve(directory, "privacy-bootstrap.mjs")).href)}; selectPrivacyBootstrap(${JSON.stringify(root)}, ${JSON.stringify(records(names))});`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", program],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PRIVACY_GRANT_PROFILE_UNQUALIFIED");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

it("rejects a changed accepted migration before selecting any grants", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "lyra-privacy-bootstrap-"));
  try {
    const fixture = resolve(temporary, "tests/fixtures/migrations");
    mkdirSync(fixture, { recursive: true });
    for (const name of [
      "legacy-inline-baseline.json",
      "legacy-inline-baseline-bootstrap.sql",
    ])
      cpSync(
        resolve(root, "tests/fixtures/migrations", name),
        resolve(fixture, name),
      );
    const target = resolve(temporary, "packages/db/prisma/migrations");
    mkdirSync(target, { recursive: true });
    for (const name of baseline)
      cpSync(resolve(migrationRoot, name), resolve(target, name), {
        recursive: true,
      });
    const changed = resolve(target, baseline[0], "migration.sql");
    writeFileSync(changed, readFileSync(changed, "utf8") + "\n-- drift\n");
    expect(() =>
      selectPrivacyBootstrap(temporary, records([...baseline, privacy])),
    ).toThrow("Accepted baseline migration drift");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
