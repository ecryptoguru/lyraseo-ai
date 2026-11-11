import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { startControlledRuntime } from "../../apps/lyraseo-web/src/server/runtime/listener";
import { createControlledFixture } from "../../apps/lyraseo-web/src/server/runtime/fixture";
import { createHandoffFixture } from "../../apps/lyraseo-web/src/server/runtime/handoff-fixture";
import { Bridge, signEnvelope } from "../../apps/lyraseo-worker/src/bridge";
import { consume } from "../../apps/lyraseo-worker/src/carrier";
import { runtimePaths } from "../../packages/contracts/src/runtime-signing";
const database = process.env.LYRA_HANDOFF_CARRIER_DB ?? "";
const validFixtureDatabase = /^lyraseo_handoff_[a-f0-9]{12}$/.test(database);
if (process.env.LYRA_REQUIRE_HANDOFF_CARRIER === "1" && !validFixtureDatabase)
  throw Error("DISPOSABLE_HANDOFF_DB_REQUIRED");
const test = validFixtureDatabase ? it : it.skip;
const { Client } = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
)("pg");
test("signed carrier uses real fixture DB for retry and ambiguous WordPress replay", async () => {
  const client = (user: string, password: string) =>
    new Client({ host: "127.0.0.1", port: 54329, database, user, password });
  const admin = client("postgres", "lyraseo_local_only"),
    op = client("lyraseo_operator", "local_operator_only");
  await admin.connect();
  await op.connect();
  const db = createDatabase(
    `postgresql://lyraseo_dispatch:local_dispatch_only@127.0.0.1:54329/${database}`,
  );
  const suffix = randomUUID(),
    user = `user-${suffix}`,
    workspace = `workspace-${suffix}`,
    site = `site-${suffix}`;
  const keyBytes = randomBytes(32),
    key = {
      id: "fixture",
      principal: "lyraseo_dispatch",
      audience: "lyraseo-kernel-a",
      actions: runtimePaths,
      secret: keyBytes,
    };
  const keys = [key];
  const env = {
    WORK_QUEUE: { send: async () => ({}) },
    CARRIER_QUALIFIED: "true",
    CARRIER_ENABLED: "true",
    BRIDGE_ORIGIN: "https://bridge.test.invalid",
    BRIDGE_KEY_ID: key.id,
    BRIDGE_SECRET: keyBytes.toString("base64url"),
    BRIDGE_PRINCIPAL: key.principal,
    BRIDGE_AUDIENCE: key.audience,
  } as Env;
  const secret = Buffer.alloc(32, 8).toString("base64url"),
    posts: Array<{ url: string; body: string; event?: string }> = [];
  let responseStatus = 503;
  const fixture = createHandoffFixture(
    "https://example.com",
    (_cipher, b) =>
      b.kind === "WORDPRESS"
        ? JSON.stringify({
            username: "fixture",
            applicationPassword: "fixture",
          })
        : secret,
    async (url, body, headers) => {
      posts.push({ url, body, event: headers["X-Lyraseo-Event-Id"] });
      if (url.includes("wp-json")) throw Error("unknown provider result");
      return { status: responseStatus, body: "" };
    },
  );
  let server: Awaited<ReturnType<typeof startControlledRuntime>> | undefined;
  try {
    await admin.query(
      `INSERT INTO lyraseo_kernel.test_environment SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database() ON CONFLICT DO NOTHING`,
    );
    await admin.query('INSERT INTO public."ProductUser"(id) VALUES ($1)', [
      user,
    ]);
    await admin.query(
      "INSERT INTO public.\"Workspace\"(id,name) VALUES ($1,'Carrier')",
      [workspace],
    );
    await admin.query(
      'INSERT INTO public."Site"(id,"workspaceId",origin,"verifiedAt") VALUES ($1,$2,\'https://example.com\',now())',
      [site, workspace],
    );
    await admin.query(
      'INSERT INTO public."Membership"("workspaceId","userId",role) VALUES ($1,$2,\'OWNER\')',
      [workspace, user],
    );
    await op.query(`SELECT lyraseo_kernel.change_policy('global',0,true)`);
    await op.query(`SELECT lyraseo_handoff.change_fixture_policy(0,true)`);
    server = await startControlledRuntime({
      db,
      keys: () => keys,
      fixture: createControlledFixture(
        "https://example.com",
        async () => new Response(""),
      ),
      handoffFixture: fixture,
    });
    const wire = (request: Request) =>
      fetch(server!.origin + new URL(request.url).pathname, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        duplex: "half",
      } as RequestInit);
    const bridge = new Bridge(env, wire);
    const destination = randomUUID(),
      intent = randomUUID(),
      event = randomUUID();
    const body = JSON.stringify({
      id: event,
      workspaceId: workspace,
      siteId: site,
    });
    await admin.query(
      `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,key_id,status,created_by) VALUES ($1,$2,$3,'WEBHOOK','https://example.com/hook','fixture','key','CONFIGURED',$4)`,
      [destination, workspace, site, user],
    );
    await admin.query(
      `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url) VALUES ($1,$2,$3,$4,1,'WEBHOOK',$5,0,$6,repeat('a',64),'FIXTURE','test',$7,$8,encode(sha256(convert_to($8,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
      [intent, workspace, site, destination, user, randomUUID(), event, body],
    );
    const claim = async () => {
      const r = await bridge.command(
        runtimePaths[0],
        { limit: 1 },
        Date.now() + 8000,
      );
      if (r.disposition !== "OK") throw Error("claim failed");
      const ref = r.refs[0]!;
      await bridge.command(runtimePaths[1], ref, Date.now() + 8000);
      return ref;
    };
    const invoke = async (ref: { workId: string; generation: number }) => {
      let ack = false;
      await consume(
        {
          messages: [
            {
              body: {
                version: 1,
                workId: ref.workId,
                generation: ref.generation,
              },
              attempts: 1,
              ack: () => {
                ack = true;
              },
              retry: () => {},
            },
          ],
        } as never,
        env,
        wire,
      );
      expect(ack).toBe(true);
    };
    const ref = await claim();
    await invoke(ref);
    expect(
      (
        await admin.query(
          `SELECT state FROM lyraseo_handoff.intent WHERE id=$1`,
          [intent],
        )
      ).rows[0].state,
    ).toBe("RETRY");
    await admin.query(
      `UPDATE lyraseo_handoff.intent SET next_due_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [intent],
    );
    await admin.query(
      `UPDATE lyraseo_handoff.dispatch SET next_due=clock_timestamp()-interval '1 second' WHERE intent_id=$1`,
      [intent],
    );
    responseStatus = 204;
    const retryRef = await claim();
    expect(retryRef.generation).toBe(ref.generation + 1);
    await invoke(retryRef);
    expect(
      (
        await admin.query(
          `SELECT state FROM lyraseo_handoff.intent WHERE id=$1`,
          [intent],
        )
      ).rows[0].state,
    ).toBe("DELIVERED");
    expect(posts.map((p) => [p.body, p.event])).toEqual([
      [body, event],
      [body, event],
    ]);
    const wpDest = randomUUID(),
      wpIntent = randomUUID(),
      draft = `draft-${suffix}`,
      wpBody = JSON.stringify({
        title: "Test",
        content: "<p>Test</p>",
        status: "draft",
      });
    await admin.query(
      `INSERT INTO public."ContentDraft"(id,"workspaceId","siteId",kind,snapshot) VALUES ($1,$2,$3,'draft','{}')`,
      [draft, workspace, site],
    );
    await admin.query(
      `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,status,created_by) VALUES ($1,$2,$3,'WORDPRESS','https://example.com/blog/','fixture','CONFIGURED',$4)`,
      [wpDest, workspace, site, user],
    );
    await admin.query(
      `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,draft_id,body,body_hash,renderer_version,destination_url) VALUES ($1,$2,$3,$4,1,'WORDPRESS',$5,0,$6,repeat('b',64),'FIXTURE',$7,$8,encode(sha256(convert_to($8,'UTF8')),'hex'),'fixture','https://example.com/blog/wp-json/wp/v2/posts?_fields=id,status,link')`,
      [wpIntent, workspace, site, wpDest, user, randomUUID(), draft, wpBody],
    );
    const wp = await claim(),
      e = await signEnvelope(
        bridge.config,
        runtimePaths[3],
        JSON.stringify({
          version: 1,
          workId: wp.workId,
          generation: wp.generation,
        }),
        Math.floor(Date.now() / 1000) - 45,
      );
    expect((await bridge.send(e, Date.now() + 10000)).disposition).toBe(
      "COMPLETED",
    );
    expect((await bridge.send(e, Date.now() + 10000)).disposition).toBe(
      "COMPLETED",
    );
    expect(
      (
        await admin.query(
          `SELECT state FROM lyraseo_handoff.intent WHERE id=$1`,
          [wpIntent],
        )
      ).rows[0].state,
    ).toBe("UNRESOLVED");
    expect(posts.filter((p) => p.url.includes("wp-json"))).toHaveLength(1);

    // Prepare a distinct delivery before pausing so a fresh request actually
    // reaches admission while the already-completed request is replayed.
    const pausedIntent = randomUUID(),
      pausedEvent = randomUUID();
    const pausedBody = JSON.stringify({
      id: pausedEvent,
      workspaceId: workspace,
      siteId: site,
    });
    await admin.query(
      `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,body,body_hash,renderer_version,destination_url) VALUES ($1,$2,$3,$4,1,'WEBHOOK',$5,0,$6,repeat('c',64),'FIXTURE','test',$7,$8,encode(sha256(convert_to($8,'UTF8')),'hex'),'fixture','https://example.com/hook')`,
      [
        pausedIntent,
        workspace,
        site,
        destination,
        user,
        randomUUID(),
        pausedEvent,
        pausedBody,
      ],
    );
    const pausedRef = await claim();
    const revision = (
      await op.query(`SELECT lyraseo_handoff.read_fixture_policy() AS v`)
    ).rows[0].v.revision;
    await op.query(`SELECT lyraseo_handoff.change_fixture_policy($1,false)`, [
      revision,
    ]);
    const fresh = await signEnvelope(
      bridge.config,
      runtimePaths[3],
      JSON.stringify({
        version: 1,
        workId: pausedRef.workId,
        generation: pausedRef.generation,
      }),
    );
    const direct = (envelope: typeof e) =>
      wire(
        new Request(bridge.config.origin + envelope.path, {
          method: "POST",
          headers: envelope.headers,
          body: envelope.body,
        }),
      );
    const freshResponse = await direct(fresh);
    expect(freshResponse.status).toBe(503);
    expect(posts.filter((p) => p.url.includes("wp-json"))).toHaveLength(1);

    // Admission initially had over 11 seconds, then a completed exact replay
    // must still work with 10 seconds or less remaining, even during pause.
    const untilNearExpiry = Math.max(0, e.expires * 1000 - Date.now() - 9500);
    await new Promise((resolve) => setTimeout(resolve, untilNearExpiry));
    expect(e.expires * 1000 - Date.now()).toBeGreaterThan(0);
    expect(e.expires * 1000 - Date.now()).toBeLessThanOrEqual(10000);
    expect((await bridge.send(e, Date.now() + 8000)).disposition).toBe(
      "COMPLETED",
    );

    keys.length = 0;
    expect((await direct(e)).status).toBe(401);
    keys.push(key);
    const invalidHeaders = new Headers(e.headers);
    invalidHeaders.set("x-lyra-signature", "invalid");
    expect((await direct({ ...e, headers: invalidHeaders })).status).toBe(401);
    const expired = await signEnvelope(
      bridge.config,
      e.path,
      e.body,
      Math.floor(Date.now() / 1000) - 61,
      e.headers.get("x-lyra-request-id")!,
    );
    expect((await direct(expired)).status).toBe(401);
    expect(posts.filter((p) => p.url.includes("wp-json"))).toHaveLength(1);
  } finally {
    await server?.close();
    await db.$disconnect();
    await admin.end();
    await op.end();
  }
}, 30000);
