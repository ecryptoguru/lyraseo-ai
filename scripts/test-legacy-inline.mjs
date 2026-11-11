import { spawnSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRunDirectory,
  verifyRequiredServices,
} from "./legacy-inline-receipt.mjs";
import {
  readPinnedBaseline,
  verifyBaseline,
  requireVisibilityGuard,
  verifyApplicationSchema,
} from "./legacy-inline-baseline.mjs";

// Owned random databases only. Never reads or mutates any canonical test database.
const root = resolve(import.meta.dirname, "..");
const container = "lyraseo-phase1-postgres";
const output = createRunDirectory(root, process.argv[2]);
function command(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...options });
  if (r.status !== 0) throw Error(`${cmd}: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}
const mroot = resolve(root, "packages/db/prisma/migrations");
// Independently replay the accepted 27 plus only this owned additive slice.
// Combined phase-one replay remains a separate parent acceptance gate.
const directories = readdirSync(mroot)
  .filter((s) => /^\d/.test(s))
  .sort();
assert.equal(directories[26], "202611030005_private_artifact_expiry");
assert(directories.includes("202611030014_legacy_inline_sources"));
const migrations = [
  ...directories.slice(0, 27),
  "202611030014_legacy_inline_sources",
];
const pinned = readPinnedBaseline(root);
const baselineCommit = pinned.baselineCommit;
const baselineHashes = pinned.migrations;
assert.deepEqual(
  migrations.slice(0, 27),
  baselineHashes.map(([name]) => name),
);
verifyBaseline(mroot, pinned);
const bootstrap = pinned.bootstrap;
// A separate replay consumes current migration/bootstrap bytes without changing
// the isolated service-test source or writing to the supplied checkout.
const assembledRoot = process.env.LYRA_INLINE_ASSEMBLED_ROOT ?? root;
assert(isAbsolute(assembledRoot), "Assembled source root must be absolute");
const applicationSchemaSha256 = verifyApplicationSchema(root, assembledRoot);
const assembledMroot = resolve(assembledRoot, "packages/db/prisma/migrations");
const assembledMigrations = readdirSync(assembledMroot)
  .filter((s) => /^\d/.test(s))
  .sort();
verifyBaseline(assembledMroot, pinned);
assert.equal(
  readFileSync(
    resolve(assembledMroot, migrations[27], "migration.sql"),
    "utf8",
  ),
  readFileSync(resolve(mroot, migrations[27], "migration.sql"), "utf8"),
  "Assembled migration36 must match this reviewed slice",
);
const { LOCAL_GRANT_BOOTSTRAP: currentBootstrap } = await import(
  pathToFileURL(resolve(assembledRoot, "scripts/lib/local-grants.mjs")).href
);
assert(
  typeof currentBootstrap === "string" && currentBootstrap.trim(),
  "Shared grant bootstrap missing",
);
const guardedVisibility = requireVisibilityGuard(
  assembledMigrations,
  currentBootstrap,
);
command("node", ["--test", "tests/legacy-inline-bootstrap.test.mjs"], {
  stdio: "inherit",
});
const instance = JSON.parse(command("docker", ["inspect", container]))[0];
assert.equal(instance.Config.Image, "postgres:17-alpine");
assert.deepEqual(instance.HostConfig.PortBindings["5432/tcp"], [
  { HostIp: "127.0.0.1", HostPort: "54329" },
]);
const db = "lyraseo_inline_" + randomUUID().replaceAll("-", "").slice(0, 12);
command("docker", [
  "exec",
  container,
  "createdb",
  "-U",
  "postgres",
  "-T",
  "template0",
  db,
]);
function sql(input, user = "postgres", failure) {
  const args = [
    "exec",
    "-i",
    container,
    "psql",
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    user,
    "-d",
    db,
  ];
  const r = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: root,
  });
  if (failure) {
    assert.notEqual(r.status, 0, `Expected denial: ${input}`);
    assert.match(r.stderr, failure);
    return r.stderr;
  }
  if (r.status !== 0) throw Error(r.stderr + "\nSQL: " + input.slice(0, 400));
  return (r.stdout ?? "").trim();
}
for (const m of migrations.slice(0, 27))
  sql(readFileSync(resolve(mroot, m, "migration.sql"), "utf8"));
if (guardedVisibility) {
  assert(
    assembledMigrations.includes("202611030006_legacy_visibility_retention"),
  );
  // Verify the guard still denies the actual unsafe accepted27 grants. This
  // failed statement is transactionally rolled back; no guard is edited away.
  sql(
    `BEGIN;\n${currentBootstrap}\nROLLBACK;`,
    "postgres",
    /UNSAFE_LEGACY_BOOTSTRAP_GRANT/,
  );
  console.log(
    "Current bootstrap correctly rejects accepted27 unsafe visibility grants",
  );
}
sql(bootstrap);
const assembledDb =
  "lyraseo_inline_" + randomUUID().replaceAll("-", "").slice(0, 12);
command("docker", [
  "exec",
  container,
  "createdb",
  "-U",
  "postgres",
  "-T",
  "template0",
  assembledDb,
]);
function assembledSql(input, failure) {
  const r = spawnSync(
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
      assembledDb,
    ],
    { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (failure) {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, failure);
    return;
  }
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
}
const assembledHashes = assembledMigrations.map((name) => {
  const bytes = readFileSync(resolve(assembledMroot, name, "migration.sql"));
  assembledSql(bytes);
  return [name, createHash("sha256").update(bytes).digest("hex")];
});
assembledSql(currentBootstrap);
assembledSql(currentBootstrap); // Repeated exact bootstrap must stay safe.
if (guardedVisibility) {
  assert.equal(
    assembledSql(
      `SELECT has_column_privilege('lyraseo_runtime','public."VisibilityRun"','rawAnswers','SELECT') OR has_column_privilege('lyraseo_runtime','public."VisibilityRun"','slots','SELECT') OR has_column_privilege('lyraseo_runtime','public."VisibilityRun"','provenance','SELECT') OR has_column_privilege('lyraseo_runtime','public."VisibilityRun"','cohort','SELECT') OR has_table_privilege('lyraseo_runtime','public."VisibilityRun"','UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege('lyraseo_runtime','public."VisibilityRun"','UPDATE')`,
    ),
    "f",
  );
  assembledSql(
    `BEGIN; GRANT SELECT("rawAnswers") ON "VisibilityRun" TO lyraseo_runtime;\n${currentBootstrap}\nROLLBACK;`,
    /UNSAFE_LEGACY_BOOTSTRAP_GRANT/,
  );
  assembledSql(currentBootstrap); // Failed column-grant probe rolled back.
}
console.log(
  "Separate assembled migration/current-bootstrap replay passed:",
  assembledDb,
  assembledMigrations.length,
  "migrations",
);
const seed = `
INSERT INTO "ProductUser"(id) VALUES ('inline-owner');
INSERT INTO "Workspace"(id,name) VALUES ('inline-w','Inline fixture'),('other-w','Unrelated fixture');
INSERT INTO "Membership"("workspaceId","userId",role) VALUES ('inline-w','inline-owner','OWNER');
INSERT INTO "Site"(id,"workspaceId",origin,"verifiedAt") VALUES ('inline-s','inline-w','https://example.com',current_timestamp),('other-s','other-w','https://other.example',current_timestamp);
INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion",status,evaluation,"createdAt","completedAt")
SELECT id,'inline-w','inline-s','inline-owner',0,id,'fixture','["https://example.com/"]',CASE WHEN id='fresh-profile' THEN 'UNSUPPORTED_RAW' ELSE 'CONTROLLED_RAW_TEST_V1' END,'{}','readiness-v2','COMPLETED','{"score":42,"rules":[{"evidence":"FROZEN_SOURCE_DIAGNOSTIC","ruleId":"E01","ruleVersion":"2","outcome":"FAIL","scopeKey":"https://example.com/"}],"comparisonInputs":{"exact":true}}','2026-10-01','2026-10-01' FROM unnest(ARRAY['due','fresh','unknown','malformed','oversized','null-body','unexpected','legacy-copy','second-due','fresh-missing-hash','fresh-unexpected','fresh-profile','fresh-mismatch']) AS u(id);
INSERT INTO "AuditPage"(id,"workspaceId","auditId","requestedUrl",evidence,provenance,"createdAt")
SELECT id||'-page','inline-w',id,'https://example.com/',jsonb_build_object('requestedUrl','https://example.com/','acquired',true,'headComplete',false,'bodyComplete',false,'headingLevels','[]'::jsonb,'h1Texts','[]'::jsonb,'mainText','EVIDENCE_RESIDUAL_MARKER','linkNames',jsonb_build_array(jsonb_build_object('name','ANCHOR_RESIDUAL','href','https://example.com/'))),
(jsonb_build_object('channel','raw-http','requestedUrl','https://example.com/','acquiredAt',stamp,'rawHtml',CASE WHEN id='null-body' THEN NULL WHEN id='oversized' THEN repeat('x',5242881) ELSE '<html>RAW_HTML_'||id||'</html>' END,'sha256',encode(sha256(convert_to(CASE WHEN id='oversized' THEN repeat('x',5242881) ELSE '<html>RAW_HTML_'||id||'</html>' END,'UTF8')),'hex'),'status',200,'headers',jsonb_build_object('content-type','text/html')) || CASE WHEN id IN ('unexpected','fresh-unexpected') THEN '{"unknownCopy":"UNEXPECTED_RAW_COPY"}'::jsonb ELSE '{}'::jsonb END) - CASE WHEN id='fresh-missing-hash' THEN ARRAY['sha256'] ELSE ARRAY[]::text[] END || CASE WHEN id='fresh-mismatch' THEN jsonb_build_object('sha256',repeat('0',64)) ELSE '{}'::jsonb END,
CASE WHEN id LIKE 'fresh%' THEN clock_timestamp() AT TIME ZONE 'UTC' ELSE '2026-10-01'::timestamp END
FROM (SELECT id,CASE WHEN id LIKE 'fresh%' THEN to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHEN id='unknown' THEN 'unknown' WHEN id='malformed' THEN '2026-13-31T00:00:00Z' ELSE '2026-09-01T00:00:00Z' END AS stamp FROM "AuditRun" WHERE "workspaceId"='inline-w') x;
INSERT INTO "ContentDraft"(id,"workspaceId","siteId",kind,snapshot) VALUES ('legacy-draft','inline-w','inline-s','draft','{"sources":[{"data":{"rawHtml":"SNAPSHOT_RAW_COPY"}}],"intentionalSummary":"KEEP_SAVED_SUMMARY"}');
INSERT INTO "ContentRevision"(id,"workspaceId","draftId",revision,content,"userId") VALUES ('revision','inline-w','legacy-draft',1,'{"body":"AUTHORED_BODY","citations":["INTENTIONAL_QUOTE"]}','inline-owner');
INSERT INTO "ContentRevisionPin"("workspaceId","draftId",revision,"pinnedBy") VALUES ('inline-w','legacy-draft',1,'inline-owner');
`;
sql(seed);
sql(
  `INSERT INTO "ContentDraft"(id,"workspaceId","siteId",kind,snapshot) SELECT 'inventory-'||lpad(n::text,3,'0'),'inline-w','inline-s','draft','{"intentionalSummary":"KEEP_SAVED_SUMMARY"}'::jsonb FROM generate_series(1,125) n;`,
);
const migration = readFileSync(
  resolve(mroot, migrations[27], "migration.sql"),
  "utf8",
);
sql(migration);
console.log("Populated additive migration replay passed:", db);
// Known producer storageFormat is immutable; separate private fixture is admitted normally.
sql(`INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion",status,"storageFormat") VALUES ('new-private','inline-w','inline-s','inline-owner',0,'new-private','fixture','[]','LOCAL_RAW_V1','{}','readiness-v2','COMPLETED','AUDIT_PRIVATE_V1');
INSERT INTO lyraseo_kernel.test_environment(database_oid,postmaster_started_at) SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database() ON CONFLICT DO NOTHING;
INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time(),'lyraseo_artifact_maintenance','inline-w','inline-s','P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database();`);
const maintenance = "lyraseo_artifact_maintenance";
const scope = "'inline-w','inline-s'";
function snapshot() {
  return sql(
    `SELECT jsonb_build_object('pages',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM "AuditPage" p),'runs',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM "AuditRun" a),'draft',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM "ContentDraft" d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM "ContentRevision" r),'pins',(SELECT jsonb_agg(to_jsonb(p) ORDER BY "draftId") FROM "ContentRevisionPin" p),'plan',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM lyraseo_legacy_inline.plan p),'event',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM lyraseo_legacy_inline.event e))`,
  );
}
const beforePreview = snapshot();
const preview = JSON.parse(
  sql(`SELECT lyraseo_legacy_inline.preview(${scope},100);`, maintenance),
);
assert.equal(beforePreview, snapshot(), "Preview must write zero rows");
let inventoryPage = preview,
  seen = new Set(),
  inventoryCalls = 0;
for (;;) {
  for (const item of inventoryPage.items) {
    const key = item.class + ":" + item.id;
    assert(!seen.has(key), "Keyset must not repeat a row/class");
    seen.add(key);
  }
  inventoryCalls++;
  if (!inventoryPage.next) break;
  const n = inventoryPage.next;
  inventoryPage = JSON.parse(
    sql(
      `SELECT lyraseo_legacy_inline.preview(${scope},100,'${n.class}','${n.id}');`,
      maintenance,
    ),
  );
  assert(inventoryCalls < 10);
}
assert.equal(
  seen.size,
  165,
  "Keyset must enumerate every class beyond the first100",
);
assert(inventoryCalls >= 2);
assert.equal(
  beforePreview,
  snapshot(),
  "Keyset preview must also write zero rows",
);
sql(
  `SELECT lyraseo_legacy_inline.preview(${scope},1,NULL,'');`,
  maintenance,
  /INVALID_LEGACY_INLINE_LIMIT/,
);
sql(
  `SELECT lyraseo_legacy_inline.preview(${scope},1,'',NULL);`,
  maintenance,
  /INVALID_LEGACY_INLINE_LIMIT/,
);
assert.equal(
  sql(
    `SELECT has_column_privilege('lyraseo_artifact_maintenance','public."AuditPage"','provenance','SELECT') OR has_column_privilege('lyraseo_artifact_maintenance','public."AuditPage"','provenance','UPDATE') OR has_column_privilege('lyraseo_artifact_maintenance','public."ContentDraft"','snapshot','SELECT')`,
  ),
  "f",
);

assert(
  preview.items.some(
    (i) => i.id === "due-page" && i.status === "due-classified",
  ),
);
assert(
  preview.items.some((i) => i.id === "fresh-page" && i.status === "not-due"),
);
for (const id of ["unknown-page", "malformed-page"])
  assert(
    preview.items.some((i) => i.id === id && i.status === "clock-unknown"),
  );
assert(
  preview.items.some(
    (i) => i.id === "unexpected-page" && i.status === "unsafe-to-separate",
  ),
);
for (const id of ["oversized-page", "null-body-page"])
  assert(
    preview.items.some((i) => i.id === id && i.status === "unsafe-to-separate"),
  );
for (const limit of ["NULL", "0", "101"])
  sql(
    `SELECT lyraseo_legacy_inline.preview(${scope},${limit});`,
    maintenance,
    /INVALID_LEGACY_INLINE_LIMIT/,
  );
const pid = sql(
  `SELECT lyraseo_legacy_inline.make_plan(${scope});`,
  maintenance,
);
for (const fn of ["status", "next", "pause"])
  sql(
    `SELECT lyraseo_legacy_inline.${fn}('other-w','other-s','${pid}');`,
    maintenance,
    /LEGACY_INLINE_SCOPE_DENIED/,
  );
sql(
  `SELECT lyraseo_legacy_inline.status(${scope},'${randomUUID()}');`,
  maintenance,
  /LEGACY_INLINE_PLAN_DENIED/,
);
sql(
  `SELECT lyraseo_legacy_inline.preview(${scope},1);`,
  "lyraseo_runtime",
  /permission denied/,
);
sql(`SET ROLE lyraseo_legacy_inline_owner;`, maintenance, /permission denied/);
sql(
  `SELECT * FROM lyraseo_legacy_inline.environment;`,
  maintenance,
  /permission denied/,
);
sql(
  `UPDATE "AuditPage" SET provenance='{}' WHERE id='due-page';`,
  "postgres",
  /IMMUTABLE_AUDIT/,
);
sql(
  `DELETE FROM "AuditPage" WHERE id='due-page';`,
  "postgres",
  /IMMUTABLE_AUDIT/,
);
sql(
  `UPDATE "AuditRun" SET evaluation='{}' WHERE id='due';`,
  "postgres",
  /IMMUTABLE_AUDIT/,
);
sql(
  `INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time(),'lyraseo_artifact_maintenance','other-w','other-s','P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database();`,
);
const beforeWrongScope = snapshot();
for (const fn of ["status", "next", "pause"])
  sql(
    `SELECT lyraseo_legacy_inline.${fn}('other-w','other-s','${pid}');`,
    maintenance,
    /LEGACY_INLINE_PLAN_DENIED/,
  );
assert.equal(snapshot(), beforeWrongScope);
sql(
  `INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time()-interval '1 second','lyraseo_artifact_maintenance','inline-w','inline-s','P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database();`,
  "postgres",
  /LEGACY_INLINE_ENROLLMENT_DENIED/,
);
const before = JSON.parse(snapshot());
const result = JSON.parse(
  sql(
    `BEGIN; SET LOCAL statement_timeout='3s'; SELECT lyraseo_legacy_inline.next(${scope},'${pid}'); COMMIT;`,
    maintenance,
  )
    .split("\n")
    .find((v) => v.startsWith("{")),
);
assert.equal(result.status, "transitioned");
const after = JSON.parse(snapshot());
assert.deepEqual(before.runs, after.runs);
assert.deepEqual(before.draft, after.draft);
assert.deepEqual(before.revisions, after.revisions);
assert.deepEqual(before.pins, after.pins);
assert.deepEqual(
  before.pages.filter((p) => p.id !== result.id),
  after.pages.filter((p) => p.id !== result.id),
);
const transitioned = after.pages.find((p) => p.id === result.id);
const original = before.pages.find((p) => p.id === result.id);
assert.deepEqual(
  { ...original, provenance: { ...original.provenance, rawHtml: undefined } },
  {
    ...transitioned,
    provenance: { ...transitioned.provenance, rawHtml: undefined },
  },
);
assert(!("rawHtml" in transitioned.provenance));
assert.equal(transitioned.evidence.mainText, "EVIDENCE_RESIDUAL_MARKER");
const hashes = JSON.parse(
  sql(
    `SELECT jsonb_build_object('old',(SELECT old_hash FROM lyraseo_legacy_inline.event WHERE page_id='${result.id}'),'new',(SELECT new_hash FROM lyraseo_legacy_inline.event WHERE page_id='${result.id}'),'actual',encode(sha256(convert_to('P2B2_INLINE_PG17_UTF8_JSONB_TEXT_V1'||chr(10)||jsonb_build_object('evidence',evidence,'provenance',provenance)::text,'UTF8')),'hex')) FROM "AuditPage" WHERE id='${result.id}'`,
  ),
);
assert.equal(hashes.new, hashes.actual);
assert.notEqual(hashes.old, hashes.new);
// Test old stored JSON hashing independently, using its original exact PostgreSQL text.
const oldText = sql(
  `SELECT jsonb_build_object('evidence',${quoteJson(original.evidence)}::jsonb,'provenance',${quoteJson(original.provenance)}::jsonb)::text`,
);
assert.equal(
  hashes.old,
  createHash("sha256")
    .update("P2B2_INLINE_PG17_UTF8_JSONB_TEXT_V1\n" + oldText)
    .digest("hex"),
);
function quoteJson(v) {
  return "'" + JSON.stringify(v).replaceAll("'", "''") + "'";
}
for (const action of ["UPDATE", "DELETE"])
  sql(
    `${action === "UPDATE" ? "UPDATE lyraseo_legacy_inline.event SET old_hash=repeat('a',64)" : "DELETE FROM lyraseo_legacy_inline.event"};`,
    maintenance,
    /permission denied/,
  );
sql(
  `UPDATE lyraseo_legacy_inline.event SET old_hash=repeat('a',64);`,
  "postgres",
  /IMMUTABLE_LEGACY_INLINE_RECEIPT/,
);
sql(
  `INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion") VALUES ('fenced','inline-w','inline-s','inline-owner',0,'fenced','fixture','[]','LOCAL_RAW_V1','{}','readiness-v2');`,
  "postgres",
  /LEGACY_INLINE_WRITER_FENCED/,
);
sql(
  `INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion",status,"storageFormat") VALUES ('private-after','inline-w','inline-s','inline-owner',0,'private-after','fixture','[]','LOCAL_RAW_V1','{}','readiness-v2','COMPLETED','AUDIT_PRIVATE_V1');`,
);
sql(`SELECT lyraseo_legacy_inline.pause(${scope},'${pid}');`, maintenance);
assert.equal(
  JSON.parse(
    sql(`SELECT lyraseo_legacy_inline.next(${scope},'${pid}');`, maintenance),
  ).status,
  "paused",
);
const paused = snapshot();
sql(`SELECT lyraseo_legacy_inline.next(${scope},'${pid}');`, maintenance);
assert.equal(snapshot(), paused);
// Real independent backend races. READY is emitted only after acquiring locks.
function session(input, user = "postgres") {
  const child = spawn(
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
      user,
      "-d",
      db,
    ],
    { cwd: root },
  );
  let stdout = "",
    stderr = "",
    readyResolve,
    readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("INLINE_READY")) readyResolve();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const error = Error(stderr);
        readyReject(error);
        reject(error);
      } else resolve(stdout);
    });
  });
  child.stdin.end(input);
  return { ready, done };
}
const racePlan = sql(
  `SELECT lyraseo_legacy_inline.make_plan(${scope});`,
  maintenance,
);
// A legacy reader buffers under shared scope locks. Transition waits until it settles.
let reader = session(
  `BEGIN;SELECT id FROM "Workspace" WHERE id='inline-w' FOR SHARE;SELECT id FROM "Site" WHERE id='inline-s' FOR SHARE;SELECT 'INLINE_READY';SELECT pg_sleep(0.6);COMMIT;`,
);
await reader.ready;
let started = Date.now();
let contender = session(
  `BEGIN;SET LOCAL statement_timeout='3s';SELECT lyraseo_legacy_inline.next(${scope},'${racePlan}');COMMIT;`,
  maintenance,
);
let raced = await contender.done;
await reader.done;
assert(
  Date.now() - started >= 400,
  "Transition must wait for the buffering reader",
);
assert(raced.includes('"status": "transitioned"'));
// Prior-statement timeout is effective while waiting; no claims/cursors survive rollback.
reader = session(
  `BEGIN;SELECT id FROM "Workspace" WHERE id='inline-w' FOR SHARE;SELECT id FROM "Site" WHERE id='inline-s' FOR SHARE;SELECT 'INLINE_READY';SELECT pg_sleep(0.5);COMMIT;`,
);
await reader.ready;
const beforeTimeout = sql(
  `SELECT to_jsonb(p) FROM lyraseo_legacy_inline.plan p WHERE id='${racePlan}'`,
);
sql(
  `BEGIN;SET LOCAL statement_timeout='100ms';SELECT lyraseo_legacy_inline.next(${scope},'${racePlan}');COMMIT;`,
  maintenance,
  /statement timeout/,
);
await reader.done;
assert.equal(
  sql(
    `SELECT to_jsonb(p) FROM lyraseo_legacy_inline.plan p WHERE id='${racePlan}'`,
  ),
  beforeTimeout,
);
// Pause wins first: after its commit, waiting work observes paused and cannot mutate.
const pauseFirst = sql(
  `SELECT lyraseo_legacy_inline.make_plan(${scope});`,
  maintenance,
);
let holder = session(
  `BEGIN;SELECT lyraseo_legacy_inline.pause(${scope},'${pauseFirst}');SELECT 'INLINE_READY';SELECT pg_sleep(0.6);COMMIT;`,
  maintenance,
);
await holder.ready;
contender = session(
  `BEGIN;SET LOCAL statement_timeout='3s';SELECT lyraseo_legacy_inline.next(${scope},'${pauseFirst}');COMMIT;`,
  maintenance,
);
raced = await contender.done;
await holder.done;
assert(raced.includes('"status": "paused"'));
// Mutation wins first: pause waits for the event transaction to settle, then is a barrier.
const mutateFirst = sql(
  `SELECT lyraseo_legacy_inline.make_plan(${scope});`,
  maintenance,
);
holder = session(
  `BEGIN;SELECT lyraseo_legacy_inline.next(${scope},'${mutateFirst}');SELECT 'INLINE_READY';SELECT pg_sleep(0.6);COMMIT;`,
  maintenance,
);
await holder.ready;
contender = session(
  `SELECT lyraseo_legacy_inline.pause(${scope},'${mutateFirst}');`,
  maintenance,
);
await contender.done;
await holder.done;
const eventCount = sql(
  `SELECT count(*) FROM lyraseo_legacy_inline.event WHERE plan_id='${mutateFirst}'`,
);
sql(
  `SELECT lyraseo_legacy_inline.next(${scope},'${mutateFirst}');`,
  maintenance,
);
assert.equal(
  sql(
    `SELECT count(*) FROM lyraseo_legacy_inline.event WHERE plan_id='${mutateFirst}'`,
  ),
  eventCount,
);
// No eligible row is completion proof. Exhaust the classified subset, then verify server backoff.
const backoffPlan = sql(
  `SELECT lyraseo_legacy_inline.make_plan(${scope});`,
  maintenance,
);
let pending;
for (let i = 0; i < 20; i++) {
  const r = JSON.parse(
    sql(
      `SELECT lyraseo_legacy_inline.next(${scope},'${backoffPlan}');`,
      maintenance,
    ),
  );
  if (r.status === "pending") {
    pending = r;
    break;
  }
}
assert(pending);
assert.equal(
  JSON.parse(
    sql(
      `SELECT lyraseo_legacy_inline.next(${scope},'${backoffPlan}');`,
      maintenance,
    ),
  ).status,
  "backoff",
);
// Empty additive replay in a second newly owned database.
const emptyDb =
  "lyraseo_inline_" + randomUUID().replaceAll("-", "").slice(0, 12);
command("docker", [
  "exec",
  container,
  "createdb",
  "-U",
  "postgres",
  "-T",
  "template0",
  emptyDb,
]);
for (const m of migrations)
  command(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      emptyDb,
    ],
    { input: readFileSync(resolve(mroot, m, "migration.sql"), "utf8") },
  );
console.log(
  "Independent backend reader/transition, timeout, pause in both orders, backoff, and empty replay passed:",
  emptyDb,
);
// Synthetic stale-binding fixture only: populate enrollment before its INSERT
// guard is created, preserving all final functions/triggers. This does not restart
// or alter the shared postmaster and is not physical restart qualification.
const staleDb =
  "lyraseo_inline_" + randomUUID().replaceAll("-", "").slice(0, 12);
command("docker", [
  "exec",
  container,
  "createdb",
  "-U",
  "postgres",
  "-T",
  "template0",
  staleDb,
]);
function staleSql(input, user = "postgres", failure) {
  const r = spawnSync(
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
      user,
      "-d",
      staleDb,
    ],
    { input, encoding: "utf8" },
  );
  if (failure) {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, failure);
    return;
  }
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
}
for (const m of migrations.slice(0, 27))
  staleSql(readFileSync(resolve(mroot, m, "migration.sql"), "utf8"));
staleSql(bootstrap);
staleSql(
  `INSERT INTO "ProductUser"(id) VALUES('inline-owner');INSERT INTO "Workspace"(id,name) VALUES('inline-w','stale fixture');INSERT INTO "Site"(id,"workspaceId",origin) VALUES('inline-s','inline-w','https://example.com');`,
);
const bindingFixture = `INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time()-interval '1 second','lyraseo_artifact_maintenance','inline-w','inline-s','P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database();\n`;
staleSql(
  migration.replace(
    "CREATE TRIGGER inline_enrollment_fence",
    bindingFixture + "CREATE TRIGGER inline_enrollment_fence",
  ),
);
assert.equal(
  staleSql(
    `SELECT lyraseo_legacy_inline.protected_scope(${scope});`,
    "lyraseo_runtime",
  ),
  "t",
);
assert.equal(
  staleSql(
    `SELECT lyraseo_legacy_inline.enrolled(${scope});`,
    "lyraseo_runtime",
  ),
  "f",
);
for (const fn of ["status", "next", "pause"])
  staleSql(
    `SELECT lyraseo_legacy_inline.${fn}(${scope},'${randomUUID()}');`,
    maintenance,
    /LEGACY_INLINE_SCOPE_DENIED/,
  );
staleSql(
  `SELECT lyraseo_legacy_inline.preview(${scope},1);`,
  maintenance,
  /LEGACY_INLINE_SCOPE_DENIED/,
);
staleSql(
  `SELECT lyraseo_legacy_inline.make_plan(${scope});`,
  maintenance,
  /LEGACY_INLINE_SCOPE_DENIED/,
);
const staleAdmission = `INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion","storageFormat") VALUES ('stale-producer','inline-w','inline-s','inline-owner',0,'stale-producer','fixture','[]','LOCAL_RAW_V1','{}','readiness-v2',`;
staleSql(staleAdmission + `NULL);`, "postgres", /LEGACY_INLINE_WRITER_FENCED/);
staleSql(staleAdmission + `'AUDIT_PRIVATE_V1');`);
console.log(
  "Synthetic stale enrollment maintenance denial + persistent writer fence/private admission passed:",
  staleDb,
);
// Application services use current schema/current bootstrap. The accepted27+36
// databases above are SQL-only historical controls, never current Prisma targets.
assembledSql(seed);
assembledSql(
  `INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time(),'lyraseo_artifact_maintenance','inline-w','inline-s','P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database();`,
);
command("pnpm", ["--filter", "@lyraseo/db", "exec", "prisma", "generate"], {
  stdio: "inherit",
});
// Signed test reset helpers use their own separately owned current-schema DB.
const bridgeDb =
  "lyraseo_expiry_" + randomUUID().replaceAll("-", "").slice(0, 12);
command("docker", [
  "exec",
  container,
  "createdb",
  "-U",
  "postgres",
  "-T",
  "template0",
  bridgeDb,
]);
for (const m of assembledMigrations)
  command(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      bridgeDb,
    ],
    {
      input: readFileSync(resolve(assembledMroot, m, "migration.sql"), "utf8"),
    },
  );
command(
  "docker",
  [
    "exec",
    "-i",
    container,
    "psql",
    "-X",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    bridgeDb,
  ],
  { input: currentBootstrap },
);
console.log("R1 owned signed bridge fixture:", bridgeDb);
command(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "tests/integration/signed-node-bridge.test.ts",
    "-t",
    "legacy inline fence R1",
  ],
  {
    env: {
      ...process.env,
      LYRA_TEST_DB_NAME: bridgeDb,
      LYRA_INLINE_R1_REQUIRED: "true",
    },
    stdio: "inherit",
  },
);
// GREEN acceptance must never inherit the intentional direct-test RED skip.
const serviceResultPath = resolve(output, "required-service-results.json");
// Product API checks use only this explicitly owned database; no shared helper reset.
command(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "tests/integration/legacy-inline-product.test.ts",
    "tests/integration/legacy-inline-r1.test.ts",
    "tests/integration/legacy-inline-r2.test.ts",
    "tests/integration/legacy-inline-issue-actions.test.ts",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${serviceResultPath}`,
  ],
  {
    env: {
      ...process.env,
      LYRA_INLINE_TEST_DB: assembledDb,
      LYRA_INLINE_R2_RED: "false",
    },
    stdio: "inherit",
  },
);
const serviceResults = JSON.parse(readFileSync(serviceResultPath, "utf8"));
const report = {
  requiredServices: verifyRequiredServices(serviceResults, root),
  database: db,
  ownedDatabases: {
    populated: db,
    empty: emptyDb,
    staleBinding: staleDb,
    signedBridge: bridgeDb,
    assembled: assembledDb,
    productServices: assembledDb,
  },
  migration: migrations[27],
  baselineHashes,
  assembled: {
    sourceRoot: assembledRoot,
    migrations: assembledHashes,
    bootstrapSha256: createHash("sha256")
      .update(currentBootstrap)
      .digest("hex"),
    guardedVisibility,
    baselineCommit,
    applicationSchemaSha256,
    baselineManifestSha256: pinned.manifestSha256,
    baselineBootstrapSha256: pinned.bootstrapSha256,
  },
  preview,
  receipt: after.event,
  checks: [
    "populated replay",
    "zero-write preview",
    "null bounds",
    "scope before mutation",
    "wrong plan",
    "maintenance least privilege",
    "ordinary immutability",
    "independent stored hashes",
    "exact protected facts",
    "revision head/body/pins exact",
    "writer fence",
    "private admission",
    "pause barrier sequential",
    "reader/transition lock race",
    "pause wins and mutation wins concurrent barriers",
    "prior-statement server timeout rollback",
    "server-time backoff",
    "empty additive replay",
    "27 restricted product API checks including11 R1,6 R2 and5 issue-action cases",
    "165 row-class inventory with keyset beyond100 and zero writes",
    "direct column privileges absent for maintenance",
    "synthetic stale-binding maintenance denial and persistent fence",
    "three signed preparation/network/private lifecycle regressions",
    "genuine artifact-backed private page bytes and retention parity",
    "R2 two-connection before/after GSC enrollment races",
    "R2 final lock before enrollment and exact-status retry",
    "R2 six concurrent reads through max-one-connection reader pool",
    "R2 restricted revoked/epoch/nonowner/guessed target authorization",
  ],
  remaining: [
    "AuditPage.evidence and receipt residuals",
    "frozen AuditRun evaluation",
    "ContentDraft.snapshot",
    "live authenticated browser acceptance beyond controlled component fixtures",
  ],
  scope: "LOCAL_TEST_ONLY_ACTIVE_STORE",
};
writeFileSync(
  resolve(output, "gate.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "Legacy inline targeted SQL gate passed; residuals remain blocked. Evidence:",
  resolve(output, "gate.json"),
);
