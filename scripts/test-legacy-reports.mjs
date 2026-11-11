import { spawnSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
const container = "lyraseo-phase1-postgres";
const inspect = spawnSync("docker", ["inspect", container], {
  encoding: "utf8",
});
if (inspect.status) throw Error("LOCAL_PG17_REQUIRED");
const info = JSON.parse(inspect.stdout)[0],
  binding = info.HostConfig.PortBindings["5432/tcp"];
assert.equal(info.Config.Image, "postgres:17-alpine");
assert.deepEqual(binding, [{ HostIp: "127.0.0.1", HostPort: "54329" }]);
let db = "lyraseo_report_gate_" + randomUUID().replaceAll("-", "").slice(0, 12);
function command(args, options = {}) {
  const r = spawnSync(
    "docker",
    ["exec", ...(options.input ? ["-i"] : []), container, ...args],
    { encoding: "utf8", ...options },
  );
  if (r.status) throw Error(r.stderr);
  return r.stdout.trim();
}
function sql(input, role = "postgres", fail) {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      role,
      "-d",
      db,
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { encoding: "utf8", input },
  );
  if (fail) {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, fail);
    return;
  }
  if (r.status) throw Error(r.stderr);
  return r.stdout.trim();
}
command(["createdb", "-U", "postgres", "-T", "template0", db]);
console.log("OWNED_DATABASE", db);
const migrations = readdirSync("packages/db/prisma/migrations")
  .filter((x) => x !== "migration_lock.toml")
  .sort();
try {
  for (const name of migrations)
    sql(
      readFileSync(
        "packages/db/prisma/migrations/" + name + "/migration.sql",
        "utf8",
      ),
    );
  console.log("EMPTY_REPLAY_OK");
  command(["dropdb", "-U", "postgres", db]);
  db =
    "lyraseo_report_populated_" + randomUUID().replaceAll("-", "").slice(0, 12);
  command(["createdb", "-U", "postgres", "-T", "template0", db]);
  console.log("OWNED_POPULATED_DATABASE", db);
  for (const name of migrations.filter(
    (name) => name < "202611030013_legacy_saved_evidence",
  ))
    sql(
      readFileSync(
        "packages/db/prisma/migrations/" + name + "/migration.sql",
        "utf8",
      ),
    );

  sql(`INSERT INTO lyraseo_kernel.test_environment(database_oid) SELECT oid FROM pg_database WHERE datname=current_database();
 INSERT INTO "ProductUser"(id) VALUES('owner'),('viewer'); INSERT INTO "Workspace"(id,name) VALUES('w','Owned fixture');
 INSERT INTO "Membership"("workspaceId","userId",role) VALUES('w','owner','OWNER'),('w','viewer','VIEWER');
 INSERT INTO "Site"(id,"workspaceId",origin) VALUES('s','w','https://example.test'),('other','w','https://other.test');
 INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv,"createdAt","evidenceFormat") VALUES
 ('legacy','w','s','Original historical title','{"scope":{"workspaceId":"w","siteId":"s"},"rawHtml":"FULL_SOURCE_MARKER","capturedAt":"2020-01-01T00:00:00Z","sources":[]}',convert_to('%PDF unknown encoded metadata FULL_SOURCE_MARKER','UTF8'),'"quoted,cell","multiline\r\nFULL_SOURCE_MARKER"','2020-02-01',NULL),
 ('v2','w','s','Saved v2','{"format":"saved-evidence-v2","sources":[]}',convert_to('%PDF saved','UTF8'),'saved csv','2020-02-02','saved-evidence-v2');`);

  for (const name of migrations.filter(
    (name) => name >= "202611030013_legacy_saved_evidence",
  ))
    sql(
      readFileSync(
        "packages/db/prisma/migrations/" + name + "/migration.sql",
        "utf8",
      ),
    );
  sql(
    `INSERT INTO lyraseo_report.environment VALUES('w','s',(SELECT oid FROM pg_database WHERE datname=current_database()),pg_postmaster_start_time(),'lyraseo_artifact_maintenance','LEGACY_REPORT_LOCAL_V1')`,
  );
  console.log("POPULATED_ADDITIVE_REPLAY_OK");
  sql(
    `GRANT SELECT ON "ProductUser","Membership","Workspace","Site","SiteGrant" TO lyraseo_runtime`,
  );
  sql(
    `INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv) VALUES('reopened','w','s','New legacy','{}',convert_to('bytes','UTF8'),'csv')`,
    "postgres",
    /LEGACY_REPORT_WRITER_FENCED/,
  );
  const context =
    "BEGIN; SELECT set_config('app.workspace_id','w',true),set_config('app.actor_id','owner',true); ";
  assert(
    !sql(
      `SELECT lyraseo_report.inventory('w','s')`,
      "lyraseo_artifact_maintenance",
    ).includes("FULL_SOURCE_MARKER"),
  );
  assert.equal(sql("SELECT count(*) FROM lyraseo_report.decision"), "0");
  sql(
    `UPDATE lyraseo_report.environment SET postmaster_started_at=postmaster_started_at-interval '1 second'`,
  );
  sql(
    `SELECT lyraseo_report.inspect('w','s','legacy')`,
    "lyraseo_artifact_maintenance",
    /REPORT_UNENROLLED/,
  );
  sql(
    `UPDATE lyraseo_report.environment SET postmaster_started_at=pg_postmaster_start_time()`,
  );
  sql(
    `BEGIN; CREATE TEMP TABLE "EvidenceReport"(id text); SET LOCAL search_path=pg_temp,public; SELECT lyraseo_report.inspect('w','s','legacy'); ROLLBACK;`,
    "lyraseo_artifact_maintenance",
  );
  const before = sql(
    `SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') FROM "EvidenceReport" r WHERE id='legacy'`,
  );
  const facts = JSON.parse(
    sql(
      `SELECT lyraseo_report.inspect('w','s','legacy')`,
      "lyraseo_artifact_maintenance",
    ),
  );
  assert.equal(facts.classification, "classification-blocked");
  assert(!JSON.stringify(facts).includes("FULL_SOURCE_MARKER"));
  const actual = JSON.parse(
    sql(
      `SELECT lyraseo_report.inspect('w','s','legacy',true)`,
      "lyraseo_artifact_maintenance",
    ),
  );
  assert(actual.snapshot.rawHtml.includes("FULL_SOURCE_MARKER"));
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(actual.pdfBase64, "base64"))
      .digest("hex"),
    actual.pdfHash,
  );
  assert.equal(
    before,
    sql(
      `SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') FROM "EvidenceReport" r WHERE id='legacy'`,
    ),
  );
  sql(
    `SELECT lyraseo_report.inspect('w','other','legacy')`,
    "lyraseo_artifact_maintenance",
    /REPORT_UNENROLLED/,
  );
  sql(
    'SELECT pdf FROM "EvidenceReport"',
    "lyraseo_runtime",
    /permission denied/,
  );
  sql(
    'SELECT snapshot FROM "EvidenceReport"',
    "lyraseo_runtime",
    /permission denied/,
  );
  sql(
    "SET ROLE lyraseo_report_owner",
    "lyraseo_artifact_maintenance",
    /permission denied/,
  );
  sql(
    `UPDATE "EvidenceReport" SET title='replacement' WHERE id='legacy'`,
    "postgres",
    /IMMUTABLE_REPORT/,
  );
  sql(
    `UPDATE "EvidenceReport" SET pdf=NULL WHERE id='legacy'`,
    "postgres",
    /REPORT_FORBIDDEN/,
  );
  sql(
    context +
      `SELECT * FROM lyraseo_report.export('w','s','legacy','pdf'); COMMIT;`,
    "lyraseo_runtime",
    /LEGACY_REVIEW/,
  );
  assert(
    sql(
      context +
        `SELECT convert_from(pdf,'UTF8') FROM lyraseo_report.export('w','s','v2','pdf'); COMMIT;`,
      "lyraseo_runtime",
    ).includes("%PDF saved"),
  );
  const expected = { ...facts };
  for (const k of ["reportId", "evidenceFormat", "classification", "reason"])
    delete expected[k];
  const quoted = JSON.stringify(expected).replaceAll("'", "''");
  sql(
    `SELECT lyraseo_report.withdraw('w','s','legacy','{}','Operator quarantines unknown historical metadata',false)`,
    "lyraseo_artifact_maintenance",
    /REPORT_CHANGED/,
  );
  sql(
    `SELECT lyraseo_report.withdraw('w','s','legacy','${quoted}','Operator quarantines unknown historical metadata',false)`,
    "lyraseo_artifact_maintenance",
  );
  assert.equal(
    sql(
      context + `SELECT lyraseo_report.status('w','s','legacy'); COMMIT;`,
      "lyraseo_runtime",
    )
      .split("\n")
      .find((x) => x.includes("withdrawn")),
    '{"csv": "withdrawn", "pdf": "withdrawn"}',
  );
  sql(
    context +
      `SELECT * FROM lyraseo_report.export('w','s','legacy','pdf'); COMMIT;`,
    "lyraseo_runtime",
    /REPORT_WITHDRAWN/,
  );
  assert.equal(
    sql(
      `SELECT pdf IS NOT NULL AND csv IS NOT NULL FROM "EvidenceReport" WHERE id='legacy'`,
    ),
    "t",
  );
  sql(
    `SELECT lyraseo_report.withdraw('w','s','legacy','${quoted}','Operator erasure cannot prove fact separation',true)`,
    "lyraseo_artifact_maintenance",
    /REPORT_CLASSIFICATION_BLOCKED/,
  );
  assert.equal(
    sql(
      `SELECT pdf IS NOT NULL AND csv IS NOT NULL FROM "EvidenceReport" WHERE id='legacy'`,
    ),
    "t",
  );
  assert.equal(sql(`SELECT count(*) FROM lyraseo_report.decision`), "2");
  assert.equal(
    sql(
      `SELECT title||':'||"createdAt"::text||':'||(snapshot->>'capturedAt') FROM "EvidenceReport" WHERE id='legacy'`,
    ),
    "Original historical title:2020-02-01 00:00:00:2020-01-01T00:00:00Z",
  );
  sql(
    `UPDATE lyraseo_report.decision SET basis='forged replacement basis'`,
    "postgres",
    /IMMUTABLE_REPORT_RECEIPT/,
  );
  sql(
    `UPDATE "EvidenceReport" SET pdf=convert_to('replacement','UTF8') WHERE id='legacy'`,
    "postgres",
    /IMMUTABLE_REPORT/,
  );
  sql(
    `SELECT lyraseo_report.withdraw('w','s','legacy','${quoted}','Repeated withdrawal keeps original receipt chain',false)`,
    "lyraseo_artifact_maintenance",
  );
  assert.equal(sql(`SELECT count(*) FROM lyraseo_report.decision`), "2");
  sql(
    `SELECT lyraseo_report.prune('w','s')`,
    "lyraseo_artifact_maintenance",
    /REPORT_SCOPE_ACTIVE/,
  );
  // A read transaction buffers a complete pre-transition projection while holding
  // Workspace -> Site -> report SHARE locks. Withdrawal must wait for its commit.
  const reader = spawn("docker", [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "lyraseo_runtime",
    "-d",
    db,
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
  ]);
  let output = "";
  const locked = new Promise((resolve, reject) => {
    reader.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("READ_LOCKED")) resolve();
    });
    reader.on("error", reject);
    reader.on("exit", (code) => {
      if (code) reject(Error("CONCURRENT_READER_FAILED"));
    });
  });
  reader.stdin.end(
    context +
      `SELECT lyraseo_report.snapshot('w','s','legacy'); SELECT 'READ_LOCKED'; SELECT pg_sleep(1); COMMIT;`,
  );
  await locked;
  const start = Date.now();
  sql(
    `SELECT lyraseo_report.withdraw('w','s','legacy','${quoted}','Concurrent withdrawal respects buffered authorized preview',false)`,
    "lyraseo_artifact_maintenance",
  );
  assert(
    Date.now() - start >= 500,
    "withdrawal returned before the competing read committed",
  );
  assert(!output.includes("FULL_SOURCE_MARKER"));
  console.log("CONCURRENT_BUFFERED_READ_BARRIER_OK");
  console.log("RESTRICTED_ROLE_HASH_WITHDRAWAL_IDEMPOTENCY_FACTS_OK");
  // The application gate receives only this process's owned database URL. It
  // imports no baseline reset helper and cannot reach the canonical test DB.
  const app = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "tests/integration/legacy-reports.test.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        LYRA_REPORT_GATE_URL: `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${db}`,
      },
    },
  );
  if (app.status !== 0) throw Error("REPORT_APPLICATION_GATE_FAILED");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  // Intentionally keep only this newly owned fixture on failure for diagnosis.
  if (!process.exitCode) command(["dropdb", "-U", "postgres", db]);
}
