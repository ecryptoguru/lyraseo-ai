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
    container.HostConfig.PortBindings["5432/tcp"]?.[0]?.HostPort !== "54329"
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
run("pnpm", ["--filter", "@lyraseo/db", "exec", "prisma", "generate"], { env });
run(
  "pnpm",
  ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
  { env },
);
const sql = `DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_runtime') THEN CREATE ROLE lyraseo_runtime LOGIN PASSWORD 'local_runtime_only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
GRANT USAGE ON SCHEMA public TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "Workspace","Membership","Site","SiteGrant" TO lyraseo_runtime;
GRANT SELECT ON "ProductUser" TO lyraseo_runtime;
GRANT SELECT ON "ProviderIdentity","StaffGrant" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "OperationQuote","StepUpGrant","BudgetPeriod","Operation","OutboxEvent","UsageReceipt" TO lyraseo_runtime;
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_identity') THEN CREATE ROLE lyraseo_identity LOGIN PASSWORD 'local_identity_only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
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
