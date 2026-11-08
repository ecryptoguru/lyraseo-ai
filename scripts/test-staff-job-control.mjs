import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
const reviewCase = process.env.LYRA_STAFF_JOB_REVIEW_CASE;
if (
  ![
    "allocation",
    "authority",
    "rotation",
    "resolution",
    "timezone",
    "budget",
  ].includes(reviewCase)
)
  throw Error("EXPLICIT_STAFF_JOB_REVIEW_CASE_REQUIRED");
const root = "packages/db/prisma/migrations";
// The assembled migration is mandatory; a stale local snapshot must never substitute for it.
const billingMigration = readFileSync(
  `${root}/202611030011_sandbox_billing_admin/migration.sql`,
  "utf8",
);
if (!billingMigration.trim()) throw Error("EMPTY_BILLING_MIGRATION");
const jobMigration = readFileSync(
  `${root}/202611030015_staff_job_control/migration.sql`,
  "utf8",
);
if (!jobMigration.trim()) throw Error("EMPTY_STAFF_JOB_MIGRATION");
const container = "lyraseo-phase1-postgres";
function run(args, input, allowFailure = false) {
  const r = spawnSync("docker", args, { encoding: "utf8", input });
  if (r.status !== 0 && !allowFailure)
    throw Error(`${args.join(" ")}: ${r.stderr}`);
  return r;
}
const inspect = JSON.parse(run(["inspect", container]).stdout)[0];
if (
  inspect.Config.Image !== "postgres:17-alpine" ||
  inspect.HostConfig.PortBindings["5432/tcp"]?.length !== 1 ||
  inspect.HostConfig.PortBindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
  inspect.HostConfig.PortBindings["5432/tcp"][0].HostPort !== "54329" ||
  !inspect.State.Running
)
  throw Error("VALIDATED_LOCAL_POSTGRES_REQUIRED");
const db = "lyraseo_staff_jobs_" + randomBytes(8).toString("hex");
const sql = (body, user = "postgres", allowFailure = false) =>
  run(
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      user,
      "-d",
      db,
    ],
    body,
    allowFailure,
  );
run(
  [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
  ],
  `CREATE DATABASE ${db} TEMPLATE template0;`,
);
// Cleanup is limited to the random database created by this process.
process.on("exit", () => {
  const cleanup = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`, encoding: "utf8" },
  );
  if (cleanup.status !== 0)
    process.stderr.write(`Own test database cleanup failed: ${cleanup.stderr}`);
});
sql(`DO $$ DECLARE r pg_roles; BEGIN
 SELECT * INTO r FROM pg_roles WHERE rolname='lyraseo_staff_job_owner';
 IF NOT FOUND THEN CREATE ROLE lyraseo_staff_job_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 ELSIF r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
 OR EXISTS(SELECT FROM pg_database WHERE datdba=r.oid)
 THEN RAISE EXCEPTION 'UNSAFE_EXISTING_STAFF_JOB_ROLE'; END IF;
END $$;`);
for (const dir of readdirSync(root)
  .filter((x) => /^\d/.test(x) && x < "202611030015_staff_job_control")
  .sort())
  sql(readFileSync(`${root}/${dir}/migration.sql`, "utf8"));
sql(jobMigration);
console.log(`MIGRATED ${db}`);
sql(`DO $$ BEGIN
 IF pg_has_role('lyraseo_staff_executor','lyraseo_staff_job_owner','MEMBER')
 OR has_column_privilege('lyraseo_billing_owner','public."Operation"','status','UPDATE')
 OR has_column_privilege('lyraseo_billing_owner','public."BudgetPeriod"','reserved','UPDATE')
 OR has_table_privilege('lyraseo_staff_job_owner','lyraseo_billing.subscription','SELECT')
 OR has_column_privilege('lyraseo_staff_job_owner','public."Operation"','requestInput','SELECT')
 OR has_schema_privilege('lyraseo_staff_job_owner','lyraseo_billing','CREATE')
 THEN RAISE EXCEPTION 'JOB_ROLE_ISOLATION_FAILED'; END IF;
END $$;`);
if (
  sql(`SET ROLE lyraseo_staff_job_owner;`, "lyraseo_staff_executor", true)
    .status === 0
)
  throw Error("UNEXPECTED_ROLE_MEMBERSHIP");
if (
  sql(
    `SELECT lyraseo_billing.job_test_proof('staff','staffsession',0);`,
    "lyraseo_staff_executor",
    true,
  ).status === 0
)
  throw Error("UNEXPECTED_PROOF_EXECUTE");
console.log("PASS purpose-specific no-login definer and role isolation");

import assert from "node:assert/strict";
sql(`INSERT INTO "ProductUser"(id) VALUES('staff'),('sponsor');
INSERT INTO "Workspace"(id,name) VALUES('ws','fixture');
INSERT INTO "Membership"("workspaceId","userId",role) VALUES('ws','sponsor','OWNER');
INSERT INTO "Site"(id,"workspaceId",origin,"verifiedAt") VALUES('site','ws','https://fixture.invalid',now());
INSERT INTO "ProductSession" VALUES('staffsession','staff',0,now(),now()),('sponsorsession','sponsor',0,now(),now());
INSERT INTO "StaffGrant"("userId",enabled) VALUES('staff',true);
INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES('staff','jobs:manage');
INSERT INTO "BudgetPeriod"(id,"userId",period,bucket,"limit",reserved) VALUES('bc','sponsor',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'COMBINED',10,3),('ba','sponsor',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'AZURE',8,3);
INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost",status,"expiresAt","leaseUntil",fence,"attemptState") VALUES
 ('retry','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','retry','hash','v1',1,'RUNNING',now()+interval '1 hour',now()-interval '1 minute',3,'NONE'),
 ('cancel','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','cancel','hash','v1',1,'QUEUED',now()+interval '1 hour',null,0,'NONE'),
 ('uncertain','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','uncertain','hash','v1',1,'WAITING_PROVIDER',now()+interval '1 hour',now()-interval '1 minute',4,'INTENT');
`);
const now = new Date().toISOString();
const actor = `'${JSON.stringify({ userId: "staff", sessionId: "staffsession", securityVersion: 0, authenticatedAt: now, mfaVerified: true, mfaAuthenticatedAt: now, authProvider: "supabase" })}'::jsonb`;
const token = (n) => String(n).repeat(40);
const requestFor = (value) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const fences = {
  retry: 3,
  cancel: 0,
  uncertain: 4,
  race: 1,
  revoked: 1,
  livelease: 2,
  budget: 2,
  grant: 2,
  accepted: 7,
};
const issue = (name, id, t, fail = false) =>
  sql(
    `SELECT lyraseo_billing.allocate_job_request(${actor},'${requestFor(t)}'::uuid); SELECT lyraseo_billing.prepare_job_request(${actor},'jobs:${name}','${id}','${t}',${fences[id]},'Investigate reported failure','${requestFor(t)}'::uuid);`,
    "lyraseo_staff_executor",
    fail,
  );
const action = (
  name,
  id,
  t,
  fence,
  reason = "Investigate reported failure",
  fail = false,
) =>
  sql(
    `SELECT lyraseo_billing.execute_job_request(${actor},'jobs:${name}','${id}',${fence},'${reason}','${requestFor(t)}'::uuid);`,
    "lyraseo_staff_executor",
    fail,
  );
assert.match(
  issue("retry", "retry", token(1), true).stderr,
  /ISSUER_REVALIDATION_UNAVAILABLE/,
);
assert.match(
  sql(
    `SELECT lyraseo_billing.staff_job_availability(${actor});`,
    "lyraseo_staff_executor",
  ).stdout,
  /"available": false/,
);
sql(`INSERT INTO lyraseo_kernel.test_environment SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database();
INSERT INTO lyraseo_billing.job_test_session SELECT oid,pg_postmaster_start_time(),'staff','staffsession',0,now()+interval '5 minutes',false FROM pg_database WHERE datname=current_database();
INSERT INTO lyraseo_billing.job_test_session SELECT oid,pg_postmaster_start_time(),'sponsor','sponsorsession',0,now()+interval '5 minutes',false FROM pg_database WHERE datname=current_database();`);
assert.match(
  sql(
    `SELECT lyraseo_billing.staff_job_availability(${actor});`,
    "lyraseo_staff_executor",
  ).stdout,
  /"available": true/,
);
issue("retry", "retry", token(1));
assert.match(
  action("retry", "retry", token(1), 3).stdout,
  /"status": "QUEUED"/,
);
assert.match(
  action("retry", "retry", token(1), 3).stdout,
  /"status": "QUEUED"/,
);
assert.match(
  action("retry", "retry", token(1), 3, "Different reported failure", true)
    .stderr,
  /IDEMPOTENCY_CONFLICT/,
);
issue("cancel", "cancel", token(2));
assert.match(
  action("cancel", "cancel", token(2), 0).stdout,
  /"status": "CANCELLED"/,
);
issue("retry", "uncertain", token(3));
assert.match(
  action("retry", "uncertain", token(3), 4, undefined, true).stderr,
  /RECONCILIATION_REQUIRED/,
);
issue("cancel", "uncertain", token(4));
assert.match(
  action("cancel", "uncertain", token(4), 4).stdout,
  /"status": "RECONCILING"/,
);
const balances = sql(
  `SELECT bucket,reserved FROM "BudgetPeriod" ORDER BY bucket; SELECT id,status,fence,"attemptState" FROM "Operation" ORDER BY id; SELECT count(*) FROM lyraseo_billing.staff_receipt WHERE action LIKE 'jobs:%' AND outcome='ALLOWED';`,
).stdout;
assert.match(balances, /AZURE\s+\|\s+2\.000000000/);
assert.match(balances, /COMBINED\s+\|\s+2\.000000000/);
assert.match(balances, /uncertain\s+\| RECONCILING\s+\|\s+4\s+\| INTENT/);
assert.match(balances, /\n\s*3\n/);
assert.notEqual(
  sql(
    `SELECT lyraseo_billing.execute_job_request(${actor},'jobs:retry','retry',3,'Investigate reported failure','${requestFor(token(1))}'::uuid);`,
    "lyraseo_runtime",
    true,
  ).status,
  0,
);
sql(
  `UPDATE lyraseo_billing.job_test_session SET revoked=true WHERE user_id='staff';`,
);
assert.match(
  action("retry", "retry", token(1), 3, undefined, true).stderr,
  /ISSUER_REVALIDATION_UNAVAILABLE/,
);
console.log(
  "PASS restricted logins, disabled issuer, target retry, replay conflict, cancellation, uncertain charge preservation, revocation",
);
// Hold a target lock so the test controls ordering across real login sessions.
const { spawn } = await import("node:child_process");
const { once } = await import("node:events");
function openPsql(user = "postgres") {
  const child = spawn(
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
      user,
      "-d",
      db,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  let out = "",
    err = "";
  child.stdout.on("data", (x) => (out += x));
  child.stderr.on("data", (x) => (err += x));
  return {
    child,
    closed,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("LOCK_TEST_TIMEOUT");
    await new Promise((r) => setTimeout(r, 25));
  }
}
function command(p, text) {
  p.child.stdin.write(text + "\n");
}
async function finish(p) {
  if (!p.child.stdin.destroyed) p.child.stdin.end();
  const [code] = await p.closed;
  return { code, out: p.out, err: p.err };
}
sql(`UPDATE lyraseo_billing.job_test_session SET revoked=false WHERE user_id='staff';
UPDATE "BudgetPeriod" SET reserved=reserved+2 WHERE "userId"='sponsor';
INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost",status,"expiresAt","leaseUntil",fence) VALUES
 ('race','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','race','hash','v1',1,'RUNNING',now()+interval '1 hour',now()-interval '1 minute',1),
 ('revoked','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','revoked','hash','v1',1,'RUNNING',now()+interval '1 hour',now()-interval '1 minute',1);`);
issue("retry", "race", token(5));
let holder = openPsql();
command(
  holder,
  `BEGIN; SELECT id FROM public."Operation" WHERE id='race' FOR UPDATE;`,
);
command(holder, "\\echo LOCK_READY");
await until(() => holder.out.includes("LOCK_READY"));
const raceQuery = `SELECT lyraseo_billing.execute_job_request(${actor},'jobs:retry','race',1,'Investigate reported failure','${requestFor(token(5))}'::uuid);`;
const first = openPsql("lyraseo_staff_executor"),
  second = openPsql("lyraseo_staff_executor");
command(first, raceQuery);
command(second, raceQuery);
await until(
  () =>
    Number(
      sql(
        `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
      ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
    ) >= 2,
);
command(holder, "COMMIT;");
await finish(holder);
const [one, two] = await Promise.all([finish(first), finish(second)]);
assert.equal(one.code, 0, one.err);
assert.equal(two.code, 0, two.err);
assert.match(one.out, /QUEUED/);
assert.equal(one.out, two.out);
assert.match(
  sql(
    `SELECT count(*) FROM lyraseo_billing.staff_receipt WHERE action='jobs:retry' AND target='race' AND outcome='ALLOWED';`,
  ).stdout,
  /\n\s*1\n/,
);
issue("retry", "revoked", token(6));
holder = openPsql();
command(
  holder,
  `BEGIN; SELECT id FROM public."Operation" WHERE id='revoked' FOR UPDATE;`,
);
command(holder, "\\echo LOCK_READY");
await until(() => holder.out.includes("LOCK_READY"));
const pending = openPsql("lyraseo_staff_executor");
command(
  pending,
  `SELECT lyraseo_billing.execute_job_request(${actor},'jobs:retry','revoked',1,'Investigate reported failure','${requestFor(token(6))}'::uuid);`,
);
await until(
  () =>
    Number(
      sql(
        `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
      ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
    ) >= 1,
);
sql(
  `UPDATE lyraseo_billing.job_test_session SET revoked=true WHERE user_id='sponsor';`,
);
command(holder, "COMMIT;");
await finish(holder);
const denied = await finish(pending);
assert.notEqual(denied.code, 0);
assert.match(denied.err, /ISSUER_REVALIDATION_UNAVAILABLE/);
assert.match(
  sql(`SELECT status,fence FROM "Operation" WHERE id='revoked';`).stdout,
  /RUNNING\s+\|\s+1/,
);
console.log(
  "PASS concurrent duplicate action and sponsor proof revocation while waiting on target lock",
);
sql(`UPDATE lyraseo_billing.job_test_session SET revoked=false WHERE user_id='sponsor';
INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost",status,"expiresAt","leaseUntil",fence) VALUES
 ('livelease','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','livelease','hash','v1',1,'RUNNING',now()+interval '1 hour',now()+interval '1 minute',2),
 ('budget','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','budget','hash','v1',50,'RUNNING',now()+interval '1 hour',now()-interval '1 minute',2),
 ('grant','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','grant','hash','v1',1,'RUNNING',now()+interval '1 hour',now()-interval '1 minute',2);`);
issue("cancel", "livelease", token(7));
assert.match(
  action("cancel", "livelease", token(7), 2, undefined, true).stderr,
  /JOB_LEASE_ACTIVE/,
);
issue("retry", "budget", token(8));
assert.match(
  action("retry", "budget", token(8), 2, undefined, true).stderr,
  /BUDGET_STATE_INVALID/,
);
issue("retry", "grant", token(9));
sql(`UPDATE "StaffGrant" SET enabled=false WHERE "userId"='staff';`);
assert.match(
  action("retry", "grant", token(9), 2, undefined, true).stderr,
  /STAFF_REQUIRED/,
);
sql(`UPDATE "StaffGrant" SET enabled=true WHERE "userId"='staff';`);
assert.match(
  action("retry", "grant", token(9), 2, undefined, true).stderr,
  /STAFF_AUTHORITY_CHANGED/,
);
assert.notEqual(
  sql(
    `UPDATE lyraseo_billing.job_test_session SET revoked=false;`,
    "lyraseo_staff_executor",
    true,
  ).status,
  0,
);
assert.notEqual(
  sql(
    `UPDATE "Operation" SET status='QUEUED' WHERE id='grant';`,
    "lyraseo_staff_executor",
    true,
  ).status,
  0,
);
console.log(
  "PASS active lease, budget ceiling, staff grant revocation and restricted table writes",
);

const denial = sql(
  `SELECT lyraseo_billing.staff_job_denied(${actor},'jobs:retry','grant');`,
  "lyraseo_staff_executor",
);
assert.equal(denial.status, 0);
assert.match(
  sql(
    `SELECT count(*) FROM lyraseo_billing.staff_receipt WHERE target='grant' AND outcome='DENIED';`,
  ).stdout,
  /\n\s*1\n/,
);
console.log("PASS bounded denied-action receipt");
const requestId = "d9f64202-42a4-4f86-8644-dd3a2feb0fe1";
sql(`UPDATE "BudgetPeriod" SET reserved=reserved+1 WHERE "userId"='sponsor';
INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost",status,"expiresAt","leaseUntil",fence) VALUES ('resume','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','resume','hash','v1',1,'RUNNING',now()+interval '1 hour',now()-interval '1 minute',1);`);
const prepareRequest = (
  reason = "Investigate fixture failure",
  allowFailure = false,
) =>
  sql(
    `SELECT lyraseo_billing.prepare_job_request(${actor},'jobs:retry','resume','${token(0)}',1,'${reason}','${requestId}'::uuid);`,
    "lyraseo_staff_executor",
    allowFailure,
  );
const executeRequest = (
  reason = "Investigate fixture failure",
  allowFailure = false,
) =>
  sql(
    `SELECT lyraseo_billing.execute_job_request(${actor},'jobs:retry','resume',1,'${reason}','${requestId}'::uuid);`,
    "lyraseo_staff_executor",
    allowFailure,
  );
sql(
  `SELECT lyraseo_billing.allocate_job_request(${actor},'${requestId}'::uuid);`,
  "lyraseo_staff_executor",
);
assert.equal(prepareRequest().status, 0);
assert.equal(prepareRequest().status, 0);
const requestStatus = () =>
  sql(
    `SELECT lyraseo_billing.job_request_status(${actor},'${requestId}'::uuid);`,
    "lyraseo_staff_executor",
  ).stdout;
assert.match(requestStatus(), /"state": "PENDING"/);
assert.match(executeRequest().stdout, /"status": "QUEUED"/);
assert.match(requestStatus(), /"state": "COMPLETE"/);
sql(
  `UPDATE lyraseo_billing.step_up SET expires_at=now()-interval '1 minute' WHERE token_hash=(SELECT token_hash FROM lyraseo_billing.job_request WHERE id='${requestId}');`,
);
assert.equal(prepareRequest().status, 0);
assert.match(executeRequest().stdout, /"status": "QUEUED"/);
assert.match(
  executeRequest("Changed fixture reason", true).stderr,
  /IDEMPOTENCY_CONFLICT/,
);
assert.match(
  sql(
    `SELECT count(*) FROM lyraseo_billing.staff_receipt WHERE target='resume' AND outcome='ALLOWED';`,
  ).stdout,
  /\n\s*1\n/,
);
console.log(
  "PASS server-bound request recovery after lost response without persisting a browser token",
);
sql(`UPDATE "BudgetPeriod" SET reserved=reserved+1 WHERE "userId"='sponsor';
INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost",status,"expiresAt","leaseUntil",fence,"attemptState","providerTaskId") VALUES ('accepted','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'route','accepted','hash','v1',1,'WAITING_PROVIDER',now()+interval '1 hour',now()-interval '1 minute',7,'ACCEPTED','redacted-fixture');`);
issue("retry", "accepted", token("x"));
assert.match(
  action("retry", "accepted", token("x"), 7, undefined, true).stderr,
  /RECONCILIATION_REQUIRED/,
);
const beforeAccepted = sql(
  `SELECT bucket,reserved FROM "BudgetPeriod" ORDER BY bucket;`,
).stdout;
issue("cancel", "accepted", token("y"));
assert.match(
  action("cancel", "accepted", token("y"), 7).stdout,
  /"status": "RECONCILING"/,
);
assert.equal(
  sql(`SELECT bucket,reserved FROM "BudgetPeriod" ORDER BY bucket;`).stdout,
  beforeAccepted,
);
assert.match(
  sql(
    `SELECT status,fence,"attemptState","providerTaskId" FROM "Operation" WHERE id='accepted';`,
  ).stdout,
  /RECONCILING\s+\|\s+7\s+\| ACCEPTED\s+\| redacted-fixture/,
);
console.log(
  "PASS accepted provider attempt never retries and retains the reservation, task reference and fence",
);
// Review regressions use the same owned database and genuine restricted login.
function reviewPrepare(name, id, fence, value) {
  return sql(
    `SELECT lyraseo_billing.allocate_job_request(${actor},'${requestFor(token(value))}'::uuid); SELECT lyraseo_billing.prepare_job_request(${actor},'jobs:${name}','${id}','${token(value)}',${fence},'Review fixture reason','${requestFor(token(value))}'::uuid);`,
    "lyraseo_staff_executor",
  );
}
function reviewExecute(name, id, fence, value, zone = "UTC") {
  return sql(
    `SET TIME ZONE '${zone}'; SELECT lyraseo_billing.execute_job_request(${actor},'jobs:${name}','${id}',${fence},'Review fixture reason','${requestFor(token(value))}'::uuid);`,
    "lyraseo_staff_executor",
    true,
  );
}
function reviewOperation(
  id,
  lease,
  expiry,
  attempt = "NONE",
  status = "RUNNING",
  providerTask = null,
) {
  sql(`UPDATE "BudgetPeriod" SET reserved=reserved+1 WHERE "userId"='sponsor';
  INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost",status,"expiresAt","leaseUntil",fence,"attemptState","providerTaskId") VALUES ('${id}','ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'review','${id}','hash','v1',1,'${status}',(clock_timestamp() AT TIME ZONE 'UTC')+interval '${expiry}',(clock_timestamp() AT TIME ZONE 'UTC')+interval '${lease}',2,'${attempt}',${providerTask ? `'${providerTask}'` : "NULL"});`);
}
if (reviewCase === "timezone") {
  sql(`DELETE FROM lyraseo_billing.staff_rate WHERE user_id='staff';`);
  sql(`UPDATE "BudgetPeriod" SET "limit"=100 WHERE "userId"='sponsor';`);
  reviewOperation("tzlive", "5 minutes", "12 hours");
  reviewPrepare("retry", "tzlive", 2, "z");
  const live = reviewExecute("retry", "tzlive", 2, "z", "Asia/Kolkata");
  assert.notEqual(
    live.status,
    0,
    "UTC-stored live lease must never be retried in Asia/Kolkata",
  );
  assert.match(live.stderr, /JOB_NOT_RETRYABLE/);
  reviewOperation("tzexpiry", "-12 hours", "-1 minute");
  reviewPrepare("retry", "tzexpiry", 2, "w");
  const expired = reviewExecute(
    "retry",
    "tzexpiry",
    2,
    "w",
    "America/Los_Angeles",
  );
  assert.notEqual(
    expired.status,
    0,
    "UTC-stored expired operation must never retry in America/Los_Angeles",
  );
  assert.match(expired.stderr, /JOB_NOT_RETRYABLE/);
  reviewOperation("tzcancel-live", "5 minutes", "12 hours");
  reviewPrepare("cancel", "tzcancel-live", 2, "a");
  assert.match(
    reviewExecute("cancel", "tzcancel-live", 2, "a", "Asia/Kolkata").stderr,
    /JOB_LEASE_ACTIVE/,
  );
  reviewOperation("tzexpired-lease", "-2 minutes", "12 hours");
  reviewPrepare("retry", "tzexpired-lease", 2, "b");
  assert.match(
    reviewExecute("retry", "tzexpired-lease", 2, "b", "America/Los_Angeles")
      .stdout,
    /"status": "QUEUED"/,
  );
  reviewOperation("tzfresh-session", "-12 hours", "12 hours");
  sql(
    `UPDATE "ProductSession" SET "createdAt"=(clock_timestamp() AT TIME ZONE 'UTC')-interval '29 days 23 hours',"refreshedAt"=(clock_timestamp() AT TIME ZONE 'UTC')-interval '6 days 23 hours' WHERE "sessionId"='sponsorsession';`,
  );
  reviewPrepare("retry", "tzfresh-session", 2, "c");
  assert.match(
    reviewExecute("retry", "tzfresh-session", 2, "c", "Asia/Kolkata").stdout,
    /"status": "QUEUED"/,
  );
  reviewOperation("tzstale-session", "-12 hours", "12 hours");
  sql(
    `UPDATE "ProductSession" SET "refreshedAt"=(clock_timestamp() AT TIME ZONE 'UTC')-interval '7 days 1 hour' WHERE "sessionId"='sponsorsession';`,
  );
  reviewPrepare("retry", "tzstale-session", 2, "d");
  assert.match(
    reviewExecute("retry", "tzstale-session", 2, "d", "America/Los_Angeles")
      .stderr,
    /SPONSOR_AUTHORITY_CHANGED/,
  );
  sql(
    `UPDATE "ProductSession" SET "createdAt"=(clock_timestamp() AT TIME ZONE 'UTC')-interval '30 days 1 hour',"refreshedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "sessionId"='sponsorsession';`,
  );
  reviewOperation("tzstale-created", "-12 hours", "12 hours");
  reviewPrepare("retry", "tzstale-created", 2, "e");
  assert.match(
    reviewExecute("retry", "tzstale-created", 2, "e", "America/Los_Angeles")
      .stderr,
    /SPONSOR_AUTHORITY_CHANGED/,
  );
  sql(
    `UPDATE "ProductSession" SET "createdAt"=clock_timestamp() AT TIME ZONE 'UTC',"refreshedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "sessionId"='sponsorsession';`,
  );
  reviewOperation(
    "tzaccepted",
    "-1 minute",
    "12 hours",
    "ACCEPTED",
    "WAITING_PROVIDER",
    "fixture-provider-task",
  );
  const before = sql(
    `SELECT bucket,reserved FROM "BudgetPeriod" ORDER BY bucket;`,
  ).stdout;
  reviewPrepare("cancel", "tzaccepted", 2, "f");
  assert.match(
    reviewExecute("cancel", "tzaccepted", 2, "f", "Asia/Kolkata").stdout,
    /"status": "RECONCILING"/,
  );
  assert.equal(
    sql(`SELECT bucket,reserved FROM "BudgetPeriod" ORDER BY bucket;`).stdout,
    before,
  );
  assert.match(
    sql(
      `SELECT (abs(extract(epoch FROM (("cancelRequestedAt" AT TIME ZONE 'UTC')-clock_timestamp())))<10)::text FROM "Operation" WHERE id='tzaccepted';`,
    ).stdout,
    /true/,
  );
  reviewOperation("tzunattempted", "-1 minute", "12 hours");
  reviewPrepare("cancel", "tzunattempted", 2, "g");
  assert.match(
    reviewExecute("cancel", "tzunattempted", 2, "g", "America/Los_Angeles")
      .stdout,
    /"status": "CANCELLED"/,
  );
  assert.match(
    sql(
      `SELECT (abs(extract(epoch FROM (("cancelRequestedAt" AT TIME ZONE 'UTC')-clock_timestamp())))<10 AND abs(extract(epoch FROM (("settledAt" AT TIME ZONE 'UTC')-clock_timestamp())))<10)::text FROM "Operation" WHERE id='tzunattempted';`,
    ).stdout,
    /true/,
  );
  console.log(
    "PASS active and expired leases, operation expiry, session freshness and UTC assignment in non-UTC sessions; accepted exposure preserved",
  );
}
if (reviewCase === "budget") {
  reviewOperation("overlimit", "-2 minutes", "1 hour");
  sql(
    `UPDATE "BudgetPeriod" SET "limit"=0.5,spent=3 WHERE "userId"='sponsor';`,
  );
  reviewPrepare("cancel", "overlimit", 2, "v");
  const released = reviewExecute("cancel", "overlimit", 2, "v");
  assert.equal(
    released.status,
    0,
    `Fully backed cancellation must work above a reduced ceiling: ${released.stderr}`,
  );
  assert.match(released.stdout, /"status": "CANCELLED"/);
  const after = sql(
    `SELECT bucket,reserved FROM "BudgetPeriod" ORDER BY bucket;`,
  ).stdout;
  assert.match(
    reviewExecute("cancel", "overlimit", 2, "v").stdout,
    /"status": "CANCELLED"/,
  );
  assert.equal(
    sql(`SELECT bucket,reserved FROM "BudgetPeriod" ORDER BY bucket;`).stdout,
    after,
  );
  reviewOperation("overlimit-retry", "-2 minutes", "1 hour");
  reviewPrepare("retry", "overlimit-retry", 2, "h");
  assert.match(
    reviewExecute("retry", "overlimit-retry", 2, "h").stderr,
    /BUDGET_STATE_INVALID/,
  );
  reviewOperation(
    "settle-race",
    "-2 minutes",
    "1 hour",
    "ACCEPTED",
    "WAITING_PROVIDER",
    "fixture-provider-task",
  );
  reviewPrepare("cancel", "settle-race", 2, "i");
  reviewOperation("cancel-race", "-2 minutes", "1 hour");
  reviewPrepare("cancel", "cancel-race", 2, "m");
  sql(
    `GRANT USAGE ON SCHEMA public TO lyraseo_runtime; GRANT SELECT ON public."ProductUser" TO lyraseo_runtime; GRANT SELECT,UPDATE ON public."Operation" TO lyraseo_runtime; GRANT SELECT,INSERT,UPDATE ON public."BudgetPeriod" TO lyraseo_runtime; GRANT SELECT,INSERT ON public."UsageReceipt" TO lyraseo_runtime;`,
  );
  const settlement = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "tests/staff-job/settlement.test.ts"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LYRA_STAFF_JOB_DB: db,
        LYRA_STAFF_JOB_REQUEST_ID: requestFor(token("i")),
        LYRA_STAFF_JOB_CANCEL_REQUEST_ID: requestFor(token("m")),
      },
    },
  );
  if (settlement.status !== 0)
    throw Error(
      `Actual settlement race failed: ${settlement.stdout} ${settlement.stderr}`,
    );
  process.stdout.write(settlement.stdout);
  console.log(
    "PASS over-limit cancellation, replay, blocked retry and concurrent actual receipt settlement",
  );
}
if (reviewCase === "resolution") {
  const id = requestFor(token("u"));
  assert.match(
    sql(
      `SELECT lyraseo_billing.resolve_job_request(${actor},'${id}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /REQUEST_NOT_ALLOCATED/,
  );
  sql(
    `SELECT lyraseo_billing.allocate_job_request(${actor},'${id}'::uuid);`,
    "lyraseo_staff_executor",
  );
  const resolved = sql(
    `SELECT lyraseo_billing.resolve_job_request(${actor},'${id}'::uuid);`,
    "lyraseo_staff_executor",
    true,
  );
  assert.equal(
    resolved.status,
    0,
    `An absent request must have a serialized safe resolution: ${resolved.stderr}`,
  );
  assert.match(resolved.stdout, /"state": "CLOSED"/);
  assert.match(
    sql(
      `SELECT lyraseo_billing.prepare_job_request(${actor},'jobs:retry','late','${token("u")}',1,'Review fixture reason','${id}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /REQUEST_CLOSED/,
  );
  reviewOperation("conflict", "-2 minutes", "1 hour");
  reviewPrepare("retry", "conflict", 2, "j");
  sql(`UPDATE "Operation" SET fence=3 WHERE id='conflict';`);
  assert.match(
    reviewExecute("retry", "conflict", 2, "j").stderr,
    /JOB_CONFLICT/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.resolve_job_request(${actor},'${requestFor(token("j"))}'::uuid);`,
      "lyraseo_staff_executor",
    ).stdout,
    /"state": "CLOSED"/,
  );
  assert.match(
    reviewExecute("retry", "conflict", 2, "j").stderr,
    /REQUEST_CLOSED/,
  );
  reviewOperation("terminal", "-2 minutes", "1 hour");
  reviewPrepare("retry", "terminal", 2, "k");
  sql(`UPDATE "Operation" SET status='COMPLETED' WHERE id='terminal';`);
  assert.match(
    reviewExecute("retry", "terminal", 2, "k").stderr,
    /JOB_TERMINAL/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.resolve_job_request(${actor},'${requestFor(token("k"))}'::uuid);`,
      "lyraseo_staff_executor",
    ).stdout,
    /"state": "CLOSED"/,
  );
  sql(`UPDATE "BudgetPeriod" SET "limit"=100 WHERE "userId"='sponsor';`);
  reviewOperation("resolve-race", "-2 minutes", "1 hour");
  reviewPrepare("retry", "resolve-race", 2, "l");
  let gate = openPsql();
  command(
    gate,
    `BEGIN; SELECT id FROM public."Operation" WHERE id='resolve-race' FOR UPDATE;`,
  );
  command(gate, "\\echo LOCK_READY");
  await until(() => gate.out.includes("LOCK_READY"));
  const running = openPsql("lyraseo_staff_executor");
  command(
    running,
    `SELECT lyraseo_billing.execute_job_request(${actor},'jobs:retry','resolve-race',2,'Review fixture reason','${requestFor(token("l"))}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 1,
  );
  const closer = openPsql("lyraseo_staff_executor");
  command(
    closer,
    `SELECT lyraseo_billing.resolve_job_request(${actor},'${requestFor(token("l"))}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 2,
  );
  command(gate, "COMMIT;");
  await finish(gate);
  const [completed, resolution] = await Promise.all([
    finish(running),
    finish(closer),
  ]);
  assert.equal(completed.code, 0, completed.err);
  assert.match(resolution.out, /"state": "COMPLETE"/);
  assert.match(resolution.out, /"status": "QUEUED"/);
  reviewOperation("resolve-first", "-2 minutes", "1 hour");
  reviewPrepare("retry", "resolve-first", 2, "n");
  gate = openPsql();
  command(
    gate,
    `BEGIN; SELECT id FROM lyraseo_billing.job_request WHERE id='${requestFor(token("n"))}'::uuid FOR UPDATE;`,
  );
  command(gate, "\\echo LOCK_READY");
  await until(() => gate.out.includes("LOCK_READY"));
  const firstCloser = openPsql("lyraseo_staff_executor");
  command(
    firstCloser,
    `SELECT lyraseo_billing.resolve_job_request(${actor},'${requestFor(token("n"))}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 1,
  );
  const lateExecutor = openPsql("lyraseo_staff_executor");
  command(
    lateExecutor,
    `SELECT lyraseo_billing.execute_job_request(${actor},'jobs:retry','resolve-first',2,'Review fixture reason','${requestFor(token("n"))}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 2,
  );
  command(gate, "COMMIT;");
  await finish(gate);
  const [closed, deniedLate] = await Promise.all([
    finish(firstCloser),
    finish(lateExecutor),
  ]);
  assert.match(closed.out, /"state": "CLOSED"/);
  assert.notEqual(deniedLate.code, 0);
  assert.match(deniedLate.err, /REQUEST_CLOSED/);
  assert.match(
    sql(`SELECT status,fence FROM "Operation" WHERE id='resolve-first';`)
      .stdout,
    /RUNNING\s+\|\s+2/,
  );
  sql(`DELETE FROM lyraseo_billing.staff_rate WHERE user_id='staff';`);
  const api = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "tests/staff-job/api.test.ts"],
    { encoding: "utf8", env: { ...process.env, LYRA_STAFF_JOB_DB: db } },
  );
  if (api.status !== 0)
    throw Error(
      `Actual API/database recovery failed: ${api.stdout} ${api.stderr}`,
    );
  process.stdout.write(api.stdout);
  sql(`DELETE FROM lyraseo_billing.staff_rate WHERE user_id='staff';`);
  const ui = spawnSync("node", ["scripts/verify-staff-job-integrated.mjs"], {
    encoding: "utf8",
    env: { ...process.env, LYRA_STAFF_JOB_DB: db },
  });
  if (ui.status !== 0)
    throw Error(
      `Integrated console/API/database verification failed: ${ui.stdout} ${ui.stderr}`,
    );
  process.stdout.write(ui.stdout);
  console.log(
    "PASS absent, stale fence, terminal and overlapping execution resolution",
  );
}
if (reviewCase === "authority") {
  sql(
    `DELETE FROM lyraseo_billing.staff_rate WHERE user_id='staff'; UPDATE "BudgetPeriod" SET "limit"=100 WHERE "userId"='sponsor';`,
  );
  reviewOperation("authority-completed", "-2 minutes", "1 hour");
  reviewPrepare("retry", "authority-completed", 2, "p");
  assert.match(
    reviewExecute("retry", "authority-completed", 2, "p").stdout,
    /"status": "QUEUED"/,
  );
  sql(
    `UPDATE lyraseo_billing.staff_capability SET enabled=false WHERE user_id='staff' AND action='jobs:manage';`,
  );
  const revoked = sql(
    `SELECT lyraseo_billing.resolve_job_request(${actor},'${requestFor(token("p"))}'::uuid);`,
    "lyraseo_staff_executor",
    true,
  );
  assert.notEqual(
    revoked.status,
    0,
    "A revoked named capability must not read completed request details",
  );
  assert.match(revoked.stderr, /STAFF_ACTION_FORBIDDEN/);
  sql(
    `UPDATE lyraseo_billing.staff_capability SET enabled=true WHERE user_id='staff' AND action='jobs:manage';`,
  );
  const gate = openPsql();
  command(
    gate,
    `BEGIN; SELECT user_id FROM lyraseo_billing.staff_capability WHERE user_id='staff' AND action='jobs:manage' FOR UPDATE;`,
  );
  command(gate, "\\echo LOCK_READY");
  await until(() => gate.out.includes("LOCK_READY"));
  const waiting = openPsql("lyraseo_staff_executor");
  command(
    waiting,
    `SELECT lyraseo_billing.resolve_job_request(${actor},'${requestFor(token("p"))}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 1,
  );
  command(
    gate,
    `UPDATE lyraseo_billing.staff_capability SET enabled=false WHERE user_id='staff' AND action='jobs:manage'; COMMIT;`,
  );
  await finish(gate);
  const deniedAfterWait = await finish(waiting);
  assert.notEqual(deniedAfterWait.code, 0);
  assert.match(deniedAfterWait.err, /STAFF_ACTION_FORBIDDEN/);
  sql(
    `UPDATE lyraseo_billing.staff_capability SET enabled=true WHERE user_id='staff' AND action='jobs:manage';`,
  );
  const requestId = requestFor(token("p"));
  const requestGate = openPsql();
  command(
    requestGate,
    `BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('staff-job-request:${requestId}',0));`,
  );
  command(requestGate, "\\echo LOCK_READY");
  await until(() => requestGate.out.includes("LOCK_READY"));
  const priorResolver = openPsql("lyraseo_staff_executor");
  command(
    priorResolver,
    `SELECT lyraseo_billing.resolve_job_request(${actor},'${requestId}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 1,
  );
  const laterRevocation = openPsql();
  command(
    laterRevocation,
    `UPDATE lyraseo_billing.staff_capability SET enabled=false WHERE user_id='staff' AND action='jobs:manage';`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='postgres' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 1,
  );
  command(requestGate, "COMMIT;");
  await finish(requestGate);
  const [prior, later] = await Promise.all([
    finish(priorResolver),
    finish(laterRevocation),
  ]);
  assert.equal(prior.code, 0, prior.err);
  assert.match(prior.out, /"state": "COMPLETE"/);
  assert.equal(later.code, 0, later.err);
  assert.match(
    sql(
      `SELECT lyraseo_billing.resolve_job_request(${actor},'${requestId}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /STAFF_ACTION_FORBIDDEN/,
  );
  console.log(
    "PASS revoked named permission denies result before and during lock wait; prior authorized resolution serializes before revocation",
  );
}
if (reviewCase === "rotation") {
  sql(`DELETE FROM lyraseo_billing.staff_rate WHERE user_id='staff'; UPDATE "BudgetPeriod" SET "limit"=100 WHERE "userId"='sponsor';
  INSERT INTO "ProductUser"(id) VALUES('staff2');
  INSERT INTO "ProductSession" VALUES('otherstaffsession','staff2',0,now(),now());
  INSERT INTO "StaffGrant"("userId",enabled) VALUES('staff2',true);
  INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES('staff2','jobs:manage');
  INSERT INTO lyraseo_billing.job_test_session SELECT oid,pg_postmaster_start_time(),'staff2','otherstaffsession',0,now()+interval '5 minutes',false FROM pg_database WHERE datname=current_database();`);
  reviewOperation("rotation-complete", "-2 minutes", "1 hour");
  reviewPrepare("retry", "rotation-complete", 2, "q");
  assert.match(
    reviewExecute("retry", "rotation-complete", 2, "q").stdout,
    /"status": "QUEUED"/,
  );
  reviewOperation("rotation-pending", "-2 minutes", "1 hour");
  reviewPrepare("retry", "rotation-pending", 2, "r");
  sql(
    `SELECT lyraseo_billing.allocate_job_request(${actor},'${requestFor(token("s"))}'::uuid);`,
    "lyraseo_staff_executor",
  );
  sql(`UPDATE "ProductUser" SET "securityVersion"=1 WHERE id='staff';
  UPDATE lyraseo_billing.job_test_session SET revoked=true WHERE user_id='staff' AND session_id='staffsession';
  INSERT INTO "ProductSession" VALUES('newstaffsession','staff',1,now(),now());
  INSERT INTO lyraseo_billing.job_test_session SELECT oid,pg_postmaster_start_time(),'staff','newstaffsession',1,now()+interval '5 minutes',false FROM pg_database WHERE datname=current_database();`);
  const now2 = new Date().toISOString();
  const current = (userId, sessionId, securityVersion) =>
    `'${JSON.stringify({ userId, sessionId, securityVersion, authenticatedAt: now2, mfaVerified: true, mfaAuthenticatedAt: now2, authProvider: "supabase" })}'::jsonb`;
  const rotated = current("staff", "newstaffsession", 1),
    other = current("staff2", "otherstaffsession", 0);
  for (const key of ["q", "r"])
    assert.match(
      sql(
        `SELECT lyraseo_billing.resolve_job_request(${other},'${requestFor(token(key))}'::uuid);`,
        "lyraseo_staff_executor",
        true,
      ).stderr,
      /FORBIDDEN/,
    );
  assert.notEqual(
    reviewExecute("retry", "rotation-pending", 2, "r").status,
    0,
    "The revoked old session must not execute",
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.execute_job_request(${rotated},'jobs:retry','rotation-pending',2,'Review fixture reason','${requestFor(token("r"))}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /IDEMPOTENCY_CONFLICT/,
  );
  const recovered = sql(
    `SELECT lyraseo_billing.resolve_job_request(${rotated},'${requestFor(token("q"))}'::uuid);`,
    "lyraseo_staff_executor",
    true,
  );
  assert.equal(
    recovered.status,
    0,
    `Same authorized staff in a new session must recover its result: ${recovered.stderr}`,
  );
  assert.match(recovered.stdout, /"state": "COMPLETE"/);
  assert.match(
    sql(
      `SELECT lyraseo_billing.job_request_status(${rotated},'${requestFor(token("q"))}'::uuid);`,
      "lyraseo_staff_executor",
    ).stdout,
    /"state": "COMPLETE"/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.resolve_job_request(${other},'${requestFor(token("s"))}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /FORBIDDEN/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.resolve_job_request(${rotated},'${requestFor(token("s"))}'::uuid);`,
      "lyraseo_staff_executor",
    ).stdout,
    /"state": "CLOSED"/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.prepare_job_request(${rotated},'jobs:retry','rotation-pending','${token("s")}',2,'Review fixture reason','${requestFor(token("s"))}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /REQUEST_CLOSED/,
  );
  const closed = sql(
    `SELECT lyraseo_billing.resolve_job_request(${rotated},'${requestFor(token("r"))}'::uuid);`,
    "lyraseo_staff_executor",
    true,
  );
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, /"state": "CLOSED"/);
  assert.match(
    sql(
      `SELECT lyraseo_billing.job_request_status(${rotated},'${requestFor(token("r"))}'::uuid);`,
      "lyraseo_staff_executor",
    ).stdout,
    /"state": "CLOSED"/,
  );
  assert.notEqual(
    reviewExecute("retry", "rotation-pending", 2, "r").status,
    0,
    "The revoked old session stays fenced after close",
  );
  console.log(
    "PASS new session and security version recover same staff only and fence revoked old session",
  );
}
if (reviewCase === "allocation") {
  sql(`DELETE FROM lyraseo_billing.staff_rate WHERE user_id='staff';
  INSERT INTO "ProductUser"(id) VALUES('staff2');
  INSERT INTO "ProductSession" VALUES('otherstaffsession','staff2',0,now(),now());
  INSERT INTO "StaffGrant"("userId",enabled) VALUES('staff2',true);
  INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES('staff2','jobs:manage');
  INSERT INTO lyraseo_billing.job_test_session SELECT oid,pg_postmaster_start_time(),'staff2','otherstaffsession',0,now()+interval '5 minutes',false FROM pg_database WHERE datname=current_database();`);
  const now2 = new Date().toISOString();
  const other = `'${JSON.stringify({ userId: "staff2", sessionId: "otherstaffsession", securityVersion: 0, authenticatedAt: now2, mfaVerified: true, mfaAuthenticatedAt: now2, authProvider: "supabase" })}'::jsonb`;
  const id = requestFor(token("s"));
  const attempted = sql(
    `SELECT lyraseo_billing.resolve_job_request(${other},'${id}'::uuid);`,
    "lyraseo_staff_executor",
    true,
  );
  assert.notEqual(
    attempted.status,
    0,
    "A different principal must not close an absent request",
  );
  assert.match(
    sql(
      `SELECT count(*) FROM lyraseo_billing.closed_job_request WHERE id='${id}'::uuid;`,
    ).stdout,
    /\n\s*0\n/,
  );
  assert.match(attempted.stderr, /REQUEST_NOT_ALLOCATED/);
  assert.match(
    sql(
      `SELECT lyraseo_billing.prepare_job_request(${actor},'jobs:retry','foreign','${token("s")}',2,'Review fixture reason','${id}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /REQUEST_NOT_ALLOCATED/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.job_request_status(${actor},'${id}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /REQUEST_NOT_ALLOCATED/,
  );
  assert.notEqual(
    sql(
      `INSERT INTO lyraseo_billing.job_allocation(id,staff_id) VALUES('${id}'::uuid,'staff');`,
      "lyraseo_staff_executor",
      true,
    ).status,
    0,
  );
  sql(
    `SELECT lyraseo_billing.allocate_job_request(${actor},'${id}'::uuid);`,
    "lyraseo_staff_executor",
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.resolve_job_request(${other},'${id}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /FORBIDDEN/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.allocate_job_request(${other},'${id}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /FORBIDDEN/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.prepare_job_request(${other},'jobs:retry','foreign','${token("s")}',2,'Review fixture reason','${id}'::uuid);`,
      "lyraseo_staff_executor",
      true,
    ).stderr,
    /FORBIDDEN/,
  );
  reviewOperation("allocation-owned", "-2 minutes", "1 hour");
  reviewPrepare("retry", "allocation-owned", 2, "s");
  assert.match(
    reviewExecute("retry", "allocation-owned", 2, "s").stdout,
    /"status": "QUEUED"/,
  );
  assert.match(
    sql(
      `SELECT lyraseo_billing.resolve_job_request(${actor},'${id}'::uuid);`,
      "lyraseo_staff_executor",
    ).stdout,
    /"state": "COMPLETE"/,
  );
  const nextId = requestFor(token("t"));
  let gate = openPsql();
  command(
    gate,
    `BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('staff-job-request:${nextId}',0));`,
  );
  command(gate, "\\echo LOCK_READY");
  await until(() => gate.out.includes("LOCK_READY"));
  const otherResolver = openPsql("lyraseo_staff_executor");
  command(
    otherResolver,
    `SELECT lyraseo_billing.resolve_job_request(${other},'${nextId}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 1,
  );
  const originalAllocator = openPsql("lyraseo_staff_executor");
  command(
    originalAllocator,
    `SELECT lyraseo_billing.allocate_job_request(${actor},'${nextId}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 2,
  );
  command(gate, "COMMIT;");
  await finish(gate);
  const [otherResult, allocatedResult] = await Promise.all([
    finish(otherResolver),
    finish(originalAllocator),
  ]);
  assert.notEqual(otherResult.code, 0);
  assert.match(otherResult.err, /REQUEST_NOT_ALLOCATED|FORBIDDEN/);
  assert.equal(allocatedResult.code, 0, allocatedResult.err);
  assert.match(
    sql(
      `SELECT staff_id FROM lyraseo_billing.job_allocation WHERE id='${nextId}'::uuid;`,
    ).stdout,
    /staff/,
  );
  assert.match(
    sql(
      `SELECT count(*) FROM lyraseo_billing.closed_job_request WHERE id='${nextId}'::uuid;`,
    ).stdout,
    /\n\s*0\n/,
  );
  reviewOperation("allocation-delayed", "-2 minutes", "1 hour");
  reviewPrepare("retry", "allocation-delayed", 2, "t");
  assert.match(
    reviewExecute("retry", "allocation-delayed", 2, "t").stdout,
    /"status": "QUEUED"/,
  );
  sql(`UPDATE "BudgetPeriod" SET "limit"=100 WHERE "userId"='sponsor';`);
  reviewOperation("allocation-overlap", "-2 minutes", "1 hour");
  const overlapId = requestFor(token("v"));
  sql(
    `SELECT lyraseo_billing.allocate_job_request(${actor},'${overlapId}'::uuid);`,
    "lyraseo_staff_executor",
  );
  gate = openPsql();
  command(
    gate,
    `BEGIN; LOCK TABLE lyraseo_billing.job_allocation IN ACCESS EXCLUSIVE MODE;`,
  );
  command(gate, "\\echo LOCK_READY");
  await until(() => gate.out.includes("LOCK_READY"));
  const delayedPrepare = openPsql("lyraseo_staff_executor");
  command(
    delayedPrepare,
    `SELECT lyraseo_billing.prepare_job_request(${actor},'jobs:retry','allocation-overlap','${token("v")}',2,'Review fixture reason','${overlapId}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 1,
  );
  const foreignCloser = openPsql("lyraseo_staff_executor");
  command(
    foreignCloser,
    `SELECT lyraseo_billing.resolve_job_request(${other},'${overlapId}'::uuid);`,
  );
  await until(
    () =>
      Number(
        sql(
          `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock';`,
        ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1] ?? 0,
      ) >= 2,
  );
  command(gate, "COMMIT;");
  await finish(gate);
  const [prepared, foreignDenied] = await Promise.all([
    finish(delayedPrepare),
    finish(foreignCloser),
  ]);
  assert.equal(prepared.code, 0, prepared.err);
  assert.notEqual(foreignDenied.code, 0);
  assert.match(foreignDenied.err, /FORBIDDEN/);
  assert.match(
    sql(
      `SELECT count(*) FROM lyraseo_billing.closed_job_request WHERE id='${overlapId}'::uuid;`,
    ).stdout,
    /\n\s*0\n/,
  );
  assert.match(
    reviewExecute("retry", "allocation-overlap", 2, "v").stdout,
    /"status": "QUEUED"/,
  );
  console.log(
    "PASS original prepare holding request lock cannot be closed by another principal",
  );
  console.log(
    "PASS absent and allocated request ownership, cross-principal denial and delayed allocation/prepare race",
  );
}
