import { spawnSync } from "node:child_process";
const name = "lyraseo-phase1-postgres";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("docker", ["info", "--format", "{{.ServerVersion}}"]);
const inspect = spawnSync("docker", ["inspect", name], { encoding: "utf8" });
if (inspect.status === 0) {
  const container = JSON.parse(inspect.stdout)[0];
  if (
    container.Config.Image !== "postgres:17-alpine" ||
    container.HostConfig.PortBindings["5432/tcp"]?.length !== 1 ||
    container.HostConfig.PortBindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
    container.HostConfig.PortBindings["5432/tcp"][0].HostPort !== "54329"
  ) {
    throw new Error(
      "An unrelated container uses the test name; leaving it untouched.",
    );
  }
  run("docker", ["start", name]);
} else
  run("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1:54329:5432",
    "--env",
    "POSTGRES_PASSWORD=lyraseo_local_only",
    "--env",
    "POSTGRES_DB=lyraseo_test",
    "postgres:17-alpine",
  ]);
for (let attempt = 0; attempt < 30; attempt++) {
  const ready = spawnSync(
    "docker",
    ["exec", name, "pg_isready", "-U", "postgres"],
    { stdio: "ignore" },
  );
  if (ready.status === 0) break;
  if (attempt === 29) throw new Error("Local PostgreSQL did not become ready.");
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const env = {
  ...process.env,
  DIRECT_URL:
    "postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/lyraseo_test",
};
function localScalar(sql) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "lyraseo_test",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error("Could not verify local cutover state: " + result.stderr);
  return result.stdout.trim();
}
// A DB lock cannot retract a reference buffered in an old publisher process.
// On an existing populated database require both stopped DB clients and an
// explicit local drain attestation. Empty fresh bootstraps have no old sends.
if (
  localScalar(
    `SELECT to_regclass('public."OutboxEvent"') IS NOT NULL AND to_regclass('public."WorkDispatch"') IS NULL`,
  ) === "t"
) {
  if (
    localScalar(
      "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend')",
    ) === "t"
  )
    throw new Error(
      "Stop local admissions and legacy publishers before applying dispatch cutover.",
    );
  if (
    localScalar('SELECT EXISTS(SELECT FROM public."OutboxEvent")') === "t" &&
    process.env.LYRA_LOCAL_OUTBOX_DRAINED !== "true"
  )
    throw new Error(
      "Drain pending old publisher sends, stop admissions, then set LYRA_LOCAL_OUTBOX_DRAINED=true for this local cutover.",
    );
}
// Provision cluster roles separately from migration SQL; these credentials
// are exclusively for the validated loopback-only disposable test instance.
const localRoles = [
  ["lyraseo_runtime", "local_runtime_only"],
  ["lyraseo_identity", "local_identity_only"],
  ["lyraseo_dispatch", "local_dispatch_only"],
  ["lyraseo_operator", "local_operator_only"],
  ["lyraseo_kernel_owner", null],
  ["anon", "local_anon_only"],
  ["authenticated", "local_authenticated_only"],
];
run(
  "docker",
  [
    "exec",
    "-i",
    name,
    "psql",
    "-U",
    "postgres",
    "-d",
    "lyraseo_test",
    "-v",
    "ON_ERROR_STOP=1",
  ],
  {
    input: localRoles
      .map(
        ([role, password]) =>
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} ${password ? `LOGIN PASSWORD '${password}'` : "NOLOGIN"} NOINHERIT NOSUPERUSER NOBYPASSRLS; END IF; END $$;`,
      )
      .join("\n"),
    stdio: ["pipe", "inherit", "inherit"],
  },
);
run("pnpm", ["--filter", "@lyraseo/db", "exec", "prisma", "generate"], { env });
run(
  "pnpm",
  ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
  { env },
);
const sql = `INSERT INTO lyraseo_kernel.test_environment(database_oid,postmaster_started_at)
  SELECT oid,pg_catalog.pg_postmaster_start_time() FROM pg_database WHERE datname=current_database()
  ON CONFLICT(database_oid) DO UPDATE SET postmaster_started_at=EXCLUDED.postmaster_started_at;
GRANT USAGE ON SCHEMA public TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "Workspace","Membership","Site","SiteGrant" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "AuditRun" TO lyraseo_runtime;
GRANT SELECT ON "AuditPage" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "IssueAction","SiteContextRevision" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "SiteVerificationChallenge" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "AnalyticsOAuthState","AnalyticsConnection","AnalyticsImport" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "GoogleOAuthState","GoogleConnection","SearchSnapshot","SearchImport" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "ContentDraft" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "ContentRevision","EvidenceReport" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "VisibilityPanel" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "VisibilityRun" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "ApiToken" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "ApiThrottle" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "PageIdentity","PageJournal" TO lyraseo_runtime;
GRANT UPDATE("revision","assignedTo") ON "PageIdentity" TO lyraseo_runtime;
GRANT SELECT ON "ProductUser" TO lyraseo_runtime;
GRANT SELECT ON "ProviderIdentity","StaffGrant" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "OperationQuote","StepUpGrant","BudgetPeriod","Operation" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "UsageReceipt" TO lyraseo_runtime;

GRANT USAGE ON SCHEMA public TO lyraseo_identity;
GRANT SELECT,INSERT ON "ProductUser","ProviderIdentity" TO lyraseo_identity;
GRANT SELECT,INSERT,UPDATE,DELETE ON "AuthThrottle","ProductSession" TO lyraseo_identity;`;
run(
  "docker",
  [
    "exec",
    "-i",
    name,
    "psql",
    "-U",
    "postgres",
    "-d",
    "lyraseo_test",
    "-v",
    "ON_ERROR_STOP=1",
  ],
  { input: sql, stdio: ["pipe", "inherit", "inherit"] },
);
console.log(
  "Isolated local test database ready on 127.0.0.1:54329. No cloud database was contacted.",
);
