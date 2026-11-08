import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_VISIBILITY_ROLE_GUARD } from "./lib/legacy-visibility-role.mjs";
import { LOCAL_GRANT_BOOTSTRAP } from "./lib/local-grants.mjs";
import {
  assertModelColumns,
  assertVisibilityReceipt,
  readRuntimeModel,
} from "./lib/legacy-visibility-gate.mjs";

// Required gate: only databases created by this process are modified or dropped.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const container = "lyraseo-phase1-postgres";
const inspected = spawnSync("docker", ["inspect", container], {
  encoding: "utf8",
});
if (inspected.status !== 0) throw Error("LEGACY_VISIBILITY_CONTAINER_REQUIRED");
const instance = JSON.parse(inspected.stdout)[0];
const bindings = instance.HostConfig.PortBindings?.["5432/tcp"];
if (
  instance.Config.Image !== "postgres:17-alpine" ||
  bindings?.length !== 1 ||
  bindings[0].HostIp !== "127.0.0.1" ||
  bindings[0].HostPort !== "54329"
)
  throw Error("UNSAFE_LEGACY_VISIBILITY_CONTAINER");
const migrationRoot = join(root, "packages/db/prisma/migrations");
const migrations = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
if (
  migrations.length < 28 ||
  migrations[26] !== "202611030005_private_artifact_expiry" ||
  migrations[27] !== "202611030006_legacy_visibility_retention"
)
  throw Error("UNEXPECTED_LEGACY_MIGRATION_SET");
const temp = mkdtempSync(join(tmpdir(), "lyraseo-legacy-gate-"));
const name = "lyraseo_legacy_" + randomUUID().replaceAll("-", "").slice(0, 12);
const populatedName =
  "lyraseo_legacy_" + randomUUID().replaceAll("-", "").slice(0, 12);
const serviceName =
  "lyraseo_legacy_" + randomUUID().replaceAll("-", "").slice(0, 12);
const created = [];
const containerInputs = [];
const schemaPath = join(root, "packages/db/prisma/schema.prisma");
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const frozenSchema = digest(schemaPath);
const frozenMigrations = migrations.map((name) => [
  name,
  digest(join(migrationRoot, name, "migration.sql")),
]);
function assertFrozenInputs() {
  if (
    digest(schemaPath) !== frozenSchema ||
    migrations.some(
      (name, index) =>
        digest(join(migrationRoot, name, "migration.sql")) !==
        frozenMigrations[index][1],
    )
  )
    throw Error("LEGACY_VISIBILITY_SCHEMA_CHANGED_DURING_GATE");
  const names = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(migrations))
    throw Error("LEGACY_VISIBILITY_MIGRATIONS_CHANGED_DURING_GATE");
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(`LEGACY_VISIBILITY_GATE_FAILED: ${command}`);
}
function config(count) {
  const dir = join(temp, `migrations-${count}`);
  cpSync(migrationRoot, dir, {
    recursive: true,
    filter: (source) =>
      !migrations
        .slice(count)
        .some(
          (m) =>
            source === join(migrationRoot, m) ||
            source.startsWith(join(migrationRoot, m) + "/"),
        ),
  });
  const path = join(temp, `prefix-${count}.config.ts`);
  const module = createRequire(join(root, "packages/db/package.json")).resolve(
    "prisma/config",
  );
  writeFileSync(
    path,
    `import {defineConfig} from ${JSON.stringify(module)};export default defineConfig({schema:${JSON.stringify(join(root, "packages/db/prisma/schema.prisma"))},migrations:{path:${JSON.stringify(dir)}},datasource:{url:process.env.DIRECT_URL}});`,
  );
  return path;
}
function migrate(database, configPath) {
  run(
    "pnpm",
    [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      configPath,
    ],
    {
      env: {
        ...process.env,
        DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${database}`,
      },
    },
  );
}
try {
  run("node", ["--test", "tests/fixtures/legacy-visibility/gate.test.mjs"]);
  for (const database of [name, populatedName, serviceName]) {
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
    created.push(database);
  }
  const prefix27 = config(27),
    prefix28 = config(28);
  migrate(name, prefix27);
  migrate(populatedName, prefix27);
  const populated = `INSERT INTO "Workspace"(id,name) VALUES('migration-w','Migration fixture');
INSERT INTO "Site"(id,"workspaceId",origin) VALUES('migration-s','migration-w','https://example.invalid');
INSERT INTO "VisibilityPanel"(id,"workspaceId","siteId",version,prompts,brands,"createdBy") VALUES('migration-p','migration-w','migration-s',1,'[]','[]','fixture');
INSERT INTO "VisibilityRun"(id,"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt") VALUES('migration-r','migration-w','migration-s','migration-p','azure-sol-api','historical','{}','[]','[{"body":"synthetic historical answer"}]','2024-02-01','2024-01-01');`;
  run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      populatedName,
    ],
    { input: populated, stdio: ["pipe", "inherit", "inherit"] },
  );
  function rowHash() {
    const result = spawnSync(
      "docker",
      [
        "exec",
        container,
        "psql",
        "-X",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        populatedName,
        "-c",
        `SELECT encode(sha256(convert_to(to_jsonb(v)::text,'UTF8')),'hex') FROM "VisibilityRun" v WHERE id='migration-r'`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0 || !/^[a-f0-9]{64}\s*$/.test(result.stdout))
      throw Error("LEGACY_POPULATED_HASH_FAILED");
    return result.stdout.trim();
  }
  const before = rowHash();
  migrate(name, prefix28);
  migrate(populatedName, prefix28);
  if (rowHash() !== before)
    throw Error("LEGACY_MIGRATION_CHANGED_HISTORICAL_ROW");
  console.log(
    "PASS: empty and populated 27 -> 28 replay preserves historical row",
  );
  // Application services use a different database with every assembled
  // migration. The historical fixtures above remain at the 28 boundary.
  assertFrozenInputs();
  migrate(serviceName, config(migrations.length));
  assertFrozenInputs();
  const applied = spawnSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      serviceName,
      "-c",
      `SELECT migration_name || ':' || checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
    ],
    { encoding: "utf8" },
  );
  if (
    applied.status !== 0 ||
    applied.stdout.trim().split("\n").join("\n") !==
      frozenMigrations.map(([name, hash]) => `${name}:${hash}`).join("\n")
  )
    throw Error("LEGACY_VISIBILITY_SERVICE_MIGRATIONS_MISMATCH");
  run("pnpm", ["--filter", "@lyraseo/db", "exec", "prisma", "generate"], {
    env: {
      ...process.env,
      DIRECT_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    },
  });
  assertFrozenInputs();
  const runtimeModel = readRuntimeModel(
    readFileSync(join(root, "packages/db/generated/internal/class.ts"), "utf8"),
  );
  function columns(extra = "") {
    const result = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        serviceName,
      ],
      {
        input: `${extra} SELECT coalesce(json_agg(json_build_array(table_name,column_name)),'[]'::json) FROM information_schema.columns WHERE table_schema='public'; ${extra ? "ROLLBACK;" : ""}`,
        encoding: "utf8",
      },
    );
    if (result.status !== 0)
      throw Error(
        "LEGACY_VISIBILITY_SCHEMA_INTROSPECTION_FAILED: " + result.stderr,
      );
    return JSON.parse(result.stdout.trim());
  }
  assertModelColumns(runtimeModel, columns());
  // Reproduce the original mismatch without persisting a schema change in
  // the owned fixture. The same preflight must reject the rolled-back probe.
  let rejected = false;
  try {
    assertModelColumns(
      runtimeModel,
      columns(
        'BEGIN; ALTER TABLE public."Workspace" DROP COLUMN "accessRevision";',
      ),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("Workspace.accessRevision")
    )
      throw error;
    rejected = true;
  }
  if (!rejected) throw Error("LEGACY_VISIBILITY_SCHEMA_NEGATIVE_NOT_DETECTED");
  assertModelColumns(runtimeModel, columns());
  console.log(
    "PASS: generated Prisma columns match assembled database; missing accessRevision rejected",
  );
  run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      serviceName,
    ],
    { input: LOCAL_GRANT_BOOTSTRAP, stdio: ["pipe", "inherit", "inherit"] },
  );
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "tests/legacy-visibility",
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${join(temp, "service-results.json")}`,
    ],
    { env: { ...process.env, LYRA_TEST_DB_NAME: serviceName } },
  );
  const report = JSON.parse(
    readFileSync(join(temp, "service-results.json"), "utf8"),
  );
  const required = JSON.parse(
    readFileSync(
      join(root, "tests/fixtures/legacy-visibility/required-cases.json"),
      "utf8",
    ),
  );
  assertVisibilityReceipt(report, required, root);
  assertFrozenInputs();
  console.log(
    "PASS: full assembled service schema and all 29 required visibility cases",
  );
  const guard = LEGACY_VISIBILITY_ROLE_GUARD;
  const migration = readFileSync(
    join(migrationRoot, migrations[27], "migration.sql"),
    "utf8",
  );
  const migrationGuard = migration.match(/DO \$\$[\s\S]*?END \$\$;/)?.[0];
  if (!guard || !migrationGuard) throw Error("LEGACY_ROLE_GUARD_CHANGED");
  const existingGuard = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      name,
    ],
    { input: guard + ";\n", encoding: "utf8" },
  );
  if (existingGuard.status !== 0 || existingGuard.stdout.trim() !== "f")
    throw Error(`LEGACY_BOOTSTRAP_ROLE_CHECK_FAILED: ${existingGuard.stderr}`);
  const inputs = [migrationGuard, guard + ";"].map((sql, index) => {
    const local = join(temp, `unsafe-${index}.sql`),
      remote = `/tmp/${name}-unsafe-${index}.sql`;
    writeFileSync(local, sql + "\n");
    run("docker", ["cp", local, `${container}:${remote}`]);
    containerInputs.push(remote);
    return remote;
  });
  run(
    "docker",
    ["exec", "-i", "-u", "postgres", container, "sh", "-s", "--", ...inputs],
    {
      input: readFileSync(
        join(root, "tests/fixtures/legacy-visibility/unsafe-roles.sh"),
      ),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  console.log("PASS: legacy visibility retention gate");
} finally {
  for (const input of containerInputs) {
    const result = spawnSync("docker", ["exec", container, "rm", "-f", input], {
      stdio: "inherit",
    });
    if (result.status !== 0) process.exitCode = 1;
  }
  for (const database of created.reverse()) {
    const result = spawnSync(
      "docker",
      ["exec", container, "dropdb", "-U", "postgres", database],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exitCode = 1;
  }
  rmSync(temp, { recursive: true, force: true });
}
