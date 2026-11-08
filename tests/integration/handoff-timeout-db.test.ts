import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { startControlledRuntime } from "../../apps/lyraseo-web/src/server/runtime/listener";
import { createControlledFixture } from "../../apps/lyraseo-web/src/server/runtime/fixture";
import { createHandoffFixture } from "../../apps/lyraseo-web/src/server/runtime/handoff-fixture";
import { Bridge, signEnvelope } from "../../apps/lyraseo-worker/src/bridge";
import { runtimePaths } from "../../packages/contracts/src/runtime-signing";
const database = process.env.LYRA_HANDOFF_CARRIER_DB ?? "";
const validFixtureDatabase = /^lyraseo_handoff_[a-f0-9]{12}$/.test(database);
if (process.env.LYRA_REQUIRE_HANDOFF_CARRIER === "1" && !validFixtureDatabase)
  throw Error("DISPOSABLE_HANDOFF_DB_REQUIRED");
const test = validFixtureDatabase ? it : it.skip;
const { Client } = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
)("pg");

test("provider timeouts settle while authorized and signer revocation denies settlement", async () => {
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
    user = `timeout-user-${suffix}`,
    workspace = `timeout-workspace-${suffix}`,
    site = `timeout-site-${suffix}`;
  const bytes = randomBytes(32),
    key = {
      id: "fixture",
      principal: "lyraseo_dispatch",
      audience: "lyraseo-kernel-a",
      actions: runtimePaths,
      secret: bytes,
    },
    keys = [key];
  const env = {
    WORK_QUEUE: { send: async () => ({}) },
    CARRIER_QUALIFIED: "true",
    CARRIER_ENABLED: "true",
    BRIDGE_ORIGIN: "https://bridge.test.invalid",
    BRIDGE_KEY_ID: key.id,
    BRIDGE_SECRET: bytes.toString("base64url"),
    BRIDGE_PRINCIPAL: key.principal,
    BRIDGE_AUDIENCE: key.audience,
  } as Env;
  const secret = Buffer.alloc(32, 8).toString("base64url"),
    posts: Array<{ url: string; body: string; event?: string }> = [];
  let mode: "hang" | "succeed" | "revoke" = "hang",
    aborted = 0;
  const fixture = createHandoffFixture(
    "https://example.com",
    (_cipher, b) =>
      b.kind === "WORDPRESS"
        ? JSON.stringify({
            username: "fixture",
            applicationPassword: "fixture",
          })
        : secret,
    async (url, body, headers, signal) => {
      posts.push({ url, body, event: headers["X-Lyraseo-Event-Id"] });
      if (mode === "succeed") return { status: 204, body: "" };
      return await new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted++;
            if (mode === "revoke") keys.length = 0;
            reject(Error("fixture timeout"));
          },
          { once: true },
        ),
      );
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
      "INSERT INTO public.\"Workspace\"(id,name) VALUES ($1,'Timeout')",
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
    const destinations = new Map<string, string>();
    const seed = async (kind: "WEBHOOK" | "WORDPRESS") => {
      const destination = destinations.get(kind) ?? randomUUID(),
        intent = randomUUID(),
        event = randomUUID(),
        draft = `timeout-draft-${randomUUID()}`;
      const connection =
        kind === "WORDPRESS"
          ? "https://example.com/blog/"
          : "https://example.com/hook";
      const target =
        kind === "WORDPRESS"
          ? `${connection}wp-json/wp/v2/posts?_fields=id,status,link`
          : connection;
      const body =
        kind === "WORDPRESS"
          ? JSON.stringify({
              title: "Timeout",
              content: "<p>Timeout</p>",
              status: "draft",
            })
          : JSON.stringify({ id: event, workspaceId: workspace, siteId: site });
      if (kind === "WORDPRESS")
        await admin.query(
          `INSERT INTO public."ContentDraft"(id,"workspaceId","siteId",kind,snapshot) VALUES ($1,$2,$3,'draft','{}')`,
          [draft, workspace, site],
        );
      if (!destinations.has(kind))
        await admin.query(
          `INSERT INTO lyraseo_handoff.destination(id,workspace_id,site_id,kind,url,secret_cipher,key_id,status,created_by) VALUES ($1,$2,$3,$4,$5,'fixture',$6,'CONFIGURED',$7)`,
          [
            destination,
            workspace,
            site,
            kind,
            connection,
            kind === "WEBHOOK" ? "key" : null,
            user,
          ],
        );
      destinations.set(kind, destination);
      await admin.query(
        `INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,event_type,event_id,draft_id,body,body_hash,renderer_version,destination_url) VALUES ($1,$2,$3,$4,1,$5,$6,0,$7,repeat('a',64),'FIXTURE',$8,$9,$10,$11,encode(sha256(convert_to($11,'UTF8')),'hex'),'fixture',$12)`,
        [
          intent,
          workspace,
          site,
          destination,
          kind,
          user,
          randomUUID(),
          kind === "WEBHOOK" ? "test" : null,
          event,
          kind === "WORDPRESS" ? draft : null,
          body,
          target,
        ],
      );
      return { intent, event, body };
    };
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
    const envelope = async (ref: { workId: string; generation: number }) =>
      signEnvelope(
        bridge.config,
        runtimePaths[3],
        JSON.stringify({
          version: 1,
          workId: ref.workId,
          generation: ref.generation,
        }),
      );
    const wp = await seed("WORDPRESS"),
      wpRef = await claim(),
      wpEnvelope = await envelope(wpRef),
      started = Date.now();
    expect(
      (await bridge.send(wpEnvelope, Date.now() + 20000)).disposition,
    ).toBe("COMPLETED");
    expect(Date.now() - started).toBeLessThan(16000);
    expect(
      (
        await admin.query(
          `SELECT state FROM lyraseo_handoff.intent WHERE id=$1`,
          [wp.intent],
        )
      ).rows[0].state,
    ).toBe("UNRESOLVED");
    expect(
      (
        await admin.query(
          `SELECT outcome,status,code FROM lyraseo_handoff.receipt WHERE intent_id=$1`,
          [wp.intent],
        )
      ).rows,
    ).toEqual([
      { outcome: "UNRESOLVED", status: null, code: "TRANSPORT_UNKNOWN" },
    ]);
    expect((await bridge.send(wpEnvelope, Date.now() + 8000)).disposition).toBe(
      "COMPLETED",
    );
    expect(posts.filter((p) => p.url.includes("wp-json"))).toHaveLength(1);
    const hook = await seed("WEBHOOK"),
      hookRef = await claim(),
      hookEnvelope = await envelope(hookRef),
      hookStarted = Date.now();
    expect(
      (await bridge.send(hookEnvelope, Date.now() + 20000)).disposition,
    ).toBe("COMPLETED");
    expect(Date.now() - hookStarted).toBeLessThan(16000);
    const hookState = (
      await admin.query(
        `SELECT state,extract(epoch FROM next_due_at-clock_timestamp()) AS seconds FROM lyraseo_handoff.intent WHERE id=$1`,
        [hook.intent],
      )
    ).rows[0];
    expect(hookState.state).toBe("RETRY");
    expect(Number(hookState.seconds)).toBeGreaterThan(45);
    expect(Number(hookState.seconds)).toBeLessThanOrEqual(60);
    expect(
      (
        await admin.query(
          `SELECT outcome,status,code FROM lyraseo_handoff.receipt WHERE intent_id=$1`,
          [hook.intent],
        )
      ).rows,
    ).toEqual([{ outcome: "RETRY", status: null, code: "TRANSPORT_UNKNOWN" }]);
    await admin.query(
      `UPDATE lyraseo_handoff.intent SET next_due_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [hook.intent],
    );
    await admin.query(
      `UPDATE lyraseo_handoff.dispatch SET next_due=clock_timestamp()-interval '1 second' WHERE intent_id=$1`,
      [hook.intent],
    );
    mode = "succeed";
    const retryRef = await claim();
    expect(retryRef.generation).toBe(hookRef.generation + 1);
    expect(
      (await bridge.send(await envelope(retryRef), Date.now() + 8000))
        .disposition,
    ).toBe("COMPLETED");
    expect(
      posts.filter((p) => p.event === hook.event).map((p) => p.body),
    ).toEqual([hook.body, hook.body]);
    const revoked = await seed("WEBHOOK"),
      revokedRef = await claim(),
      revokedEnvelope = await envelope(revokedRef);
    mode = "revoke";
    await expect(
      bridge.send(revokedEnvelope, Date.now() + 20000),
    ).rejects.toThrow();
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS count FROM lyraseo_handoff.receipt WHERE intent_id=$1`,
          [revoked.intent],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query(
          `SELECT state FROM lyraseo_handoff.intent WHERE id=$1`,
          [revoked.intent],
        )
      ).rows[0].state,
    ).toBe("SENDING");
    expect(aborted).toBe(3);
  } finally {
    await server?.close();
    await db.$disconnect();
    await admin.end();
    await op.end();
  }
}, 60000);
