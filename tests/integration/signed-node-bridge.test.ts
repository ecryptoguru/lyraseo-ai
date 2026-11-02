import { createHmac, createHash, randomUUID, randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { once } from "node:events";
import { connect } from "node:net";
import { request as http } from "node:http";
import { afterEach, afterAll, beforeEach, it, expect, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { startControlledRuntime } from "../../apps/lyraseo-web/src/server/runtime/listener";
import {
  runtimePaths,
  type RuntimePath,
  type RuntimeKey,
} from "../../packages/contracts/src/runtime-signing";
import {
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
  actor,
} from "../helpers/database";
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";
import { acquireRawPage } from "../../packages/visibility/src/acquisition";
import {
  cancelAuditRun,
  createAuditRun,
  claimAuditRun,
} from "../../packages/db/src/audits";
import { admitStep, checkStep } from "../../packages/db/src/bridge";
import {
  createControlledFixture,
  type ControlledFixture,
} from "../../apps/lyraseo-web/src/server/runtime/fixture";
const admin = createDatabase(adminUrl),
  web = createDatabase(runtimeUrl);
const u = new URL(adminUrl);
u.username = "lyraseo_dispatch";
u.password = "local_dispatch_only";
const db = createDatabase(u.href);
const key: RuntimeKey = {
  id: "original",
  principal: "lyraseo_dispatch",
  audience: "lyraseo-kernel-a",
  actions: runtimePaths,
  secret: new Uint8Array(randomBytes(32)),
};
const rotated: RuntimeKey = {
  ...key,
  id: "replacement",
  secret: new Uint8Array(randomBytes(32)),
};
let keys: RuntimeKey[] = [key, rotated];
let listener: Awaited<ReturnType<typeof startControlledRuntime>> | undefined;
const urls: string[] = [];
let transport: ControlledFixture["request"];
let afterResolve: (() => Promise<void>) | undefined;
function signing(
  path: RuntimePath,
  body: string,
  rid = randomUUID(),
  issued = Math.floor(Date.now() / 1000),
  expires = issued + 60,
  k = key,
  bytes?: Buffer,
) {
  const values = [
    "lyra-runtime-v1",
    k.id,
    k.principal,
    k.audience,
    "POST",
    path,
    String(issued),
    String(expires),
    rid,
    createHash("sha256")
      .update(bytes ?? body)
      .digest("hex"),
  ];
  const mac = createHmac("sha256", k.secret);
  for (const val of values) {
    const b = Buffer.from(val);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    mac.update(len);
    mac.update(b);
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-lyra-key-id": k.id,
    "x-lyra-principal": k.principal,
    "x-lyra-audience": k.audience,
    "x-lyra-issued-at": String(issued),
    "x-lyra-expires-at": String(expires),
    "x-lyra-request-id": rid,
    "x-lyra-signature": mac.digest("base64url"),
  };
  return { body, bytes, path, headers, rid, issued, expires };
}
type Signed = ReturnType<typeof signing>;
function wire(
  e: Signed,
  path: string = e.path,
  headers: Record<string, string | string[]> = e.headers,
  method = "POST",
) {
  return new Promise<{
    status: number;
    data: Record<string, unknown>;
    headers: import("node:http").IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = http(listener!.origin, { path, method, headers }, (res) => {
      let body = "";
      res.on("data", (s) => (body += s));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          data: JSON.parse(body || "{}"),
          headers: res.headers,
        }),
      );
    });
    req.on("error", reject);
    if (method === "POST") req.write(e.bytes ?? e.body);
    req.end();
  });
}
const ok = async (e: Signed) => {
  const r = await wire(e);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
async function boot(handlerBudgetMs?: number) {
  listener = await startControlledRuntime({
    db,
    keys: () => keys,
    handlerBudgetMs,
    fixture: createControlledFixture(
      "https://example.com",
      (url, signal) =>
        transport(url, signal, async () => signal.throwIfAborted()),
      async () => {
        await afterResolve?.();
      },
    ),
  });
}
async function fixture(pages = 2) {
  const audit = await admin.auditRun.create({
    data: {
      workspaceId: "a",
      siteId: "a-site",
      userId: "owner",
      securityVersion: 0,
      idempotencyKey: randomUUID(),
      inputHash: "fixture",
      profile: "CONTROLLED_RAW_TEST_V1",
      declarations: {},
      methodologyVersion: "readiness-v2",
      manifest: ["https://example.com/", "https://example.com/about"].slice(
        0,
        pages,
      ),
    },
  });
  const d = await admin.workDispatch.create({
    data: {
      workspaceId: "a",
      siteId: "a-site",
      userId: "owner",
      admittedSecurityVersion: 0,
      targetKind: "AUDIT_RAW",
      auditId: audit.id,
      capability: "audits",
      profile: audit.profile,
      eligibility: "CONTROLLED_TEST",
      admittedAt: audit.createdAt,
      expiresAt: new Date(+audit.createdAt + 3600000),
      disposition: "PENDING",
      nextAttemptAt: new Date(),
    },
  });
  return { audit, d };
}
async function claim() {
  const result = await ok(signing(runtimePaths[0], '{"limit":2}'));
  return (
    result.refs as { workId: string; generation: number; claimToken: string }[]
  )[0]!;
}
const ack = (ref: Awaited<ReturnType<typeof claim>>) =>
  ok(signing(runtimePaths[1], JSON.stringify(ref)));
const step = (ref: Awaited<ReturnType<typeof claim>>) =>
  signing(
    runtimePaths[3],
    JSON.stringify({
      version: 1,
      workId: ref.workId,
      generation: ref.generation,
    }),
  );
const env = (e: Signed) => ({
  requestId: e.rid,
  rawBody: e.body,
  audience: key.audience,
  issuedAt: new Date(e.issued * 1000),
  expiresAt: new Date(e.expires * 1000),
});
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  await admin.internalRequest.deleteMany();
  await admin.runtimePolicy.updateMany({
    data: { enabled: true },
    where: { key: { in: ["global", "audits"] } },
  });
  urls.length = 0;
  keys = [key, rotated];
  afterResolve = undefined;
  transport = async (url, signal, gate) => {
    await gate();
    signal.throwIfAborted();
    urls.push(url);
    return url.endsWith("robots.txt")
      ? new Response("User-agent: *\nAllow: /")
      : new Response(
          "<html><head><title>Fixture</title></head><body><main>Fixture body</main></body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
  };
  await boot();
});
afterEach(async () => {
  await listener?.close();
  listener = undefined;
  await admin.runtimePolicy.updateMany({ data: { enabled: false } });
});
afterAll(() =>
  Promise.all([admin.$disconnect(), db.$disconnect(), web.$disconnect()]),
);
it("uses exact signed HTTP → ack → two immutable generations; restart/rekey and lost response never refetch", async () => {
  const { audit, d } = await fixture();
  const ref = await claim(),
    first = step(ref);
  expect(await wire(first)).toMatchObject({
    status: 503,
    data: { disposition: "RETRY" },
  });
  expect(await ack(ref)).toEqual({ disposition: "DELIVERED" });
  expect(await ok(first)).toEqual({ disposition: "YIELDED" });
  expect(await admin.auditPage.count()).toBe(1);
  await listener!.close();
  await boot();
  keys = [rotated];
  expect(
    await ok(
      signing(
        first.path,
        first.body,
        first.rid,
        first.issued,
        first.expires,
        rotated,
      ),
    ),
  ).toEqual({ disposition: "YIELDED" });
  expect(await wire(first)).toMatchObject({ status: 401 });
  keys = [key, rotated];
  expect(
    await wire(
      signing(
        first.path,
        first.body,
        first.rid,
        first.issued - 1,
        first.expires - 1,
      ),
    ),
  ).toMatchObject({ status: 409 });
  expect(await ack(ref)).toEqual({ disposition: "STALE" });
  expect(urls).toHaveLength(2);
  const second = await claim();
  expect(second.generation).toBe(2);
  await ack(second);
  const last = step(second);
  expect(await ok(last)).toEqual({ disposition: "COMPLETED" });
  expect(await ok(last)).toEqual({ disposition: "COMPLETED" });
  const saved = await admin.auditRun.findUniqueOrThrow({
    where: { id: audit.id },
  });
  expect(saved).toMatchObject({
    status: "COMPLETED",
    profile: "CONTROLLED_RAW_TEST_V1",
    evaluation: {
      methodologyVersion: "readiness-v2",
      rules: expect.arrayContaining([
        expect.objectContaining({ ruleId: "D01", outcome: "PASS" }),
        expect.objectContaining({ ruleId: "E01", outcome: "UNKNOWN" }),
      ]),
    },
  });
  expect(
    await admin.workDispatch.findUniqueOrThrow({ where: { id: d.id } }),
  ).toMatchObject({ disposition: "SUPPRESSED", generation: 2 });
  expect(urls).toHaveLength(4);
  expect(await admin.auditPage.count()).toBe(2);
  expect(await admin.operation.count()).toBe(0);
  expect(await admin.usageReceipt.count()).toBe(0);
});
it("rejects raw aliases, duplicate headers, oversize chunked, compression, keys and cookie-only before reservation", async () => {
  const e = signing(runtimePaths[0], '{"limit":2}');
  for (const path of [
    e.path + "/",
    e.path + "?",
    e.path + "?x=1",
    e.path.replace("/runtime/", "/runtime//"),
    "/api/x/../internal/runtime/dispatch",
    e.path.replace("/dispatch", "/%64ispatch"),
    e.path.replace("/runtime/", "/runtime\\"),
  ])
    expect(await wire(e, path)).toMatchObject({
      status: 404,
      headers: { "cache-control": "private, no-store" },
    });
  expect(await wire(e, e.path, e.headers, "GET")).toMatchObject({
    status: 405,
  });
  for (const h of [
    { "x-lyra-issued-at": [String(e.issued), String(e.issued)] },
    { host: "other.test" },
    { "content-encoding": "gzip" },
    { "x-http-method-override": "POST" },
    { "x-lyra-principal": "another" },
    { "x-lyra-audience": "other" },
    { "x-lyra-key-id": "unknown" },
    { "x-lyra-signature": e.headers["x-lyra-signature"] + "=" },
  ]) {
    expect(
      await wire(e, e.path, { ...e.headers, ...h } as Record<
        string,
        string | string[]
      >),
    ).toMatchObject({ status: 401 });
  }
  expect(
    await wire(e, e.path, {
      cookie: "signed-session=test",
      "content-type": "application/json",
    }),
  ).toMatchObject({ status: 401 });
  for (const p of runtimePaths)
    expect(
      await wire(
        signing(
          p,
          " ".repeat(
            p === runtimePaths[0] || p === runtimePaths[4] ? 8193 : 1025,
          ),
        ),
      ),
    ).toMatchObject({ status: 401 });
  for (const bad of ['{"limit":1,"limit":2}', "null", "{"])
    expect(await wire(signing(e.path, bad))).toMatchObject({ status: 400 });
  expect(await admin.internalRequest.count()).toBe(0);
  expect(urls).toEqual([]);
});
it("signed defer rotates token; stale defer cannot undo replacement", async () => {
  await fixture();
  const ref = await claim();
  const deferred = signing(
    runtimePaths[2],
    JSON.stringify({ ...ref, retrySeconds: 1 }),
  );
  expect(await wire(deferred, runtimePaths[1])).toMatchObject({ status: 401 });
  expect(await ok(deferred)).toEqual({ disposition: "DEFERRED" });
  await admin.workDispatch.update({
    where: { id: ref.workId },
    data: { nextAttemptAt: new Date(0) },
  });
  const replacement = await claim();
  expect(replacement.claimToken).not.toEqual(ref.claimToken);
  expect(await ok(signing(runtimePaths[2], deferred.body))).toEqual({
    disposition: "STALE",
  });
  expect(await ack(replacement)).toEqual({ disposition: "DELIVERED" });
});
it("allows a twelve-second receipt despite the control lease being ten seconds", async () => {
  await fixture(1);
  const ref = await claim();
  await ack(ref);
  const original = transport;
  transport = async (url, sig, gate) => {
    if (!url.endsWith("robots.txt"))
      await new Promise((r) => setTimeout(r, 11500));
    return original(url, sig, gate);
  };
  expect(await ok(step(ref))).toEqual({ disposition: "COMPLETED" });
}, 25000);
it("reclaims expired RUNNING work; fences the dead process and refuses a forged proof or direct commit", async () => {
  const { d, audit } = await fixture(1),
    ref = await claim();
  await ack(ref);
  const e = step(ref),
    attempt = await admitStep(db, env(e), "https://example.com");
  if (attempt.disposition !== "ADMITTED") throw new Error("admit failed");
  expect(await ok(e)).toEqual({ disposition: "IN_PROGRESS" });
  await expect(checkStep(db, randomUUID(), attempt.proof)).rejects.toThrow();
  await expect(
    db.$queryRaw`SELECT lyraseo_audit.commit_step(${e.rid}::uuid,${"x".repeat(72)},'{}'::json,NULL)`,
  ).rejects.toThrow(/STALE_ATTEMPT/);
  await admin.auditRun.update({
    where: { id: audit.id },
    data: { leaseUntil: new Date(0) },
  });
  await admin.workDispatch.update({
    where: { id: d.id },
    data: { nextAttemptAt: new Date(0) },
  });
  expect(await ok(signing(runtimePaths[4], '{"limit":1}'))).toMatchObject({
    reopened: 1,
    suppressed: 0,
  });
  const next = await claim();
  expect(next.generation).toBe(2);
  await ack(next);
  expect(await ok(step(next))).toEqual({ disposition: "COMPLETED" });
  await expect(checkStep(db, e.rid, attempt.proof)).rejects.toThrow();
  expect(await admin.auditPage.count()).toBe(1);
});
it.each([
  "pause",
  "cancel",
  "epoch",
  "viewer",
  "editor-grant-removal",
  "editor-membership-removal",
  "deleted",
  "suspend",
  "proof",
  "signer",
])(
  "aborts in-flight I/O after %s within one second without a failed page",
  async (kind) => {
    if (
      kind === "editor-grant-removal" ||
      kind === "editor-membership-removal"
    ) {
      await admin.membership.update({
        where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
        data: { role: "EDITOR" },
      });
      await admin.siteGrant.create({
        data: { workspaceId: "a", siteId: "a-site", userId: "owner" },
      });
    }
    const { audit } = await fixture(1),
      ref = await claim();
    await ack(ref);
    let started!: () => void, aborted!: () => void;
    const pending = new Promise<void>((r) => (started = r)),
      stopped = new Promise<void>((r) => (aborted = r));
    transport = async (url, signal, gate) => {
      await gate();
      urls.push(url);
      started();
      return new Response(
        new ReadableStream({
          start(ctrl) {
            signal.addEventListener(
              "abort",
              () => {
                aborted();
                ctrl.error(new Error("stopped"));
              },
              { once: true },
            );
          },
        }),
      );
    };
    const response = wire(step(ref));
    await pending;
    if (kind === "signer") keys = [rotated];
    if (kind === "pause")
      await admin.runtimePolicy.update({
        where: { key: "global" },
        data: { enabled: false },
      });
    if (kind === "cancel")
      await cancelAuditRun(web, actor, {
        workspaceId: "a",
        siteId: "a-site",
        auditId: audit.id,
      });
    if (kind === "epoch")
      await admin.productUser.update({
        where: { id: "owner" },
        data: { securityVersion: 1 },
      });
    if (kind === "suspend")
      await admin.productUser.update({
        where: { id: "owner" },
        data: { suspended: true },
      });
    if (kind === "editor-grant-removal")
      await admin.siteGrant.delete({
        where: {
          workspaceId_siteId_userId: {
            workspaceId: "a",
            siteId: "a-site",
            userId: "owner",
          },
        },
      });
    if (kind === "editor-membership-removal")
      await admin.membership.delete({
        where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
      });
    if (kind === "viewer")
      await admin.membership.update({
        where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
        data: { role: "VIEWER" },
      });
    if (kind === "deleted")
      await admin.site.update({
        where: { id: "a-site" },
        data: { deletedAt: new Date() },
      });
    if (kind === "proof")
      await admin.site.update({
        where: { id: "a-site" },
        data: { verifiedAt: new Date(0) },
      });
    await Promise.race([
      stopped,
      new Promise((_, rej) => {
        const timer = setTimeout(
          () => rej(new Error("abort exceeded 1s")),
          1000,
        );
        timer.unref();
      }),
    ]);
    expect((await response).status).toBe(kind === "signer" ? 401 : 503);
    expect(await admin.auditPage.count()).toBe(0);
    expect(urls).toHaveLength(1);
  },
);

it("writes at most one HTTP response to an unframed malformed GET", async () => {
  const target = new URL(listener!.origin);
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname, () =>
      socket.write(
        "GET /api/internal/runtime/step HTTP/1.1\r\nHost: " +
          target.host +
          "\r\nConnection: close\r\n\r\n{malformed}",
      ),
    );
    let bytes = "";
    socket.on("data", (b) => (bytes += b.toString()));
    socket.on("end", () => resolve(bytes));
    socket.on("error", reject);
  });
  expect(raw.match(/HTTP\/1\.1 /g)).toHaveLength(1);
  expect(raw).toMatch(/^HTTP\/1\.1 (400|405) /);
  expect(await admin.internalRequest.count()).toBe(0);
});

it.each(["page", "audit", "delivery", "replay"])(
  "rolls back the whole step when the %s write fails",
  async (stage) => {
    const { d, audit } = await fixture(),
      ref = await claim();
    await ack(ref);
    // Test-only admin trigger fails after a real finalizer write, inside its tx.
    const triggers = {
      page: ['"AuditPage"', "INSERT", ""],
      audit: ['"AuditRun"', "UPDATE", "WHEN (NEW.status='QUEUED')"],
      delivery: [
        '"WorkDispatch"',
        "UPDATE",
        "WHEN (NEW.generation>OLD.generation)",
      ],
      replay: ['"InternalRequest"', "UPDATE", "WHEN (NEW.state='COMPLETE')"],
    } as const;
    const [table, operation, predicate] =
      triggers[stage as keyof typeof triggers];
    await admin.$executeRawUnsafe(
      "CREATE FUNCTION lyraseo_audit.test_rollback_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_ROLLBACK'; END $$",
    );
    try {
      await admin.$executeRawUnsafe(
        `CREATE TRIGGER test_bridge_rollback AFTER ${operation} ON ${table} FOR EACH ROW ${predicate} EXECUTE FUNCTION lyraseo_audit.test_rollback_probe()`,
      );
      const e = step(ref);
      expect(await wire(e)).toMatchObject({
        status: 503,
        data: { error: "UNAVAILABLE" },
      });
      expect(await admin.auditPage.count()).toBe(0);
      expect(
        await admin.auditRun.findUniqueOrThrow({ where: { id: audit.id } }),
      ).toMatchObject({ status: "RUNNING", fence: 1, evaluation: null });
      expect(
        await admin.workDispatch.findUniqueOrThrow({ where: { id: d.id } }),
      ).toMatchObject({ generation: 1, disposition: "DELIVERED" });
      expect(
        await admin.internalRequest.findFirstOrThrow({
          where: { requestId: e.rid },
        }),
      ).toMatchObject({ state: "ACTIVE", result: null });
    } finally {
      await admin.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS test_bridge_rollback ON ${table}`,
      );
      await admin.$executeRawUnsafe(
        "DROP FUNCTION lyraseo_audit.test_rollback_probe()",
      );
    }
  },
);

it("blocks direct bridge DML, role switching, private guard calls and forged GUCs", async () => {
  const { audit, d } = await fixture(1);
  for (const sql of [
    'SELECT id FROM "Site"',
    'SELECT evidence FROM "AuditPage"',
    "UPDATE \"AuditRun\" SET status='COMPLETED'",
    'SELECT "tokenHash" FROM "ApiToken"',
    "SELECT * FROM lyraseo_audit.attempt",
    'SELECT * FROM "UsageReceipt"',
    "SET ROLE lyraseo_kernel_owner",
    "SET ROLE lyraseo_runtime",
    "SELECT lyraseo_audit.web_can_run('a-site')",
    "SELECT lyraseo_audit.read_target('id')",
  ])
    await expect(db.$queryRawUnsafe(sql)).rejects.toThrow(/permission denied/);
  for (const sql of [
    "SELECT * FROM lyraseo_audit.attempt",
    'SELECT * FROM "WorkDispatch"',
    "SELECT lyraseo_audit.check_step(gen_random_uuid(),'x')",
    "SELECT lyraseo_audit.run_site_permission('a','a-site','owner')",
    "SELECT lyraseo_kernel.read_policy('global')",
    'UPDATE "AuditRun" SET fence=0',
    'DELETE FROM "AuditPage"',
    'INSERT INTO "AuditPage" DEFAULT VALUES',
  ])
    await expect(web.$queryRawUnsafe(sql)).rejects.toThrow(/permission denied/);
  await expect(
    web.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id','owner',true),set_config('app.workspace_id','a',true)`;
      return tx.$queryRaw`SELECT lyraseo_audit.web_transition('a-site',${audit.id},0,'claim',NULL,'fake',NULL)`;
    }),
  ).rejects.toThrow(/FORBIDDEN/);
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id','owner',true),set_config('app.workspace_id','a',true)`;
      return tx.$queryRaw`SELECT lyraseo_audit.commit_step(${randomUUID()}::uuid,${"p".repeat(72)},'{}'::json,NULL)`;
    }),
  ).rejects.toThrow(/STALE_ATTEMPT/);
  expect(
    await ok(
      signing(
        runtimePaths[3],
        JSON.stringify({ version: 1, workId: randomUUID(), generation: 1 }),
      ),
    ),
  ).toEqual({ disposition: "STALE" });
  expect(
    await admin.auditRun.findUniqueOrThrow({ where: { id: audit.id } }),
  ).toMatchObject({ fence: 0, status: "QUEUED" });
  expect(
    await admin.workDispatch.findUniqueOrThrow({ where: { id: d.id } }),
  ).toMatchObject({ generation: 1, disposition: "PENDING" });
  expect(urls).toEqual([]);
});

it("checks the DB clock after a contended replay lock even for a COMPLETE step", async () => {
  const now = Math.floor(Date.now() / 1000);
  const e = signing(
    runtimePaths[3],
    JSON.stringify({ version: 1, workId: randomUUID(), generation: 1 }),
    randomUUID(),
    now - 57,
    now + 3,
  );
  const r = env(e);
  const [dig] = await admin.$queryRaw<
    { digest: Uint8Array }[]
  >`SELECT sha256(convert_to(jsonb_build_array('v1',${r.audience}::text,'POST',${e.path}::text,
 encode(sha256(convert_to(${e.body}::text,'UTF8')),'hex'),extract(epoch from ${r.issuedAt}::timestamptz),extract(epoch from ${r.expiresAt}::timestamptz))::text,'UTF8')) AS digest`;
  await admin.internalRequest.create({
    data: {
      servicePrincipalId: "lyraseo_dispatch",
      requestId: e.rid,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      fingerprint: new Uint8Array(dig!.digest),
      state: "COMPLETE",
      fence: 1,
      completedAt: new Date(),
      result: { disposition: "YIELDED" },
    },
  });
  let response!: ReturnType<typeof wire>;
  await admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "InternalRequest" WHERE "requestId"=${e.rid}::uuid FOR UPDATE`;
      response = wire(e);
      await expect
        .poll(
          async () => {
            const [row] = await admin.$queryRaw<
              { waiting: boolean }[]
            >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_dispatch' AND wait_event_type='Lock') AS waiting`;
            return row!.waiting;
          },
          { timeout: 1500, interval: 10 },
        )
        .toBe(true);
      await tx.$queryRaw`SELECT 1 FROM pg_sleep(greatest(0,extract(epoch from ${r.expiresAt}::timestamptz-clock_timestamp())))`;
    },
    { timeout: 6000 },
  );
  expect(await response).toMatchObject({
    status: 400,
    data: { error: "INVALID_REQUEST" },
  });
  expect(urls).toEqual([]);
});
it("revocation after DNS, redirect or the last byte prevents subsequent dispatch and persistence", async () => {
  for (const point of ["post-dns", "redirect", "last-byte"]) {
    if (point !== "post-dns") {
      await resetDatabase();
      await seedTenants();
    }
    await admin.runtimePolicy.update({
      where: { key: "global" },
      data: { enabled: true },
    });
    await fixture(1);
    const ref = await claim();
    await ack(ref);
    const sockets: string[] = [];
    afterResolve =
      point === "post-dns"
        ? async () => {
            await admin.runtimePolicy.update({
              where: { key: "global" },
              data: { enabled: false },
            });
          }
        : undefined;
    transport = async (url, signal, gate) => {
      const revoke = () =>
        admin.runtimePolicy.update({
          where: { key: "global" },
          data: { enabled: false },
        });
      await gate();
      signal.throwIfAborted();
      sockets.push(url);
      if (url.endsWith("robots.txt"))
        return new Response("User-agent: *\nAllow: /");
      if (point === "redirect") {
        await revoke();
        return new Response(null, {
          status: 302,
          headers: { location: "/elsewhere" },
        });
      }
      await revoke();
      return new Response("<html>Complete bytes</html>", {
        headers: { "Content-Type": "text/html" },
      });
    };
    expect((await wire(step(ref))).status).toBe(503);
    expect(sockets.length).toBe(point === "post-dns" ? 0 : 2);
    expect(await admin.auditPage.count()).toBe(0);
  }
});
it("persists UNKNOWN for 204, NUL or unavailable bytes without fabricating rendered evidence", async () => {
  for (const input of ["204", "nul", "unavailable"]) {
    if (input !== "204") {
      await resetDatabase();
      await seedTenants();
    }
    const { audit } = await fixture(1);
    const ref = await claim();
    await ack(ref);
    transport = async (url, signal, gate) => {
      await gate();
      signal.throwIfAborted();
      if (url.endsWith("robots.txt"))
        return new Response(null, { status: 404 });
      if (input === "unavailable") throw new Error("ACQUISITION_FAILED");
      return new Response(input === "nul" ? "ab\u0000cd" : null, {
        status: input === "204" ? 204 : 200,
        headers: { "Content-Type": "text/html" },
      });
    };
    expect(await ok(step(ref))).toEqual({ disposition: "COMPLETED" });
    const saved = await admin.auditRun.findUniqueOrThrow({
      where: { id: audit.id },
    });
    expect(saved.evaluation).toMatchObject({
      rules: expect.arrayContaining([
        expect.objectContaining({ ruleId: "D01", outcome: "UNKNOWN" }),
      ]),
    });
    const page = await admin.auditPage.findFirstOrThrow({
      where: { auditId: audit.id },
    });
    expect(page.evidence).toMatchObject({
      acquired: false,
      headComplete: false,
      bodyComplete: false,
    });
    expect(page.provenance).not.toHaveProperty("rawHtml");
  }
});

it("recovers exact replay in new OS processes after both lost step responses", async () => {
  await listener!.close();
  listener = undefined;
  const require = createRequire(import.meta.url);
  const nodePackage = require.resolve("vite-node/package.json", {
    paths: [dirname(require.resolve("vitest/package.json"))],
  });
  const cli = resolve(dirname(nodePackage), "vite-node.mjs");
  const events: number[] = [];
  const bootChild = async () => {
    const child = fork(cli, ["tests/fixtures/runtime/listener-process.ts"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let calls = 0;
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        child.on("error", reject);
        child.once("exit", () =>
          reject(new Error("controlled listener exited before ready")),
        );
        child.on("message", (message: { event: string; origin?: string }) => {
          if (message.event === "configure")
            child.send({ secret: Buffer.from(key.secret).toString("base64") });
          if (message.event === "ready") resolve(message.origin!);
          if (message.event === "fixture-hop") calls++;
        });
      });
      listener = {
        origin,
        async close() {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
          events.push(calls);
        },
      };
    } catch (error) {
      child.kill();
      throw error;
    }
  };
  await bootChild();
  await fixture();
  const ref = await claim();
  await ack(ref);
  const first = step(ref);
  expect(await ok(first)).toEqual({ disposition: "YIELDED" });
  await listener!.close();
  listener = undefined;
  await bootChild();
  expect(await ok(first)).toEqual({ disposition: "YIELDED" });
  const second = await claim();
  await ack(second);
  const terminal = step(second);
  expect(await ok(terminal)).toEqual({ disposition: "COMPLETED" });
  await listener!.close();
  listener = undefined;
  await bootChild();
  expect(await ok(terminal)).toEqual({ disposition: "COMPLETED" });
  await listener!.close();
  listener = undefined;
  expect(events).toEqual([2, 2, 0]);
  expect(await admin.auditPage.count()).toBe(2);
}, 30000);

it("duplicates share one live attempt while another signed request waits for the audit lease", async () => {
  await fixture(1);
  const ref = await claim();
  await ack(ref);
  const e = step(ref);
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (enter = r)),
    hold = new Promise<void>((r) => (release = r));
  const original = transport;
  transport = async (...args) => {
    enter();
    await hold;
    return original(...args);
  };
  const first = wire(e);
  await started;
  try {
    expect(await ok(e)).toEqual({ disposition: "IN_PROGRESS" });
    expect(await wire(step(ref))).toMatchObject({
      status: 503,
      data: { disposition: "RETRY" },
    });
  } finally {
    release();
  }
  expect(await first).toMatchObject({
    status: 200,
    data: { disposition: "COMPLETED" },
  });
  expect(urls).toHaveLength(2);
  expect(await admin.auditPage.count()).toBe(1);
});

it("binds the exact maximum-length body to PostgreSQL's UTF-8 hash on each action", async () => {
  const ref = { workId: randomUUID(), generation: 1, claimToken: randomUUID() };
  const bodies = [
    String.raw`{"lim\u0069t":1}`,
    JSON.stringify(ref),
    JSON.stringify({ ...ref, retrySeconds: 1 }),
    JSON.stringify({ version: 1, workId: ref.workId, generation: 1 }),
    '{"limit":1}',
  ];
  for (const [i, path] of runtimePaths.entries()) {
    const max =
      path === runtimePaths[0] || path === runtimePaths[4] ? 8192 : 1024;
    const raw = bodies[i]!.padEnd(max, " "),
      e = signing(path, raw);
    const result = await ok(e);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      32768,
    );
    if (path === runtimePaths[3]) {
      expect(result.disposition).toBe("STALE");
      continue;
    }
    const [row] = await admin.$queryRaw<
      { fingerprintMatches: boolean }[]
    >`SELECT fingerprint=sha256(convert_to(jsonb_build_array('v1','lyraseo-kernel-a','POST',${path}::text,${createHash("sha256").update(raw).digest("hex")}::text,extract(epoch from "issuedAt"),extract(epoch from "expiresAt"))::text,'UTF8')) AS "fingerprintMatches" FROM "InternalRequest" WHERE "requestId"=${e.rid}::uuid`;
    expect(row!.fingerprintMatches).toBe(true);
    expect(
      await wire(signing(path, raw.trimEnd(), e.rid, e.issued, e.expires)),
    ).toMatchObject({ status: 409 });
  }
});
it("rejects near-expiry step, expired/future/overlong envelopes and other action keys", async () => {
  const now = Math.floor(Date.now() / 1000),
    body = '{"limit":1}';
  for (const [issue, expiry] of [
    [now - 60, now],
    [now + 32, now + 60],
    [now, now + 61],
    [now, now],
  ])
    expect(
      await wire(signing(runtimePaths[0], body, randomUUID(), issue, expiry)),
    ).toMatchObject({ status: 401 });
  keys = [{ ...key, actions: [runtimePaths[1]] }];
  expect(await wire(signing(runtimePaths[0], body))).toMatchObject({
    status: 401,
  });
  keys = [key];
  expect(await admin.internalRequest.count()).toBe(0);
  await fixture();
  const ref = await claim();
  await ack(ref);
  const e = step(ref);
  expect(
    await wire(signing(e.path, e.body, e.rid, now - 20, now + 40)),
  ).toMatchObject({ status: 503 });
  expect(
    await admin.internalRequest.findFirst({ where: { requestId: e.rid } }),
  ).toBeNull();
  expect(urls).toEqual([]);
});
it("rejects fabricated evidence and final evaluation in a direct commit despite a real proof", async () => {
  await fixture(1);
  const ref = await claim();
  await ack(ref);
  const e = step(ref),
    attempt = await admitStep(db, env(e), "https://example.com");
  if (attempt.disposition !== "ADMITTED") throw new Error("missing attempt");
  const bad = {
    evidence: {
      requestedUrl: attempt.url,
      acquired: true,
      headComplete: true,
      bodyComplete: true,
    },
    provenance: { channel: "raw-http", requestedUrl: attempt.url },
  };
  await expect(
    db.$queryRaw`SELECT lyraseo_audit.commit_step(${e.rid}::uuid,${attempt.proof},${JSON.stringify(bad)}::json,'{}'::jsonb)`,
  ).rejects.toThrow(/INVALID_PAGE_EVIDENCE/);
  const { acquireRawPage } =
    await import("../../packages/visibility/src/acquisition");
  const observed = await acquireRawPage(
    attempt.url,
    attempt.origin,
    (url, signal) =>
      transport(url, signal, () => checkStep(db, e.rid, attempt.proof)),
  );
  await expect(
    db.$queryRaw`SELECT lyraseo_audit.commit_step(${e.rid}::uuid,${attempt.proof},${JSON.stringify(observed)}::json,'{}'::jsonb)`,
  ).rejects.toThrow(/INVALID_EVALUATION/);
  expect(await admin.auditPage.count()).toBe(0);
  expect(
    await admin.internalRequest.findFirstOrThrow({
      where: { requestId: e.rid },
    }),
  ).toMatchObject({ state: "ACTIVE", result: null });
});
it("returns only bounded opaque refs for the full 20-target HTTP dispatch batch", async () => {
  const createdAt = new Date();
  for (let i = 0; i < 20; i++) {
    const w = "batch-" + i,
      site = w + "-site";
    await admin.workspace.create({
      data: {
        id: w,
        name: w,
        memberships: { create: { userId: "owner", role: "OWNER" } },
      },
    });
    await admin.site.create({
      data: {
        workspaceId: w,
        id: site,
        origin: "https://example.com",
        verifiedAt: createdAt,
      },
    });
    const audit = await admin.auditRun.create({
      data: {
        workspaceId: w,
        siteId: site,
        userId: "owner",
        securityVersion: 0,
        idempotencyKey: randomUUID(),
        inputHash: "fixture",
        profile: "CONTROLLED_RAW_TEST_V1",
        declarations: {},
        methodologyVersion: "readiness-v2",
        manifest: ["https://example.com/"],
        createdAt,
      },
    });
    await admin.workDispatch.create({
      data: {
        workspaceId: w,
        siteId: site,
        userId: "owner",
        admittedSecurityVersion: 0,
        targetKind: "AUDIT_RAW",
        auditId: audit.id,
        capability: "audits",
        profile: audit.profile,
        eligibility: "CONTROLLED_TEST",
        admittedAt: createdAt,
        expiresAt: new Date(+createdAt + 3600000),
        disposition: "PENDING",
        nextAttemptAt: createdAt,
      },
    });
  }
  const e = signing(runtimePaths[0], '{"limit":20}');
  const batch = await ok(e);
  expect(Object.keys(batch).sort()).toEqual(["disposition", "refs"]);
  expect(batch.refs).toHaveLength(20);
  for (const ref of batch.refs as Record<string, unknown>[])
    expect(Object.keys(ref).sort()).toEqual([
      "claimToken",
      "generation",
      "workId",
    ]);
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(32768);
  expect(await ok(e)).toEqual(batch);
  expect(urls).toEqual([]);
});
it("leaves an existing paid target, its reservation and receipt history untouched", async () => {
  const operation = await admin.operation.create({
    data: {
      userId: "owner",
      workspaceId: "a",
      siteId: "a-site",
      sessionId: actor.sessionId,
      securityVersion: 0,
      kind: "GENERATION",
      provider: "AZURE",
      period: "2026-11",
      route: "test",
      idempotencyKey: randomUUID(),
      inputHash: "fixture",
      tariffVersion: "fixture",
      reservedCost: "0.3",
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const target = await admin.workDispatch.findFirstOrThrow({
    where: { operationId: operation.id },
  });
  const e = signing(
    runtimePaths[3],
    JSON.stringify({
      version: 1,
      workId: target.id,
      generation: target.generation,
    }),
  );
  expect(await ok(e)).toEqual({ disposition: "STALE" });
  expect(
    await admin.operation.findUniqueOrThrow({ where: { id: operation.id } }),
  ).toEqual(operation);
  expect(
    await admin.workDispatch.findUniqueOrThrow({ where: { id: target.id } }),
  ).toEqual(target);
  expect(await admin.auditPage.count()).toBe(0);
  expect(await admin.usageReceipt.count()).toBe(0);
  expect(
    await admin.internalRequest.findFirst({ where: { requestId: e.rid } }),
  ).toBeNull();
  expect(urls).toEqual([]);
});
it("serializes a concurrent policy change behind the valid finalizer", async () => {
  await fixture(1);
  const ref = await claim();
  await ack(ref);
  const e = step(ref);
  const opUrl = new URL(adminUrl);
  opUrl.username = "lyraseo_operator";
  opUrl.password = "local_operator_only";
  const operator = createDatabase(opUrl.href);
  const waitForLock = async (role: string) =>
    expect
      .poll(
        async () => {
          const [row] = await admin.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename=${role} AND wait_event_type='Lock') AS waiting`;
          return row!.waiting;
        },
        { timeout: 2500, interval: 10 },
      )
      .toBe(true);
  await admin.$executeRawUnsafe(
    "CREATE FUNCTION lyraseo_audit.test_finalize_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(3971717); RETURN NEW; END $$",
  );
  try {
    await admin.$executeRawUnsafe(
      'CREATE TRIGGER test_finalize_barrier AFTER INSERT ON "AuditPage" FOR EACH ROW EXECUTE FUNCTION lyraseo_audit.test_finalize_barrier()',
    );
    let result!: ReturnType<typeof wire>, pause!: Promise<unknown>;
    await admin.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(3971717)`;
        result = wire(e);
        await waitForLock("lyraseo_dispatch");
        const policy = await admin.runtimePolicy.findUniqueOrThrow({
          where: { key: "global" },
        });
        pause =
          operator.$queryRaw`SELECT lyraseo_kernel.change_policy('global',${policy.revision}::integer,false)`.then(
            (rows) => rows,
          );
        await waitForLock("lyraseo_operator");
      },
      { timeout: 7000 },
    );
    expect(await result).toMatchObject({
      status: 200,
      data: { disposition: "COMPLETED" },
    });
    await pause;
    expect(await admin.auditPage.count()).toBe(1);
    expect(
      await admin.runtimePolicy.findUniqueOrThrow({ where: { key: "global" } }),
    ).toMatchObject({ enabled: false });
  } finally {
    await operator.$disconnect();
    await admin.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS test_finalize_barrier ON "AuditPage"',
    );
    await admin.$executeRawUnsafe(
      "DROP FUNCTION lyraseo_audit.test_finalize_barrier()",
    );
  }
});
it("rejects signed BOM and non-UTF8 bytes before reservation; token-only headers have no authority", async () => {
  const raw = '{"limit":1}',
    now = Math.floor(Date.now() / 1000);
  for (const bytes of [
    Buffer.from([0xff, 0xfe]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw)]),
  ])
    expect(
      await wire(
        signing(runtimePaths[0], raw, randomUUID(), now, now + 60, key, bytes),
      ),
    ).toMatchObject({ status: 401, data: { error: "INVALID_AUTHENTICATION" } });
  const e = signing(runtimePaths[0], raw);
  expect(
    await wire(e, e.path, {
      "content-type": "application/json",
      authorization: "Bearer local-read-token",
    }),
  ).toMatchObject({ status: 401 });
  const unicode = '{"unknown":"☂ 漢字"}';
  const [row] = await admin.$queryRaw<
    { digest: string }[]
  >`SELECT encode(sha256(convert_to(${unicode},'UTF8')),'hex') digest`;
  expect(row!.digest).toBe(
    createHash("sha256").update(unicode, "utf8").digest("hex"),
  );
  expect(await wire(signing(runtimePaths[0], unicode))).toMatchObject({
    status: 400,
  });
  expect(await admin.internalRequest.count()).toBe(0);
});
it("keeps proofs bound to their own admitted audit, workspace, request and immutable URL", async () => {
  const first = await fixture(1);
  const createdAt = new Date(),
    otherOrigin = "https://other.com";
  const other = await admin.auditRun.create({
    data: {
      workspaceId: "b",
      siteId: "b-site",
      userId: "owner",
      securityVersion: 0,
      idempotencyKey: randomUUID(),
      inputHash: "fixture",
      profile: "CONTROLLED_RAW_TEST_V1",
      declarations: {},
      methodologyVersion: "readiness-v2",
      manifest: [otherOrigin + "/"],
      createdAt,
    },
  });
  const second = await admin.workDispatch.create({
    data: {
      workspaceId: "b",
      siteId: "b-site",
      userId: "owner",
      admittedSecurityVersion: 0,
      targetKind: "AUDIT_RAW",
      auditId: other.id,
      capability: "audits",
      profile: other.profile,
      eligibility: "CONTROLLED_TEST",
      admittedAt: createdAt,
      expiresAt: new Date(+createdAt + 3600000),
      disposition: "PENDING",
      nextAttemptAt: createdAt,
    },
  });
  const batch = await ok(signing(runtimePaths[0], '{"limit":2}'));
  const refs = batch.refs as Awaited<ReturnType<typeof claim>>[];
  expect(refs).toHaveLength(2);
  const owned = refs.find((r) => r.workId === first.d.id)!,
    otherRef = refs.find((r) => r.workId === second.id)!;
  await ack(owned);
  await ack(otherRef);
  const e = step(owned),
    e2 = step(otherRef);
  // The actual listener's in-memory fixture serves only example.com. A
  // differently enrolled DB target cannot consume replay or claim its lease.
  expect(await ok(e2)).toEqual({ disposition: "STALE" });
  expect(
    await admin.auditRun.findUniqueOrThrow({ where: { id: other.id } }),
  ).toMatchObject({ fence: 0, status: "QUEUED" });
  expect(
    await admin.internalRequest.findFirst({ where: { requestId: e2.rid } }),
  ).toBeNull();
  const firstProof = await admitStep(db, env(e), "https://example.com"),
    otherProof = await admitStep(db, env(e2), otherOrigin);
  if (
    firstProof.disposition !== "ADMITTED" ||
    otherProof.disposition !== "ADMITTED"
  )
    throw new Error("missing fixture proof");
  await expect(checkStep(db, e2.rid, firstProof.proof)).rejects.toThrow(
    /STALE_ATTEMPT/,
  );
  await expect(checkStep(db, e.rid, otherProof.proof)).rejects.toThrow(
    /STALE_ATTEMPT/,
  );
  await checkStep(db, e.rid, firstProof.proof);
  expect(await admin.auditPage.count()).toBe(0);
  expect(urls).toEqual([]);
});

const htmlTransport = (html: string) => async (url: string) =>
  url.endsWith("robots.txt")
    ? new Response(null, { status: 404 })
    : new Response(Buffer.from(html, "utf8"), {
        headers: { "content-type": "text/html" },
      });
async function oneHtmlRun(adapter: "browser" | "bridge", html: string) {
  const source = htmlTransport(html);
  if (adapter === "bridge") {
    const { audit } = await fixture(1),
      ref = await claim();
    await ack(ref);
    transport = (url) => source(url);
    expect(await ok(step(ref))).toEqual({ disposition: "COMPLETED" });
    return admin.auditPage.findFirstOrThrow({ where: { auditId: audit.id } });
  }
  const audit = await createAuditRun(web, actor, {
    workspaceId: "a",
    siteId: "a-site",
    idempotencyKey: randomUUID(),
    manifest: ["https://example.com/"],
    profile: "LOCAL_RAW_V1",
  });
  await runRawAuditStep(
    web,
    actor,
    { workspaceId: "a", siteId: "a-site", auditId: audit.id },
    source,
  );
  return admin.auditPage.findFirstOrThrow({ where: { auditId: audit.id } });
}
for (const adapter of ["browser", "bridge"] as const) {
  it(`round1 ${adapter} retains UTF8 BOM in original source and treats BOM-only HTML as empty`, async () => {
    const html =
      "\uFEFF<html><head><title>Byte faithful</title></head><body>雪</body></html>";
    const page = await oneHtmlRun(adapter, html);
    expect(page.evidence).toMatchObject({
      acquired: true,
      titleElements: ["Byte faithful"],
    });
    expect(page.provenance).toMatchObject({
      rawHtml: html,
      sha256: createHash("sha256").update(html).digest("hex"),
    });
    const empty = await oneHtmlRun(adapter, "\uFEFF");
    expect(empty.evidence).toMatchObject({ acquired: false });
    expect(empty.provenance).toMatchObject({
      error: "EMPTY_HTML_BODY",
      sha256: createHash("sha256").update("\uFEFF").digest("hex"),
    });
    expect(empty.provenance).not.toHaveProperty("rawHtml");
  });
  it(`round1 ${adapter} admits exact compact evidence byte limit and records overflow as unavailable`, async () => {
    const url = "https://example.com/",
      title = "a : ,  雪",
      html = (pad: number) =>
        "<html><head>" +
        ("<title>" + title + "</title>").repeat(50) +
        "<title>" +
        "x".repeat(pad) +
        "</title></head></html>";
    const base = await acquireRawPage(url, url, htmlTransport(html(0)));
    const fill = 262144 - Buffer.byteLength(JSON.stringify(base.evidence));
    const page = await oneHtmlRun(adapter, html(fill));
    expect(page.evidence).toMatchObject({ acquired: true });
    expect(Buffer.byteLength(JSON.stringify(page.evidence))).toBe(262144);
    expect(
      (page.evidence as { titleElements: string[] }).titleElements[0],
    ).toBe(title);
    const over = await oneHtmlRun(adapter, html(fill + 1));
    expect(over.evidence).toMatchObject({ acquired: false });
    expect(over.provenance).toMatchObject({ error: "EVIDENCE_TOO_LARGE" });
  });
}
it.each(["entry", "bytes"])(
  "round1 same-ID %s key replacement during asynchronous verification cannot reserve the old signature",
  async (mode) => {
    keys = [{ ...key, secret: Uint8Array.from(key.secret) }, rotated];
    const original = crypto.subtle.verify.bind(crypto.subtle);
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    const spy = vi
      .spyOn(crypto.subtle, "verify")
      .mockImplementationOnce(async (...args) => {
        entered();
        await hold;
        return original(...args);
      });
    try {
      const response = wire(signing(runtimePaths[0], '{"limit":1}'));
      await started;
      if (mode === "entry")
        keys[0] = { ...key, secret: new Uint8Array(randomBytes(32)) };
      else keys[0]!.secret.set(randomBytes(32));
      release();
      expect(await response).toMatchObject({
        status: 401,
        data: { error: "INVALID_AUTHENTICATION" },
      });
      expect(await admin.internalRequest.count()).toBe(0);
      expect(urls).toEqual([]);
    } finally {
      release();
      spy.mockRestore();
    }
  },
);
it("round1 SQL admission rechecks its wall deadline after waiting on the workspace lock", async () => {
  const { d, audit } = await fixture(1);
  const ref = await claim();
  await ack(ref);
  const e = step(ref),
    r = env(e);
  const before = await admin.workDispatch.findUniqueOrThrow({
    where: { id: d.id },
  });
  let result!: Promise<unknown>;
  await admin.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id='a' FOR UPDATE`;
    const deadline = new Date(Date.now() + 800);
    result =
      db.$queryRaw`SELECT lyraseo_audit.admit_step(${e.rid}::uuid,${key.audience},${e.path},${e.body},${r.issuedAt}::timestamptz,${r.expiresAt}::timestamptz,${deadline}::timestamptz)`.then(
        (x) => x,
        (e) => e,
      );
    await expect
      .poll(
        async () => {
          const [row] = await admin.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_dispatch' AND wait_event_type='Lock') AS waiting`;
          return row!.waiting;
        },
        { timeout: 650, interval: 10 },
      )
      .toBe(true);
    await tx.$queryRaw`SELECT 1 FROM pg_sleep(greatest(0,extract(epoch from ${deadline}::timestamptz-clock_timestamp())))`;
  });
  expect(await result).toMatchObject({
    message: expect.stringContaining("HANDLER_DEADLINE"),
  });
  expect(
    await admin.auditRun.findUniqueOrThrow({ where: { id: audit.id } }),
  ).toMatchObject({ fence: 0, status: "QUEUED" });
  expect(
    await admin.workDispatch.findUniqueOrThrow({ where: { id: d.id } }),
  ).toEqual(before);
  expect(
    await admin.internalRequest.findFirst({ where: { requestId: e.rid } }),
  ).toBeNull();
});
it("round1 delayed body and contended control SQL share one HTTP response deadline", async () => {
  await listener!.close();
  const defaultProbe = process.env.LYRA_BRIDGE_DEFAULT_DEADLINE_PROBE === "1";
  const budget = defaultProbe ? 45000 : 1800;
  await boot(defaultProbe ? undefined : budget);
  const { d } = await fixture(1);
  const signed = signing(runtimePaths[0], '{"limit":1}');
  let reply!: Promise<{ status: number; time: number }>;
  await admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT key FROM "RuntimePolicy" WHERE key='global' FOR UPDATE`;
      const sent = Date.now();
      let finishBody!: () => void;
      const bodySent = new Promise<void>((r) => (finishBody = r));
      reply = new Promise((resolve, reject) => {
        const req = http(
          listener!.origin,
          { path: signed.path, method: "POST", headers: signed.headers },
          (res) => {
            res.resume();
            res.on("end", () =>
              resolve({ status: res.statusCode!, time: Date.now() - sent }),
            );
          },
        );
        req.on("error", reject);
        req.write(signed.body.slice(0, 1));
        setTimeout(
          () => req.end(signed.body.slice(1), finishBody),
          budget - 850,
        );
      });
      await bodySent;
      await expect
        .poll(
          async () => {
            const [row] = await admin.$queryRaw<
              { waiting: boolean }[]
            >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_dispatch' AND wait_event_type='Lock') AS waiting`;
            return row!.waiting;
          },
          { timeout: 650, interval: 10 },
        )
        .toBe(true);
      const outcome = await Promise.race([
        reply,
        new Promise<never>((_, rej) => {
          const timer = setTimeout(
            () => rej(new Error("HTTP_DEADLINE_MISSED")),
            budget + 350 - (Date.now() - sent),
          );
          timer.unref();
        }),
      ]);
      expect(outcome.status).toBe(503);
      expect(outcome.time).toBeLessThanOrEqual(budget + 350);
      // The HTTP deadline must also cancel the pending SQL while we still own the lock.
      await expect
        .poll(
          async () => {
            const [row] = await admin.$queryRaw<
              { waiting: boolean }[]
            >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_dispatch' AND wait_event_type='Lock') AS waiting`;
            return row!.waiting;
          },
          { timeout: 500, interval: 10 },
        )
        .toBe(false);
    },
    { timeout: budget + 4000 },
  );
  await reply;
  expect(
    await admin.internalRequest.findFirst({ where: { requestId: signed.rid } }),
  ).toBeNull();
  expect(
    await admin.workDispatch.findUniqueOrThrow({ where: { id: d.id } }),
  ).toEqual(d);
}, 55000);
it.each(["browser", "bridge"] as const)(
  "round1 fixed %s SQL wrapper rejects a receipt one compact byte over the cap",
  async (adapter) => {
    const url = "https://example.com/",
      receipt = await acquireRawPage(
        url,
        url,
        htmlTransport("<html><head><title> : ,  </title></head></html>"),
      );
    const fill = 262145 - Buffer.byteLength(JSON.stringify(receipt.evidence));
    receipt.evidence.titleElements[0] += "x".repeat(fill);
    expect(Buffer.byteLength(JSON.stringify(receipt.evidence))).toBe(262145);
    if (adapter === "browser") {
      const scope = { workspaceId: "a", siteId: "a-site" };
      const audit = await createAuditRun(web, actor, {
        ...scope,
        idempotencyKey: randomUUID(),
        manifest: [url],
        profile: "LOCAL_RAW_V1",
      });
      const lease = await claimAuditRun(
        web,
        actor,
        { ...scope, auditId: audit.id },
        "test",
      );
      await expect(
        web.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.actor_id','owner',true),set_config('app.workspace_id','a',true)`;
          return tx.$queryRaw`SELECT lyraseo_audit.web_transition('a-site',${audit.id},0,'checkpoint',${lease.fence}::integer,NULL,${JSON.stringify(receipt)}::json)`;
        }),
      ).rejects.toThrow(/EVIDENCE_TOO_LARGE/);
    } else {
      await fixture(1);
      const ref = await claim();
      await ack(ref);
      const e = step(ref),
        admitted = await admitStep(db, env(e), "https://example.com");
      if (admitted.disposition !== "ADMITTED")
        throw new Error("missing fixture attempt");
      await expect(
        db.$queryRaw`SELECT lyraseo_audit.commit_step(${e.rid}::uuid,${admitted.proof},${JSON.stringify(receipt)}::json,NULL)`,
      ).rejects.toThrow(/EVIDENCE_TOO_LARGE/);
    }
    expect(await admin.auditPage.count()).toBe(0);
  },
);
it("round1 closes an unfinished signed body at its server budget before reservation", async () => {
  await listener!.close();
  await boot(200);
  const e = signing(runtimePaths[0], '{"limit":1}');
  const outcome = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = http(
        listener!.origin,
        { path: e.path, method: "POST", headers: e.headers },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.write("{"); // omit the final chunk
    },
  );
  expect(outcome).toEqual({
    status: 503,
    body: JSON.stringify({ disposition: "RETRY" }),
  });
  expect(await admin.internalRequest.count()).toBe(0);
  expect(urls).toEqual([]);
});

it("round2 an authorized page-one proof cannot poison the page-two evaluation projection", async () => {
  const { audit, d } = await fixture(2),
    ref = await claim();
  await ack(ref);
  const e = step(ref),
    first = await admitStep(db, env(e), "https://example.com");
  if (first.disposition !== "ADMITTED") throw new Error("missing proof");
  const receipt = await acquireRawPage(
    first.url,
    first.origin,
    htmlTransport("<html><title> : ,  雪</title></html>"),
  );
  const small = JSON.stringify(receipt).replace(
    '"evidence":{',
    '"evidence":{"extra":[' + Array(100).fill("1e10000").join(",") + "],",
  );
  expect(Buffer.byteLength(small)).toBeLessThan(8192);
  const commit = (raw: string) =>
    db.$queryRaw<
      { result: { disposition: string } }[]
    >`SELECT lyraseo_audit.commit_step(${e.rid}::uuid,${first.proof},${raw}::json,NULL) result`;
  const attack = await commit(small).then(
    (rows) => rows[0]!.result.disposition,
    (e) =>
      e instanceof Error && e.message.includes("EVIDENCE_TOO_LARGE")
        ? "REJECTED"
        : "UNEXPECTED",
  );
  if (attack === "REJECTED") {
    expect(await admin.auditPage.count()).toBe(0);
    expect(
      await admin.workDispatch.findUniqueOrThrow({ where: { id: d.id } }),
    ).toMatchObject({ generation: 1, disposition: "DELIVERED" });
    expect(
      await admin.internalRequest.findFirstOrThrow({
        where: { requestId: e.rid },
      }),
    ).toMatchObject({ state: "ACTIVE" });
    const markup = (pad: number) =>
      "<html><head><title> : ,  雪</title><title>" +
      "x".repeat(pad) +
      "</title></head></html>";
    const observed = (pad: number) =>
      acquireRawPage(first.url, first.origin, htmlTransport(markup(pad)));
    const base = await observed(0);
    const exact = await observed(
      262144 - Buffer.byteLength(JSON.stringify(base.evidence)),
    );
    expect(Buffer.byteLength(JSON.stringify(exact.evidence))).toBe(262144);
    expect(await commit(JSON.stringify(exact))).toMatchObject([
      { result: { disposition: "YIELDED" } },
    ]);
  }
  const nextRef = await claim();
  await ack(nextRef);
  const e2 = step(nextRef),
    second = await admitStep(db, env(e2), "https://example.com");
  if (second.disposition !== "ADMITTED") throw new Error("missing next proof");
  // Measure inside SQL so the regression never sends an unbounded document to Node.
  const [row] = await db.$queryRaw<
    { bytes: number; title: string }[]
  >`SELECT octet_length((facts->'priorEvidence')::text) AS bytes,facts#>>'{priorEvidence,0,titleElements,0}' AS title
      FROM lyraseo_audit.prepare_step(${e2.rid}::uuid,${second.proof}) AS facts`;
  expect(
    attack,
    `page two projected ${row!.bytes} bytes after submitting a ${Buffer.byteLength(small)}-byte receipt`,
  ).toBe("REJECTED");
  expect(row!.bytes).toBeGreaterThan(262144);
  expect(row!.bytes).toBeLessThanOrEqual(2 * 262144 + 2);
  expect(row!.title).toBe(" : ,  雪");
  expect(await admin.auditPage.count({ where: { auditId: audit.id } })).toBe(1);
});

it("round2 web wrapper refuses tiny compact values whose JSONB representation balloons", async () => {
  const url = "https://example.com/",
    scope = { workspaceId: "a", siteId: "a-site" };
  const audit = await createAuditRun(web, actor, {
      ...scope,
      idempotencyKey: randomUUID(),
      manifest: [url],
      profile: "LOCAL_RAW_V1",
    }),
    lease = await claimAuditRun(
      web,
      actor,
      { ...scope, auditId: audit.id },
      "test",
    );
  const receipt = await acquireRawPage(
    url,
    url,
    htmlTransport("<html>Source</html>"),
  );
  const save = (raw: string) =>
    web.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id','owner',true),set_config('app.workspace_id','a',true)`;
      return tx.$queryRaw`SELECT lyraseo_audit.web_transition('a-site',${audit.id},0,'checkpoint',${lease.fence}::integer,NULL,${raw}::json)`;
    });
  for (const [field, numbers] of [
    ["evidence", Array(100).fill("1e-10000")],
    ["provenance", Array(520).fill("1e130000")],
  ] as const) {
    const raw = JSON.stringify(receipt).replace(
      '"' + field + '":{',
      '"' + field + '":{"extra":[' + numbers.join(",") + "],",
    );
    expect(Buffer.byteLength(raw)).toBeLessThan(8192);
    await expect(save(raw)).rejects.toThrow(/EVIDENCE_TOO_LARGE/);
  }
  expect(await admin.auditPage.count()).toBe(0);
});

it("round2 snapshots the validated duration while keeping the keyring live", async () => {
  await listener!.close();
  const options = {
    db,
    keys: () => keys,
    handlerBudgetMs: 200,
    fixture: createControlledFixture(
      "https://example.com",
      async () => new Response(null, { status: 404 }),
    ),
  };
  listener = await startControlledRuntime(options);
  options.handlerBudgetMs = 120000;
  const e = signing(runtimePaths[0], '{"limit":1}');
  let req: ReturnType<typeof http> | undefined;
  try {
    const result = await Promise.race([
      new Promise<number>((resolve, reject) => {
        req = http(
          listener!.origin,
          { path: e.path, method: "POST", headers: e.headers },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
          },
        );
        req.on("error", reject);
        req.write("{");
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("VALIDATED_BUDGET_CHANGED")),
          650,
        );
        timer.unref();
      }),
    ]);
    expect(result).toBe(503);
  } finally {
    req?.destroy();
  }
  expect(await admin.internalRequest.count()).toBe(0);
  keys = [rotated];
  expect(await wire(e)).toMatchObject({ status: 401 });
});
it("round2 prepare rejects oversized preexisting prior evidence before returning its array", async () => {
  const { audit } = await fixture(2),
    url = "https://example.com/";
  const evidence =
    '{"requestedUrl":"' +
    url +
    '","extra":[' +
    Array(30).fill("1e10000").join(",") +
    '],"label":"' +
    "x".repeat(230000) +
    '"}';
  // Each component fits alone. Numeric bytes plus string bytes cross the projection ceiling.
  expect(Buffer.byteLength(evidence)).toBeLessThan(262144);
  await admin.$executeRaw`INSERT INTO "AuditPage"(id,"workspaceId","auditId","requestedUrl",evidence,provenance) VALUES(${randomUUID()},'a',${audit.id},${url},${evidence}::jsonb,'{}'::jsonb)`;
  const ref = await claim();
  await ack(ref);
  const e = step(ref),
    second = await admitStep(db, env(e), "https://example.com");
  if (second.disposition !== "ADMITTED") throw new Error("missing next proof");
  expect(second.url).toEqual("https://example.com/about");
  await expect(
    db.$queryRaw`SELECT octet_length((lyraseo_audit.prepare_step(${e.rid}::uuid,${second.proof})->'priorEvidence')::text)`,
  ).rejects.toThrow(/EVIDENCE_TOO_LARGE/);
  expect(
    await admin.auditRun.findUniqueOrThrow({ where: { id: audit.id } }),
  ).toMatchObject({ status: "RUNNING", evaluation: null });
  expect(await admin.auditPage.count()).toBe(1);
});

function methodKeyringOptions() {
  return {
    db,
    fixture: createControlledFixture("https://example.com", (url, signal) =>
      transport(url, signal, async () => signal.throwIfAborted()),
    ),
    current: [key] as RuntimeKey[],
    keys() {
      return this.current;
    },
  };
}
async function replaceListener(
  options: Parameters<typeof startControlledRuntime>[0],
) {
  await listener!.close();
  listener = undefined;
  listener = await startControlledRuntime(options);
}
it.each(["state", "provider"])(
  "round3 method-backed %s replacement denies a revoked signer before new work",
  async (change) => {
    const options = methodKeyringOptions();
    await replaceListener(options);
    const { audit } = await fixture(1),
      ref = await claim();
    await ack(ref);
    const before = await admin.internalRequest.count();
    if (change === "state") options.current = [rotated];
    else options.keys = () => [rotated];
    const revoked = step(ref);
    expect(await wire(revoked)).toMatchObject({
      status: 401,
      data: { error: "INVALID_AUTHENTICATION" },
    });
    expect(await admin.internalRequest.count()).toBe(before);
    expect(urls).toEqual([]);
    expect(
      await admin.auditRun.findUniqueOrThrow({ where: { id: audit.id } }),
    ).toMatchObject({ status: "QUEUED", fence: 0 });
    const valid = signing(
      revoked.path,
      revoked.body,
      randomUUID(),
      revoked.issued,
      revoked.expires,
      rotated,
    );
    expect(await ok(valid)).toEqual({ disposition: "COMPLETED" });
  },
);
it("round3 method-backed revocation aborts pending I/O before a later hop or checkpoint", async () => {
  const options = methodKeyringOptions();
  await replaceListener(options);
  const { audit } = await fixture(1),
    ref = await claim();
  await ack(ref);
  let enter!: () => void,
    release!: () => void,
    abortObserved = false;
  const pending = new Promise<void>((r) => (enter = r)),
    hold = new Promise<void>((r) => (release = r));
  transport = async (url, signal) => {
    urls.push(url);
    signal.addEventListener(
      "abort",
      () => {
        abortObserved = true;
      },
      { once: true },
    );
    enter();
    await hold;
    return new Response(null, { status: 404 });
  };
  const e = step(ref),
    response = wire(e);
  try {
    await pending;
    options.current = [];
    const outcome = await Promise.race([
      response,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("LIVE_KEYRING_REVOCATION_MISSED")),
          1000,
        );
        timer.unref();
      }),
    ]);
    expect(outcome).toMatchObject({
      status: 401,
      data: { error: "INVALID_AUTHENTICATION" },
    });
    expect(abortObserved).toBe(true);
    expect(urls).toEqual(["https://example.com/robots.txt"]);
    expect(await admin.auditPage.count()).toBe(0);
    expect(
      await admin.auditRun.findUniqueOrThrow({ where: { id: audit.id } }),
    ).toMatchObject({ status: "RUNNING", evaluation: null });
    expect(
      await admin.internalRequest.findFirstOrThrow({
        where: { requestId: e.rid },
      }),
    ).toMatchObject({ state: "ACTIVE", result: null });
  } finally {
    release();
    await response;
  }
});
it("round3 class-prototype provider authenticates and revokes using its original receiver", async () => {
  class Config {
    readonly db = db;
    readonly fixture = methodKeyringOptions().fixture;
    #active: RuntimeKey[] = [key];
    keys() {
      return this.#active;
    }
    revoke() {
      this.#active = [];
    }
  }
  const options = new Config();
  await replaceListener(options);
  expect(await ok(signing(runtimePaths[0], '{"limit":1}'))).toMatchObject({
    disposition: "OK",
    refs: [],
  });
  const before = await admin.internalRequest.count();
  options.revoke();
  expect(await wire(signing(runtimePaths[0], '{"limit":1}'))).toMatchObject({
    status: 401,
    data: { error: "INVALID_AUTHENTICATION" },
  });
  expect(await admin.internalRequest.count()).toBe(before);
  expect(urls).toEqual([]);
});
