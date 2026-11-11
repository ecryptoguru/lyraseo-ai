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
const lockX = await connect("postgres", "lyraseo_local_only");
const lockY = await connect("postgres", "lyraseo_local_only");
const recoveryA = await connect("lyraseo_dispatch", "local_dispatch_only");
const recoveryB = await connect("lyraseo_dispatch", "local_dispatch_only");
const suffix = randomUUID().slice(0, 8),
  workspace = `overlap-${suffix}`,
  site = `overlap-site-${suffix}`,
  u1 = `overlap-${suffix}-actor1`,
  u2 = `overlap-${suffix}-actor2`;
async function blockedBy(pid) {
  return (await admin.query("SELECT pg_blocking_pids($1) AS pids", [pid]))
    .rows[0].pids;
}
async function waitFor(pid, accepted) {
  for (let n = 0; n < 300; n++) {
    const pids = await blockedBy(pid);
    if (accepted(pids)) return pids;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`recovery ${pid} did not reach the expected lock barrier`);
}
try {
  await admin.query(`INSERT INTO public."ProductUser"(id) VALUES($1),($2)`, [
    u1,
    u2,
  ]);
  await admin.query(
    `INSERT INTO public."Workspace"(id,name) VALUES($1,'Overlap')`,
    [workspace],
  );
  await admin.query(
    `INSERT INTO public."Site"(id,"workspaceId",origin,"verifiedAt") VALUES($1,$2,'https://example.com',now())`,
    [site, workspace],
  );
  await admin.query(
    `INSERT INTO public."Membership"("workspaceId","userId",role) VALUES($1,$2,'OWNER'),($1,$3,'EDITOR')`,
    [workspace, u1, u2],
  );
  await admin.query(
    `INSERT INTO public."SiteGrant"("workspaceId","siteId","userId") VALUES($1,$2,$3)`,
    [workspace, site, u2],
  );
  await admin.query(
    `INSERT INTO public."ContentDraft"(id,"workspaceId","siteId",kind,snapshot) VALUES($1,$2,$3,'draft','{}')`,
    [`draft-${suffix}`, workspace, site],
  );
  const ids = [randomUUID(), randomUUID()].sort(),
    y = ids[0],
    x = ids[1];
  await admin.query(
    `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,status,created_by) VALUES
 ($1,$3,$4,'WORDPRESS','https://example.com/blog/','cipher','CONFIGURED',$5),
 ($2,$3,$4,'WEBHOOK','https://example.com/hook','cipher','CONFIGURED',$5)`,
    [x, y, workspace, site, u1],
  );
  const intentX = randomUUID(),
    intentY2 = randomUUID(),
    intentY1 = randomUUID();
  async function add(id, dest, kind, user, age) {
    const event = randomUUID(),
      body =
        kind === "WEBHOOK"
          ? JSON.stringify({ id: event, type: "test" })
          : '{"status":"draft"}';
    await admin.query(
      `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,draft_id,event_type,event_id,body,body_hash,renderer_version,destination_url)
  VALUES($1,$2,$3,$4,1,$5,$6,0,$7,repeat('a',64),'FIXTURE',$8,$9,$10,$11,encode(sha256(convert_to($11,'UTF8')),'hex'),'fixture',$12)`,
      [
        id,
        workspace,
        site,
        dest,
        kind,
        user,
        randomUUID(),
        kind === "WORDPRESS" ? `draft-${suffix}` : null,
        kind === "WEBHOOK" ? "test" : null,
        event,
        body,
        kind === "WORDPRESS"
          ? "https://example.com/blog/wp-json/wp/v2/posts?_fields=id,status,link"
          : "https://example.com/hook",
      ],
    );
    await admin.query(
      `UPDATE lyraseo_handoff.dispatch SET state='DELIVERED',delivered_at=now(),next_due=clock_timestamp()-make_interval(secs=>$2) WHERE intent_id=$1`,
      [id, age],
    );
  }
  await add(intentX, x, "WORDPRESS", u1, 30);
  await add(intentY2, y, "WEBHOOK", u2, 20);
  await add(intentY1, y, "WEBHOOK", u1, 10);
  const [pidX, pidY, pidA, pidB] = await Promise.all(
    [lockX, lockY, recoveryA, recoveryB].map(
      async (c) =>
        (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    ),
  );
  await lockX.query("BEGIN");
  await lockX.query("SET LOCAL deadlock_timeout='100ms'");
  await lockX.query(
    "SELECT id FROM lyraseo_handoff.intent WHERE id=$1 FOR UPDATE",
    [intentX],
  );
  await lockY.query("BEGIN");
  await lockY.query("SET LOCAL deadlock_timeout='100ms'");
  await lockY.query(
    "SELECT id FROM lyraseo_handoff.intent WHERE id=$1 FOR UPDATE",
    [intentY1],
  );
  await Promise.all([
    recoveryA.query("SET statement_timeout='8s'"),
    recoveryB.query("SET statement_timeout='8s'"),
  ]);
  const invoke = (c, limit) =>
    c
      .query(
        `SELECT lyraseo_kernel.command($1,'lyraseo-kernel-a','/api/internal/runtime/recover',$2,$3,$4) AS v`,
        [
          randomUUID(),
          JSON.stringify({ limit }),
          new Date(),
          new Date(Date.now() + 59000),
        ],
      )
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
  const a = invoke(recoveryA, 2);
  const aBlocks = await waitFor(
    pidA,
    (pids) => pids.includes(pidX) || pids.includes(pidY),
  );
  const b = invoke(recoveryB, 3);
  const bBlocks = await waitFor(
    pidB,
    (pids) => pids.includes(pidA) || pids.includes(pidY) || pids.includes(pidX),
  );
  console.log(
    "Observed barrier order:",
    JSON.stringify({
      firstBlockedBy: aBlocks.includes(pidX) ? "X-intent" : "Y-intent",
      secondBlockedBy: bBlocks.includes(pidA)
        ? "first-recovery"
        : bBlocks.includes(pidY)
          ? "Y-intent"
          : "X-intent",
    }),
  );
  await Promise.all([lockX.query("COMMIT"), lockY.query("COMMIT")]);
  const results = await Promise.all([a, b]);
  for (const r of results) {
    if (!r.ok) throw r.error;
    assert.equal(r.value.rows[0].v.disposition, "OK");
  }
  const rows = (
    await admin.query(
      "SELECT state FROM lyraseo_handoff.dispatch WHERE intent_id=ANY($1::uuid[])",
      [[intentX, intentY2, intentY1]],
    )
  ).rows;
  assert.equal(rows.length, 3);
  assert.ok(
    rows.every((r) => r.state === "PENDING"),
    "all three due items must be reopened",
  );
  assert.equal(
    (
      await admin.query('SELECT "deletedAt" FROM public."Site" WHERE id=$1', [
        site,
      ])
    ).rows[0].deletedAt,
    null,
  );
  const revokedIntent = randomUUID();
  await add(revokedIntent, y, "WEBHOOK", u2, 40);
  await admin.query("BEGIN");
  await admin.query(
    'SELECT id FROM public."Workspace" WHERE id=$1 FOR UPDATE',
    [workspace],
  );
  await admin.query(
    'DELETE FROM public."SiteGrant" WHERE ("workspaceId","siteId","userId")=($1,$2,$3)',
    [workspace, site, u2],
  );
  await admin.query("COMMIT");
  const revokedRecovery = await invoke(recoveryA, 3);
  if (!revokedRecovery.ok) throw revokedRecovery.error;
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.dispatch WHERE intent_id=$1",
        [revokedIntent],
      )
    ).rows[0].state,
    "SUPPRESSED",
  );
  assert.ok(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.dispatch WHERE intent_id=ANY($1::uuid[])",
        [[intentX, intentY2, intentY1]],
      )
    ).rows.every((r) => r.state === "PENDING"),
  );
  console.log(
    "PASS: overlapping limits 2/3 reopen all three eligible items; revoked scope is suppressed",
  );
} finally {
  await Promise.all([
    admin.end(),
    lockX.end(),
    lockY.end(),
    recoveryA.end(),
    recoveryB.end(),
  ]);
}
