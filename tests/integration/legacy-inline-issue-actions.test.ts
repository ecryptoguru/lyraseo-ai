import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../packages/db/src";
import { reviewAuditIssue } from "../../packages/db/src/audits";

const name = process.env.LYRA_INLINE_TEST_DB;
if (name && !/^lyraseo_inline_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_INLINE_DATABASE_REQUIRED");
const url = `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${name ?? "lyraseo_inline_invalid"}`;
const runtime = createDatabase(url);
const admin = createDatabase(
  url.replace(
    "lyraseo_runtime:local_runtime_only",
    "postgres:lyraseo_local_only",
  ),
);
const actor = {
  userId: "inline-owner",
  sessionId: "inline-session",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  authProvider: "supabase" as const,
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture() {
  const id = randomUUID(),
    workspaceId = "issue-w-" + id,
    siteId = "issue-s-" + id;
  await admin.workspace.create({
    data: { id: workspaceId, name: "Owned issue-action regression" },
  });
  await admin.membership.create({
    data: { workspaceId, userId: actor.userId, role: "OWNER" },
  });
  await admin.site.create({
    data: {
      id: siteId,
      workspaceId,
      origin: "https://issue.example",
      verifiedAt: new Date(),
    },
  });
  const run = await admin.auditRun.create({
    data: {
      workspaceId,
      siteId,
      userId: actor.userId,
      securityVersion: 0,
      idempotencyKey: id,
      inputHash: id,
      manifest: ["https://issue.example/"],
      profile: "LOCAL_RAW_V1",
      declarations: {},
      methodologyVersion: "readiness-v2",
      status: "COMPLETED",
      evaluation: {
        rules: [
          {
            ruleId: "WITHHELD_RULE",
            scopeKey: "https://issue.example/",
            outcome: "FAIL",
            evidence: "WITHHELD_FACT",
          },
        ],
      },
    },
  });
  return { scope: { workspaceId, siteId, auditId: run.id }, run };
}
async function enroll(scope: { workspaceId: string; siteId: string }) {
  await admin.$executeRaw`INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time(),'lyraseo_artifact_maintenance',${scope.workspaceId},${scope.siteId},'P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database()`;
}
async function identityRace(
  kind: "epoch" | "suspension",
  order: "review-first" | "revocation-first",
) {
  const f = await fixture();
  const userId = "issue-identity-" + randomUUID();
  await admin.productUser.create({ data: { id: userId } });
  await admin.membership.create({
    data: { workspaceId: f.scope.workspaceId, userId, role: "OWNER" },
  });
  const identity = { ...actor, userId };
  const patch = kind === "epoch" ? { securityVersion: 1 } : { suspended: true };
  const arrived = deferred(),
    release = deferred();
  if (order === "review-first") {
    const observed = runtime.$extends({
      query: {
        issueAction: {
          async create({ args, query }) {
            arrived.resolve();
            await release.promise;
            return query(args);
          },
        },
      },
    });
    const reviewing = reviewAuditIssue(observed, identity, f.scope, input());
    await arrived.promise;
    let revoked = false;
    const revoking = admin.productUser
      .update({ where: { id: userId }, data: patch })
      .then(() => {
        revoked = true;
      });
    try {
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const [row] = await admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE%ProductUser%' AND pid<>pg_backend_pid()) AS waiting`;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        if (revoked) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(
        revoked,
        kind + " must wait until the admitted write commits",
      ).toBe(false);
      expect(waiting).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([reviewing, revoking]);
    }
    expect((await reviewing).userId).toBe(userId);
    await revoking;
    expect(
      await admin.issueAction.count({ where: { auditId: f.run.id } }),
    ).toBe(1);
  } else {
    const revoking = admin.$transaction(async (tx) => {
      await tx.productUser.update({ where: { id: userId }, data: patch });
      arrived.resolve();
      await release.promise;
    });
    await arrived.promise;
    let settled = false;
    const reviewing = reviewAuditIssue(
      runtime,
      identity,
      f.scope,
      input(),
    ).then(
      () => {
        settled = true;
        return "ALLOWED";
      },
      (e: Error) => {
        settled = true;
        return e.message;
      },
    );
    try {
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const [row] = await admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_runtime' AND wait_event_type='Lock' AND query LIKE '%lock_issue_actor%') AS waiting`;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        if (settled) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(
        settled,
        kind + " must settle before the identity lock decision",
      ).toBe(false);
      expect(waiting).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([reviewing, revoking]);
    }
    await revoking;
    expect(await reviewing).toBe("FORBIDDEN");
    expect(
      await admin.issueAction.count({ where: { auditId: f.run.id } }),
    ).toBe(0);
  }
  await expect(
    reviewAuditIssue(runtime, identity, f.scope, input()),
  ).rejects.toThrow("FORBIDDEN");
  expect(
    await admin.auditRun.findUniqueOrThrow({ where: { id: f.run.id } }),
  ).toEqual(f.run);
}
const input = (ruleId = "WITHHELD_RULE") => ({
  ruleId,
  scopeKey: "https://issue.example/",
  disposition: "REVIEWED" as const,
  reason: "Authored review reason",
});
afterAll(async () => {
  await runtime.$disconnect();
  await admin.$disconnect();
});
describe.skipIf(!name)("legacy inline issue-action boundary", () => {
  it("rejects matching and guessed withheld rules before loading evaluation or mutating actions", async () => {
    const f = await fixture();
    await enroll(f.scope);
    const reads: unknown[] = [];
    const observed = runtime.$extends({
      query: {
        auditRun: {
          async findFirst({ args, query }) {
            reads.push(args);
            return query(args);
          },
        },
      },
    });
    for (const rule of ["WITHHELD_RULE", "GUESSED_RULE"])
      await expect(
        reviewAuditIssue(observed, actor, f.scope, input(rule)),
      ).rejects.toThrow("LEGACY_EVIDENCE_WITHHELD");
    expect(reads).toEqual([]);
    expect(
      await admin.issueAction.count({ where: { auditId: f.run.id } }),
    ).toBe(0);
    expect(
      await admin.auditRun.findUniqueOrThrow({ where: { id: f.run.id } }),
    ).toEqual(f.run);
  });
  it("keeps cross-scope and missing IDs not-found and revoked actors forbidden without mutation", async () => {
    const f = await fixture(),
      other = await fixture();
    await enroll(f.scope);
    for (const scope of [
      { ...f.scope, auditId: "guessed-" + randomUUID() },
      { ...other.scope, auditId: f.run.id },
      { ...f.scope, auditId: other.run.id },
    ])
      await expect(
        reviewAuditIssue(runtime, actor, scope, input()),
      ).rejects.toThrow("NOT_FOUND");
    const userId = "revoked-issue-" + randomUUID();
    await admin.productUser.create({ data: { id: userId } });
    await admin.membership.create({
      data: { workspaceId: f.scope.workspaceId, userId, role: "EDITOR" },
    });
    await admin.siteGrant.create({
      data: {
        workspaceId: f.scope.workspaceId,
        siteId: f.scope.siteId,
        userId,
      },
    });
    await admin.siteGrant.delete({
      where: {
        workspaceId_siteId_userId: {
          workspaceId: f.scope.workspaceId,
          siteId: f.scope.siteId,
          userId,
        },
      },
    });
    for (const identity of [
      { ...actor, userId },
      { ...actor, securityVersion: 999 },
    ])
      for (const auditId of [f.run.id, "guessed-" + randomUUID()])
        await expect(
          reviewAuditIssue(runtime, identity, { ...f.scope, auditId }, input()),
        ).rejects.toThrow("FORBIDDEN");
    expect(
      await admin.issueAction.count({
        where: { auditId: { in: [f.run.id, other.run.id] } },
      }),
    ).toBe(0);
    expect(
      await admin.auditRun.findUniqueOrThrow({ where: { id: f.run.id } }),
    ).toEqual(f.run);
    const [rights] = await runtime.$queryRaw<
      { directUpdate: boolean }[]
    >`SELECT has_any_column_privilege(current_user,'public."ProductUser"','UPDATE') AS "directUpdate"`;
    expect(rights?.directUpdate).toBe(false);
    const failures: string[] = [];
    for (const kind of ["epoch", "suspension"] as const)
      for (const order of ["review-first", "revocation-first"] as const)
        try {
          await identityRace(kind, order);
        } catch (error) {
          failures.push(
            `${kind}/${order}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
    expect(failures).toEqual([]);
  });
  it("serializes an admitted unprotected review before enrollment commits", async () => {
    const f = await fixture(),
      arrived = deferred(),
      release = deferred();
    const observed = runtime.$extends({
      query: {
        issueAction: {
          async create({ args, query }) {
            arrived.resolve();
            await release.promise;
            return query(args);
          },
        },
      },
    });
    const reviewing = reviewAuditIssue(observed, actor, f.scope, input());
    await arrived.promise;
    let enrolled = false;
    const enrolling = enroll(f.scope).then(() => {
      enrolled = true;
    });
    try {
      // Observe the second backend actually blocked on the scope lock.
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const [row] = await admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%lyraseo_legacy_inline.environment%' AND pid<>pg_backend_pid()) AS waiting`;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        if (enrolled) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(enrolled).toBe(false);
      expect(waiting).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([reviewing, enrolling]);
    }
    const action = await reviewing;
    await enrolling;
    expect(action.ruleId).toBe("WITHHELD_RULE");
    for (const rule of ["WITHHELD_RULE", "GUESSED_RULE"])
      await expect(
        reviewAuditIssue(runtime, actor, f.scope, input(rule)),
      ).rejects.toThrow("LEGACY_EVIDENCE_WITHHELD");
    expect(
      await admin.issueAction.count({ where: { auditId: f.run.id } }),
    ).toBe(1);
  });
  it.each(["retained", "revoked"] as const)(
    "waits for enrollment and rechecks %s authority before revealing withholding",
    async (access) => {
      const f = await fixture(),
        arrived = deferred(),
        release = deferred();
      const enrolling = admin.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${f.scope.workspaceId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${f.scope.siteId} AND "workspaceId"=${f.scope.workspaceId} FOR UPDATE`;
        arrived.resolve();
        await release.promise;
        await tx.$executeRaw`INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time(),'lyraseo_artifact_maintenance',${f.scope.workspaceId},${f.scope.siteId},'P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database()`;
      });
      await arrived.promise;
      let settled = false;
      const reviewing = reviewAuditIssue(runtime, actor, f.scope, input()).then(
        () => {
          settled = true;
          return "ALLOWED";
        },
        (e: Error) => {
          settled = true;
          return e.message;
        },
      );
      try {
        let waiting = false;
        for (let n = 0; n < 100; n++) {
          const [row] = await admin.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_runtime' AND wait_event_type='Lock' AND query LIKE '%FOR SHARE%') AS waiting`;
          if (row?.waiting) {
            waiting = true;
            break;
          }
          if (settled) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(settled).toBe(false);
        expect(waiting).toBe(true);
        if (access === "revoked")
          await admin.membership.update({
            where: {
              workspaceId_userId: {
                workspaceId: f.scope.workspaceId,
                userId: actor.userId,
              },
            },
            data: { role: "VIEWER" },
          });
      } finally {
        release.resolve();
        await Promise.allSettled([reviewing, enrolling]);
      }
      await enrolling;
      expect(await reviewing).toBe(
        access === "revoked" ? "FORBIDDEN" : "LEGACY_EVIDENCE_WITHHELD",
      );
      expect(
        await admin.issueAction.count({ where: { auditId: f.run.id } }),
      ).toBe(0);
    },
  );
});
