import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const { Client } = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
)("pg");
const database = process.env.LYRA_HANDOFF_DISPATCH_DB;
if (
  !/^lyraseo_handoff_[a-f0-9]{12}$/.test(database ?? "") ||
  process.env.LYRA_HANDOFF_OWNED_DB !== database
)
  throw Error("DISPOSABLE_DB_REQUIRED");
const suffix = randomUUID().slice(0, 8);
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
const svc = await connect("lyraseo_dispatch", "local_dispatch_only");
const svc2 = await connect("lyraseo_dispatch", "local_dispatch_only");
try {
  await admin.query(`INSERT INTO lyraseo_kernel.test_environment SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database() ON CONFLICT DO NOTHING;
 INSERT INTO public."ProductUser"(id) VALUES ('carrier-user-${suffix}');
 INSERT INTO public."Workspace"(id,name) VALUES ('carrier-work-${suffix}','Carrier');
 INSERT INTO public."Site"(id,"workspaceId",origin,"verifiedAt") VALUES ('carrier-site-${suffix}','carrier-work-${suffix}','https://example.com',now());
 INSERT INTO public."Membership"("workspaceId","userId",role) VALUES('carrier-work-${suffix}','carrier-user-${suffix}','OWNER')`);
  const initial = (
    await op.query("SELECT lyraseo_handoff.read_fixture_policy() AS v")
  ).rows[0].v;
  if (initial.revision === 0) {
    assert.equal(initial.enabled, false);
    assert.equal(initial.qualified, false);
  }
  if (
    !(
      await admin.query(
        `SELECT enabled FROM public."RuntimePolicy" WHERE key='global'`,
      )
    ).rows[0].enabled
  )
    await op.query(`SELECT lyraseo_kernel.change_policy('global',0,true)`);
  if (
    !(
      await admin.query(
        `SELECT enabled FROM lyraseo_handoff.dispatch_policy WHERE id`,
      )
    ).rows[0].enabled
  )
    await op.query(`SELECT lyraseo_handoff.change_fixture_policy(0,true)`);
  const destination = randomUUID(),
    intent = randomUUID(),
    event = randomUUID(),
    body = JSON.stringify({ id: event, type: "test" });
  await admin.query(
    `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,status,created_by) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}','WEBHOOK','https://example.com/hook','cipher','CONFIGURED','carrier-user-${suffix}')`,
    [destination],
  );
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}',$2,1,'WEBHOOK','carrier-user-${suffix}',0,$3,repeat('a',64),'FIXTURE','test',$4,$5,encode(sha256(convert_to($5,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
    [intent, destination, randomUUID(), event, body],
  );
  const command = async (path, value, client = svc) => {
    const issued = new Date(),
      expires = new Date(Date.now() + 59000);
    return (
      await client.query(
        `SELECT lyraseo_kernel.command($1,'lyraseo-kernel-a',$2,$3,$4,$5) AS v`,
        [randomUUID(), path, JSON.stringify(value), issued, expires],
      )
    ).rows[0].v;
  };
  const claim = await command("/api/internal/runtime/dispatch", { limit: 1 });
  assert.equal(claim.disposition, "OK");
  assert.equal(claim.refs.length, 1);
  const ref = claim.refs[0];
  assert.equal(
    (await command("/api/internal/runtime/dispatch/ack", ref)).disposition,
    "DELIVERED",
  );
  assert.equal(
    (
      await svc.query("SELECT lyraseo_handoff.resolve_delivery($1,$2) AS v", [
        ref.workId,
        ref.generation,
      ])
    ).rows[0].v,
    true,
  );
  const rid = randomUUID(),
    raw = JSON.stringify({
      version: 1,
      workId: ref.workId,
      generation: ref.generation,
    }),
    issued = new Date(),
    expires = new Date(Date.now() + 16000),
    deadline = new Date(Date.now() + 40000);
  const step = (
    await svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
      [rid, raw, issued, expires, deadline],
    )
  ).rows[0].v;
  assert.equal(step.disposition, "ADMITTED");
  const binding = (
    await svc.query("SELECT lyraseo_handoff.check_step($1,$2) AS v", [
      rid,
      step.proof,
    ])
  ).rows[0].v;
  assert.equal(binding.body, body);
  const finished = (
    await svc.query(
      `SELECT lyraseo_handoff.finish_step($1,$2,'DELIVERED',204,'RESPONSE',NULL,NULL) AS v`,
      [rid, step.proof],
    )
  ).rows[0].v;
  assert.equal(finished.disposition, "COMPLETED");
  // An exact, already-completed request must replay while its signature is
  // still valid, even inside the minimum time reserved for a new send.
  while (expires.getTime() - Date.now() > 10000)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(expires.getTime() > Date.now());
  const replayPolicyRevision = (
    await admin.query(
      "SELECT revision FROM lyraseo_handoff.dispatch_policy WHERE id",
    )
  ).rows[0].revision;
  await op.query("SELECT lyraseo_handoff.change_fixture_policy($1,false)", [
    replayPolicyRevision,
  ]);
  await assert.rejects(
    svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5)`,
      [
        randomUUID(),
        raw,
        new Date(),
        new Date(Date.now() + 59000),
        new Date(Date.now() + 40000),
      ],
    ),
    /PAUSED/,
  );
  assert.equal(
    (
      await svc.query(
        `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
        [rid, raw, issued, expires, deadline],
      )
    ).rows[0].v.disposition,
    "COMPLETED",
  );
  await assert.rejects(
    svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5)`,
      [
        rid,
        JSON.stringify({
          version: 1,
          workId: ref.workId,
          generation: ref.generation + 1,
        }),
        issued,
        expires,
        deadline,
      ],
    ),
    /REQUEST_CONFLICT/,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.intent WHERE id=$1",
        [intent],
      )
    ).rows[0].state,
    "DELIVERED",
  );
  await op.query("SELECT lyraseo_handoff.change_fixture_policy($1,true)", [
    replayPolicyRevision + 1,
  ]);
  await assert.rejects(
    svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5)`,
      [randomUUID(), raw, issued, expires, deadline],
    ),
    /RETRY_FRESH/,
  );

  const retryIntent = randomUUID(),
    retryEvent = randomUUID(),
    retryBody = JSON.stringify({ id: retryEvent, type: "test" });
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}',$2,1,'WEBHOOK','carrier-user-${suffix}',0,$3,repeat('c',64),'FIXTURE','test',$4,$5,encode(sha256(convert_to($5,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
    [retryIntent, destination, randomUUID(), retryEvent, retryBody],
  );
  const retryRef = (
    await command("/api/internal/runtime/dispatch", { limit: 1 })
  ).refs[0];
  await command("/api/internal/runtime/dispatch/ack", retryRef);
  const retryRid = randomUUID(),
    retryRaw = JSON.stringify({
      version: 1,
      workId: retryRef.workId,
      generation: retryRef.generation,
    }),
    retryIssued = new Date(),
    retryExpires = new Date(Date.now() + 59000),
    retryDeadline = new Date(Date.now() + 40000);
  const retry = (
    await svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
      [retryRid, retryRaw, retryIssued, retryExpires, retryDeadline],
    )
  ).rows[0].v;
  const b1 = (
    await svc.query("SELECT lyraseo_handoff.check_step($1,$2) AS v", [
      retryRid,
      retry.proof,
    ])
  ).rows[0].v;
  await svc.query(
    `SELECT lyraseo_handoff.finish_step($1,$2,'RETRY',NULL,'NETWORK_UNCERTAIN',NULL,NULL)`,
    [retryRid, retry.proof],
  );
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.intent WHERE id=$1",
        [retryIntent],
      )
    ).rows[0].state,
    "RETRY",
  );
  assert.equal(
    (
      await svc.query("SELECT lyraseo_handoff.resolve_delivery($1,$2) AS v", [
        retryRef.workId,
        retryRef.generation,
      ])
    ).rows[0].v,
    true,
  );
  assert.equal(
    (
      await svc.query(
        `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
        [retryRid, retryRaw, retryIssued, retryExpires, retryDeadline],
      )
    ).rows[0].v.disposition,
    "COMPLETED",
  );
  await assert.rejects(
    svc.query(
      `SELECT lyraseo_kernel.command($1,'lyraseo-kernel-a','/api/internal/runtime/dispatch',$2,$3,$4)`,
      [retryRid, JSON.stringify({ limit: 1 }), retryIssued, retryExpires],
    ),
    /REQUEST_CONFLICT/,
  );

  await admin.query(
    `UPDATE lyraseo_handoff.intent SET next_due_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [retryIntent],
  );
  await admin.query(
    `UPDATE lyraseo_handoff.dispatch SET next_due=clock_timestamp()-interval '1 second' WHERE intent_id=$1`,
    [retryIntent],
  );
  const nextRef = (
    await command("/api/internal/runtime/dispatch", { limit: 1 })
  ).refs[0];
  assert.equal(nextRef.generation, retryRef.generation + 1);
  await command("/api/internal/runtime/dispatch/ack", nextRef);
  const nextRid = randomUUID(),
    nextRaw = JSON.stringify({
      version: 1,
      workId: nextRef.workId,
      generation: nextRef.generation,
    });
  const next = (
    await svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
      [
        nextRid,
        nextRaw,
        new Date(),
        new Date(Date.now() + 59000),
        new Date(Date.now() + 40000),
      ],
    )
  ).rows[0].v;
  const b2 = (
    await svc.query("SELECT lyraseo_handoff.check_step($1,$2) AS v", [
      nextRid,
      next.proof,
    ])
  ).rows[0].v;
  assert.equal(b2.body, b1.body);
  assert.equal(b2.eventId, b1.eventId);
  await assert.rejects(
    svc.query(
      `SELECT lyraseo_handoff.finish_step($1,$2,'DELIVERED',204,'RESPONSE',NULL,NULL)`,
      [retryRid, retry.proof],
    ),
    /STALE_ATTEMPT/,
  );
  await svc.query(
    `SELECT lyraseo_handoff.finish_step($1,$2,'DELIVERED',204,'RESPONSE',NULL,NULL)`,
    [nextRid, next.proof],
  );
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.intent WHERE id=$1",
        [retryIntent],
      )
    ).rows[0].state,
    "DELIVERED",
  );

  const raceIntent = randomUUID(),
    raceEvent = randomUUID(),
    raceBody = JSON.stringify({ id: raceEvent, type: "test" });
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}',$2,1,'WEBHOOK','carrier-user-${suffix}',0,$3,repeat('d',64),'FIXTURE','test',$4,$5,encode(sha256(convert_to($5,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
    [raceIntent, destination, randomUUID(), raceEvent, raceBody],
  );
  const concurrent = await Promise.all([
    command("/api/internal/runtime/dispatch", { limit: 1 }, svc),
    command("/api/internal/runtime/dispatch", { limit: 1 }, svc2),
  ]);
  const raceRefs = concurrent.flatMap((x) => x.refs);
  assert.equal(raceRefs.length, 1);
  const raceRef = raceRefs[0];
  await command("/api/internal/runtime/dispatch/ack", raceRef);
  const raceRaw = JSON.stringify({
    version: 1,
    workId: raceRef.workId,
    generation: raceRef.generation,
  });
  const attempt = async (client) => {
    const id = randomUUID(),
      now = new Date(),
      expires = new Date(Date.now() + 59000),
      deadline = new Date(Date.now() + 40000);
    return {
      id,
      value: (
        await client.query(
          `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
          [id, raceRaw, now, expires, deadline],
        )
      ).rows[0].v,
    };
  };
  const attempts = await Promise.all([attempt(svc), attempt(svc2)]);
  assert.deepEqual(attempts.map((x) => x.value.disposition).sort(), [
    "ADMITTED",
    "IN_PROGRESS",
  ]);
  const winner = attempts.find((x) => x.value.disposition === "ADMITTED");
  await Promise.all([
    svc.query("SET lock_timeout='2s'"),
    svc2.query("SET lock_timeout='2s'"),
  ]);
  const completions = await Promise.allSettled([
    svc.query(
      `SELECT lyraseo_handoff.finish_step($1,$2,'DELIVERED',204,'RESPONSE',NULL,NULL)`,
      [winner.id, winner.value.proof],
    ),
    svc2.query(
      `SELECT lyraseo_handoff.finish_step($1,$2,'DELIVERED',204,'RESPONSE',NULL,NULL)`,
      [winner.id, winner.value.proof],
    ),
  ]);
  assert.equal(completions.filter((x) => x.status === "fulfilled").length, 1);
  const failed = completions.find((x) => x.status === "rejected");
  assert.match(failed.reason.message, /STALE_ATTEMPT/);

  const blockedIntent = randomUUID(),
    blockedEvent = randomUUID(),
    blockedBody = JSON.stringify({ id: blockedEvent, type: "test" });
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}',$2,1,'WEBHOOK','carrier-user-${suffix}',0,$3,repeat('e',64),'FIXTURE','test',$4,$5,encode(sha256(convert_to($5,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
    [blockedIntent, destination, randomUUID(), blockedEvent, blockedBody],
  );
  const blockedRef = (
    await command("/api/internal/runtime/dispatch", { limit: 1 })
  ).refs[0];
  await command("/api/internal/runtime/dispatch/ack", blockedRef);
  const blockedRid = randomUUID(),
    blockedRaw = JSON.stringify({
      version: 1,
      workId: blockedRef.workId,
      generation: blockedRef.generation,
    });
  const blocked = (
    await svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
      [
        blockedRid,
        blockedRaw,
        new Date(),
        new Date(Date.now() + 59000),
        new Date(Date.now() + 40000),
      ],
    )
  ).rows[0].v;
  const svcPid = (await svc.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  await admin.query("BEGIN");
  await admin.query(
    'SELECT id FROM public."Workspace" WHERE id=$1 FOR UPDATE',
    [`carrier-work-${suffix}`],
  );
  const blockedCheck = svc.query("SELECT lyraseo_handoff.check_step($1,$2)", [
    blockedRid,
    blocked.proof,
  ]);
  const blockedRejection = assert.rejects(blockedCheck, /STALE_ATTEMPT/);
  let blockedOnLock = false;
  for (let n = 0; n < 100; n++) {
    if (
      (
        await admin.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [svcPid],
        )
      ).rows[0]?.wait_event_type === "Lock"
    ) {
      blockedOnLock = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(blockedOnLock);
  await admin.query(
    `UPDATE lyraseo_handoff.dispatch_attempt SET deadline=clock_timestamp()-interval '1 second' WHERE request_id=$1`,
    [blockedRid],
  );
  await admin.query("COMMIT");
  await blockedRejection;
  await admin.query(
    `UPDATE lyraseo_handoff.intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [blockedIntent],
  );
  await admin.query(
    `UPDATE lyraseo_handoff.dispatch SET next_due=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [blockedRef.workId],
  );
  await command("/api/internal/runtime/recover", { limit: 20 });
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.intent WHERE id=$1",
        [blockedIntent],
      )
    ).rows[0].state,
    "RETRY",
  );

  const quotaIntent = randomUUID(),
    quotaEvent = randomUUID(),
    quotaBody = JSON.stringify({ id: quotaEvent, type: "test" });
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}',$2,1,'WEBHOOK','carrier-user-${suffix}',0,$3,repeat('f',64),'FIXTURE','test',$4,$5,encode(sha256(convert_to($5,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
    [quotaIntent, destination, randomUUID(), quotaEvent, quotaBody],
  );
  const quotaRef = (
    await command("/api/internal/runtime/dispatch", { limit: 1 })
  ).refs[0];
  await command("/api/internal/runtime/dispatch/ack", quotaRef);
  await admin.query(
    `UPDATE lyraseo_handoff.egress_hour SET used=60 WHERE (workspace_id,site_id)=($1,$2)`,
    [`carrier-work-${suffix}`, `carrier-site-${suffix}`],
  );
  const quotaRid = randomUUID(),
    quotaRaw = JSON.stringify({
      version: 1,
      workId: quotaRef.workId,
      generation: quotaRef.generation,
    });
  const capped = (
    await svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
      [
        quotaRid,
        quotaRaw,
        new Date(),
        new Date(Date.now() + 59000),
        new Date(Date.now() + 40000),
      ],
    )
  ).rows[0].v;
  assert.equal(capped.disposition, "IN_PROGRESS");
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.intent WHERE id=$1",
        [quotaIntent],
      )
    ).rows[0].state,
    "PREPARED",
  );
  await admin.query(
    `UPDATE lyraseo_handoff.egress_hour SET used=1 WHERE (workspace_id,site_id)=($1,$2)`,
    [`carrier-work-${suffix}`, `carrier-site-${suffix}`],
  );
  await admin.query(
    `UPDATE lyraseo_handoff.dispatch SET state='SUPPRESSED',next_due=NULL,delivered_at=NULL WHERE id=$1`,
    [quotaRef.workId],
  );

  for (let n = 0; n < 2; n++) {
    const id = randomUUID(),
      eid = randomUUID(),
      bytes = JSON.stringify({ id: eid, type: "test" });
    await admin.query(
      `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}',$2,1,'WEBHOOK','carrier-user-${suffix}',0,$3,repeat('9',64),'FIXTURE','test',$4,$5,encode(sha256(convert_to($5,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
      [id, destination, randomUUID(), eid, bytes],
    );
  }
  const siteRefs = (
    await command("/api/internal/runtime/dispatch", { limit: 2 })
  ).refs;
  assert.equal(siteRefs.length, 2);
  for (const ref of siteRefs)
    await command("/api/internal/runtime/dispatch/ack", ref);
  const siteAttempt = async (client, ref) => {
    const id = randomUUID(),
      raw = JSON.stringify({
        version: 1,
        workId: ref.workId,
        generation: ref.generation,
      });
    return {
      id,
      ref,
      value: (
        await client.query(
          `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
          [
            id,
            raw,
            new Date(),
            new Date(Date.now() + 59000),
            new Date(Date.now() + 40000),
          ],
        )
      ).rows[0].v,
    };
  };
  const siteAttempts = await Promise.all([
    siteAttempt(svc, siteRefs[0]),
    siteAttempt(svc2, siteRefs[1]),
  ]);
  assert.deepEqual(siteAttempts.map((x) => x.value.disposition).sort(), [
    "ADMITTED",
    "IN_PROGRESS",
  ]);
  const siteWinner = siteAttempts.find(
      (x) => x.value.disposition === "ADMITTED",
    ),
    siteLoser = siteAttempts.find((x) => x.value.disposition === "IN_PROGRESS");
  await svc.query(
    `SELECT lyraseo_handoff.finish_step($1,$2,'DELIVERED',204,'RESPONSE',NULL,NULL)`,
    [siteWinner.id, siteWinner.value.proof],
  );
  const siteRetry = await siteAttempt(svc, siteLoser.ref);
  assert.equal(siteRetry.value.disposition, "ADMITTED");
  await svc.query(
    `SELECT lyraseo_handoff.finish_step($1,$2,'DELIVERED',204,'RESPONSE',NULL,NULL)`,
    [siteRetry.id, siteRetry.value.proof],
  );
  await assert.rejects(
    svc.query("SELECT * FROM lyraseo_handoff.dispatch"),
    /permission denied/,
  );
  const wpDest = randomUUID(),
    wpIntent = randomUUID(),
    draft = `carrier-draft-${suffix}`,
    wpBody = '{"status":"draft"}';
  await admin.query(
    `INSERT INTO public."ContentDraft"(id,"workspaceId","siteId",kind,snapshot) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}','draft','{}')`,
    [draft],
  );
  await admin.query(
    `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,status,created_by) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}','WORDPRESS','https://example.com/blog/','cipher','CONFIGURED','carrier-user-${suffix}')`,
    [wpDest],
  );
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,draft_id,body,body_hash,renderer_version,destination_url) VALUES ($1,'carrier-work-${suffix}','carrier-site-${suffix}',$2,1,'WORDPRESS','carrier-user-${suffix}',0,$3,repeat('b',64),'FIXTURE',$4,$5,encode(sha256(convert_to($5,'UTF8')),'hex'),'fixture','https://example.com/blog/wp-json/wp/v2/posts?_fields=id,status,link')`,
    [wpIntent, wpDest, randomUUID(), draft, wpBody],
  );
  const wpClaim = await command("/api/internal/runtime/dispatch", { limit: 1 });
  assert.equal(wpClaim.refs.length, 1);
  const wpRef = wpClaim.refs[0];
  await command("/api/internal/runtime/dispatch/ack", wpRef);
  const wpRid = randomUUID(),
    wpRaw = JSON.stringify({
      version: 1,
      workId: wpRef.workId,
      generation: wpRef.generation,
    });
  const wp = (
    await svc.query(
      `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5) AS v`,
      [
        wpRid,
        wpRaw,
        new Date(),
        new Date(Date.now() + 59000),
        new Date(Date.now() + 40000),
      ],
    )
  ).rows[0].v;
  assert.equal(wp.kind, "WORDPRESS");
  const rev = (
    await admin.query(
      "SELECT revision FROM lyraseo_handoff.dispatch_policy WHERE id",
    )
  ).rows[0].revision;
  await op.query("SELECT lyraseo_handoff.change_fixture_policy($1,false)", [
    rev,
  ]);
  await op.query("SELECT lyraseo_handoff.change_fixture_policy($1,true)", [
    rev + 1,
  ]);
  await assert.rejects(
    svc.query("SELECT lyraseo_handoff.check_step($1,$2)", [wpRid, wp.proof]),
    /STALE_ATTEMPT/,
  );
  await admin.query(
    `UPDATE lyraseo_handoff.intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [wpIntent],
  );
  await admin.query(
    `UPDATE lyraseo_handoff.dispatch SET next_due=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [wpRef.workId],
  );
  const recovery = await command("/api/internal/runtime/recover", {
    limit: 20,
  });
  assert.ok(recovery.suppressed >= 1);
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.intent WHERE id=$1",
        [wpIntent],
      )
    ).rows[0].state,
    "UNRESOLVED",
  );
  assert.equal(
    (
      await admin.query(
        "SELECT state FROM lyraseo_handoff.dispatch WHERE id=$1",
        [wpRef.workId],
      )
    ).rows[0].state,
    "SUPPRESSED",
  );
  assert.equal(
    (await command("/api/internal/runtime/dispatch", { limit: 20 })).refs
      .length,
    0,
  );
  console.log(
    "PASS: fixture dispatch fencing, retry, concurrency, quota and crash recovery",
  );
} finally {
  await Promise.all([admin.end(), op.end(), svc.end(), svc2.end()]);
}
