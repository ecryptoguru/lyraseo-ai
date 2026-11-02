import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  claimDue,
  changeRuntimePolicy,
  readRuntimePolicy,
  ackDelivery,
  deferDelivery,
  recoverDue,
  resolveStepBinding,
  type KernelRequest,
  type DispatchRef,
} from "../../packages/db/src/dispatch";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";

import {
  cancelOperation,
  acceptAttempt,
  settleOperation,
} from "../../packages/db/src/accounting";
import { cancelAuditRun } from "../../packages/db/src/audits";
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";

const admin = createDatabase(adminUrl);
const web = createDatabase(runtimeUrl);
function role(user: string, password: string) {
  const url = new URL(adminUrl);
  url.username = user;
  url.password = password;
  return createDatabase(url.href);
}
const service = role("lyraseo_dispatch", "local_dispatch_only");
const otherSession = role("lyraseo_dispatch", "local_dispatch_only");
const operator = role("lyraseo_operator", "local_operator_only");
const identity = role("lyraseo_identity", "local_identity_only");
const anon = role("anon", "local_anon_only");
const authenticated = role("authenticated", "local_authenticated_only");
const auditProfile = "CONTROLLED_RAW_TEST_V1";
const dispatchPath = "/api/internal/runtime/dispatch";
function request(body: unknown = { limit: 20 }): KernelRequest {
  const issuedAt = new Date();
  return {
    requestId: randomUUID(),
    audience: "lyraseo-kernel-a",
    issuedAt,
    expiresAt: new Date(+issuedAt + 60000),
    rawBody: JSON.stringify(body),
  };
}
async function policy(key: string, enabled: boolean, revision?: number) {
  const expected =
    revision ?? (await readRuntimePolicy(operator, key))!.revision;
  return changeRuntimePolicy(operator, key, expected, enabled);
}
async function enable() {
  await policy("global", true);
  await policy("audits", true);
}
async function fixture(
  siteId = "a-site",
  createdAt = new Date(),
  expiry = new Date(+createdAt + 3600000),
  profile = auditProfile,
  workspaceId = "a",
  manifest: string[] = [],
) {
  const audit = await admin.auditRun.create({
    data: {
      workspaceId,
      siteId,
      userId: "owner",
      securityVersion: 0,
      profile,
      manifest,
      declarations: {},
      methodologyVersion: "fixture",
      inputHash: "test",
      idempotencyKey: randomUUID(),
      createdAt,
    },
  });
  return admin.workDispatch.create({
    data: {
      workspaceId,
      siteId,
      userId: "owner",
      admittedSecurityVersion: 0,
      targetKind: "AUDIT_RAW",
      auditId: audit.id,
      capability: "audits",
      profile,
      eligibility: "CONTROLLED_TEST",
      admittedAt: createdAt,
      expiresAt: expiry,
      disposition: "PENDING",
      nextAttemptAt: createdAt,
    },
  });
}
async function oneRef() {
  const batch = await claimDue(service, request());
  if (batch.disposition !== "OK" || batch.refs.length !== 1)
    throw new Error("Expected one controlled reference");
  return batch.refs[0]!;
}
function begin(r: KernelRequest) {
  return service.$queryRaw<
    { ticket: { state: string; token: string; fence: number } }[]
  >`SELECT lyraseo_kernel.begin_request(
   ${r.requestId}::uuid,${r.audience},${dispatchPath},${r.rawBody},${r.issuedAt}::timestamptz,${r.expiresAt}::timestamptz) ticket`;
}
function finish(r: KernelRequest, ticket: { token: string; fence: number }) {
  return service.$queryRaw`SELECT lyraseo_kernel.finish_request(
   ${r.requestId}::uuid,${r.audience},${dispatchPath},${r.rawBody},${r.issuedAt}::timestamptz,${r.expiresAt}::timestamptz,${ticket.token}::uuid,${ticket.fence}::int)`;
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterEach(async () => {
  for (const key of ["global", "audits"])
    if (
      (await admin.runtimePolicy.findUniqueOrThrow({ where: { key } })).enabled
    )
      await policy(key, false);
});
afterAll(async () => {
  await Promise.all(
    [
      admin,
      web,
      service,
      otherSession,
      operator,
      identity,
      anon,
      authenticated,
    ].map((db) => db.$disconnect()),
  );
});

it("blocks legacy archive reading, insertion and both fenced and unfenced acknowledgements", async () => {
  await expect(web.outboxEvent.findMany()).rejects.toThrow(/denied/);
  await expect(
    web.outboxEvent.create({
      data: {
        id: "legacy",
        operationId: "legacy",
        workspaceId: "a",
        userId: "owner",
      },
    }),
  ).rejects.toThrow(/denied/);
  await expect(
    web.outboxEvent.updateMany({ data: { deliveredAt: new Date() } }),
  ).rejects.toThrow(/denied/);
  await expect(web.$executeRaw`TRUNCATE public."OutboxEvent"`).rejects.toThrow(
    /denied/,
  );
});

it("keeps policies closed and CAS audited, including competing operator changes", async () => {
  const original = await admin.runtimePolicy.findMany();
  expect(original.map((p) => p.key).sort()).toEqual([
    "analytics",
    "audits",
    "content",
    "context",
    "global",
    "mcp",
    "search",
    "visibility",
  ]);
  expect(original.every((p) => !p.enabled)).toBe(true);
  await fixture();
  expect(await claimDue(service, request())).toEqual({
    disposition: "PAUSED",
    refs: [],
  });
  const rev = original.find((p) => p.key === "global")!.revision;
  const outcomes = await Promise.allSettled([
    policy("global", true, rev),
    policy("global", true, rev),
  ]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    await admin.runtimePolicyChange.findUniqueOrThrow({
      where: { key_revision: { key: "global", revision: rev + 1 } },
    }),
  ).toMatchObject({ operatorId: "lyraseo_operator", enabled: true });
  expect(await claimDue(service, request())).toEqual({
    disposition: "PAUSED",
    refs: [],
  });
  await expect(
    admin.runtimePolicyChange.updateMany({ data: { operatorId: "forged" } }),
  ).rejects.toThrow("IMMUTABLE_HISTORY");
});

it.each([
  ["web", web],
  ["identity", identity],
  ["anon", anon],
  ["authenticated", authenticated],
] as const)(
  "denies %s all kernel operations, including with forged transaction-local GUCs",
  async (_label, db) => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.actor_id','owner',true),set_config('app.workspace_id','a',true),set_config('app.service_principal','lyraseo_dispatch',true)`;
        return tx.$queryRaw`SELECT * FROM public."WorkDispatch"`;
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(claimDue(db, request())).rejects.toThrow(/denied/);
    await expect(resolveStepBinding(db, randomUUID(), 1)).rejects.toThrow(
      /denied/,
    );
    await expect(db.$executeRaw`SET ROLE lyraseo_kernel_owner`).rejects.toThrow(
      /denied/,
    );
    const [priv] = await db.$queryRaw<{ forbidden: boolean }[]>`SELECT
    EXISTS(SELECT FROM pg_proc WHERE pronamespace='lyraseo_kernel'::regnamespace AND has_function_privilege(current_user,oid,'EXECUTE'))
    OR EXISTS(SELECT FROM pg_class WHERE relname IN ('InternalRequest','RuntimePolicy','RuntimePolicyChange','WorkDispatch','OutboxEvent')
       AND has_table_privilege(current_user,oid,'SELECT,INSERT,DELETE,UPDATE,TRUNCATE')) AS forbidden`;
    expect(priv!.forbidden).toBe(false);
  },
);

it("isolates the service and the operator, verifies metadata RLS, schema ACL and non-owner function identities", async () => {
  const rows = await admin.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) FROM pg_class WHERE relname IN ('InternalRequest','WorkDispatch','RuntimePolicy','RuntimePolicyChange','test_environment')
    AND relrowsecurity AND relforcerowsecurity AND relowner<>'lyraseo_kernel_owner'::regrole`;
  expect(rows[0]!.count).toBe(5n);
  const bad =
    await admin.$queryRaw`SELECT proname FROM pg_proc p WHERE pronamespace='lyraseo_kernel'::regnamespace
   AND (proowner<>'lyraseo_kernel_owner'::regrole OR proconfig IS NULL OR NOT (proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])
   OR EXISTS(SELECT FROM aclexplode(proacl) WHERE grantee=0))`;
  expect(bad).toEqual([]);
  await expect(
    service.$executeRaw`SET ROLE lyraseo_kernel_owner`,
  ).rejects.toThrow(/denied/);
  await expect(
    service.$queryRaw`SELECT lyraseo_kernel.change_policy('global',0,true)`,
  ).rejects.toThrow(/denied/);
  await expect(
    service.$queryRaw`SELECT lyraseo_kernel.apply_command('/api/internal/runtime/recover','{"limit":20}'::jsonb)`,
  ).rejects.toThrow(/denied/);
  await expect(service.operation.findMany()).rejects.toThrow(/denied/);
  await expect(service.workDispatch.findMany()).rejects.toThrow(/denied/);
  await expect(
    service.$executeRaw`CREATE TABLE lyraseo_kernel.injected(id int)`,
  ).rejects.toThrow(/denied/);
  await expect(claimDue(operator, request())).rejects.toThrow(/denied/);
  for (const db of [web, identity, anon, authenticated, operator, service]) {
    await expect(
      db.$executeRaw`UPDATE public."UsageReceipt" SET amount=0`,
    ).rejects.toThrow(/denied/);
    await expect(
      db.$executeRaw`DELETE FROM public."UsageReceipt"`,
    ).rejects.toThrow(/denied/);
    await expect(
      db.$executeRaw`TRUNCATE public."UsageReceipt"`,
    ).rejects.toThrow(/denied/);
  }
});

it("leases once under simultaneous requests, stores the exact replay including token, and resolves only after acknowledgement", async () => {
  await enable();
  const work = await fixture();
  const r = request();
  const [a, b] = await Promise.all([
    claimDue(service, r),
    claimDue(otherSession, r),
  ]);
  expect(a).toEqual(b);
  expect(a.disposition).toBe("OK");
  const ref = (a as { refs: DispatchRef[] }).refs[0]!;
  expect(Object.keys(ref).sort()).toEqual([
    "claimToken",
    "generation",
    "workId",
  ]);
  expect(ref.workId).toBe(work.id);
  expect(
    await resolveStepBinding(service, ref.workId, ref.generation),
  ).toBeNull();
  expect(await claimDue(otherSession, request())).toEqual({
    disposition: "OK",
    refs: [],
  });
  expect(
    (await admin.workDispatch.findUniqueOrThrow({ where: { id: work.id } }))
      .sendAttempts,
  ).toBe(1);
  await expect(
    claimDue(service, { ...r, rawBody: '{ "limit":20 }' }),
  ).rejects.toThrow("REQUEST_CONFLICT");
  await expect(recoverDue(service, r)).rejects.toThrow("REQUEST_CONFLICT");
  const ack = request(ref);
  expect(await ackDelivery(service, ack)).toEqual({ disposition: "DELIVERED" });
  expect(await ackDelivery(otherSession, ack)).toEqual({
    disposition: "DELIVERED",
  });
  expect(await resolveStepBinding(service, work.id, 1)).toMatchObject({
    targetId: work.auditId,
    userId: "owner",
    action: "INSPECT_CONTROLLED_AUDIT",
  });
  expect(await resolveStepBinding(service, randomUUID(), 1)).toBeNull();
  expect(await claimDue(service, r)).toEqual(a);
});

it("locks replay first and skips a delivery locked by an independently connected transaction", async () => {
  await enable();
  const work = await fixture();
  await admin.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM public."WorkDispatch" WHERE id=${work.id}::uuid FOR UPDATE`;
    expect(await claimDue(service, request())).toEqual({
      disposition: "OK",
      refs: [],
    });
  });
  const outcomes = await Promise.all([
    claimDue(service, request()),
    claimDue(otherSession, request()),
  ]);
  expect(
    outcomes.map((r) => (r.disposition === "OK" ? r.refs.length : -1)).sort(),
  ).toEqual([0, 1]);
});

it("takes over a crashed request only after lease expiry and rejects stale completions", async () => {
  await enable();
  await fixture();
  const r = request();
  const first = (await begin(r))[0]!.ticket;
  expect(first).toMatchObject({ state: "OWNED", fence: 1 });
  expect(await claimDue(otherSession, r)).toEqual({
    disposition: "IN_PROGRESS",
  });
  await admin.internalRequest.updateMany({
    where: { requestId: r.requestId },
    data: { leaseUntil: new Date(0) },
  });
  const takeover = (await begin(r))[0]!.ticket;
  expect(takeover.fence).toBe(2);
  expect(takeover.token).not.toBe(first.token);
  await expect(finish(r, first)).rejects.toThrow("STALE_REQUEST");
  const finishes = await Promise.allSettled([
    finish(r, takeover),
    finish(r, takeover),
  ]);
  expect(
    finishes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect((await claimDue(otherSession, r)).disposition).toBe("OK");
  expect((await admin.workDispatch.findFirstOrThrow()).sendAttempts).toBe(1);
});

it("rejects one of two concurrent fingerprints reusing the same request ID", async () => {
  const r = request();
  const outcomes = await Promise.allSettled([
    claimDue(service, r),
    recoverDue(otherSession, r),
  ]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  expect(
    outcomes.filter((o) => o.status === "rejected")[0]!.reason.message,
  ).toContain("REQUEST_CONFLICT");
});

it("delayed acknowledgement and deferral cannot clear a replacement lease or later generation", async () => {
  await enable();
  const work = await fixture();
  const first = await oneRef();
  await admin.workDispatch.update({
    where: { id: work.id },
    data: { leaseUntil: new Date(0) },
  });
  const replacement = await oneRef();
  expect(replacement.generation).toBe(first.generation);
  expect(replacement.claimToken).not.toBe(first.claimToken);
  expect(await ackDelivery(service, request(first))).toEqual({
    disposition: "STALE",
  });
  expect(
    await deferDelivery(service, request({ ...first, retrySeconds: 1 })),
  ).toEqual({ disposition: "STALE" });
  expect(await ackDelivery(service, request(replacement))).toEqual({
    disposition: "DELIVERED",
  });
  expect(await recoverDue(service, request())).toMatchObject({ reopened: 0 });
  await admin.workDispatch.update({
    where: { id: work.id },
    data: { nextAttemptAt: new Date(0) },
  });
  const recover = request();
  expect(await recoverDue(service, recover)).toMatchObject({ reopened: 1 });
  expect(await recoverDue(otherSession, recover)).toMatchObject({
    reopened: 1,
  });
  const next = await oneRef();
  expect(next.generation).toBe(2);
  expect(await resolveStepBinding(service, work.id, 1)).toBeNull();
  expect(await ackDelivery(service, request(replacement))).toEqual({
    disposition: "STALE",
  });
  expect(
    await deferDelivery(service, request({ ...next, retrySeconds: 60 })),
  ).toEqual({ disposition: "DEFERRED" });
  expect(await claimDue(service, request())).toEqual({
    disposition: "OK",
    refs: [],
  });
  expect(
    (await admin.auditRun.findUniqueOrThrow({ where: { id: work.auditId! } }))
      .fence,
  ).toBe(0);
});

it("suppresses expiry in bounded recovery, and only reopens explicitly controlled abandoned pre-intent leases", async () => {
  await enable();
  const old = new Date(Date.now() - 3600000);
  const expired = await fixture("a-site", old, new Date(+old + 100));
  expect(await claimDue(service, request())).toEqual({
    disposition: "OK",
    refs: [],
  });
  expect(await recoverDue(service, request())).toMatchObject({
    suppressed: 1,
    reopened: 0,
  });
  expect(
    (await admin.workDispatch.findUniqueOrThrow({ where: { id: expired.id } }))
      .disposition,
  ).toBe("SUPPRESSED");
  await admin.auditRun.update({
    where: { id: expired.auditId! },
    data: { status: "FAILED" },
  });
  await admin.site.create({
    data: {
      id: "second",
      workspaceId: "a",
      origin: "https://second.example",
      verifiedAt: new Date(),
    },
  });
  const w = await fixture("second");
  await oneRef();
  await admin.workDispatch.update({
    where: { id: w.id },
    data: { leaseUntil: new Date(0) },
  });
  expect(await recoverDue(service, request())).toMatchObject({ reopened: 1 });
  expect((await oneRef()).generation).toBe(2);
});

it("checks global and scoped revocation again between claim, acknowledgement and resolution", async () => {
  await enable();
  const work = await fixture();
  const ref = await oneRef();
  await policy("audits", false);
  expect(await ackDelivery(service, request(ref))).toEqual({
    disposition: "PAUSED",
  });
  await policy("audits", true);
  await admin.productUser.update({
    where: { id: "owner" },
    data: { securityVersion: 1 },
  });
  expect(await ackDelivery(service, request(ref))).toEqual({
    disposition: "STALE",
  });
  await admin.productUser.update({
    where: { id: "owner" },
    data: { securityVersion: 0 },
  });
  expect(await ackDelivery(service, request(ref))).toEqual({
    disposition: "DELIVERED",
  });
  await policy("global", false);
  expect(await resolveStepBinding(service, work.id, 1)).toBeNull();
  await policy("global", true);
  await admin.membership.delete({
    where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
  });
  expect(await resolveStepBinding(service, work.id, 1)).toBeNull();
  await admin.auditRun.update({
    where: { id: work.auditId! },
    data: { status: "FAILED" },
  });
  expect(
    await admin.workDispatch.findUniqueOrThrow({ where: { id: work.id } }),
  ).toMatchObject({ disposition: "SUPPRESSED", claimToken: null });
});

it("selects eligible work behind 21 older revoked sponsors and rejects forged scope or unknown profiles", async () => {
  await enable();
  for (let i = 0; i < 21; i++) {
    const id = "blocked-" + i;
    const owner = "owner-" + i;
    await admin.workspace.create({ data: { id, name: id } });
    await admin.productUser.create({ data: { id: owner, suspended: true } });
    await admin.membership.create({
      data: { userId: owner, workspaceId: id, role: "OWNER" },
    });
    await admin.site.create({
      data: {
        id,
        workspaceId: id,
        origin: "https://blocked" + i + ".example",
        verifiedAt: new Date(),
      },
    });
    const createdAt = new Date(Date.now() - 60000);
    const audit = await admin.auditRun.create({
      data: {
        userId: owner,
        workspaceId: id,
        siteId: id,
        securityVersion: 0,
        profile: auditProfile,
        manifest: [],
        declarations: {},
        methodologyVersion: "fixture",
        inputHash: "test",
        idempotencyKey: id,
        createdAt,
      },
    });
    await admin.workDispatch.create({
      data: {
        userId: owner,
        workspaceId: id,
        siteId: id,
        admittedSecurityVersion: 0,
        targetKind: "AUDIT_RAW",
        auditId: audit.id,
        capability: "audits",
        profile: auditProfile,
        eligibility: "CONTROLLED_TEST",
        admittedAt: createdAt,
        expiresAt: new Date(+createdAt + 3600000),
        disposition: "PENDING",
        nextAttemptAt: createdAt,
      },
    });
  }
  const valid = await fixture();
  expect((await oneRef()).workId).toBe(valid.id);
  await expect(
    admin.workDispatch.update({
      where: { id: valid.id },
      data: { userId: "other" },
    }),
  ).rejects.toThrow("IMMUTABLE_DISPATCH");
  await admin.site.create({
    data: {
      id: "unknown",
      workspaceId: "b",
      origin: "https://unknown.example",
      verifiedAt: new Date(),
    },
  });
  await expect(
    fixture(
      "unknown",
      new Date(),
      new Date(Date.now() + 60000),
      "UNQUALIFIED_RAW",
      "b",
    ),
  ).rejects.toThrow(/check constraint/);
  await expect(admin.$executeRaw`INSERT INTO public."WorkDispatch"("workspaceId","siteId","userId","admittedSecurityVersion","targetKind","auditId",capability,profile,eligibility,"admittedAt","expiresAt",disposition,"nextAttemptAt")
    VALUES('a','unknown','other',0,'AUDIT_RAW',${valid.auditId},'audits',${auditProfile},'CONTROLLED_TEST',now(),now()+interval '1 hour','PENDING',now())`).rejects.toThrow(
    "INVALID_AUDIT_BINDING",
  );
});

it("bounds requests and cleanup and rolls back replay and delivery together on a DB failure", async () => {
  await enable();
  const work = await fixture();
  for (const limit of [null, 0, 21, 1.2, "1"])
    await expect(claimDue(service, request({ limit }))).rejects.toThrow(
      "INVALID_LIMIT",
    );
  for (const body of [
    { limit: 1, userId: "owner" },
    { limit: 1, principal: "another" },
  ])
    await expect(claimDue(service, request(body))).rejects.toThrow(
      "INVALID_LIMIT",
    );
  const r = request();
  await expect(claimDue(service, { ...r, audience: "wrong" })).rejects.toThrow(
    "INVALID_REQUEST",
  );
  await expect(
    claimDue(service, { ...r, expiresAt: new Date(0) }),
  ).rejects.toThrow("INVALID_REQUEST");
  await expect(
    claimDue(service, { ...r, rawBody: "a".repeat(8193) }),
  ).rejects.toThrow("INVALID_REQUEST");
  await expect(
    service.$queryRaw`SELECT lyraseo_kernel.cleanup_requests(21)`,
  ).rejects.toThrow("INVALID_LIMIT");
  // Forced counter overflow occurs after begin_request, before completion.
  await admin.workDispatch.update({
    where: { id: work.id },
    data: { sendAttempts: 2147483647 },
  });
  await expect(claimDue(service, r)).rejects.toThrow(/integer out of range/);
  expect(
    await admin.internalRequest.count({ where: { requestId: r.requestId } }),
  ).toBe(0);
  expect(
    (await admin.workDispatch.findUniqueOrThrow({ where: { id: work.id } }))
      .claimToken,
  ).toBeNull();
  await admin.workDispatch.update({
    where: { id: work.id },
    data: { sendAttempts: 0 },
  });
  await claimDue(service, r);
  const [keep] = await service.$queryRaw<
    { removed: number }[]
  >`SELECT lyraseo_kernel.cleanup_requests(1) removed`;
  expect(keep!.removed).toBe(0);
});

it("rejects expired completed replay and cleans up only bounded rows older than the retry window", async () => {
  const now = Date.now();
  const short = {
    ...request(),
    issuedAt: new Date(now - 59000),
    expiresAt: new Date(now + 350),
  };
  expect(await claimDue(service, short)).toEqual({
    disposition: "PAUSED",
    refs: [],
  });
  await admin.$executeRaw`SELECT pg_sleep(0.4)`;
  await expect(claimDue(service, short)).rejects.toThrow("INVALID_REQUEST");
  const oldIds = [randomUUID(), randomUUID()];
  const prior = await admin.internalRequest.findFirstOrThrow({
    where: { requestId: short.requestId },
  });
  await admin.internalRequest.createMany({
    data: oldIds.map((id) => ({
      requestId: id,
      servicePrincipalId: prior.servicePrincipalId,
      state: "COMPLETE",
      fence: 1,
      fingerprint: prior.fingerprint,
      issuedAt: new Date(now - 172800000 - 60000),
      expiresAt: new Date(now - 172800000),
      completedAt: new Date(now - 172800000),
      result: { disposition: "PAUSED", refs: [] },
    })),
  });
  const [batch] = await service.$queryRaw<
    { n: number }[]
  >`SELECT lyraseo_kernel.cleanup_requests(1) n`;
  expect(batch!.n).toBe(1);
  expect(
    await admin.internalRequest.count({ where: { requestId: { in: oldIds } } }),
  ).toBe(1);
  expect(
    await admin.internalRequest.count({
      where: { requestId: short.requestId },
    }),
  ).toBe(1);
  await service.$queryRaw`SELECT lyraseo_kernel.cleanup_requests(1)`;
  await expect(
    admin.internalRequest.updateMany({
      where: { requestId: short.requestId },
      data: { result: { disposition: "a".repeat(32769) } },
    }),
  ).rejects.toThrow(/check constraint/);
});

it("rolls back target cancellation and its same-transaction suppression together", async () => {
  await enable();
  const work = await fixture();
  const ref = await oneRef();
  await ackDelivery(service, request(ref));
  await expect(
    admin.$transaction(async (tx) => {
      await tx.auditRun.update({
        where: { id: work.auditId! },
        data: { status: "FAILED" },
      });
      expect(
        (await tx.workDispatch.findUniqueOrThrow({ where: { id: work.id } }))
          .disposition,
      ).toBe("SUPPRESSED");
      throw new Error("ROLLBACK_FIXTURE");
    }),
  ).rejects.toThrow("ROLLBACK_FIXTURE");
  expect(
    await resolveStepBinding(service, work.id, work.generation),
  ).toMatchObject({ targetId: work.auditId });
});

it("protects a terminal archival event even against an indirect parent-ID update by the runtime", async () => {
  const op = await admin.operation.create({
    data: {
      workspaceId: "a",
      siteId: "a-site",
      userId: "owner",
      sessionId: "fixture",
      securityVersion: 0,
      kind: "GENERATION",
      provider: "AZURE",
      period: "2026-11",
      route: "archive",
      idempotencyKey: randomUUID(),
      inputHash: "hash",
      tariffVersion: "fixture",
      reservedCost: 0.3,
      status: "FAILED",
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  expect(
    await admin.workDispatch.count({ where: { operationId: op.id } }),
  ).toBe(0);
  const before = await admin.outboxEvent.findUniqueOrThrow({
    where: { operationId: op.id },
  });
  await expect(
    web.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id','owner',true)`;
      return tx.operation.update({
        where: { id: op.id },
        data: { id: "rewritten" },
      });
    }),
  ).rejects.toThrow("IMMUTABLE_HISTORY");
  await expect(
    admin.outboxEvent.delete({ where: { id: before.id } }),
  ).rejects.toThrow("IMMUTABLE_HISTORY");
  expect(
    await admin.outboxEvent.findUniqueOrThrow({
      where: { operationId: op.id },
    }),
  ).toEqual(before);
});

it.each(["ack", "defer"])(
  "rechecks %s after waiting on an unchanged locked tuple past the delivery deadline",
  async (action) => {
    await enable();
    const work = await fixture();
    const ref = await oneRef();
    const ack = request(action === "ack" ? ref : { ...ref, retrySeconds: 1 });
    const path = dispatchPath + "/" + action;
    const deadline = (
      await admin.$queryRaw<
        { deadline: Date }[]
      >`UPDATE "WorkDispatch" SET "leaseUntil"=clock_timestamp()+interval '1 second' WHERE id=${work.id}::uuid RETURNING "leaseUntil" AS deadline`
    )[0]!.deadline;
    let pending: Promise<{ result: { disposition: string } }[]> | undefined;
    await admin.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WorkDispatch" WHERE id=${work.id}::uuid FOR UPDATE`;
      pending = otherSession.$transaction(async (other) => {
        await other.$executeRaw`SET LOCAL application_name='kernel-delayed-ack'`;
        return other.$queryRaw<
          { result: { disposition: string } }[]
        >`SELECT lyraseo_kernel.command(${ack.requestId}::uuid,${ack.audience},${path},${ack.rawBody},${ack.issuedAt}::timestamptz,${ack.expiresAt}::timestamptz) result`;
      });
      const waitLimit = Date.now() + 3000;
      for (;;) {
        const [waiter] = await admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='kernel-delayed-ack' AND wait_event_type='Lock') waiting`;
        if (waiter!.waiting) break;
        if (Date.now() >= waitLimit)
          throw new Error("Acknowledgement did not reach row-lock barrier");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await tx.$executeRaw`SELECT pg_sleep_until(${deadline}::timestamptz + interval '30 milliseconds')`;
    });
    expect((await pending!)![0]!.result).toEqual({ disposition: "STALE" });
    expect(
      await admin.workDispatch.findUniqueOrThrow({ where: { id: work.id } }),
    ).toMatchObject({
      generation: 1,
      claimToken: ref.claimToken,
      disposition: "PENDING",
    });
    expect(await recoverDue(service, request())).toMatchObject({ reopened: 1 });
    expect((await oneRef()).generation).toBe(2);
  },
);

it("rolls back the admission of an old binary that attempts a redundant nested outbox insert", async () => {
  const id = randomUUID();
  await admin.budgetPeriod.createMany({
    data: ["COMBINED", "AZURE"].map((bucket) => ({
      userId: actor.userId,
      period: "2026-11",
      bucket,
      limit: 8,
      reserved: "0.25",
      spent: "0.375",
    })),
  });
  const balances = () =>
    admin.budgetPeriod.findMany({ orderBy: { bucket: "asc" } });
  const before = await balances();
  await expect(
    web.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id','owner',true),set_config('app.workspace_id','a',true)`;
      const changed = await tx.budgetPeriod.updateMany({
        where: { userId: actor.userId, period: "2026-11" },
        data: { reserved: { increment: "0.1" } },
      });
      expect(changed.count).toBe(2);
      return tx.operation.create({
        data: {
          id,
          workspaceId: "a",
          siteId: "a-site",
          userId: "owner",
          sessionId: "legacy",
          securityVersion: 0,
          kind: "GENERATION",
          provider: "AZURE",
          period: "2026-11",
          route: "legacy",
          idempotencyKey: id,
          inputHash: "hash",
          tariffVersion: "fixture",
          reservedCost: 0.1,
          expiresAt: new Date(Date.now() + 60000),
          outbox: { create: { workspaceId: "a", userId: "owner" } },
        },
      });
    }),
  ).rejects.toThrow(/denied/);
  expect(await balances()).toEqual(before);
  expect(await admin.operation.count({ where: { id } })).toBe(0);
  expect(await admin.outboxEvent.count({ where: { operationId: id } })).toBe(0);
  expect(await admin.workDispatch.count({ where: { operationId: id } })).toBe(
    0,
  );
});

it("rejects browser execution of a controlled audit before claim or transport and still permits cancellation", async () => {
  const work = await fixture(
    "a-site",
    new Date(),
    new Date(Date.now() + 3600000),
    auditProfile,
    "a",
    ["https://example.com/"],
  );
  const scope = { workspaceId: "a", siteId: "a-site", auditId: work.auditId! };
  let calls = 0;
  await expect(
    runRawAuditStep(web, actor, scope, async () => {
      calls++;
      throw new Error("fixture transport");
    }),
  ).rejects.toThrow("FORBIDDEN");
  expect(calls).toBe(0);
  expect(
    await admin.auditRun.findUniqueOrThrow({ where: { id: scope.auditId } }),
  ).toMatchObject({ fence: 0, status: "QUEUED", leaseOwner: null });
  await cancelAuditRun(web, actor, scope);
  expect(
    (await admin.workDispatch.findUniqueOrThrow({ where: { id: work.id } }))
      .disposition,
  ).toBe("SUPPRESSED");
});

async function uncertainFixture(attemptState: string) {
  const known = attemptState === "ACCEPTED" ? "known-task" : null;
  const op = await admin.operation.create({
    data: {
      userId: "owner",
      workspaceId: "a",
      siteId: "a-site",
      sessionId: actor.sessionId,
      securityVersion: 0,
      kind: "GENERATION",
      provider: "AZURE",
      period: "2026-11",
      route: "fixture",
      idempotencyKey: randomUUID(),
      inputHash: "hash",
      tariffVersion: "fixture",
      reservedCost: "0.3",
      status: "RUNNING",
      attemptState,
      providerTaskId: known,
      fence: 7,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  await admin.budgetPeriod.createMany({
    data: ["AZURE", "COMBINED"].map((bucket) => ({
      userId: "owner",
      period: "2026-11",
      bucket,
      limit: 8,
      reserved: "0.3",
    })),
  });
  return op;
}
it.each(["INTENT", "ACCEPTED"])(
  "retains one ledger handoff after cancelling a cutover %s, and accepts its late receipt",
  async (attemptState) => {
    const op = await uncertainFixture(attemptState);
    const known = op.providerTaskId;
    const balances = () =>
      admin.budgetPeriod.findMany({
        where: { bucket: { in: ["AZURE", "COMBINED"] } },
        orderBy: { bucket: "asc" },
      });
    const before = await balances();
    await cancelOperation(web, actor, op.id);
    expect(await recoverDue(service, request())).toEqual({
      disposition: "OK",
      reopened: 0,
      suppressed: 0,
      reconciliation: 1,
    });
    expect(await recoverDue(service, request())).toMatchObject({
      reconciliation: 0,
    });
    expect(await balances()).toEqual(before);
    expect(
      await admin.operation.findUniqueOrThrow({ where: { id: op.id } }),
    ).toMatchObject({ fence: 7, providerTaskId: known, status: "RECONCILING" });
    await acceptAttempt(web, actor, op.id, 7, "known-task");
    expect(await recoverDue(service, request())).toMatchObject({
      reconciliation: 0,
    });
    await settleOperation(web, actor, op.id, 7, {
      receiptId: "late",
      amount: "0.13",
      acceptedOutput: false,
    });
    expect(
      (await balances()).map((row) => [
        row.reserved.toString(),
        row.spent.toString(),
      ]),
    ).toEqual([
      ["0", "0.13"],
      ["0", "0.13"],
    ]);
  },
);

it("retires a pending ledger handoff if the definitive receipt arrives before recovery", async () => {
  const op = await uncertainFixture("ACCEPTED");
  await cancelOperation(web, actor, op.id);
  await settleOperation(web, actor, op.id, op.fence, {
    receiptId: "settled-first",
    amount: "0.13",
    acceptedOutput: false,
  });
  expect(await recoverDue(service, request())).toEqual({
    disposition: "OK",
    reopened: 0,
    suppressed: 0,
    reconciliation: 0,
  });
  expect(
    (
      await admin.workDispatch.findUniqueOrThrow({
        where: { operationId: op.id },
      })
    ).ledgerHandoff,
  ).toBe("NONE");
  expect(
    await admin.usageReceipt.count({ where: { operationId: op.id } }),
  ).toBe(1);
});
