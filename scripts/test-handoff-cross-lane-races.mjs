import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { Client } = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
)("pg");
const database = process.env.LYRA_HANDOFF_DISPATCH_DB;
if (
  !/^lyraseo_handoff_[a-f0-9]{12}$/.test(database ?? "") ||
  process.env.LYRA_HANDOFF_OWNED_DB !== database
)
  throw Error("DISPOSABLE_DB_REQUIRED");
async function connect(user, password) {
  const c = new Client({
    host: "127.0.0.1",
    port: 54329,
    database,
    user,
    password,
  });
  await c.connect();
  return c;
}
const admin = await connect("postgres", "lyraseo_local_only");
const op = await connect("lyraseo_operator", "local_operator_only");
const recoveryClient = await connect("lyraseo_dispatch", "local_dispatch_only");
const auditClient = await connect("postgres", "lyraseo_local_only");
const suffix = randomUUID().slice(0, 8);
async function createWorkspace(label) {
  const w = `cross-${suffix}-${label}`,
    s = `${w}-site`,
    u = `${w}-user`;
  await admin.query('INSERT INTO public."ProductUser"(id) VALUES($1)', [u]);
  await admin.query(
    `INSERT INTO public."Workspace"(id,name) VALUES($1,'Cross lane')`,
    [w],
  );
  await admin.query(
    `INSERT INTO public."Site"(id,"workspaceId",origin,"verifiedAt") VALUES($1,$2,'https://example.com',now())`,
    [s, w],
  );
  await admin.query(
    `INSERT INTO public."Membership"("workspaceId","userId",role) VALUES($1,$2,'OWNER')`,
    [w, u],
  );
  return { w, s, u };
}
async function addHandoff(scope, offset) {
  const d = randomUUID(),
    i = randomUUID(),
    event = randomUUID(),
    body = JSON.stringify({ id: event, type: "test" });
  await admin.query(
    `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,status,created_by)
    VALUES($1,$2,$3,'WEBHOOK','https://example.com/hook','cipher','CONFIGURED',$4)`,
    [d, scope.w, scope.s, scope.u],
  );
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url)
    VALUES($1,$2,$3,$4,1,'WEBHOOK',$5,0,$6,repeat('a',64),'FIXTURE','test',$7,$8,encode(sha256(convert_to($8,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
    [i, scope.w, scope.s, d, scope.u, randomUUID(), event, body],
  );
  await admin.query(
    `UPDATE lyraseo_handoff.dispatch SET state='DELIVERED',delivered_at=now(),next_due=now()-make_interval(secs=>$2) WHERE intent_id=$1`,
    [i, offset],
  );
}
async function addAudit(scope) {
  const auditId = `audit-${randomUUID()}`,
    dispatchId = randomUUID();
  await admin.query(
    `INSERT INTO public."AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion")
    VALUES($1,$2,$3,$4,0,$5,'fixture','["https://example.com/"]','CONTROLLED_RAW_TEST_V1','{}','readiness-v2')`,
    [auditId, scope.w, scope.s, scope.u, randomUUID()],
  );
  await admin.query(
    `INSERT INTO public."WorkDispatch"(id,"workspaceId","siteId","userId","admittedSecurityVersion","targetKind","auditId",capability,profile,eligibility,"admittedAt","expiresAt",disposition,"nextAttemptAt","deliveredAt")
    SELECT $1,"workspaceId","siteId","userId","securityVersion",'AUDIT_RAW',id,'audits',profile,'CONTROLLED_TEST',"createdAt" AT TIME ZONE 'UTC',("createdAt" AT TIME ZONE 'UTC')+interval '1 hour','DELIVERED',clock_timestamp()-interval '10 seconds',clock_timestamp() FROM public."AuditRun" WHERE id=$2`,
    [dispatchId, auditId],
  );
  return dispatchId;
}
async function waitForLock(pid) {
  for (let n = 0; n < 200; n++) {
    if (
      (
        await admin.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [pid],
        )
      ).rows[0]?.wait_event_type === "Lock"
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("expected blocked recovery did not reach its barrier");
}
let scenarioNumber = 0;
async function scenario(multi, retire = false) {
  const tag = `${++scenarioNumber}-${retire ? "retire" : "audit"}`;
  const first = await createWorkspace(`${tag}-first`);
  const target = multi ? await createWorkspace(`${tag}-target`) : first;
  if (multi) await addHandoff(first, 30);
  await addHandoff(target, 20);
  const work = await addAudit(target);
  const recoveryPid = (
    await recoveryClient.query("SELECT pg_backend_pid() AS pid")
  ).rows[0].pid;
  await auditClient.query("BEGIN");
  await auditClient.query("SET LOCAL deadlock_timeout='100ms'");
  await auditClient.query("SET LOCAL statement_timeout='5s'");
  await auditClient.query(
    'SELECT id FROM public."Workspace" WHERE id=$1 FOR UPDATE',
    [target.w],
  );
  if (!retire)
    await auditClient.query("SET LOCAL SESSION AUTHORIZATION lyraseo_dispatch");
  const issued = new Date(),
    expires = new Date(Date.now() + 59000);
  const recover = recoveryClient
    .query(
      `SELECT lyraseo_kernel.command($1,'lyraseo-kernel-a','/api/internal/runtime/recover',$2,$3,$4) AS v`,
      [randomUUID(), JSON.stringify({ limit: 20 }), issued, expires],
    )
    .then(
      (value) => ({ kind: "recover", value }),
      (error) => ({ kind: "recover", error }),
    );
  await waitForLock(recoveryPid);
  if (retire) {
    await auditClient.query(
      'UPDATE public."Site" SET "deletedAt"=now() WHERE id=$1',
      [target.s],
    );
    await auditClient.query("SELECT lyraseo_handoff.retire_site($1,$2)", [
      target.w,
      target.s,
    ]);
    await auditClient.query("COMMIT");
    const recovered = await recover;
    if (recovered.error) throw recovered.error;
    assert.equal(recovered.value.rows[0].v.disposition, "OK");
    assert.equal(
      (
        await admin.query(
          "SELECT status FROM lyraseo_handoff.destination WHERE (workspace_id,site_id)=($1,$2)",
          [target.w, target.s],
        )
      ).rows[0].status,
      "REVOKED",
    );
    return;
  }
  const raw = JSON.stringify({ version: 1, workId: work, generation: 1 });
  const audit = auditClient
    .query(
      `SELECT lyraseo_audit.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
      [
        randomUUID(),
        raw,
        new Date(),
        new Date(Date.now() + 59000),
        new Date(Date.now() + 40000),
      ],
    )
    .then(
      (value) => ({ kind: "audit", value }),
      (error) => ({ kind: "audit", error }),
    );
  const firstResult = await Promise.race([recover, audit]);
  if (firstResult.kind === "audit" && !firstResult.error) {
    assert.equal(firstResult.value.rows[0].v.disposition, "ADMITTED");
    await auditClient.query("COMMIT");
    const recovered = await recover;
    if (recovered.error) throw recovered.error;
    assert.equal(recovered.value.rows[0].v.disposition, "OK");
  } else {
    await auditClient.query("ROLLBACK");
    await Promise.all([recover, audit]);
    throw (
      firstResult.error ?? Error("recovery completed before the audit barrier")
    );
  }
}
try {
  const auditPolicy = (
    await admin.query(
      `SELECT enabled,revision FROM public."RuntimePolicy" WHERE key='audits'`,
    )
  ).rows[0];
  if (!auditPolicy.enabled)
    await op.query("SELECT lyraseo_kernel.change_policy('audits',$1,true)", [
      auditPolicy.revision,
    ]);
  await recoveryClient.query("SET statement_timeout='5s'");
  await scenario(false);
  await scenario(true);
  await scenario(false, true);
  await scenario(true, true);
  console.log(
    "PASS: cross-lane recovery, audit admission and retirement preserve lock order across one or multiple workspaces",
  );
} finally {
  await Promise.all([
    admin.end(),
    op.end(),
    recoveryClient.end(),
    auditClient.end(),
  ]);
}
