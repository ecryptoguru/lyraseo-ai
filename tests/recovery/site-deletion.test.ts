import { afterAll, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { withEvidenceRead } from "../../packages/db/src/context";
import { createDatabase } from "../../packages/db/src";
import {
  acceptSiteDeletion,
  localSiteDeletionMaintenance,
  previewSiteDeletion,
} from "../../packages/db/src/site-deletion";
import { openRecoveryJournal } from "../../packages/db/src/recovery-journal";
import { exportRetainedWork } from "../../packages/db/src/retained-work";
import { localRecoveryPoints } from "../../packages/db/src/recovery-points";
import { stagePrivilegedSyntheticDeletion } from "../helpers/recovery-operator";
import { readPage } from "../../packages/db/src/pages";
const database = process.env.LYRA_RECOVERY_DB;
if (!/^lyraseo_recovery_[a-f0-9]{12}$/.test(database ?? ""))
  throw Error("OWNED_RECOVERY_DATABASE_REQUIRED");
const admin = createDatabase(
  `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${database}`,
);
const runtime = createDatabase(
  `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${database}`,
);
const maintenance = createDatabase(
  `postgresql://lyraseo_artifact_maintenance:local_expiry_only@127.0.0.1:54329/${database}`,
);
const roots: string[] = [];
afterAll(async () => {
  await Promise.all([
    admin.$disconnect(),
    runtime.$disconnect(),
    maintenance.$disconnect(),
    ...roots.map((root) => rm(root, { recursive: true, force: true })),
  ]);
});
async function fixture() {
  const nonce = randomUUID().replaceAll("-", "");
  const workspaceId = "w" + nonce,
    siteId = "s" + nonce,
    userId = "u" + nonce;
  await admin.$executeRaw`INSERT INTO "ProductUser"(id) VALUES(${userId})`;
  await admin.$executeRaw`INSERT INTO "Workspace"(id,name) VALUES(${workspaceId},'Deletion fixture')`;
  await admin.$executeRaw`INSERT INTO "Membership"("workspaceId","userId",role) VALUES(${workspaceId},${userId},'OWNER')`;
  await admin.$executeRaw`INSERT INTO "Site"(id,"workspaceId",origin) VALUES(${siteId},${workspaceId},'https://deletion.example')`;
  await admin.$executeRaw`INSERT INTO lyraseo_history.environment(workspace_id,site_id,database_oid,postmaster_started_at,policy_version,enabled) SELECT ${workspaceId},${siteId},oid,pg_postmaster_start_time(),'HISTORY_EXPIRY_LOCAL_V1',true FROM pg_database WHERE datname=current_database()`;
  const actor = {
    userId,
    sessionId: "session-" + nonce,
    securityVersion: 0,
    authenticatedAt: new Date().toISOString(),
    mfaVerified: true,
    mfaAuthenticatedAt: new Date().toISOString(),
    authProvider: "supabase" as const,
  };
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lyraseo-delete-journal-")),
  );
  roots.push(root);
  const key = randomBytes(32),
    journal = await openRecoveryJournal({ root, key, enabled: true });
  const scope = { workspaceId, siteId },
    preview = await previewSiteDeletion(runtime, actor, scope);
  const input = {
    caseId: randomUUID(),
    requestId: randomUUID(),
    confirmSiteId: siteId,
    confirmIncarnation: preview.incarnation,
    permanent: true as const,
  };
  return { actor, scope, journal, root, key, input };
}
it("fails closed before journal or data changes even with the TypeScript flag enabled", async () => {
  const { actor, scope, journal, input } = await fixture();
  await admin.googleConnection.create({
    data: {
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      encryptedRefreshToken: "SYNTHETIC_SECRET",
    },
  });
  await expect(
    acceptSiteDeletion(runtime, actor, scope, input, {
      journal,
      resolveActor: async () => actor,
      enabled: true,
    }),
  ).rejects.toThrow("DELETION_ADMISSION_UNQUALIFIED");
  expect((await journal.watermark()).sequence).toBe(0);
  expect(
    (await admin.site.findUniqueOrThrow({ where: { id: scope.siteId } }))
      .deletedAt,
  ).toBeNull();
  expect(
    await admin.googleConnection.count({ where: { siteId: scope.siteId } }),
  ).toBe(1);
});
it("preserves an existing unresolved durable intent while admission remains unavailable", async () => {
  const { actor, scope, journal, input } = await fixture();
  const pending = await journal.intent({
    caseId: input.caseId,
    requestId: input.requestId,
    ...scope,
    incarnation: input.confirmIncarnation,
    epoch: 1,
    action: "DELETE_SITE",
  });
  await expect(
    acceptSiteDeletion(runtime, actor, scope, input, {
      journal,
      resolveActor: async () => actor,
      enabled: true,
    }),
  ).rejects.toThrow("DELETION_ADMISSION_UNQUALIFIED");
  expect(await journal.pending()).toEqual([pending]);
  expect(
    (await admin.site.findUniqueOrThrow({ where: { id: scope.siteId } }))
      .deletedAt,
  ).toBeNull();
});
it("requires current MFA, explicit confirmation and a genuine journal before creating an intent", async () => {
  const { actor, scope, journal, input } = await fixture();
  await expect(
    acceptSiteDeletion(runtime, actor, scope, input, {
      journal,
      enabled: false,
      resolveActor: async () => actor,
    }),
  ).rejects.toThrow("SITE_DELETION_DISABLED");
  await expect(
    acceptSiteDeletion(
      runtime,
      actor,
      scope,
      { ...input, confirmSiteId: "foreign" },
      { journal, enabled: true, resolveActor: async () => actor },
    ),
  ).rejects.toThrow("DELETION_CONFIRMATION_REQUIRED");
  await expect(
    acceptSiteDeletion(runtime, actor, scope, input, {
      journal,
      enabled: true,
      resolveActor: async () => ({
        ...actor,
        mfaAuthenticatedAt: new Date(Date.now() - 300001).toISOString(),
      }),
    }),
  ).rejects.toThrow("RECENT_AUTH_AND_MFA_REQUIRED");
  expect(await journal.pending()).toEqual([]);
});
it("preserves an uncertain financial fence and reserved partition balances during deletion", async () => {
  const { actor, scope, journal, input } = await fixture(),
    operationId = randomUUID();
  await admin.operation.create({
    data: {
      id: operationId,
      ...scope,
      userId: actor.userId,
      sessionId: actor.sessionId,
      securityVersion: 0,
      kind: "API_OBSERVATION",
      provider: "AZURE",
      period: "2026-11",
      route: "synthetic-deletion-fixture",
      idempotencyKey: operationId,
      inputHash: "synthetic",
      requestInput: { label: "SYNTHETIC_ONLY_NOT_A_PROVIDER_REQUEST" },
      tariffVersion: "SYNTHETIC_FIXTURE_ONLY",
      reservedCost: "0.01",
      status: "RECONCILING",
      expiresAt: new Date(Date.now() + 3600000),
      fence: 7,
      attemptState: "INTENT",
    },
  });
  await admin.budgetPeriod.createMany({
    data: [
      {
        id: randomUUID(),
        userId: actor.userId,
        period: "2026-11",
        bucket: "COMBINED",
        limit: "10",
        reserved: "0.01",
      },
      {
        id: randomUUID(),
        userId: actor.userId,
        period: "2026-11",
        bucket: "AZURE",
        limit: "8",
        reserved: "0.01",
      },
    ],
  });
  const before =
    await admin.$queryRaw`SELECT to_jsonb(o) row FROM "Operation" o WHERE id=${operationId}`;
  const budgets =
    await admin.$queryRaw`SELECT to_jsonb(b) row FROM "BudgetPeriod" b WHERE "userId"=${actor.userId} ORDER BY bucket`;
  await expect(
    acceptSiteDeletion(runtime, actor, scope, input, {
      journal,
      resolveActor: async () => actor,
      enabled: true,
    }),
  ).rejects.toThrow("DELETION_ADMISSION_UNQUALIFIED");
  expect(
    await admin.$queryRaw`SELECT to_jsonb(o) row FROM "Operation" o WHERE id=${operationId}`,
  ).toEqual(before);
  expect(
    await admin.$queryRaw`SELECT to_jsonb(b) row FROM "BudgetPeriod" b WHERE "userId"=${actor.userId} ORDER BY bucket`,
  ).toEqual(budgets);
  expect((await journal.watermark()).sequence).toBe(0);
});
it("does not return buffered page evidence when its site is tombstoned during the base read", async () => {
  const { actor, scope } = await fixture(),
    id = randomUUID();
  await admin.$executeRaw`INSERT INTO "PageIdentity"(id,"workspaceId","siteId","originalUrl","normalizedUrl","createdBy") VALUES(${id},${scope.workspaceId},${scope.siteId},'https://deletion.example/','https://deletion.example/',${actor.userId})`;
  const concurrent = runtime.$extends({
    query: {
      siteContextRevision: {
        async findFirst({ args, query }) {
          const captured = await query(args);
          await admin.$executeRaw`UPDATE "Site" SET "deletedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "workspaceId"=${scope.workspaceId} AND id=${scope.siteId}`;
          return captured;
        },
      },
    },
  });
  await expect(
    readPage(concurrent as unknown as typeof runtime, actor, scope, id),
  ).rejects.toThrow("NOT_FOUND");
});
it("exports authored bytes and rehearses a privileged synthetic deletion separately from disabled user admission", async () => {
  const { actor, scope, journal, input, root: journalRoot } = await fixture();
  const draftId = randomUUID(),
    revisionId = randomUUID(),
    reportId = randomUUID();
  const body = "ORIGINAL_AUTHORED_BODY_" + randomUUID();
  await admin.$executeRaw`INSERT INTO "ContentDraft"(id,"workspaceId","siteId",kind,snapshot) VALUES(${draftId},${scope.workspaceId},${scope.siteId},'draft','{}')`;
  await admin.$executeRaw`INSERT INTO "ContentRevision"(id,"workspaceId","draftId",revision,content,"userId") VALUES(${revisionId},${scope.workspaceId},${draftId},1,${JSON.stringify({ title: "Original", body, assumptions: [], citations: [] })}::jsonb,${actor.userId})`;
  await admin.$executeRaw`INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv) VALUES(${reportId},${scope.workspaceId},${scope.siteId},'Historical conclusion','{"rawHtml":"RAW_SOURCE_NEVER_BACKED_UP","sources":[]}',decode('0001','hex'),'RAW_DOWNLOAD_NEVER_BACKED_UP')`;
  const [reportSupport] = await admin.$queryRaw<
    { available: boolean }[]
  >`SELECT to_regprocedure('lyraseo_report.snapshot(text,text,text)') IS NOT NULL available`;
  if (!reportSupport?.available) {
    await expect(exportRetainedWork(runtime, actor, scope)).rejects.toThrow(
      "RECOVERY_REPORT_PROJECTION_UNQUALIFIED",
    );
    return; // Historical-prefix capability is explicitly unavailable, never a raw fallback.
  }
  const exported = await exportRetainedWork(runtime, actor, scope);
  expect(exported.records).toHaveLength(2);
  expect(JSON.stringify(exported)).not.toContain("RAW_SOURCE_NEVER_BACKED_UP");
  expect(JSON.stringify(exported)).not.toContain(
    "RAW_DOWNLOAD_NEVER_BACKED_UP",
  );
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lyraseo-retained-backup-")),
  );
  roots.push(root);
  const points = await localRecoveryPoints({
    root,
    journalRoot,
    key: randomBytes(32),
    enabled: true,
  });
  const point = await points.create({
    ...exported,
    journal: await journal.watermark(),
  });
  expect(JSON.stringify(await points.verify(point.id))).toContain(body);
  const staged = await stagePrivilegedSyntheticDeletion(
    admin,
    actor,
    scope,
    input,
    journal,
  );
  const sweep = await localSiteDeletionMaintenance(maintenance, {
    enabled: true,
  }).sweep(scope, staged.id, 12);
  expect(sweep).toMatchObject({ completedTasks: 0, allCopiesErased: false });
  expect(
    await admin.$queryRaw`SELECT id FROM "ContentRevision" WHERE id=${revisionId}`,
  ).toEqual([{ id: revisionId }]);
  const restored = await points.rehearse(
    point.id,
    journal,
    await journal.watermark(),
  );
  expect(restored.records).toEqual([]);
  expect(restored.erasedRecords).toBe(2);
  expect(restored.reopenAllowed).toBe(false);
  expect(restored.credentialsRestored).toBe(0);
  await expect(exportRetainedWork(runtime, actor, scope)).rejects.toThrow(
    "NOT_FOUND",
  );
});

it("rejects a direct runtime call with forged actor GUCs and a fabricated journal receipt", async () => {
  const { actor, scope, journal, input } = await fixture();
  expect((await journal.watermark()).sequence).toBe(0);
  await expect(
    runtime.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id',${actor.userId},true),set_config('app.workspace_id',${scope.workspaceId},true)`;
      return tx.$queryRaw`SELECT lyraseo_deletion.accept_site(${scope.workspaceId},${scope.siteId},0,${input.caseId}::uuid,${input.requestId}::uuid,${input.confirmIncarnation}::uuid,${randomUUID()}::uuid,1::bigint,${"a".repeat(64)}) value`;
    }),
  ).rejects.toThrow();
  expect(
    (await admin.site.findUniqueOrThrow({ where: { id: scope.siteId } }))
      .deletedAt,
  ).toBeNull();
  expect((await journal.watermark()).sequence).toBe(0);
  await expect(
    admin.$queryRaw`SELECT lyraseo_deletion.accept_site(${scope.workspaceId},${scope.siteId},0,${input.caseId}::uuid,${input.requestId}::uuid,${input.confirmIncarnation}::uuid,${randomUUID()}::uuid,1::bigint,${"a".repeat(64)})`,
  ).rejects.toThrow("DELETION_ADMISSION_UNQUALIFIED");
});

it("bounds incomplete sweep metadata and never attempts an unbounded site payload delete", async () => {
  const { actor, scope, journal, input } = await fixture();
  await admin.contentDraft.createMany({
    data: Array.from({ length: 1001 }, () => ({
      ...scope,
      kind: "draft",
      snapshot: { private: "MUST_REMAIN_UNTIL_BATCHED_ADAPTER" },
    })),
  });
  const staged = await stagePrivilegedSyntheticDeletion(
      admin,
      actor,
      scope,
      input,
      journal,
    ),
    ops = localSiteDeletionMaintenance(maintenance, { enabled: true });
  expect(await ops.sweep(scope, staged.id, 1)).toMatchObject({
    completedTasks: 0,
    allCopiesErased: false,
  });
  expect(
    await admin.$queryRaw`SELECT count(*)::integer n FROM lyraseo_deletion.task WHERE case_id=${staged.id}::uuid AND state='NEEDS_ADAPTER'`,
  ).toEqual([{ n: 1 }]);
  expect(await admin.contentDraft.count({ where: scope })).toBe(1001);
  await ops.sweep(scope, staged.id, 12);
  expect(
    await admin.$queryRaw`SELECT count(*)::integer n FROM lyraseo_deletion.task WHERE case_id=${staged.id}::uuid AND state='NEEDS_ADAPTER' AND result->>'reason'='BOUNDED_ERASURE_NOT_QUALIFIED'`,
  ).toEqual([{ n: 12 }]);
  expect(await admin.contentDraft.count({ where: scope })).toBe(1001);
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_deletion.accept_site(${scope.workspaceId},${scope.siteId},0,${input.caseId}::uuid,${input.requestId}::uuid,${input.confirmIncarnation}::uuid,${randomUUID()}::uuid,1::bigint,${"a".repeat(64)})`,
  ).rejects.toThrow();
  await expect(
    runtime.$executeRawUnsafe("SET ROLE lyraseo_deletion_owner"),
  ).rejects.toThrow();
  const [blocked] = await admin.$queryRaw<
    { permission: boolean }[]
  >`SELECT has_function_privilege('lyraseo_runtime','lyraseo_deletion.accept_site(text,text,integer,uuid,uuid,uuid,uuid,bigint,text)','EXECUTE') permission`;
  expect(blocked?.permission).toBe(false);
});

it("preserves an original SQL read failure after rechecking authorization rather than masking it with25P02", async () => {
  const { actor, scope } = await fixture();
  let failure: unknown;
  try {
    await withEvidenceRead(
      runtime,
      actor,
      scope,
      "read",
      undefined,
      async (tx) => {
        await tx.$queryRawUnsafe("SELECT 1/0");
        return "NO_EVIDENCE";
      },
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("division by zero");
  expect(String(failure)).not.toContain("25P02");
  const meta = (
    failure as {
      meta?: {
        code?: string;
        driverAdapterError?: { cause?: { code?: string } };
      };
    }
  ).meta;
  expect(meta?.code ?? meta?.driverAdapterError?.cause?.code).toBe("22012");
  const result = await withEvidenceRead(
    runtime,
    actor,
    scope,
    "read",
    undefined,
    async () => ({ safe: true }),
  );
  expect(result).toEqual({ safe: true });
});

for (const revocation of [
  "site",
  "membership",
  "site-grant",
  "user-security-epoch",
] as const) {
  for (const outcome of ["success", "sql-failure"] as const) {
    it(`withholds a ${outcome} read after concurrent ${revocation} revocation at a controlled barrier`, async () => {
      const { actor, scope } = await fixture();
      let ownerActor: typeof actor | undefined;
      if (revocation === "site-grant") {
        const ownerId = "control-owner-" + randomUUID();
        await admin.productUser.create({ data: { id: ownerId } });
        await admin.membership.create({
          data: {
            workspaceId: scope.workspaceId,
            userId: ownerId,
            role: "OWNER",
          },
        });
        await admin.membership.update({
          where: {
            workspaceId_userId: {
              workspaceId: scope.workspaceId,
              userId: actor.userId,
            },
          },
          data: { role: "EDITOR" },
        });
        await admin.siteGrant.create({
          data: { ...scope, userId: actor.userId },
        });
        ownerActor = { ...actor, userId: ownerId, sessionId: randomUUID() };
      }
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
      const pending = withEvidenceRead(
        runtime,
        actor,
        scope,
        "read",
        undefined,
        async (tx) => {
          entered();
          await barrier;
          if (outcome === "sql-failure") await tx.$queryRawUnsafe("SELECT 1/0");
          return "PRIVATE_BUFFERED_EVIDENCE";
        },
      );
      // Attach a rejection handler before releasing either connection.
      const result = pending.then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      await started;
      try {
        if (revocation === "site")
          await admin.site.update({
            where: { id: scope.siteId },
            data: { deletedAt: new Date() },
          });
        else if (revocation === "membership")
          await admin.membership.delete({
            where: {
              workspaceId_userId: {
                workspaceId: scope.workspaceId,
                userId: actor.userId,
              },
            },
          });
        else if (revocation === "site-grant")
          await admin.siteGrant.delete({
            where: {
              workspaceId_siteId_userId: { ...scope, userId: actor.userId },
            },
          });
        else
          await admin.productUser.update({
            where: { id: actor.userId },
            data: { securityVersion: { increment: 1 } },
          });
      } finally {
        release();
      }
      const observed = await result;
      expect(observed.value).toBeNull();
      expect(observed.error).toBeInstanceOf(Error);
      expect(String(observed.error)).toContain(
        revocation === "site" ? "NOT_FOUND" : "FORBIDDEN",
      );
      expect(String(observed.error)).not.toContain("25P02");
      if (ownerActor)
        expect(
          await withEvidenceRead(
            runtime,
            ownerActor,
            scope,
            "read",
            undefined,
            async () => "AUTHORIZED_SAME_TENANT_OWNER",
          ),
        ).toBe("AUTHORIZED_SAME_TENANT_OWNER");
    });
  }
}
