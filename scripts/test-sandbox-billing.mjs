import { createHash, randomBytes } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
const container = "lyraseo-phase1-postgres";
function run(cmd, args, options = {}) {
  const p = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (p.status !== 0)
    throw Error(
      `${cmd} failed (${p.status}): ${p.stderr ?? ""}${p.stdout ?? ""}`,
    );
  return p.stdout;
}
const inspect = JSON.parse(run("docker", ["inspect", container]))[0];
if (
  inspect.Config.Image !== "postgres:17-alpine" ||
  inspect.HostConfig.PortBindings["5432/tcp"]?.length !== 1 ||
  inspect.HostConfig.PortBindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
  inspect.HostConfig.PortBindings["5432/tcp"][0].HostPort !== "54329" ||
  !inspect.State.Running
)
  throw Error("VALIDATED_LOCAL_POSTGRES_REQUIRED");
const sourceRoot = realpathSync(
  process.env.LYRA_BILLING_RECOVERY_SOURCE_ROOT ?? process.cwd(),
);
if (sourceRoot !== realpathSync(process.cwd())) {
  const ownGit = run("git", ["rev-parse", "--git-common-dir"]).trim();
  const otherGit = run("git", [
    "-C",
    sourceRoot,
    "rev-parse",
    "--git-common-dir",
  ]).trim();
  if (realpathSync(ownGit) !== realpathSync(otherGit))
    throw Error("RECOVERY_FIXTURE_MUST_SHARE_GIT_REPOSITORY");
}
const recoveryDir = "202611030010_privacy_recovery";
const recoverySqlPath = `${sourceRoot}/packages/db/prisma/migrations/${recoveryDir}/migration.sql`;
const hasRecovery = existsSync(recoverySqlPath);
const recoverySql = hasRecovery ? readFileSync(recoverySqlPath, "utf8") : null;
const recoveryModuleHashes = hasRecovery
  ? Object.fromEntries(
      ["site-deletion.ts", "recovery-journal.ts", "context.ts"].map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(`${sourceRoot}/packages/db/src/${file}`))
          .digest("hex"),
      ]),
    )
  : {};
const name = "lyraseo_billing_" + randomBytes(6).toString("hex");
const sql = (db, body) =>
  run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-v",
      "ON_ERROR_STOP=1",
      "-X",
    ],
    { input: body },
  );
for (const [role, password] of [
  ["lyraseo_billing_owner", null],
  ...(hasRecovery
    ? [
        ["lyraseo_history_owner", null],
        ["lyraseo_deletion_owner", null],
      ]
    : []),
  ["lyraseo_billing_intake", "local_billing_intake_only"],
  ["lyraseo_billing_reconciler", "local_billing_reconciler_only"],
  ["lyraseo_staff_executor", "local_staff_executor_only"],
]) {
  sql(
    "postgres",
    `DO $$ DECLARE r pg_roles; BEGIN SELECT * INTO r FROM pg_roles WHERE rolname='${role}'; IF FOUND THEN IF r.rolcanlogin<>${password !== null} OR r.rolinherit OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) OR EXISTS(SELECT FROM pg_database WHERE datdba=r.oid) THEN RAISE EXCEPTION 'UNSAFE_EXISTING_BILLING_ROLE'; END IF; ELSE CREATE ROLE ${role} ${password ? `LOGIN PASSWORD '${password}'` : "NOLOGIN"} NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$;`,
  );
}
sql("postgres", `CREATE DATABASE ${name} TEMPLATE template0;`);
mkdirSync("output", { recursive: true });
writeFileSync("output/sandbox-billing-owned-db.txt", name + "\n");
writeFileSync(
  "output/sandbox-billing-recovery-source.json",
  JSON.stringify(
    {
      available: hasRecovery,
      root: sourceRoot,
      sourceModuleHashes: recoveryModuleHashes,
      migration: hasRecovery ? recoveryDir : null,
      migrationSHA256: hasRecovery
        ? createHash("sha256")
            .update(readFileSync(recoverySqlPath))
            .digest("hex")
        : null,
      profile: hasRecovery ? "ACTUAL_LOCAL_SERVICE_REHEARSAL" : "UNAVAILABLE",
    },
    null,
    2,
  ) + "\n",
);
let dirs = readdirSync("packages/db/prisma/migrations")
  .filter((x) => /^\d/.test(x))
  .sort();
if (hasRecovery && !dirs.includes(recoveryDir))
  dirs = [...dirs, recoveryDir].sort();
const migrationSql = (dir) =>
  dir === recoveryDir
    ? recoverySql
    : readFileSync(
        `packages/db/prisma/migrations/${dir}/migration.sql`,
        "utf8",
      );
for (const dir of dirs) sql(name, migrationSql(dir));
sql(
  name,
  `INSERT INTO lyraseo_kernel.test_environment SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database(); GRANT USAGE ON SCHEMA public TO lyraseo_runtime; GRANT SELECT ON "ProductUser","Workspace","Membership","StaffGrant" TO lyraseo_runtime;`,
);
// A second NEW database rehearses the additive upgrade with retained product,
// private audit and exact provider-cost history. The tested database is separate.
const upgrade = "lyraseo_billing_" + randomBytes(6).toString("hex");
sql("postgres", `CREATE DATABASE ${upgrade} TEMPLATE template0;`);
const current = "202611030011_sandbox_billing_admin";
const staffJobControl = "202611030015_staff_job_control";
for (const dir of dirs.filter((dir) => dir !== current && dir !== staffJobControl))
  sql(upgrade, migrationSql(dir));
sql(
  upgrade,
  `INSERT INTO "ProductUser"(id) VALUES('billing-history-user');
 INSERT INTO "Workspace"(id,name) VALUES('billing-history-workspace','Retained fixture');
 INSERT INTO "Membership"("workspaceId","userId",role) VALUES('billing-history-workspace','billing-history-user','OWNER');
 INSERT INTO "Site"(id,"workspaceId",origin,"verifiedAt") VALUES('billing-history-site','billing-history-workspace','https://history.invalid',now());
 INSERT INTO "BudgetPeriod"(id,"userId",period,bucket,"limit",spent,reserved) VALUES('billing-history-budget','billing-history-user','2026-11','AZURE',8,0.123456789,0.5);
 INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion",status,evaluation)
 VALUES('billing-history-audit','billing-history-workspace','billing-history-site','billing-history-user',0,'history','history','["https://history.invalid/"]','LOCAL_RAW_V1','{}','readiness-v2','COMPLETED','{"saved":true}');
 INSERT INTO "StaffGrant"("userId",enabled) VALUES('billing-history-user',false);`,
);
const snapshot = `SELECT jsonb_build_object('users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "ProductUser" t),'workspaces',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "Workspace" t),'audits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "AuditRun" t),'budgets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "BudgetPeriod" t),'staff',(SELECT jsonb_agg(to_jsonb(t) ORDER BY "userId") FROM "StaffGrant" t),'policies',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM "RuntimePolicy" t));`;
const before = sql(upgrade, snapshot);
sql(upgrade, 'GRANT SELECT ON "ProductUser" TO lyraseo_billing_intake;');
let unsafeRejected = false;
try {
  sql(
    upgrade,
    readFileSync(
      `packages/db/prisma/migrations/${current}/migration.sql`,
      "utf8",
    ),
  );
} catch (error) {
  if (!String(error).includes("UNSAFE_BILLING_ROLE")) throw error;
  unsafeRejected = true;
}
if (!unsafeRejected) throw Error("UNSAFE_BILLING_ROLE_WAS_ACCEPTED");
sql(upgrade, 'REVOKE SELECT ON "ProductUser" FROM lyraseo_billing_intake;');
sql(
  upgrade,
  readFileSync(
    `packages/db/prisma/migrations/${current}/migration.sql`,
    "utf8",
  ),
);
sql(
  upgrade,
  readFileSync(
    `packages/db/prisma/migrations/${staffJobControl}/migration.sql`,
    "utf8",
  ),
);
const after = sql(upgrade, snapshot);
if (before !== after)
  throw Error("SANDBOX_BILLING_UPGRADE_CHANGED_EXISTING_HISTORY");
writeFileSync(
  "output/sandbox-billing-populated-replay.json",
  JSON.stringify(
    {
      database: upgrade,
      baselineMigrations: dirs.length - 1,
      current,
      unchangedHistoricalSnapshot: true,
      profile: "LOCAL_SYNTHETIC_ONLY",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `PASS additive populated replay ${upgrade}: exact product/audit/budget/staff/policy history unchanged.`,
);
const env = {
  ...process.env,
  LYRA_SANDBOX_BILLING_TEST_DB: name,
  LYRA_BILLING_RECOVERY_SOURCE_ROOT: sourceRoot,
  LYRA_BILLING_HAS_RECOVERY: String(hasRecovery),
};
const p = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", process.env.LYRA_BILLING_REVIEW_ONLY==="true"?"tests/sandbox-billing/review-r1.test.ts":"tests/sandbox-billing"],
  { stdio: "inherit", env },
);
console.log(
  `Owned sandbox billing database retained: ${name}; no provider calls or canonical reset.`,
);
let sourceStable = true;
for (const [file, digest] of Object.entries(recoveryModuleHashes))
  if (
    createHash("sha256")
      .update(readFileSync(`${sourceRoot}/packages/db/src/${file}`))
      .digest("hex") !== digest
  )
    sourceStable = false;
if (!sourceStable) console.error("RECOVERY_SOURCE_CHANGED_DURING_GATE");
process.exitCode = sourceStable ? (p.status ?? 1) : 1;
