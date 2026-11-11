import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  readPinnedBaseline,
  requireVisibilityGuard,
  verifyBaseline,
} from "../legacy-inline-baseline.mjs";
import { LOCAL_GRANT_BOOTSTRAP } from "./local-grants.mjs";

// Reviewed exact 39-migration assembly; additions or byte changes require a
// new independent qualification before the current grants can be selected.
const assembledExtra = [
  [
    "202611030006_legacy_visibility_retention",
    "a8449142a68c265569043c0e23bc3390b9a7eb862d56e383e70e87f4ffd86cda",
  ],
  [
    "202611030007_provider_attempt_ledger",
    "1f2dea470e4c32fe1ec33034b631ecb0bca2157fa86434b5b8626c5a9396d70a",
  ],
  [
    "202611030008_external_handoffs",
    "7b2b081e645eaa1ba30cf8cdb5e428928dd46641bcfd69e5e36a91bc2ee44b76",
  ],
  [
    "202611030009_agency_team",
    "84371e99a75e64887d04110fb6ed27c6a4312727f4465a4a3b08552de12ae545",
  ],
  [
    "202611030010_privacy_recovery",
    "866bba430cc23a7a06beec3b5d3503ddd1dcd2047437b1b117106b2b24af6be7",
  ],
  [
    "202611030011_sandbox_billing_admin",
    "5f804ab1cd2c53e394a456d2d199932a63baa4a4f7af96dc4aaca33cb116b2a5",
  ],
  [
    "202611030012_provider_observation_binding",
    "9f1cd044386733d7cb284b1e6cbbcdc15e0f42def649976f3e85fca5051275a5",
  ],
  [
    "202611030013_legacy_saved_evidence",
    "d23fb3720b28151b7eac1c7c83d4f082f5990e61c3980ff5312f7aa891910ff3",
  ],
  [
    "202611030014_legacy_inline_sources",
    "b475e1b985f3b923bbc2544c1f74cdfacdb80ebddec9f1c4c609c7644f188f04",
  ],
  [
    "202611030015_staff_job_control",
    "6e3617b7b2da24a46f99f9dd38d8322a80185f122efcc03600282306fd0d42b9",
  ],
  [
    "202611030016_handoff_dispatch",
    "5bdaedfd17d77638024dfb6bb2983a2b98f1ebb8e8e4c92cdc2fd4a8120f9c13",
  ],
  [
    "202611030018_audit_admission_guard",
    "f3097a2f77dafc3f95b079c1db07ad9c9e3f7dceadbc30fd4af4ae72e9fda1f1",
  ],
];
const grantSha256 =
  "e87d55c50d094c786c03c0ba5f2839800119a598d43214894074410fe96e2727";
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Pre-read and qualify the exact immutable SQL which the caller will execute. */
export function preparePrivacyMigrationPlan(root, { profile, teamSql } = {}) {
  const migrationRoot = resolve(root, "packages/db/prisma/migrations");
  const pinned = readPinnedBaseline(root);
  let names;
  if (profile === "historical") {
    if (teamSql !== undefined) throw Error("PRIVACY_MIGRATION_SET_UNQUALIFIED");
    names = [...pinned.migrations.map(([name]) => name), assembledExtra[4][0]];
  } else if (profile === "assembled") {
    names = readdirSync(migrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (teamSql !== undefined) {
      if (typeof teamSql !== "string" || names.includes(assembledExtra[3][0]))
        throw Error("UNQUALIFIED_TEAM_MIGRATION");
      names.push(assembledExtra[3][0]);
      names.sort();
    }
  } else throw Error("PRIVACY_MIGRATION_SET_UNQUALIFIED");

  const steps = names.map((name) => {
    const bytes =
      name === assembledExtra[3][0] && teamSql !== undefined
        ? Buffer.from(teamSql, "utf8")
        : readFileSync(resolve(migrationRoot, name, "migration.sql"));
    // Do not silently change SQL bytes through replacement-character decoding.
    const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(sql, "utf8").equals(bytes))
      throw Error("PRIVACY_MIGRATION_BYTES_INVALID");
    return Object.freeze({ name, sql, sha256: digest(bytes) });
  });
  const bootstrap = selectPrivacyBootstrap(
    root,
    steps.map(({ name, sha256 }) => [name, sha256]),
  );
  return Object.freeze({ steps: Object.freeze(steps), bootstrap });
}

// Records bind migration names to hashes of the actual SQL bytes submitted to
// PostgreSQL, including an optional agency fixture from another worktree.
export function selectPrivacyBootstrap(root, installed) {
  const pinned = readPinnedBaseline(root);
  verifyBaseline(resolve(root, "packages/db/prisma/migrations"), pinned);
  if (!Array.isArray(installed))
    throw Error("PRIVACY_MIGRATION_SET_UNQUALIFIED");
  const historical = [...pinned.migrations, assembledExtra[4]];
  const historicalWithTeam = [
    ...pinned.migrations,
    assembledExtra[3],
    assembledExtra[4],
  ];
  if (same(installed, historical) || same(installed, historicalWithTeam))
    return pinned.bootstrap;
  if (!same(installed, [...pinned.migrations, ...assembledExtra]))
    throw Error("PRIVACY_MIGRATION_SET_UNQUALIFIED");
  if (
    createHash("sha256").update(LOCAL_GRANT_BOOTSTRAP).digest("hex") !==
    grantSha256
  )
    throw Error("PRIVACY_GRANT_PROFILE_UNQUALIFIED");
  requireVisibilityGuard(
    installed.map(([name]) => name),
    LOCAL_GRANT_BOOTSTRAP,
  );
  return LOCAL_GRANT_BOOTSTRAP;
}
