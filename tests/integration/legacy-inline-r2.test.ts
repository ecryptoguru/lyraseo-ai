import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "../../packages/db/generated/client";
import { claimAuditRun } from "../../packages/db/src/audits";
import { readPage, registerPage } from "../../packages/db/src/pages";
import * as gsc from "../../packages/db/src/gsc";
import { auditErrorCode } from "../../packages/db/src/audit-errors";

const name = process.env.LYRA_INLINE_TEST_DB;
if (name && !/^lyraseo_inline_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_INLINE_DATABASE_REQUIRED");
const { PrismaPg } = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
)("@prisma/adapter-pg");
const connection = `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${name ?? "lyraseo_inline_invalid"}`;
// Every page service must complete with only one connection in its own pool.
const reader = new PrismaClient({
  adapter: new PrismaPg({ connectionString: connection, max: 1 }),
});
const writer = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: connection.replace(
      "lyraseo_runtime:local_runtime_only",
      "postgres:lyraseo_local_only",
    ),
    max: 1,
  }),
});
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
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(active = false) {
  const suffix = randomUUID(),
    workspaceId = "r2-workspace-" + suffix,
    siteId = "r2-" + suffix,
    address = `https://r2-${suffix}.example/`;
  await writer.workspace.create({
    data: { id: workspaceId, name: "Owned R2 race fixture" },
  });
  await writer.membership.create({
    data: { workspaceId, userId: actor.userId, role: "OWNER" },
  });
  await writer.site.create({
    data: {
      id: siteId,
      workspaceId,
      origin: new URL(address).origin,
      verifiedAt: new Date(),
    },
  });
  const audit = await writer.auditRun.create({
    data: {
      workspaceId,
      siteId,
      userId: actor.userId,
      securityVersion: 0,
      idempotencyKey: suffix,
      inputHash: "r2-owned-fixture",
      manifest: [address],
      profile: "LOCAL_RAW_V1",
      methodologyVersion: "readiness-v2",
      declarations: {},
      status: active ? "QUEUED" : "COMPLETED",
      evaluation: active
        ? undefined
        : {
            manifest: [address],
            score: 42,
            coverage: 1,
            methodologyVersion: "readiness-v2",
            rules: [
              {
                ruleId: "R2_FINDING",
                ruleVersion: "2",
                scopeKey: address,
                outcome: "FAIL",
                reasonCode: "R2_FROZEN",
                evidence: "R2_FROZEN_TEXT",
              },
            ],
          },
    },
  });
  await writer.searchSnapshot.create({
    data: {
      workspaceId,
      siteId,
      property: address,
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      shape: "page",
      status: "complete",
      rows: [{ keys: [address], impressions: 300, clicks: 1, position: 8 }],
    },
  });
  const scope = { workspaceId, siteId },
    page = await registerPage(reader, actor, scope, address);
  return { scope, page, audit, address };
}
async function enroll({
  workspaceId,
  siteId,
}: {
  workspaceId: string;
  siteId: string;
}) {
  await writer.$executeRaw`INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time(),'lyraseo_artifact_maintenance',${workspaceId},${siteId},'P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database()`;
}
const originalSearch = gsc.readGoogleSearch;
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await reader.$disconnect();
  await writer.$disconnect();
});
describe.skipIf(!name)(
  "legacy inline R2 final composition and authority",
  () => {
    it.each(["before-search", "after-search"] as const)(
      "revalidates audits and GSC when enrollment commits %s",
      async (phase) => {
        const f = await fixture(),
          arrived = deferred(),
          resume = deferred();
        vi.spyOn(gsc, "readGoogleSearch").mockImplementation(
          async (...args) => {
            if (phase === "before-search") {
              arrived.resolve();
              await resume.promise;
            }
            const result = await originalSearch(...args);
            if (phase === "after-search") {
              expect(
                result.opportunities.some((o) => o.kind === "demand-and-audit"),
              ).toBe(true);
              arrived.resolve();
              await resume.promise;
            }
            return result;
          },
        );
        const pending = readPage(reader, actor, f.scope, f.page.id);
        await arrived.promise;
        try {
          await enroll(f.scope);
        } finally {
          resume.resolve();
        }
        const result = await pending;
        expect(result.audits).toHaveLength(1);
        expect(result.audits[0]!.evidenceStatus).toBe(
          "legacy-lineage-withheld",
        );
        expect(result.audits[0]!.findings).toEqual([]);
        expect(result.search.auditEvidenceStatus).toBe(
          "legacy-lineage-withheld",
        );
        expect(
          result.search.opportunities.some(
            (o) => o.kind === "demand-and-audit",
          ),
        ).toBe(false);
        expect(JSON.stringify(result)).not.toContain("R2_FINDING");
      },
    );
    it("retries instead of composing an audit whose exact status changed during GSC work", async () => {
      const f = await fixture(true),
        arrived = deferred(),
        resume = deferred();
      vi.spyOn(gsc, "readGoogleSearch").mockImplementation(async (...args) => {
        const result = await originalSearch(...args);
        arrived.resolve();
        await resume.promise;
        return result;
      });
      const pending = readPage(reader, actor, f.scope, f.page.id);
      await arrived.promise;
      try {
        await claimAuditRun(
          reader,
          actor,
          { ...f.scope, auditId: f.audit.id },
          "r2-status-change",
        );
      } finally {
        resume.resolve();
      }
      await expect(pending).rejects.toThrow("SOURCE_CHANGED");
    });
    it.skipIf(process.env.LYRA_INLINE_R2_RED === "true")(
      "holds final scope lock through payload construction before a waiting enrollment",
      async () => {
        const f = await fixture(),
          arrived = deferred(),
          resume = deferred();
        let paused = false;
        const observed = reader.$extends({
          query: {
            auditRun: {
              async findMany({ args, query }) {
                const rows = await query(args);
                if (
                  !paused &&
                  args.where?.siteId === f.scope.siteId &&
                  args.select?.storageFormat &&
                  args.select?.completedAt
                ) {
                  paused = true;
                  arrived.resolve();
                  await resume.promise;
                }
                return rows;
              },
            },
          },
        });
        const pending = readPage(
          observed as unknown as PrismaClient,
          actor,
          f.scope,
          f.page.id,
        );
        await Promise.race([
          arrived.promise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(Error("FINAL_SCOPE_LOCK_NOT_OBSERVED")),
              5000,
            ),
          ),
        ]);
        let enrolled = false;
        const enrollment = enroll(f.scope).then(() => {
          enrolled = true;
        });
        try {
          await new Promise((r) => setTimeout(r, 60));
          expect(enrolled).toBe(false);
        } finally {
          resume.resolve();
        }
        const before = await pending;
        await enrollment;
        expect(before.audits[0]!.evidenceStatus).toBe("available");
        expect(before.audits[0]!.findings).toHaveLength(1);
        expect(
          before.search.opportunities.some(
            (o) => o.kind === "demand-and-audit",
          ),
        ).toBe(true);
        const after = await readPage(reader, actor, f.scope, f.page.id);
        expect(after.audits[0]!.evidenceStatus).toBe("legacy-lineage-withheld");
        expect(
          after.search.opportunities.some((o) => o.kind === "demand-and-audit"),
        ).toBe(false);
      },
    );
    it("completes concurrent composed page reads with a max-one-connection pool", async () => {
      const f = await fixture();
      const result = await Promise.all(
        Array.from({ length: 6 }, () =>
          readPage(reader, actor, f.scope, f.page.id),
        ),
      );
      expect(result).toHaveLength(6);
      expect(
        result.every((r) => r.audits[0]!.evidenceStatus === "available"),
      ).toBe(true);
    });
    it("authorizes revoked actors stale epochs nonowners and guessed IDs before revealing the fence", async () => {
      const f = await fixture(true),
        { workspaceId } = f.scope,
        suffix = randomUUID(),
        revoked = "r2-revoked-" + suffix,
        nonowner = "r2-nonowner-" + suffix;
      await writer.productUser.createMany({
        data: [{ id: revoked }, { id: nonowner }],
      });
      await writer.membership.createMany({
        data: [
          { workspaceId, userId: revoked, role: "EDITOR" },
          { workspaceId, userId: nonowner, role: "OWNER" },
        ],
      });
      await writer.siteGrant.create({
        data: { workspaceId, siteId: f.scope.siteId, userId: revoked },
      });
      const privateRun = await writer.auditRun.create({
        data: {
          workspaceId,
          siteId: f.scope.siteId,
          userId: actor.userId,
          securityVersion: 0,
          idempotencyKey: randomUUID(),
          inputHash: "r2-private-identity",
          manifest: [f.address],
          profile: "LOCAL_RAW_V1",
          methodologyVersion: "readiness-v2",
          declarations: {},
          status: "COMPLETED",
          storageFormat: "AUDIT_PRIVATE_V1",
        },
      });
      await enroll(f.scope);
      await writer.siteGrant.deleteMany({
        where: { workspaceId, siteId: f.scope.siteId, userId: revoked },
      });
      const transition = async (userId: string, epoch: number, id: string) => {
        try {
          await reader.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.actor_id',${userId},true)`;
            await tx.$queryRaw`SELECT lyraseo_audit.web_transition(${f.scope.siteId},${id},${epoch}::integer,'claim',NULL,NULL,NULL::json)`;
          });
          return "ALLOWED";
        } catch (e) {
          return auditErrorCode(e);
        }
      };
      for (const id of [f.audit.id, privateRun.id, "r2-guessed-" + suffix]) {
        expect(await transition(revoked, 0, id)).toBe("FORBIDDEN");
        expect(await transition(actor.userId, 999, id)).toBe("FORBIDDEN");
      }
      for (const id of [f.audit.id, privateRun.id])
        expect(await transition(nonowner, 0, id)).toBe("FORBIDDEN");
      expect(await transition(actor.userId, 0, f.audit.id)).toBe(
        "LEGACY_INLINE_WRITER_FENCED",
      );
      expect(await transition(actor.userId, 0, "r2-guessed-" + suffix)).toBe(
        "NOT_FOUND",
      );
      expect(
        await writer.auditRun.findUniqueOrThrow({ where: { id: f.audit.id } }),
      ).toEqual(f.audit);
    });
  },
);
