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
let db =
  "lyraseo_report_review_" + randomUUID().replaceAll("-", "").slice(0, 12);
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
console.log("OWNED_REVIEW_DATABASE", db);
const failures = [];
function check(name, work) {
  try {
    work();
    console.log("PASS", name);
  } catch (error) {
    failures.push(name);
    console.error("FAIL", name, error.message);
  }
}
try {
  const migrations = readdirSync("packages/db/prisma/migrations")
    .filter((x) => x !== "migration_lock.toml")
    .sort();
  for (const name of migrations.filter(
    (x) => x < "202611030013_legacy_saved_evidence",
  ))
    sql(
      readFileSync(
        "packages/db/prisma/migrations/" + name + "/migration.sql",
        "utf8",
      ),
    );
  sql(`INSERT INTO lyraseo_kernel.test_environment(database_oid) SELECT oid FROM pg_database WHERE datname=current_database();
 INSERT INTO "Workspace"(id,name) VALUES('w','Owned review fixture'); INSERT INTO "Site"(id,"workspaceId",origin) VALUES('s','w','https://example.test');
 INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv)
 SELECT CASE WHEN i=100 THEN 'inv-100-'||repeat('x',10000) WHEN i=200 THEN 'inv-200-'||repeat('界',10000) ELSE 'inv-'||lpad(i::text,3,'0') END,'w','s',CASE WHEN i=205 THEN repeat('OVERSIZED_METADATA',10000) ELSE 'Historical fixture' END,
 jsonb_build_object('unknown','RAW_SOURCE_MARKER'),convert_to('unknown PDF','UTF8'),CASE WHEN i=205 THEN repeat('OVERSIZED_SOURCE',800000) ELSE 'unknown CSV' END FROM generate_series(1,205) i;
 GRANT SELECT(snapshot,pdf,csv) ON "EvidenceReport" TO lyraseo_runtime,lyraseo_identity,lyraseo_dispatch,lyraseo_operator,lyraseo_artifact_maintenance,anon,authenticated;
 GRANT SELECT ON "EvidenceReport" TO PUBLIC;
 GRANT SELECT(snapshot,pdf,csv) ON "EvidenceReport" TO PUBLIC;`);
  const preUpgrade = sql(
    `SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(r) ORDER BY id)::text,'UTF8')),'hex') FROM "EvidenceReport" r`,
  );
  const preIdentities = sql(
    `SELECT jsonb_agg(encode(sha256(convert_to((to_jsonb(r)-ARRAY['snapshot','pdf','csv'])::text,'UTF8')),'hex') ORDER BY id)::text FROM "EvidenceReport" r`,
  );
  sql(
    readFileSync(
      "packages/db/prisma/migrations/202611030013_legacy_saved_evidence/migration.sql",
      "utf8",
    ),
  );
  assert.equal(
    preUpgrade,
    sql(
      `SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(r)-'identifierKey' ORDER BY id)::text,'UTF8')),'hex') FROM "EvidenceReport" r`,
    ),
  );
  assert.equal(
    preIdentities,
    sql(
      `SELECT jsonb_agg(lyraseo_report.facts(r)->>'identityHash' ORDER BY id)::text FROM "EvidenceReport" r`,
    ),
  );
  console.log(
    "PASS populated generated-key upgrade preserves every original stored column and legacy identity hash",
  );
  sql(
    `INSERT INTO lyraseo_report.environment VALUES('w','s',(SELECT oid FROM pg_database WHERE datname=current_database()),pg_postmaster_start_time(),'lyraseo_artifact_maintenance','LEGACY_REPORT_LOCAL_V1')`,
  );
  function assertDenied() {
    for (const column of ["snapshot", "pdf", "csv"]) {
      for (const principal of [
        "lyraseo_runtime",
        "lyraseo_identity",
        "lyraseo_dispatch",
        "lyraseo_operator",
        "lyraseo_artifact_maintenance",
        "anon",
        "authenticated",
      ])
        assert.equal(
          sql(
            `SELECT has_column_privilege('${principal}','public."EvidenceReport"','${column}','SELECT')`,
          ),
          "f",
        );
      sql(
        `BEGIN; SELECT set_config('app.workspace_id','w',true); SELECT ${column} FROM "EvidenceReport" WHERE id='inv-001'; ROLLBACK;`,
        "lyraseo_runtime",
        /permission denied/,
      );
    }
  }
  check("independent grants removed before bootstrap", assertDenied);
  for (const file of [
    "scripts/local-db.mjs",
    "tests/fixtures/expiry/history-bootstrap.sql",
  ])
    check("bootstrap effective payload denial " + file, () => {
      sql(
        'GRANT SELECT(snapshot,pdf,csv) ON "EvidenceReport" TO lyraseo_runtime; GRANT SELECT ON "EvidenceReport" TO PUBLIC; GRANT SELECT(pdf) ON "EvidenceReport" TO PUBLIC;',
      );
      const source = readFileSync(file, "utf8");
      const complete = file.endsWith(".sql")
        ? source
        : (source.match(/LOCAL_GRANT_BOOTSTRAP = `([\s\S]*?)`;/)?.[1] ??
          readFileSync("scripts/lib/local-grants.mjs", "utf8").match(
            /LOCAL_GRANT_BOOTSTRAP = `([\s\S]*?)`/,
          )?.[1]);
      assert(complete, "complete bootstrap SQL required");
      sql(complete);
      assertDenied();
    });
  sql(
    `UPDATE lyraseo_report.environment SET postmaster_started_at=postmaster_started_at-interval '1 second'`,
  );
  check("stale maintenance binding rejected", () =>
    sql(
      `SELECT lyraseo_report.inspect('w','s','inv-001')`,
      "lyraseo_artifact_maintenance",
      /REPORT_UNENROLLED/,
    ),
  );
  check("persistent admission fence after simulated restart", () =>
    sql(
      `BEGIN; SELECT set_config('app.workspace_id','w',true); INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv) VALUES('reopened','w','s','New inline','{}',convert_to('bytes','UTF8'),'csv'); ROLLBACK;`,
      "lyraseo_runtime",
      /LEGACY_REPORT_WRITER_FENCED/,
    ),
  );
  sql(
    `UPDATE lyraseo_report.environment SET postmaster_started_at=pg_postmaster_start_time()`,
  );
  check(
    "bounded zero-write inventory keyset continuation includes oversized residual",
    () => {
      const before = sql(
        `SELECT encode(sha256(convert_to(jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM "EvidenceReport" r),'decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM lyraseo_report.decision d),'enrollment',(SELECT jsonb_agg(to_jsonb(e) ORDER BY site_id) FROM lyraseo_report.environment e))::text,'UTF8')),'hex')`,
      );
      const expected = JSON.parse(
        sql(
          `SELECT jsonb_agg(encode(sha256(convert_to(id,'UTF8')),'hex') ORDER BY id) FROM "EvidenceReport"`,
        ),
      );
      let cursor = null,
        ids = [],
        oversized = 0,
        firstCursor,
        oversizedItems = [];
      for (let page = 0; page < 4; page++) {
        const output = sql(
          `SELECT lyraseo_report.inventory('w','s',${cursor ? "'" + cursor + "'" : "NULL"})`,
          "lyraseo_artifact_maintenance",
        );
        assert(!output.includes("RAW_SOURCE_MARKER"));
        assert(!output.includes("OVERSIZED_METADATA"));
        assert(!output.includes("OVERSIZED_SOURCE"));
        assert(Buffer.byteLength(output) < 1000000);
        const inventory = JSON.parse(output);
        assert.equal(inventory.counts.legacyTotal, 205);
        assert(inventory.items.length <= 100);
        ids.push(
          ...inventory.items.map(
            (x) => x.idHash ?? createHash("sha256").update(x.id).digest("hex"),
          ),
        );
        for (const item of inventory.items) {
          if (item.idByteLength > 1024) {
            oversized++;
            oversizedItems.push(item);
            assert.equal(item.id, null);
            assert.equal(item.identifierStatus, "oversized-identifier");
          }
        }
        const limited = inventory.items.find((x) => x.id === "inv-205");
        if (limited) {
          assert.equal(limited.facts, null);
          assert.equal(
            limited.factStatus,
            "classification-blocked-resource-limit",
          );
        }
        cursor = inventory.nextCursor;
        if (page === 0) firstCursor = cursor;
        assert(
          cursor === null || Buffer.byteLength(cursor) <= 128,
          "bounded continuation must handle the boundary identifier",
        );
        if (cursor === null) break;
      }
      assert.equal(ids.length, 205);
      assert.equal(new Set(ids).size, 205);
      assert.deepEqual(ids, expected);
      assert.equal(oversized, 2);
      assert.deepEqual(
        oversizedItems.map((x) => x.idByteLength),
        [
          Buffer.byteLength("inv-100-" + "x".repeat(10000)),
          Buffer.byteLength("inv-200-" + "界".repeat(10000)),
        ],
      );
      assert.equal(cursor, null);
      assert.equal(
        before,
        sql(
          `SELECT encode(sha256(convert_to(jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM "EvidenceReport" r),'decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM lyraseo_report.decision d),'enrollment',(SELECT jsonb_agg(to_jsonb(e) ORDER BY site_id) FROM lyraseo_report.environment e))::text,'UTF8')),'hex')`,
        ),
      );
      console.log(
        "PASS complete unique 205-row inventory, long ASCII/non-ASCII boundaries, <=128-byte cursors and zero-write source/control/receipt hashes",
      );
      for (const item of oversizedItems) {
        const output = sql(
          `SELECT lyraseo_report.inspect_key('w','s','${item.idHash}',false)`,
          "lyraseo_artifact_maintenance",
        );
        const metadata = JSON.parse(output);
        assert.equal(metadata.idHash, item.idHash);
        assert.equal(metadata.idByteLength, item.idByteLength);
        assert(Buffer.byteLength(output) < 4096);
        sql(
          `SELECT lyraseo_report.withdraw_key('w','s','${item.idHash}','${JSON.stringify(item.facts)}','Operator quarantines oversized identifier fixture',false)`,
          "lyraseo_artifact_maintenance",
        );
      }
      sql(
        `SELECT lyraseo_report.inspect_key('w','s','${"f".repeat(64)}',false)`,
        "lyraseo_artifact_maintenance",
        /NOT_FOUND/,
      );
      sql(
        `SELECT lyraseo_report.inspect_key('w','other','${oversizedItems[0].idHash}',false)`,
        "lyraseo_artifact_maintenance",
        /REPORT_UNENROLLED/,
      );
      console.log(
        "PASS bounded opaque inspection/withdrawal of both oversized IDs and rejected unknown/cross-scope keys",
      );
      // A controlled administrator re-enrollment replaces one legacy ID with a
      // different ID at the same population. The old cursor must be rejected.
      sql(`BEGIN; DELETE FROM lyraseo_report.environment;
        DELETE FROM "EvidenceReport" WHERE id='inv-001';
        INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv) VALUES('replacement','w','s','Controlled replacement','{}',convert_to('bytes','UTF8'),'csv');
        INSERT INTO lyraseo_report.environment VALUES('w','s',(SELECT oid FROM pg_database WHERE datname=current_database()),pg_postmaster_start_time(),'lyraseo_artifact_maintenance','LEGACY_REPORT_LOCAL_V1'); COMMIT;`);
      sql(
        `SELECT lyraseo_report.inventory('w','s','${firstCursor}')`,
        "lyraseo_artifact_maintenance",
        /REPORT_INVENTORY_CHANGED/,
      );
      console.log(
        "PASS same-population identifier replacement rejects stale continuation",
      );
      sql(
        `SELECT lyraseo_report.inspect('w','s','inv-205',true)`,
        "lyraseo_artifact_maintenance",
        /REPORT_INSPECTION_LIMIT/,
      );
    },
  );
} finally {
  command(["dropdb", "-U", "postgres", db]);
}
if (failures.length)
  throw Error("REPORT_REVIEW_REGRESSIONS: " + failures.join("; "));
