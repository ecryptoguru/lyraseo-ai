import { spawnSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { LOCAL_GRANT_BOOTSTRAP } from "./lib/local-grants.mjs";
const container = "lyraseo-phase1-postgres";
const inspected = spawnSync("docker", ["inspect", container], {
  encoding: "utf8",
});
if (inspected.status) throw Error("LOCAL_PG17_REQUIRED");
const image = JSON.parse(inspected.stdout)[0];
assert.equal(image.Config.Image, "postgres:17-alpine");
assert.deepEqual(image.HostConfig.PortBindings["5432/tcp"], [
  { HostIp: "127.0.0.1", HostPort: "54329" },
]);
function exec(args, input) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      ...(input !== undefined ? ["-i"] : []),
      "-u",
      "postgres",
      container,
      ...args,
    ],
    { encoding: "utf8", input },
  );
  if (result.status) throw Error(result.stderr);
  return result.stdout.trim();
}
const owned = exec(["mktemp", "-d", "/tmp/lyraseo-report-role-XXXXXXXX"]);
assert(/^\/tmp\/lyraseo-report-role-[A-Za-z0-9]+$/.test(owned));
const socket = owned + "/socket",
  data = owned + "/data";
let started = false;
function sql(db, input, role = "postgres", expected) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      "postgres",
      container,
      "psql",
      "-h",
      socket,
      "-p",
      "55439",
      "-U",
      role,
      "-d",
      db,
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input, encoding: "utf8" },
  );
  if (expected) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    return;
  }
  if (result.status) throw Error(result.stderr);
  return result.stdout.trim();
}
function asynchronousSql(db, input, role = "postgres") {
  const child = spawn("docker", [
    "exec",
    "-i",
    "-u",
    "postgres",
    container,
    "psql",
    "-h",
    socket,
    "-p",
    "55439",
    "-U",
    role,
    "-d",
    db,
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
  ]);
  const result = { out: "", error: "", done: null };
  child.stdout.on("data", (value) => (result.out += value));
  child.stderr.on("data", (value) => (result.error += value));
  result.done = new Promise((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  child.stdin.end(input);
  return result;
}
async function ready(process, marker) {
  for (let i = 0; i < 100; i++) {
    if (process.out.includes(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("TEST_BARRIER_NOT_READY");
}
const bootstrapSource = readFileSync("scripts/local-db.mjs", "utf8");
const fullCurrent = LOCAL_GRANT_BOOTSTRAP;
const fullHistory = readFileSync(
  "tests/fixtures/expiry/history-bootstrap.sql",
  "utf8",
);
assert(
  fullCurrent &&
    fullCurrent.includes("GRANT USAGE ON SCHEMA public TO lyraseo_identity;"),
);
const roles = vm.runInNewContext(
  "(" + bootstrapSource.match(/const localRoles = (\[[\s\S]*?\n\]);/)[1] + ")",
);
const migrationRoot = "packages/db/prisma/migrations/";
const migrations = readdirSync(migrationRoot)
  .filter((x) => x !== "migration_lock.toml")
  .sort();
const report = readFileSync(
  migrationRoot + "202611030013_legacy_saved_evidence/migration.sql",
  "utf8",
);
try {
  exec([
    "initdb",
    "-D",
    data,
    "--auth=trust",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  exec(["mkdir", socket]);
  exec([
    "pg_ctl",
    "-D",
    data,
    "-l",
    owned + "/server.log",
    "-o",
    `-c listen_addresses='' -k ${socket} -p 55439`,
    "-w",
    "start",
  ]);
  started = true;
  console.log("OWNED_SOCKET_ONLY_POSTMASTER", owned);
  for (const [role, password] of roles) {
    assert(/^[a-z_]+$/.test(role));
    sql(
      "postgres",
      `CREATE ROLE ${role} ${password ? "LOGIN" : "NOLOGIN"} NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`,
    );
  }
  sql("postgres", "CREATE ROLE report_payload_carrier NOLOGIN NOINHERIT;");
  for (const mode of ["inherit", "set"]) {
    const db = "role_" + mode;
    sql("postgres", `CREATE DATABASE ${db} TEMPLATE template0;`);
    for (const name of migrations.filter(
      (x) => x < "202611030013_legacy_saved_evidence",
    ))
      sql(db, readFileSync(migrationRoot + name + "/migration.sql", "utf8"));
    sql(
      db,
      `INSERT INTO "ProductUser"(id) VALUES('owner'); INSERT INTO "Workspace"(id,name) VALUES('w','Owned roles'); INSERT INTO "Membership"("workspaceId","userId",role) VALUES('w','owner','OWNER'); INSERT INTO "Site"(id,"workspaceId",origin) VALUES('s','w','https://example.test');
   INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv) VALUES('legacy','w','s','Fixture','{}',convert_to('bytes','UTF8'),'csv');`,
    );
    sql(
      db,
      `INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,"evidenceFormat",snapshot,pdf,csv) VALUES('legacy','w','s','Duplicate','saved-evidence-v2','{}',convert_to('bytes','UTF8'),'csv');`,
      "postgres",
      /duplicate key/,
    );
    sql(
      db,
      'REVOKE SELECT ON "EvidenceReport" FROM lyraseo_runtime; REVOKE SELECT(snapshot,pdf,csv) ON "EvidenceReport" FROM lyraseo_runtime;',
    );
    function admit() {
      sql(
        db,
        `GRANT SELECT(id,snapshot,pdf,csv) ON "EvidenceReport" TO report_payload_carrier;
   GRANT report_payload_carrier TO lyraseo_runtime WITH INHERIT ${mode === "inherit" ? "TRUE" : "FALSE"}, SET ${mode === "set" ? "TRUE" : "FALSE"};`,
      );
    }
    function remove() {
      sql(
        db,
        'REVOKE report_payload_carrier FROM lyraseo_runtime; REVOKE ALL ON "EvidenceReport" FROM report_payload_carrier; REVOKE SELECT(id,snapshot,pdf,csv) ON "EvidenceReport" FROM report_payload_carrier;',
      );
    }
    function proveAttack() {
      assert.equal(
        sql(
          db,
          `SELECT has_column_privilege('lyraseo_runtime','public."EvidenceReport"','pdf','SELECT')`,
        ),
        mode === "inherit" ? "t" : "f",
      );
      const result = sql(
        db,
        `BEGIN; SELECT set_config('app.workspace_id','w',true); ${mode === "set" ? "SET ROLE report_payload_carrier;" : ""} SELECT octet_length(pdf) FROM "EvidenceReport" WHERE id='legacy'; ROLLBACK;`,
        "lyraseo_runtime",
      );
      assert(result.split("\n").includes("5"));
      console.log(
        "ATTACK_PRECONDITION_PROVEN",
        mode,
        "actual payload length read through the isolated role path",
      );
    }
    admit();
    proveAttack();
    sql(db, report, "postgres", /UNSAFE_REPORT_PAYLOAD_PRIVILEGE/);
    remove();
    sql(db, report);
    console.log(
      "PASS migration rejects actual " + mode + " payload reachability",
    );
    for (const [name, payload] of [
      ["complete current bootstrap SQL", fullCurrent],
      ["complete historical bootstrap SQL", fullHistory],
    ]) {
      admit();
      proveAttack();
      sql(
        db,
        "BEGIN;\n" + payload + "\nCOMMIT;",
        "postgres",
        /UNSAFE_REPORT_PAYLOAD_PRIVILEGE/,
      );
      remove();
      sql(db, "BEGIN;\n" + payload + "\nCOMMIT;");
      for (const column of ["snapshot", "pdf", "csv"]) {
        assert.equal(
          sql(
            db,
            `SELECT has_column_privilege('lyraseo_runtime','public."EvidenceReport"','${column}','SELECT')`,
          ),
          "f",
        );
        sql(
          db,
          `BEGIN; SELECT set_config('app.workspace_id','w',true); SELECT ${column} FROM "EvidenceReport"; ROLLBACK;`,
          "lyraseo_runtime",
          /permission denied/,
        );
      }
      if (name === "complete historical bootstrap SQL") {
        for (const column of ["resultExpiresAt", "storageFormat"]) {
          const exists = sql(
            db,
            `SELECT EXISTS(SELECT FROM pg_attribute WHERE attrelid='public."VisibilityRun"'::regclass AND attname='${column}' AND NOT attisdropped)`,
          );
          if (exists === "t")
            assert.equal(
              sql(
                db,
                `SELECT has_column_privilege('lyraseo_runtime','public."VisibilityRun"','${column}','SELECT')`,
              ),
              "t",
            );
        }
        console.log(
          "PASS historical bootstrap retains full-head VisibilityRun metadata column grants where present",
        );
      }
      console.log(
        "PASS " + name + " rejects " + mode + " attack, then succeeds safely",
      );
    }
    const runtimeWrite = sql(
      db,
      `BEGIN; SET LOCAL app.workspace_id='w'; INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,"evidenceFormat",snapshot,pdf,csv) VALUES('runtime-index-parity','w','s','Current writer fixture','saved-evidence-v2','{}',convert_to('bytes','UTF8'),'csv') RETURNING id; ROLLBACK;`,
      "lyraseo_runtime",
    );
    assert(runtimeWrite.includes("runtime-index-parity"));
    console.log(
      "PASS restricted runtime INSERT/RETURNING remains compatible with the opaque-key index",
    );
    if (mode === "inherit") {
      const originalFacts = sql(
        db,
        `SELECT lyraseo_report.facts(r)::text FROM "EvidenceReport" r WHERE id='legacy'`,
      );
      sql(db, `UPDATE "EvidenceReport" SET id=id WHERE id='legacy';`);
      assert.equal(
        originalFacts,
        sql(
          db,
          `SELECT lyraseo_report.facts(r)::text FROM "EvidenceReport" r WHERE id='legacy'`,
        ),
      );
      sql(
        db,
        `UPDATE "EvidenceReport" SET "identifierKey"='forged' WHERE id='legacy';`,
        "postgres",
        /can only be updated to DEFAULT/,
      );
      const dump = exec([
        "pg_dump",
        "-h",
        socket,
        "-p",
        "55439",
        "-U",
        "postgres",
        "-d",
        db,
        "--data-only",
        "--inserts",
        "--no-owner",
        "--no-privileges",
        "--enable-row-security",
        '--table=public."EvidenceReport"',
      ]);
      assert(dump.includes('INSERT INTO public."EvidenceReport"'));
      assert(
        !/INSERT INTO public\."EvidenceReport"[^;]*identifierKey/.test(dump),
      );
      sql("postgres", "CREATE DATABASE generated_restore TEMPLATE template0;");
      for (const name of migrations)
        sql(
          "generated_restore",
          readFileSync(migrationRoot + name + "/migration.sql", "utf8"),
        );
      sql(
        "generated_restore",
        `INSERT INTO "Workspace"(id,name) VALUES('w','Restore fixture'); INSERT INTO "Site"(id,"workspaceId",origin) VALUES('s','w','https://example.test');`,
      );
      sql("generated_restore", dump);
      assert.equal(
        originalFacts,
        sql(
          "generated_restore",
          `SELECT lyraseo_report.facts(r)::text FROM "EvidenceReport" r WHERE id='legacy'`,
        ),
      );
      assert.equal(
        sql(
          "generated_restore",
          `SELECT "identifierKey"=encode(sha256(convert_to(id,'UTF8')),'hex') FROM "EvidenceReport" WHERE id='legacy'`,
        ),
        "t",
      );
      console.log(
        "PASS generated-key dump projection omits derived column and restore recomputes it with identical original facts",
      );
    }
    if (mode === "set") {
      sql(
        db,
        `INSERT INTO "Site"(id,"workspaceId",origin) VALUES('resource','w','https://resource.test');
       INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv)
        SELECT CASE WHEN i=1 THEN 'resource-1-'||repeat('x',70000) ELSE 'resource-'||i END,'w','resource','Fixture','{}',convert_to('1','UTF8'),'c' FROM generate_series(1,300000) i;
       INSERT INTO lyraseo_report.environment VALUES('w','resource',(SELECT oid FROM pg_database WHERE datname=current_database()),pg_postmaster_start_time(),'lyraseo_artifact_maintenance','LEGACY_REPORT_LOCAL_V1');`,
      );
      // Reproduce an absent-key resolver with no caller statement timeout while
      // a controlled slow digest helper makes accidental scope scans observable.
      sql(
        db,
        `CREATE OR REPLACE FUNCTION lyraseo_report.id_key(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN IF octet_length(value)>65536 THEN RAISE EXCEPTION 'OVERSIZED_IDENTIFIER_HASHED_DURING_RESOLUTION'; END IF; IF value LIKE 'resource-%' THEN PERFORM pg_sleep(0.001); END IF; RETURN encode(sha256(convert_to(value,'UTF8')),'hex'); END $$;`,
      );
      const resolverPlan = sql(
        db,
        `SET enable_seqscan=off; SET enable_indexscan=on; SET enable_bitmapscan=off; SET enable_sort=off; EXPLAIN (COSTS OFF) SELECT id FROM "EvidenceReport" WHERE ("workspaceId","siteId")=('w','resource') AND "identifierKey">='${"f".repeat(64)}' ORDER BY "identifierKey" LIMIT 2;`,
      );
      assert(
        resolverPlan.includes("EvidenceReport_opaque_key_idx"),
        "resolver must use bounded key index; plan=" +
          resolverPlan +
          "; index=" +
          sql(
            db,
            `SELECT pg_get_indexdef('public."EvidenceReport_opaque_key_idx"'::regclass)`,
          ),
      );
      const absentControl = sql(
        db,
        `SELECT encode(sha256(convert_to(jsonb_build_object('environment',(SELECT jsonb_agg(to_jsonb(e) ORDER BY site_id) FROM lyraseo_report.environment e),'receipts',(SELECT count(*) FROM lyraseo_report.decision),'row',(SELECT to_jsonb(r) FROM "EvidenceReport" r WHERE id='resource-2'))::text,'UTF8')),'hex')`,
      );
      // No ANALYZE/warmup: stale bulk-insert statistics must not make an
      // authorized point read scan the entire newly populated scope.
      sql(
        db,
        `BEGIN; SET LOCAL app.workspace_id='w'; SET LOCAL app.actor_id='owner'; SET LOCAL statement_timeout='150ms'; SELECT lyraseo_report.status('w','resource','resource-2'); COMMIT;`,
        "lyraseo_runtime",
      );
      const statusPlan = sql(
        db,
        `SET ROLE lyraseo_report_owner; SET enable_indexscan=on; SET enable_bitmapscan=off; SET enable_seqscan=off; SET enable_sort=off; EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) WITH candidates AS MATERIALIZED (SELECT * FROM "EvidenceReport" WHERE ("workspaceId","siteId")=('w','resource') AND "identifierKey">=encode(sha256(convert_to('resource-2','UTF8')),'hex') AND "identifierKey"<encode(sha256(convert_to('resource-2','UTF8')),'hex')||'g' ORDER BY "identifierKey" LIMIT 2 FOR SHARE) SELECT * FROM candidates WHERE id='resource-2';`,
      );
      assert.match(statusPlan, /Index Cond:.*identifierKey/);
      console.log(
        "PASS cold authorized status point read with stale bulk statistics and 150ms timeout",
        statusPlan,
      );
      for (const action of ["inspect", "withdraw"]) {
        const absentOperation =
          action === "inspect"
            ? `inspect_key('w','resource','${"f".repeat(64)}',false)`
            : `withdraw_key('w','resource','${"f".repeat(64)}','{}','Absent identifier must not lock the site',false)`;
        const absent = spawn("docker", [
          "exec",
          "-i",
          "-u",
          "postgres",
          container,
          "psql",
          "-h",
          socket,
          "-p",
          "55439",
          "-U",
          "lyraseo_artifact_maintenance",
          "-d",
          db,
          "-X",
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
        ]);
        let absentError = "";
        absent.stderr.on("data", (chunk) => (absentError += chunk));
        let absentFinished = false;
        const absentDone = new Promise((resolve) =>
          absent.on("close", (code) => {
            absentFinished = true;
            resolve(code);
          }),
        );
        const absentStart = Date.now();
        absent.stdin.end(
          `SET application_name='r3_absent'; SET statement_timeout=0; SET enable_indexscan=off; SET enable_bitmapscan=off; SET enable_seqscan=on; SELECT lyraseo_report.${absentOperation};`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        let readerError;
        try {
          sql(
            db,
            `BEGIN; SET LOCAL app.workspace_id='w'; SET LOCAL app.actor_id='owner'; SET LOCAL statement_timeout='150ms'; SELECT lyraseo_report.status('w','resource','resource-2'); COMMIT;`,
            "lyraseo_runtime",
          );
        } catch (error) {
          readerError = error;
        }
        for (let i = 0; i < 30 && !absentFinished; i++)
          await new Promise((resolve) => setTimeout(resolve, 50));
        // Cancellation is diagnostic cleanup if the old scope scan remains active;
        // it is not accepted as successful bounded resolver completion.
        sql(
          db,
          `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='r3_absent' AND state='active' AND datname=current_database();`,
        );
        await absentDone;
        assert(
          !readerError,
          "competing product reader failed during absent-key resolution: " +
            (readerError?.message ?? "unknown"),
        );
        assert.match(
          absentError,
          /NOT_FOUND/,
          "absent-key lookup must finish without external timeout/cancellation",
        );
        assert(
          Date.now() - absentStart < 2500,
          "absent-key indexed lookup must be bounded",
        );
        console.log(
          "PASS " +
            action +
            " slow-scope absent lookup with statement_timeout=0 completes while product reader proceeds",
        );
      }
      assert.equal(
        absentControl,
        sql(
          db,
          `SELECT encode(sha256(convert_to(jsonb_build_object('environment',(SELECT jsonb_agg(to_jsonb(e) ORDER BY site_id) FROM lyraseo_report.environment e),'receipts',(SELECT count(*) FROM lyraseo_report.decision),'row',(SELECT to_jsonb(r) FROM "EvidenceReport" r WHERE id='resource-2'))::text,'UTF8')),'hex')`,
        ),
      );
      const oversizedStoredKey = sql(
        db,
        `SELECT encode(sha256(convert_to('resource-1-'||repeat('x',70000),'UTF8')),'hex')`,
      );
      for (const call of [
        `inspect_key('w','resource','${oversizedStoredKey}',false)`,
        `withdraw_key('w','resource','${oversizedStoredKey}','{}','Oversized key must not be rehashed',false)`,
      ])
        sql(
          db,
          "SET statement_timeout=0; SELECT lyraseo_report." + call,
          "lyraseo_artifact_maintenance",
          /REPORT_CLASSIFICATION_BLOCKED_RESOURCE_LIMIT/,
        );
      console.log(
        "PASS oversized stored identifier is classified before rehash/materialization by both wrappers",
      );
      sql(
        db,
        `CREATE OR REPLACE FUNCTION lyraseo_report.id_key(value text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(value,'UTF8')),'hex') $$;`,
      );

      const key2 = sql(
        db,
        `SELECT encode(sha256(convert_to('resource-2','UTF8')),'hex')`,
      );
      const tooLargeKey = sql(
        db,
        `SELECT encode(sha256(convert_to('resource-1-'||repeat('x',70000),'UTF8')),'hex')`,
      );
      const targetBefore = sql(
        db,
        `SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') FROM "EvidenceReport" r WHERE id='resource-2'`,
      );
      for (const operation of ["inspect", "withdraw"]) {
        const call =
          operation === "inspect"
            ? `inspect_key('w','resource','${key2}',false)`
            : `withdraw_key('w','resource','${key2}','{}','Lock timeout must not change original',false)`;
        const blocked = asynchronousSql(
          db,
          `BEGIN; SET application_name='r3_holder'; SELECT id FROM "Site" WHERE id='resource' FOR UPDATE; SELECT 'R3_LOCKED'; SELECT pg_sleep(1.5); COMMIT;`,
        );
        await ready(blocked, "R3_LOCKED");
        const started = Date.now();
        sql(
          db,
          `SET statement_timeout=0; SET lock_timeout=0; SELECT lyraseo_report.${call};`,
          "lyraseo_artifact_maintenance",
          /REPORT_IDENTIFIER_RESOURCE_LIMIT/,
        );
        assert(Date.now() - started < 2000);
        await blocked.done;
        assert.equal(blocked.error, "");
      }
      assert.equal(
        targetBefore,
        sql(
          db,
          `SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') FROM "EvidenceReport" r WHERE id='resource-2'`,
        ),
      );
      assert.equal(
        sql(db, "SELECT count(*) FROM lyraseo_report.decision"),
        "0",
      );
      for (const call of [
        `inspect_key('w','resource','${tooLargeKey}',false)`,
        `withdraw_key('w','resource','${tooLargeKey}','{}','Oversized identifier stays blocked',false)`,
      ])
        sql(
          db,
          "SET statement_timeout=0; SELECT lyraseo_report." + call,
          "lyraseo_artifact_maintenance",
          /REPORT_CLASSIFICATION_BLOCKED_RESOURCE_LIMIT/,
        );
      console.log(
        "PASS both wrappers enforce internal lock timeout without caller timeout, reject over-envelope ID and preserve original/receipts",
      );
      // A waiting withdrawal must reauthorize after the site lock is acquired.
      const revoker = asynchronousSql(
        db,
        `BEGIN; SET application_name='r3_holder'; SELECT id FROM "Site" WHERE id='resource' FOR UPDATE; DELETE FROM lyraseo_report.environment WHERE site_id='resource'; SELECT 'R3_REVOKING'; SELECT pg_sleep(0.8); COMMIT;`,
      );
      await ready(revoker, "R3_REVOKING");
      const revokedCall = asynchronousSql(
        db,
        `SET application_name='r3_postwait'; SET statement_timeout=0; SELECT lyraseo_report.withdraw_key('w','resource','${key2}','{}','Post-wait enrollment is mandatory',false);`,
        "lyraseo_artifact_maintenance",
      );
      let waited = false;
      for (let i = 0; i < 8; i++) {
        if (
          sql(
            db,
            `SELECT count(*) FROM pg_stat_activity WHERE application_name='r3_postwait' AND wait_event_type='Lock'`,
          ) === "1"
        ) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await revoker.done;
      await revokedCall.done;
      assert(waited);
      assert.match(revokedCall.error, /REPORT_UNENROLLED/);
      sql(
        db,
        `INSERT INTO lyraseo_report.environment VALUES('w','resource',(SELECT oid FROM pg_database WHERE datname=current_database()),pg_postmaster_start_time(),'lyraseo_artifact_maintenance','LEGACY_REPORT_LOCAL_V1');`,
      );
      const remover = asynchronousSql(
        db,
        `BEGIN; SELECT id FROM "Site" WHERE id='resource' FOR UPDATE; DELETE FROM "EvidenceReport" WHERE id='resource-2'; SELECT 'R3_REMOVING'; SELECT pg_sleep(0.8); COMMIT;`,
      );
      await ready(remover, "R3_REMOVING");
      const removedCall = asynchronousSql(
        db,
        `SET statement_timeout=0; SELECT lyraseo_report.withdraw_key('w','resource','${key2}','{}','Target must be re-resolved under lock',false);`,
        "lyraseo_artifact_maintenance",
      );
      await remover.done;
      await removedCall.done;
      assert.match(removedCall.error, /NOT_FOUND/);
      assert.equal(
        sql(db, "SELECT count(*) FROM lyraseo_report.decision"),
        "0",
      );
      console.log(
        "PASS post-wait enrollment revocation and target deletion reject withdrawal without receipts",
      );
      sql(db, 'DROP INDEX public."EvidenceReport_opaque_key_idx";');
      sql(
        db,
        `SELECT lyraseo_report.inspect_key('w','resource','${key2}',false);`,
        "lyraseo_artifact_maintenance",
        /REPORT_IDENTIFIER_INDEX_UNAVAILABLE/,
      );
      sql(
        db,
        `SELECT lyraseo_report.withdraw_key('w','resource','${key2}','{}','Missing index stays blocked',false);`,
        "lyraseo_artifact_maintenance",
        /REPORT_IDENTIFIER_INDEX_UNAVAILABLE/,
      );
      sql(
        db,
        'CREATE INDEX "EvidenceReport_opaque_key_idx" ON public."EvidenceReport"("workspaceId","siteId","identifierKey");',
      );
      console.log(
        "PASS missing resolver index fails closed instead of falling back to a scope scan",
      );
      const beforeResource = sql(
        db,
        `SELECT count(*)||':'||(SELECT count(*) FROM lyraseo_report.decision) FROM "EvidenceReport"`,
      );
      const beforeSettings = sql(
        db,
        `SELECT current_setting('work_mem')||':'||current_setting('temp_file_limit')`,
        "lyraseo_artifact_maintenance",
      );
      sql(
        db,
        `SET statement_timeout='10s'; SELECT lyraseo_report.inventory('w','resource');`,
        "lyraseo_artifact_maintenance",
        /REPORT_INVENTORY_RESOURCE_LIMIT/,
      );
      assert.equal(
        beforeResource,
        sql(
          db,
          `SELECT count(*)||':'||(SELECT count(*) FROM lyraseo_report.decision) FROM "EvidenceReport"`,
        ),
      );
      assert.equal(
        beforeSettings,
        sql(
          db,
          `SELECT current_setting('work_mem')||':'||current_setting('temp_file_limit')`,
          "lyraseo_artifact_maintenance",
        ),
      );
      sql(
        db,
        `SELECT lyraseo_report.membership_step(NULL,repeat('0',64),clock_timestamp()-interval '1 second');`,
        "postgres",
        /REPORT_INVENTORY_RESOURCE_LIMIT/,
      );
      console.log(
        "PASS inventory resource ceiling/budget rejects large scan without rows/receipts or persistent GUC changes",
      );
      sql(
        db,
        `INSERT INTO lyraseo_report.environment VALUES('w','s',(SELECT oid FROM pg_database WHERE datname=current_database()),pg_postmaster_start_time(),'lyraseo_artifact_maintenance','LEGACY_REPORT_LOCAL_V1');
       CREATE OR REPLACE FUNCTION lyraseo_report.id_key(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN IF current_setting('work_mem')<>'64kB' OR current_setting('temp_file_limit')<>'16MB' THEN RAISE EXCEPTION 'UNEXPECTED_INVENTORY_RESOURCE_CONFIG'; END IF; PERFORM pg_sleep(0.1); RETURN encode(sha256(convert_to(value,'UTF8')),'hex'); END $$;`,
      );
      const timeoutStarted = Date.now();
      sql(
        db,
        `SET statement_timeout='20ms'; SELECT lyraseo_report.inventory('w','s');`,
        "lyraseo_artifact_maintenance",
        /REPORT_INVENTORY_RESOURCE_LIMIT/,
      );
      assert(Date.now() - timeoutStarted < 1000);
      console.log(
        "PASS actual 64kB/16MB function resource settings and caller timeout interrupt slow processing within one second",
      );
      sql(
        db,
        `CREATE OR REPLACE FUNCTION lyraseo_report.id_key(value text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT repeat('0',64) $$;
    INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,"evidenceFormat",snapshot,pdf,csv) VALUES('other','w','s','Collision fixture','saved-evidence-v2','{}',convert_to('bytes','UTF8'),'csv'),('other-two','w','s','Second collision fixture','saved-evidence-v2','{}',convert_to('bytes','UTF8'),'csv');`,
      );
      for (const call of [
        "inspect_key('w','s',repeat('0',64),false)",
        "withdraw_key('w','s',repeat('0',64),'{}','Collision fixture must fail closed',false)",
      ])
        sql(
          db,
          "SELECT lyraseo_report." + call,
          "lyraseo_artifact_maintenance",
          /REPORT_IDENTIFIER_COLLISION/,
        );
      assert.equal(
        sql(db, "SELECT count(*) FROM lyraseo_report.decision"),
        "0",
      );
      console.log(
        "PASS controlled digest collision denies inspection and withdrawal with no receipt",
      );
    }
  }
  sql("postgres", "CREATE DATABASE history_prefix TEMPLATE template0;");
  for (const name of migrations.slice(0, 20))
    sql(
      "history_prefix",
      readFileSync(migrationRoot + name + "/migration.sql", "utf8"),
    );
  sql(
    "history_prefix",
    'GRANT SELECT(snapshot,pdf,csv) ON "EvidenceReport" TO lyraseo_runtime; GRANT SELECT(pdf) ON "EvidenceReport" TO PUBLIC;',
  );
  sql("history_prefix", fullHistory);
  for (const column of ["snapshot", "pdf", "csv"])
    assert.equal(
      sql(
        "history_prefix",
        `SELECT has_column_privilege('lyraseo_runtime','public."EvidenceReport"','${column}','SELECT')`,
      ),
      "f",
    );
  console.log(
    "PASS complete historical bootstrap executes against intended pre-evidenceFormat migration prefix20",
  );
} finally {
  if (started) exec(["pg_ctl", "-D", data, "-m", "fast", "-w", "stop"]);
  exec(["rm", "-rf", owned]);
}
