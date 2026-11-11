import { LOCAL_GRANT_BOOTSTRAP } from "./lib/local-grants.mjs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(`OBSERVATION_ADAPTER_GATE_FAILED:${command}`);
  return r;
}
const container = "lyraseo-phase1-postgres";
const c = JSON.parse(
  run("docker", ["inspect", container], { encoding: "utf8", stdio: "pipe" })
    .stdout,
)[0];
const b = c.HostConfig.PortBindings?.["5432/tcp"];
if (
  c.Config.Image !== "postgres:17-alpine" ||
  b?.length !== 1 ||
  b[0].HostIp !== "127.0.0.1" ||
  b[0].HostPort !== "54329" ||
  !c.State.Running
)
  throw Error("UNSAFE_OBSERVATION_TEST_CONTAINER");
const database =
  "lyraseo_ledger_" + randomUUID().replaceAll("-", "").slice(0, 12);
run("docker", [
  "exec",
  container,
  "createdb",
  "-U",
  "postgres",
  "-T",
  "template0",
  database,
]);
console.log("Owned observation adapter database:", database);
function sql(input) {
  run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input, stdio: ["pipe", "inherit", "inherit"] },
  );
}
// Existing reviewed roles are required; this test never changes shared services/roles.
run(
  "pnpm",
  ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
  {
    env: {
      ...process.env,
      DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${database}`,
    },
  },
);
sql(LOCAL_GRANT_BOOTSTRAP);
sql(
  `INSERT INTO lyraseo_ledger.environment(database_oid,postmaster_started_at,fixture_version) SELECT oid,pg_postmaster_start_time(),'SYNTHETIC_LEDGER_V1' FROM pg_database WHERE datname=current_database();`,
);
run("pnpm", ["exec", "vitest", "run", "tests/observation-adapters"], {
  env: { ...process.env, LYRA_OBSERVATION_DB: database },
});
console.log(
  "PASS: offline observation adapter/binding/ledger fixture. Database retained for review:",
  database,
);
