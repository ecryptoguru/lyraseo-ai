import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { Client } = createRequire(resolve(root, "packages/db/package.json"))(
  "pg",
);
const docker = (...args) => {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw Error(`docker failed: ${result.stderr}`);
  return result.stdout;
};
const info = JSON.parse(docker("inspect", "lyraseo-phase1-postgres"))[0];
const bindings = info.HostConfig.PortBindings["5432/tcp"];
assert.equal(info.Config.Image, "postgres:17-alpine");
assert.deepEqual(bindings, [{ HostIp: "127.0.0.1", HostPort: "54329" }]);
const name = `lyraseo_handoff_${randomBytes(6).toString("hex")}`;
docker(
  "exec",
  "lyraseo-phase1-postgres",
  "psql",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  `CREATE DATABASE ${name} TEMPLATE template0`,
);
const directUrl = `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`;
const temporaryRoot = resolve(root, "packages/db/tmp");
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(resolve(temporaryRoot, "handoff-fence-"));
const migrationRoot = resolve(root, "packages/db/prisma/migrations");
mkdirSync(resolve(temporary, "migrations"));
for (const entry of readdirSync(migrationRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name < "202611030016_handoff_dispatch")
    cpSync(
      resolve(migrationRoot, entry.name),
      resolve(temporary, "migrations", entry.name),
      { recursive: true },
    );
}
cpSync(
  resolve(migrationRoot, "migration_lock.toml"),
  resolve(temporary, "migrations/migration_lock.toml"),
);
const config = resolve(temporary, "prisma.config.ts");
writeFileSync(
  config,
  `import {defineConfig} from "prisma/config";export default defineConfig({schema:${JSON.stringify(resolve(root, "packages/db/prisma/schema.prisma"))},migrations:{path:${JSON.stringify(resolve(temporary, "migrations"))}},datasource:{url:process.env.DIRECT_URL}});`,
);
function migrate(extra = []) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      ...extra,
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, DIRECT_URL: directUrl },
    },
  );
  if (result.status !== 0) throw Error("migration failed");
}
try {
  migrate(["--config", config]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const connect = async (user, password) => {
  const client = new Client({
    host: "127.0.0.1",
    port: 54329,
    database: name,
    user,
    password,
  });
  await client.connect();
  return client;
};
const admin = await connect("postgres", "lyraseo_local_only");
// Rehearse an upgrade with an existing, explicitly enrolled fixture role.
await admin.query(`GRANT USAGE ON SCHEMA lyraseo_handoff TO lyraseo_handoff_fixture;
 GRANT EXECUTE ON FUNCTION lyraseo_handoff.fixture_claim(uuid),lyraseo_handoff.fixture_before_socket(uuid,integer),lyraseo_handoff.fixture_finish(uuid,integer,text,integer,text,bigint,text) TO lyraseo_handoff_fixture`);
migrate();
const grants = (
  await admin.query(`SELECT
 has_function_privilege('lyraseo_handoff_fixture','lyraseo_handoff.fixture_claim(uuid)','EXECUTE') AS wrapper,
 has_function_privilege('lyraseo_handoff_fixture','lyraseo_handoff.fixture_claim_inner(uuid)','EXECUTE') AS inner_access`)
).rows[0];
assert.deepEqual(grants, { wrapper: true, inner_access: false });
const sender = await connect(
  "lyraseo_handoff_fixture",
  "local_handoff_fixture_only",
);
const deleter = await connect("postgres", "lyraseo_local_only");
try {
  await admin.query(`INSERT INTO lyraseo_handoff.fixture_environment SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database();
    GRANT USAGE ON SCHEMA lyraseo_handoff TO lyraseo_handoff_fixture;
    GRANT EXECUTE ON FUNCTION lyraseo_handoff.fixture_claim(uuid),lyraseo_handoff.fixture_before_socket(uuid,integer),lyraseo_handoff.fixture_finish(uuid,integer,text,integer,text,bigint,text) TO lyraseo_handoff_fixture;
    INSERT INTO public."ProductUser"(id) VALUES ('fence-user');
    INSERT INTO public."Workspace"(id,name) VALUES ('fence-workspace','Fence');
    INSERT INTO public."Site"(id,"workspaceId",origin,"verifiedAt") VALUES ('fence-site','fence-workspace','https://example.com',now());
    INSERT INTO public."Membership"("workspaceId","userId",role) VALUES ('fence-workspace','fence-user','OWNER');`);
  const dest = randomUUID(),
    intent = randomUUID(),
    event = randomUUID();
  const body = JSON.stringify({ id: event, type: "test" });
  await admin.query(
    `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,status,created_by)
    VALUES ($1,'fence-workspace','fence-site','WEBHOOK','https://example.com/hook','fixture-cipher','CONFIGURED','fence-user')`,
    [dest],
  );
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url)
    VALUES ($1,'fence-workspace','fence-site',$2,1,'WEBHOOK','fence-user',0,$3,repeat('a',64),'FIXTURE','test',$4,$5,encode(sha256(convert_to($5,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
    [intent, dest, randomUUID(), event, body],
  );
  const claimed = (
    await sender.query("SELECT lyraseo_handoff.fixture_claim($1) AS v", [
      intent,
    ])
  ).rows[0].v;
  assert.equal(claimed.attempt, 1);
  const pid = (await sender.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  await deleter.query("BEGIN");
  await deleter.query(
    'SELECT id FROM public."Workspace" WHERE id=$1 FOR UPDATE',
    ["fence-workspace"],
  );
  await deleter.query(
    'UPDATE public."Site" SET "deletedAt"=now() WHERE id=$1',
    ["fence-site"],
  );
  const socketCheck = sender.query(
    "SELECT lyraseo_handoff.fixture_before_socket($1,$2)",
    [intent, claimed.fence],
  );
  const socketRejected = assert.rejects(socketCheck, /STALE_HANDOFF/);
  let waiting = false;
  for (let i = 0; i < 100; i++) {
    const state = (
      await admin.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
        [pid],
      )
    ).rows[0];
    if (state?.wait_event_type === "Lock") {
      waiting = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(waiting, "pre-socket check must wait for concurrent retirement");
  await deleter.query("COMMIT");
  await socketRejected;
  await assert.rejects(
    sender.query("SELECT * FROM lyraseo_handoff.intent"),
    /permission denied/,
  );
  await assert.rejects(
    sender.query("SELECT lyraseo_handoff.fixture_before_socket_inner($1,$2)", [
      intent,
      claimed.fence,
    ]),
    /permission denied/,
  );

  // A user security epoch change that wins the same scope lock must also be
  // visible to a check already queued behind it.
  await admin.query('UPDATE public."Site" SET "deletedAt"=NULL WHERE id=$1', [
    "fence-site",
  ]);
  await deleter.query("BEGIN");
  await deleter.query(
    'SELECT id FROM public."Workspace" WHERE id=$1 FOR UPDATE',
    ["fence-workspace"],
  );
  await deleter.query(
    'UPDATE public."ProductUser" SET "securityVersion"=1 WHERE id=$1',
    ["fence-user"],
  );
  const staleEpoch = sender.query(
    "SELECT lyraseo_handoff.fixture_before_socket($1,$2)",
    [intent, claimed.fence],
  );
  const epochRejected = assert.rejects(staleEpoch, /STALE_HANDOFF/);
  waiting = false;
  for (let i = 0; i < 100; i++) {
    const state = (
      await admin.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
        [pid],
      )
    ).rows[0];
    if (state?.wait_event_type === "Lock") {
      waiting = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(
    waiting,
    "pre-socket check must wait for the identity epoch change",
  );
  await deleter.query("COMMIT");
  await epochRejected;
  await admin.query(
    'UPDATE public."ProductUser" SET "securityVersion"=0 WHERE id=$1',
    ["fence-user"],
  );

  // The opposite order: a successful barrier holds the tenant/site locks until
  // its transaction ends. Retirement then records WP uncertainty, never a
  // second automatic create.
  await admin.query('UPDATE public."Site" SET "deletedAt"=NULL WHERE id=$1', [
    "fence-site",
  ]);
  const wpDest = randomUUID(),
    wpIntent = randomUUID(),
    wpBody = '{"status":"draft"}';
  await admin.query(`INSERT INTO public."ContentDraft"(id,"workspaceId","siteId",kind,snapshot)
    VALUES ('fence-draft','fence-workspace','fence-site','draft','{}')`);
  await admin.query(
    `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,status,created_by)
    VALUES ($1,'fence-workspace','fence-site','WORDPRESS','https://example.com/blog/','fixture-cipher','CONFIGURED','fence-user')`,
    [wpDest],
  );
  await admin.query(
    `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,draft_id,body,body_hash,renderer_version,destination_url)
    VALUES ($1,'fence-workspace','fence-site',$2,1,'WORDPRESS','fence-user',0,$3,repeat('b',64),'FIXTURE','fence-draft',$4,encode(sha256(convert_to($4,'UTF8')),'hex'),'fixture','https://example.com/blog/wp-json/wp/v2/posts?_fields=id,status,link')`,
    [wpIntent, wpDest, randomUUID(), wpBody],
  );
  const wp = (
    await sender.query("SELECT lyraseo_handoff.fixture_claim($1) AS v", [
      wpIntent,
    ])
  ).rows[0].v;
  await sender.query("BEGIN");
  await sender.query("SELECT lyraseo_handoff.fixture_before_socket($1,$2)", [
    wpIntent,
    wp.fence,
  ]);
  const deletePid = (await deleter.query("SELECT pg_backend_pid() AS pid"))
    .rows[0].pid;
  await deleter.query("BEGIN");
  const retirementLock = deleter.query(
    'SELECT id FROM public."Workspace" WHERE id=$1 FOR UPDATE',
    ["fence-workspace"],
  );
  waiting = false;
  for (let i = 0; i < 100; i++) {
    const state = (
      await admin.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
        [deletePid],
      )
    ).rows[0];
    if (state?.wait_event_type === "Lock") {
      waiting = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(waiting, "retirement must wait for the active barrier transaction");
  await sender.query("COMMIT");
  await retirementLock;
  await deleter.query(
    'UPDATE public."Site" SET "deletedAt"=now() WHERE id=$1',
    ["fence-site"],
  );
  await deleter.query("SELECT lyraseo_handoff.retire_site($1,$2)", [
    "fence-workspace",
    "fence-site",
  ]);
  await deleter.query("COMMIT");
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
      await sender.query("SELECT lyraseo_handoff.fixture_claim($1) AS v", [
        wpIntent,
      ])
    ).rows[0].v,
    null,
  );
  await assert.rejects(
    sender.query("SELECT lyraseo_handoff.fixture_before_socket($1,$2)", [
      wpIntent,
      wp.fence,
    ]),
    /STALE_HANDOFF/,
  );
  console.log(
    `PASS: restricted barriers serialize both retirement orderings and preserve WP uncertainty; retained fixture DB ${name}`,
  );
} finally {
  await Promise.all([admin.end(), sender.end(), deleter.end()]);
}

const dispatch = spawnSync(
  "node",
  [resolve(root, "scripts/test-handoff-dispatch-fixture.mjs")],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      LYRA_HANDOFF_DISPATCH_DB: name,
      LYRA_HANDOFF_OWNED_DB: name,
    },
  },
);
if (dispatch.status !== 0) throw Error("fixture dispatch validation failed");
for (const test of [
  "test-handoff-cross-lane-races.mjs",
  "test-handoff-replay-races.mjs",
  "test-handoff-overlapping-recovery.mjs",
]) {
  const run = spawnSync("node", [resolve(root, "scripts", test)], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      LYRA_HANDOFF_DISPATCH_DB: name,
      LYRA_HANDOFF_OWNED_DB: name,
    },
  });
  if (run.status !== 0) throw Error(`${test} failed`);
}
