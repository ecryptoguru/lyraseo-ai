import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePrivacyMigrationPlan } from "./lib/privacy-bootstrap.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const teamMigration = process.env.LYRA_RECOVERY_TEAM_MIGRATION;
let teamSql;
if (teamMigration) {
  const path = realpathSync(teamMigration);
  if (
    !path.endsWith(
      "/packages/db/prisma/migrations/202611030009_agency_team/migration.sql",
    )
  )
    throw Error("UNQUALIFIED_TEAM_MIGRATION");
  const repository = path.slice(
    0,
    -"/packages/db/prisma/migrations/202611030009_agency_team/migration.sql"
      .length,
  );
  const common = (cwd) => {
    const result = spawnSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8" },
    );
    if (result.status !== 0) throw Error("TEAM_REPOSITORY_REQUIRED");
    return realpathSync(result.stdout.trim());
  };
  if (common(repository) !== common(root))
    throw Error("TEAM_REPOSITORY_MISMATCH");
  teamSql = readFileSync(path, "utf8");
  process.stdout.write(
    JSON.stringify({
      teamMigrationSha256: createHash("sha256").update(teamSql).digest("hex"),
    }) + "\n",
  );
}
// Validate and retain exact SQL before Docker, role provisioning or database creation.
const plan = preparePrivacyMigrationPlan(root, {
  profile: "assembled",
  teamSql,
});
const historicalSeedBytes = readFileSync(
  resolve(root, "tests/fixtures/migrations/pre-history-recovery.sql"),
);
if (
  createHash("sha256").update(historicalSeedBytes).digest("hex") !==
  "a7fdb6cadc2157f1a6af968c72c7c865c50661b313304ea93814411c09442711"
)
  throw Error("HISTORY_SEED_UNQUALIFIED");
const historicalSeed = new TextDecoder("utf-8", { fatal: true }).decode(
  historicalSeedBytes,
);
const container = "lyraseo-phase1-postgres";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw Error("HISTORY_GATE_FAILED: " + command);
  return result;
}
const inspected = JSON.parse(
  run("docker", ["inspect", container], { stdio: "pipe", encoding: "utf8" })
    .stdout,
)[0];
const bindings = inspected.HostConfig.PortBindings?.["5432/tcp"];
if (
  inspected.Config.Image !== "postgres:17-alpine" ||
  bindings?.length !== 1 ||
  bindings[0].HostIp !== "127.0.0.1" ||
  bindings[0].HostPort !== "54329"
)
  throw Error("UNSAFE_HISTORY_CONTAINER");
const database =
  "lyraseo_recovery_" + randomUUID().replaceAll("-", "").slice(0, 12);
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
const sql = (input) =>
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
try {
  sql(
    `DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_history_owner') THEN CREATE ROLE lyraseo_history_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$;`,
  );
  sql(
    `DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_deletion_owner') THEN CREATE ROLE lyraseo_deletion_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$;`,
  );
  let populated = false;
  for (const step of plan.steps) {
    if (!populated && step.name > "202611030005_private_artifact_expiry") {
      sql(historicalSeed);
      populated = true;
    }
    sql(step.sql);
  }
  if (!populated) throw Error("HISTORY_MIGRATION_REQUIRED");
  sql(plan.bootstrap);
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      teamSql ? "tests/recovery/team-deletion.test.ts" : "tests/recovery",
    ],
    {
      env: {
        ...process.env,
        LYRA_RECOVERY_DB: database,
        LYRA_RECOVERY_TEAM_TEST: plan.steps.some(
          (step) => step.name === "202611030009_agency_team",
        )
          ? "true"
          : "false",
      },
    },
  );
  if (!teamSql)
    run(
      "pnpm",
      ["exec", "vitest", "run", "tests/integration/retention.test.ts"],
      { env: { ...process.env, LYRA_TEST_DB_NAME: database } },
    );
} finally {
  run("docker", ["exec", container, "dropdb", "-U", "postgres", database]);
}
