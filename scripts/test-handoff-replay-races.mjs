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
  const client = new Client({
    host: "127.0.0.1",
    port: 54329,
    database,
    user,
    password,
  });
  await client.connect();
  return client;
}
const admin = await connect("postgres", "lyraseo_local_only");
const clients = await Promise.all(
  Array.from({ length: 4 }, () =>
    connect("lyraseo_dispatch", "local_dispatch_only"),
  ),
);
try {
  const now = Date.now(),
    issued = new Date(now - 1000),
    short = new Date(now + 14000),
    long = new Date(now + 59000);
  const cases = [
    {
      state: "COMPLETE",
      expires: short,
      deadline: long,
      error: /INVALID_REQUEST/,
    },
    {
      state: "ACTIVE",
      expires: short,
      deadline: long,
      error: /INVALID_REQUEST/,
    },
    {
      state: "COMPLETE",
      expires: long,
      deadline: short,
      error: /HANDLER_DEADLINE/,
    },
    {
      state: "ACTIVE",
      expires: long,
      deadline: short,
      error: /HANDLER_DEADLINE/,
    },
  ].map((c) => ({
    ...c,
    rid: randomUUID(),
    raw: JSON.stringify({ version: 1, workId: randomUUID(), generation: 1 }),
  }));
  for (const c of cases) {
    await admin.query(
      `INSERT INTO public."InternalRequest"("servicePrincipalId","requestId",fingerprint,"issuedAt","expiresAt",state,"ownerToken",fence,"leaseUntil","completedAt",result)
      VALUES('lyraseo_dispatch',$1,sha256(convert_to(jsonb_build_array('v1','lyraseo-kernel-a','POST','/api/internal/runtime/step',encode(sha256(convert_to($2::text,'UTF8')),'hex'),extract(epoch from $3::timestamptz),extract(epoch from $4::timestamptz))::text,'UTF8')),$3,$4,$5,CASE WHEN $5='ACTIVE' THEN $6::uuid END,1,CASE WHEN $5='ACTIVE' THEN $4::timestamptz END,CASE WHEN $5='COMPLETE' THEN clock_timestamp() END,CASE WHEN $5='COMPLETE' THEN '{"disposition":"COMPLETED"}'::jsonb END)`,
      [c.rid, c.raw, issued, c.expires, c.state, randomUUID()],
    );
  }
  const pids = await Promise.all(
    clients.map(
      async (c) =>
        (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    ),
  );
  await admin.query("BEGIN");
  await admin.query(
    `SELECT "requestId" FROM public."InternalRequest" WHERE "servicePrincipalId"='lyraseo_dispatch' AND "requestId"=ANY($1::uuid[]) FOR UPDATE`,
    [cases.map((c) => c.rid)],
  );
  const results = cases.map((c, i) =>
    clients[i]
      .query(
        `SELECT lyraseo_handoff.admit_step($1,'lyraseo-kernel-a','/api/internal/runtime/step',$2,$3,$4,$5)`,
        [c.rid, c.raw, issued, c.expires, c.deadline],
      )
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      ),
  );
  let blocked = false;
  for (let n = 0; n < 200; n++) {
    const rows = (
      await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'",
        [pids],
      )
    ).rows[0];
    if (rows.n === 4) {
      blocked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(
    blocked,
    "all completed and active replays must be held at the request lock",
  );
  const delay = Math.max(0, short.getTime() - Date.now() + 150);
  await new Promise((r) => setTimeout(r, delay));
  await admin.query("COMMIT");
  const settled = await Promise.all(results);
  console.log(
    "Replay outcomes:",
    cases.map((c, i) => ({
      state: c.state,
      deadline: i < 2 ? "signature" : "handler",
      outcome: settled[i].ok ? "RETURNED" : settled[i].error.message,
    })),
  );
  for (let i = 0; i < cases.length; i++) {
    assert.equal(
      settled[i].ok,
      false,
      `${cases[i].state} replay returned after its ${i < 2 ? "signature" : "handler"} deadline`,
    );
    assert.match(settled[i].error.message, cases[i].error);
  }
  console.log(
    "PASS: completed and active replays reject signature or handler expiry after lock waits",
  );
} finally {
  await Promise.all([admin.end(), ...clients.map((c) => c.end())]);
}
