import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPIRY_ROLE_GUARD } from "./lib/expiry-bootstrap.mjs";
import { LOCAL_GRANT_BOOTSTRAP } from "./lib/local-grants.mjs";

// Required local/CI gate. Every mutable database and cluster is created by this
// process; no canonical database, source template or shared role is changed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const container = "lyraseo-phase1-postgres";
const inspect = spawnSync("docker", ["inspect", container], {
  encoding: "utf8",
});
if (inspect.status !== 0) throw Error("PRIVATE_EXPIRY_CONTAINER_REQUIRED");
const instance = JSON.parse(inspect.stdout)[0];
const bindings = instance.HostConfig.PortBindings?.["5432/tcp"];
if (
  instance.Config.Image !== "postgres:17-alpine" ||
  bindings?.length !== 1 ||
  bindings[0].HostIp !== "127.0.0.1" ||
  bindings[0].HostPort !== "54329"
)
  throw Error("UNSAFE_PRIVATE_EXPIRY_CONTAINER");
const temp = mkdtempSync(join(tmpdir(), "lyraseo-expiry-gate-"));
const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
const created = [];
const containerInputs = [];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(`PRIVATE_EXPIRY_GATE_FAILED: ${command}`);
  return result;
}
function sql(db, input) {
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
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input, stdio: ["pipe", "inherit", "inherit"] },
  );
}
function createDb() {
  const name =
    "lyraseo_expiry_" + randomUUID().replaceAll("-", "").slice(0, 12);
  // createdb fails if the random name already exists; only successful creations
  // are ever added to the cleanup list.
  run("docker", [
    "exec",
    container,
    "createdb",
    "-U",
    "postgres",
    "-T",
    "template0",
    name,
  ]);
  created.push(name);
  return name;
}
const migrationRoot = join(root, "packages/db/prisma/migrations");
const migrations = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
if (
  migrations.length < 28 ||
  migrations[25] !== "202611030004_artifact_origin_binding" ||
  migrations[26] !== "202611030005_private_artifact_expiry" ||
  migrations[27] !== "202611030006_legacy_visibility_retention"
)
  throw Error("UNEXPECTED_MIGRATION_SET");
if (
  createHash("sha256")
    .update(readFileSync(join(migrationRoot, migrations[25], "migration.sql")))
    .digest("hex") !==
  "16ad4be15f46ca07e6a71484ceb6b5a9681a853023c9e700825260ece0c6cea7"
)
  throw Error("ORIGIN_BASELINE_CHANGED");
const prismaConfigModule = createRequire(
  join(root, "packages/db/package.json"),
).resolve("prisma/config");
function prefixConfig(count) {
  const directory = join(temp, "migrations-" + count);
  mkdirSync(directory, { recursive: true });
  for (const name of migrations.slice(0, count))
    cpSync(join(migrationRoot, name), join(directory, name), {
      recursive: true,
    });
  cpSync(
    join(migrationRoot, "migration_lock.toml"),
    join(directory, "migration_lock.toml"),
  );
  const config = join(temp, "prefix-" + count + ".config.ts");
  writeFileSync(
    config,
    `import {defineConfig} from ${JSON.stringify(prismaConfigModule)};export default defineConfig({schema:${JSON.stringify(join(root, "packages/db/prisma/schema.prisma"))},migrations:{path:${JSON.stringify(directory)}},datasource:{url:process.env.DIRECT_URL}});`,
  );
  return config;
}
function migrate(db, config) {
  run(
    "pnpm",
    [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      ...(config ? ["--config", config] : []),
    ],
    {
      env: {
        ...process.env,
        DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${db}`,
      },
    },
  );
}
function vitest(file, env) {
  run("pnpm", ["exec", "vitest", "run", file, "--reporter=verbose"], {
    env: { ...process.env, ...env, LYRA_PRIVATE_EXPIRY_REQUIRED: "true" },
  });
}
const bootstrap = LOCAL_GRANT_BOOTSTRAP;
const guard = EXPIRY_ROLE_GUARD;
const historyBootstrap = readFileSync(
  join(root, "tests/fixtures/expiry/history-bootstrap.sql"),
  "utf8",
);
for (const line of historyBootstrap.trim().split("\n"))
  if (!bootstrap.split("\n").includes(line))
    throw Error("HISTORY_BOOTSTRAP_DRIFT");
const fixture = readFileSync(
  join(root, "tests/fixtures/migrations/dispatch-paid.sql"),
  "utf8",
);
if (
  createHash("sha256").update(fixture).digest("hex") !==
  "dae13a7bfc62df6d32ce7b7a2b76c8abaf57714ddf9b13d95e5374399f5d609a"
)
  throw Error("HISTORY_FIXTURE_CHANGED");
const legacyGrant =
  'GRANT SELECT,INSERT,UPDATE ON "Operation","OutboxEvent","UsageReceipt" TO lyraseo_runtime;';
if (!fixture.includes(legacyGrant))
  throw Error("HISTORY_FIXTURE_GRANT_MISSING");
try {
  const expiryDb = createDb();
  migrate(expiryDb, prefixConfig(26));
  migrate(expiryDb);
  sql(expiryDb, bootstrap);
  console.log("Running required private expiry integration suite on", expiryDb);
  vitest("tests/integration/private-artifact-expiry.test.ts", {
    LYRA_TEST_DB_NAME: expiryDb,
  });

  const historyDb = createDb();
  migrate(historyDb, prefixConfig(20));
  sql(historyDb, fixture.replace(legacyGrant, ""));
  migrate(historyDb);
  sql(
    historyDb,
    `INSERT INTO lyraseo_kernel.test_environment(database_oid,postmaster_started_at) SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database();\n${historyBootstrap}`,
  );
  console.log("Running required synthetic history suite on", historyDb);
  vitest("tests/integration/private-artifact-expiry-history.test.ts", {
    LYRA_EXPIRY_HISTORY_DB_NAME: historyDb,
  });

  const migrationInput = `/tmp/lyraseo-expiry-gate-${nonce}-migration.sql`;
  const guardInput = `/tmp/lyraseo-expiry-gate-${nonce}-guard.sql`;
  const localGuard = join(temp, "bootstrap-guard.sql");
  writeFileSync(localGuard, guard + ";\n");
  run("docker", [
    "cp",
    join(migrationRoot, migrations[26], "migration.sql"),
    `${container}:${migrationInput}`,
  ]);
  containerInputs.push(migrationInput);
  run("docker", ["cp", localGuard, `${container}:${guardInput}`]);
  containerInputs.push(guardInput);
  console.log("Running required unsafe-role checks in an isolated postmaster");
  run(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "postgres",
      container,
      "sh",
      "-s",
      "--",
      migrationInput,
      guardInput,
    ],
    {
      input: readFileSync(join(root, "tests/fixtures/expiry/unsafe-roles.sh")),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  console.log(
    "PASS: private expiry, synthetic history and isolated unsafe-role gate",
  );
} finally {
  for (const input of containerInputs) {
    const result = spawnSync("docker", ["exec", container, "rm", "-f", input], {
      stdio: "inherit",
    });
    if (result.status !== 0) process.exitCode = 1;
  }
  for (const db of created.reverse()) {
    const result = spawnSync(
      "docker",
      ["exec", container, "dropdb", "-U", "postgres", db],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exitCode = 1;
  }
  rmSync(temp, { recursive: true, force: true });
}
