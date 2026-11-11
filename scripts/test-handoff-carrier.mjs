// Each case owns a newly created database in the pinned local fixture cluster.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const container = "lyraseo-phase1-postgres";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0)
    throw Error(`Carrier gate command failed: ${command}`);
  return result;
}
const info = JSON.parse(
  run("docker", ["inspect", container], { encoding: "utf8", stdio: "pipe" })
    .stdout,
)[0];
if (
  info.Config.Image !== "postgres:17-alpine" ||
  info.HostConfig.PortBindings["5432/tcp"]?.length !== 1 ||
  info.HostConfig.PortBindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
  info.HostConfig.PortBindings["5432/tcp"][0].HostPort !== "54329"
)
  throw Error("UNEXPECTED_FIXTURE_CLUSTER");
function sql(database, statement) {
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
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
    ],
    { input: statement, stdio: ["pipe", "inherit", "inherit"] },
  );
}
for (const test of [
  "tests/integration/handoff-carrier-db.test.ts",
  "tests/integration/handoff-timeout-db.test.ts",
]) {
  const database = `lyraseo_handoff_${randomBytes(6).toString("hex")}`;
  let owned = false;
  try {
    console.log(
      `Creating owned carrier fixture database ${database} for ${test}`,
    );
    sql("postgres", `CREATE DATABASE ${database} TEMPLATE template0`);
    owned = true;
    const direct = `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${database}`;
    run(
      "pnpm",
      ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
      { env: { ...process.env, DIRECT_URL: direct } },
    );
    sql(
      database,
      "INSERT INTO lyraseo_handoff.fixture_environment SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database()",
    );
    run("pnpm", ["exec", "vitest", "run", test], {
      env: {
        ...process.env,
        LYRA_HANDOFF_CARRIER_DB: database,
        LYRA_REQUIRE_HANDOFF_CARRIER: "1",
      },
    });
  } finally {
    if (owned) sql("postgres", `DROP DATABASE ${database} WITH (FORCE)`);
  }
}
