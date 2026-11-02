// Focused P2a2 replay. Owns only freshly created observation-named local databases.
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  container = "lyraseo-phase1-postgres";
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...options });
  if (r.status !== 0) throw Error(`Replay command failed: ${cmd}`);
  return r;
}
const instance = JSON.parse(
  run("docker", ["inspect", container], { encoding: "utf8", stdio: "pipe" })
    .stdout,
)[0];
if (
  instance.Config.Image !== "postgres:17-alpine" ||
  instance.HostConfig.PortBindings["5432/tcp"]?.length !== 1 ||
  instance.HostConfig.PortBindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
  instance.HostConfig.PortBindings["5432/tcp"][0].HostPort !== "54329"
)
  throw Error("Unexpected local container");
const require = createRequire(join(root, "packages/db/package.json")),
  { Client } = require("pg");
const adminUrl = (name) =>
  `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`;
const control = new Client({ connectionString: adminUrl("postgres") });
await control.connect();
const migrationRoot = join(root, "packages/db/prisma/migrations"),
  migrations = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((x) => x.isDirectory())
    .map((x) => x.name)
    .sort();
const scratch = mkdtempSync(join(root, "packages/db/tmp/observation-replay-")),
  owned = [];
function prefix(last) {
  const directory = join(scratch, `prefix-${last}`);
  cpSync(migrationRoot, directory, { recursive: true });
  for (const name of migrations.slice(last))
    rmSync(join(directory, name), { recursive: true });
  const config = join(scratch, `prefix-${last}.config.ts`);
  writeFileSync(
    config,
    `import {defineConfig} from 'prisma/config';export default defineConfig({schema:${JSON.stringify(join(root, "packages/db/prisma/schema.prisma"))},migrations:{path:${JSON.stringify(directory)}},datasource:{url:process.env.DIRECT_URL}});`,
  );
  return config;
}
const configs = new Map([7, 20, 24].map((n) => [n, prefix(n)]));
function migrate(name, last) {
  run(
    "pnpm",
    [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      ...(last ? ["--config", configs.get(last)] : []),
    ],
    { env: { ...process.env, DIRECT_URL: adminUrl(name) } },
  );
}
const fixture = (name) =>
  readFileSync(join(root, "tests/fixtures/migrations", name), "utf8");
async function snapshot(db) {
  const { rows } = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename",
  );
  const hashes = {};
  for (const { tablename } of rows) {
    const remove =
      tablename === "ArtifactBlob"
        ? ["ownerKind", "recordingId", "runId", "panelId", "promptId"]
        : tablename === "ArtifactRef"
          ? ["recordingId", "runId", "panelId", "promptId"]
          : tablename === "VisibilityRun"
            ? ["storageFormat"]
            : [];
    const escaped = '"' + tablename.replaceAll('"', '""') + '"';
    const result = await db.query(
      `SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]')::text AS value FROM (SELECT to_jsonb(t)-$1::text[] AS v FROM ${escaped} t) rows`,
      [remove],
    );
    hashes[tablename] = createHash("sha256")
      .update(result.rows[0].value)
      .digest("hex");
  }
  return hashes;
}
try {
  for (const scenario of ["empty", "populated"]) {
    const name =
      "lyraseo_p2a2_replay_" + randomUUID().replaceAll("-", "").slice(0, 12);
    await control.query(`CREATE DATABASE ${name}`);
    owned.push(name);
    console.log(`Owned ${scenario} observation replay database ${name}`);
    if (scenario === "empty") {
      migrate(name);
      continue;
    }
    migrate(name, 7);
    const db = new Client({ connectionString: adminUrl(name) });
    await db.connect();
    try {
      await db.query(fixture("dispatch-paid.sql"));
      migrate(name, 20);
      await db.query(fixture("dispatch-audits.sql"));
      migrate(name, 24);
      await db.query(fixture("pre-retention.sql"));
      await db.query(`INSERT INTO "AuditPage"(id,"auditId","workspaceId","requestedUrl",evidence,provenance) VALUES('00000000-0000-4000-8000-000000000025','active-controlled','controlled-workspace','https://example.com/artifact-history','{}','{"acquiredAt":"2024-10-31T12:13:14.456Z"}');
 INSERT INTO "ArtifactBlob"(id,"workspaceId","siteId","auditId","requestedUrl","pageId",fence,"capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state) VALUES('00000000-0000-4000-8000-000000000026','controlled-workspace','controlled-site','active-controlled','https://example.com/artifact-history','00000000-0000-4000-8000-000000000025',1,'2024-10-31 12:13:14.456','2024-11-30 12:13:14.456',repeat('a',64),repeat('b',64),1,repeat('b',64),1,'READY');
 INSERT INTO "ArtifactRef"("workspaceId","siteId","auditId","pageId",anchors,"slotPageId","blobId",generation,"capturedAt","expiresAt") SELECT "workspaceId","siteId","auditId","pageId"::text,'[]',"pageId",id,generation,"capturedAt","expiresAt" FROM "ArtifactBlob";`);
      const before = await snapshot(db);
      migrate(name);
      const after = await snapshot(db);
      for (const [table, hash] of Object.entries(before))
        if (after[table] !== hash)
          throw Error(`Historical table changed: ${table}`);
      const {
        rows: [row],
      } = await db.query(
        `SELECT (SELECT count(*) FROM "VisibilityRecording") AS recordings,(SELECT count(*) FROM "VisibilityObservationSlot") AS slots,(SELECT count(*) FROM "RuntimePolicy" WHERE enabled) AS enabled,(SELECT bool_or((has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE') OR has_table_privilege(r,t,'DELETE'))) FROM unnest(ARRAY['lyraseo_runtime','lyraseo_dispatch','lyraseo_identity']) r CROSS JOIN unnest(ARRAY['"VisibilityRecording"','"VisibilityObservationSlot"']) t) AS widened`,
      );
      if (
        row.recordings !== "0" ||
        row.slots !== "0" ||
        row.enabled !== "0" ||
        row.widened
      )
        throw Error("Unexpected backfill, policy enablement or widened grants");
      console.log(
        `PASS: populated24→25 preserves ${Object.keys(before).length} complete historical table digests including audit/ref tuples, metrics, P1 clocks and financial receipts; no private observation backfill/grants.`,
      );
    } finally {
      await db.end();
    }
  }
  console.log(
    "PASS: empty25 replay. Historical metadata fixtures are not physical storage or provider qualification.",
  );
} finally {
  for (const name of owned.reverse()) {
    await control.query(`DROP DATABASE ${name}`);
    console.log(`Dropped owned ${name}`);
  }
  await control.end();
  rmSync(scratch, { recursive: true });
}
