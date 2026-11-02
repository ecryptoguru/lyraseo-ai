import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Only disposable databases in the validated local test container are touched.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const container = "lyraseo-phase1-postgres";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0)
    throw new Error(`Migration check command failed: ${command}`);
  return result;
}
const inspected = run("docker", ["inspect", container], {
  encoding: "utf8",
  stdio: "pipe",
});
const instance = JSON.parse(inspected.stdout)[0];
if (
  instance.Config.Image !== "postgres:17-alpine" ||
  instance.HostConfig.PortBindings["5432/tcp"]?.[0]?.HostPort !== "54329"
)
  throw new Error("Unexpected database container; leaving it untouched.");
const migrationRoot = join(root, "packages/db/prisma/migrations");
const migrations = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const baseline = migrations.filter(
  (name) => name <= "202611020002_request_input",
);
if (baseline.length !== 7)
  throw new Error("Expected the seven-migration published baseline.");
const scratch = join(
  root,
  "packages/db/tmp",
  `migration-replay-${randomUUID()}`,
);
const baselineRoot = join(scratch, "baseline");
mkdirSync(baselineRoot, { recursive: true });
for (const migration of baseline)
  cpSync(join(migrationRoot, migration), join(baselineRoot, migration), {
    recursive: true,
  });
cpSync(
  join(migrationRoot, "migration_lock.toml"),
  join(baselineRoot, "migration_lock.toml"),
);
const config = join(scratch, "prisma.config.ts");
writeFileSync(
  config,
  `import {defineConfig} from "prisma/config";export default defineConfig({schema:${JSON.stringify(join(root, "packages/db/prisma/schema.prisma"))},migrations:{path:${JSON.stringify(baselineRoot)}},datasource:{url:process.env.DIRECT_URL}});`,
);
const databases = [];
function sql(database, statement, capture = false) {
  return run(
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
      "-At",
    ],
    {
      input: statement,
      stdio: ["pipe", "inherit", "inherit"],
      ...(capture ? { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] } : {}),
    },
  ).stdout;
}
function migrate(database, baselineOnly = false) {
  run(
    "pnpm",
    [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      ...(baselineOnly ? ["--config", config] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${database}`,
      },
    },
  );
}
try {
  for (const scenario of ["empty", "populated"]) {
    const database = `lyraseo_replay_${scenario}_${randomUUID().replaceAll("-", "")}`;
    run("docker", ["exec", container, "createdb", "-U", "postgres", database]);
    databases.push(database);
    if (scenario === "populated") {
      migrate(database, true);
      sql(
        database,
        `INSERT INTO "ProductUser"(id) VALUES('migration-owner');
INSERT INTO "Workspace"(id,name) VALUES('migration-workspace','Retained baseline');
INSERT INTO "Membership"("workspaceId","userId",role) VALUES('migration-workspace','migration-owner','OWNER');
INSERT INTO "Site"(id,"workspaceId",origin,"verifiedAt") VALUES('migration-site','migration-workspace','https://example.com',CURRENT_TIMESTAMP);
INSERT INTO "BudgetPeriod"(id,"userId",period,bucket,"limit",spent,reserved) VALUES('migration-budget','migration-owner','2026-11','COMBINED',10,1.25,0.5);
INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost","actualCost",status,"expiresAt","attemptState","requestInput") VALUES('migration-operation','migration-workspace','migration-site','migration-owner','baseline-session',0,'GENERATION','AZURE','2026-11','/fixture','retry','hash','fixture-only',0.5,0.125,'FAILED',CURRENT_TIMESTAMP+INTERVAL '1 day','ACCEPTED','{"retained":true}');
INSERT INTO "UsageReceipt"(id,"operationId","workspaceId","userId",provider,"receiptId",amount,"acceptedOutput") VALUES('migration-receipt','migration-operation','migration-workspace','migration-owner','AZURE','fixture-receipt',0.125,false);`,
      );
    }
    migrate(database);
    const applied = Number(
      sql(
        database,
        'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;',
        true,
      ).trim(),
    );
    if (applied !== migrations.length)
      throw new Error("Migration count does not match source.");
    if (scenario === "populated") {
      const preserved = sql(
        database,
        `SELECT json_build_object('workspace',w.name,'role',m.role,'origin',s.origin,'spent',b.spent::text,'reserved',b.reserved::text,'status',o.status,'input',o."requestInput",'receipt',r.amount::text) FROM "Workspace" w JOIN "Membership" m ON m."workspaceId"=w.id JOIN "Site" s ON s."workspaceId"=w.id JOIN "BudgetPeriod" b ON b."userId"=m."userId" JOIN "Operation" o ON o."siteId"=s.id JOIN "UsageReceipt" r ON r."operationId"=o.id WHERE w.id='migration-workspace';`,
        true,
      );
      const value = JSON.parse(preserved);
      if (
        JSON.stringify(value) !==
        JSON.stringify({
          workspace: "Retained baseline",
          role: "OWNER",
          origin: "https://example.com",
          spent: "1.250000000",
          reserved: "0.500000000",
          status: "FAILED",
          input: { retained: true },
          receipt: "0.125000000",
        })
      )
        throw new Error(
          "Populated baseline changed during additive migration.",
        );
    }
    console.log(
      `PASS: ${scenario} migration replay, ${applied} migrations${scenario === "populated" ? "; identities, site access, operation input, ledger and receipt preserved" : ""}.`,
    );
  }
} finally {
  for (const database of databases)
    run("docker", ["exec", container, "dropdb", "-U", "postgres", database]);
  rmSync(scratch, { recursive: true, force: true });
}
