import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../packages/db/src";
import {
  acceptSiteDeletion,
  previewSiteDeletion,
  localSiteDeletionMaintenance,
} from "../../packages/db/src/site-deletion";
import { stagePrivilegedSyntheticDeletion } from "../helpers/recovery-operator";
import { openRecoveryJournal } from "../../packages/db/src/recovery-journal";
const enabled = process.env.LYRA_RECOVERY_TEAM_TEST === "true";
const database = process.env.LYRA_RECOVERY_DB;
if (!/^lyraseo_recovery_[a-f0-9]{12}$/.test(database ?? ""))
  throw Error("OWNED_RECOVERY_DATABASE_REQUIRED");
const url = (role: string, password: string) =>
  `postgresql://${role}:${password}@127.0.0.1:54329/${database}`;
const admin = createDatabase(url("postgres", "lyraseo_local_only")),
  runtime = createDatabase(url("lyraseo_runtime", "local_runtime_only")),
  maintenance = createDatabase(
    url("lyraseo_artifact_maintenance", "local_expiry_only"),
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
async function fixture(unknown = false) {
  const n = randomUUID(),
    w = "team-w-" + n,
    s = "team-s-" + n,
    other = "team-other-" + n,
    u = "team-u-" + n;
  await admin.productUser.create({ data: { id: u } });
  await admin.workspace.create({
    data: { id: w, name: "Synthetic agency deletion" },
  });
  await admin.membership.create({
    data: { workspaceId: w, userId: u, role: "OWNER" },
  });
  await admin.site.createMany({
    data: [
      { id: s, workspaceId: w, origin: "https://team-delete.example" },
      { id: other, workspaceId: w, origin: "https://team-keep.example" },
    ],
  });
  await admin.$executeRaw`INSERT INTO lyraseo_history.environment(workspace_id,site_id,database_oid,postmaster_started_at,policy_version,enabled) SELECT ${w},${s},oid,pg_postmaster_start_time(),'HISTORY_EXPIRY_LOCAL_V1',true FROM pg_database WHERE datname=current_database()`;
  const now = new Date().toISOString(),
    actor = {
      userId: u,
      sessionId: "session-" + n,
      securityVersion: 0,
      authenticatedAt: now,
      mfaAuthenticatedAt: now,
      mfaVerified: true,
      authProvider: "supabase" as const,
    };
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lyraseo-team-journal-")),
  );
  roots.push(root);
  const journal = await openRecoveryJournal({
    root,
    key: randomBytes(32),
    enabled: true,
  });
  const page = "team-page-" + n;
  await admin.pageIdentity.create({
    data: {
      id: page,
      workspaceId: w,
      siteId: s,
      createdBy: u,
      assignedTo: u,
      originalUrl: "https://team-delete.example/private",
      normalizedUrl: "https://team-delete.example/private",
    },
  });
  const audit = await admin.auditRun.create({
    data: {
      workspaceId: w,
      siteId: s,
      userId: u,
      securityVersion: 0,
      idempotencyKey: n,
      inputHash: n,
      manifest: [],
      profile: "LOCAL_RAW_V1",
      declarations: {},
      methodologyVersion: "readiness-v2",
    },
  });
  const issue = "team-issue-" + n;
  await admin.$executeRaw`INSERT INTO "IssueAssignment"(id,"workspaceId","siteId","auditId","ruleId","scopeKey","assigneeUserId",revision) VALUES(${issue},${w},${s},${audit.id},'title','https://team-delete.example/private',${u},1)`;
  for (const [id, sites] of [
    ["shared-" + n, [s, other]],
    ["single-" + n, [s]],
  ] as const) {
    await admin.$executeRaw`INSERT INTO "WorkspaceInvitation"(id,"workspaceId","tokenHash","invitedEmailDigest",role,"createdBy","expiresAt") VALUES(${id},${w},${randomBytes(32).toString("hex")},${"a".repeat(64)},'EDITOR',${u},CURRENT_TIMESTAMP+interval '1 day')`;
    for (const site of sites)
      await admin.$executeRaw`INSERT INTO "WorkspaceInvitationSite"("workspaceId","invitationId","siteId") VALUES(${w},${id},${site})`;
  }
  const batch = "team-batch-" + n,
    keepInput = { private: "HEALTHY_SITE_INPUT_PRESERVED" },
    request = {
      workspaceId: w,
      items: [
        {
          siteId: s,
          kind: "API_OBSERVATION",
          input: { private: "DELETED_SITE_INPUT" },
        },
        { siteId: other, kind: "API_OBSERVATION", input: keepInput },
      ],
      ...(unknown ? { unclassified: "UNKNOWN_SHARED_PAYLOAD" } : {}),
    };
  const preview = {
    batchQuoteId: batch,
    items: [
      { siteId: s, ordinal: 0, status: "QUOTED" },
      { siteId: other, ordinal: 1, status: "QUOTED" },
    ],
    combinedMaximum: "0.020000000",
    currency: "USD",
  };
  await admin.$executeRaw`INSERT INTO "AgencyBatchQuote"(id,"workspaceId","userId","securityVersion","requestInput","inputHash","confirmationHash",preview,"expiresAt") VALUES(${batch},${w},${u},0,${JSON.stringify(request)}::jsonb,'original-input-hash','original-confirmation-hash',${JSON.stringify(preview)}::jsonb,CURRENT_TIMESTAMP+interval '4 minutes')`;
  for (const [ordinal, site] of [s, other].entries())
    await admin.$executeRaw`INSERT INTO "AgencyBatchItem"("batchQuoteId","workspaceId","userId","siteId",ordinal,status) VALUES(${batch},${w},${u},${site},${ordinal},'QUOTED')`;
  await admin.$executeRaw`INSERT INTO "WorkspaceBrandingRevision"(id,"workspaceId",revision,"displayName","createdBy") VALUES(${"branding-" + n},${w},1,'Shared agency branding',${u})`;
  const scope = { workspaceId: w, siteId: s },
    previewDelete = await previewSiteDeletion(runtime, actor, scope),
    input = {
      caseId: randomUUID(),
      requestId: randomUUID(),
      confirmSiteId: s,
      confirmIncarnation: previewDelete.incarnation,
      permanent: true as const,
    };
  return {
    w,
    s,
    other,
    u,
    actor,
    journal,
    scope,
    input,
    batch,
    keepInput,
    page,
    issue,
    n,
  };
}
describe.skipIf(!enabled)(
  "agency31 + safe privacy32 incomplete deletion boundary",
  () => {
    it("does not retire agency records through an unqualified admission or sweep", async () => {
      const f = await fixture();
      await expect(
        acceptSiteDeletion(runtime, f.actor, f.scope, f.input, {
          journal: f.journal,
          resolveActor: async () => f.actor,
          enabled: true,
        }),
      ).rejects.toThrow("DELETION_ADMISSION_UNQUALIFIED");
      expect((await f.journal.watermark()).sequence).toBe(0);
      expect(
        await admin.$queryRaw`SELECT revision,"assignedTo" FROM "PageIdentity" WHERE id=${f.page}`,
      ).toEqual([{ revision: 1, assignedTo: f.u }]);
      expect(
        await admin.$queryRaw`SELECT revision,"assigneeUserId" FROM "IssueAssignment" WHERE id=${f.issue}`,
      ).toEqual([{ revision: 1, assigneeUserId: f.u }]);
      const staged = await stagePrivilegedSyntheticDeletion(
        admin,
        f.actor,
        f.scope,
        f.input,
        f.journal,
      );
      const ops = localSiteDeletionMaintenance(maintenance, { enabled: true });
      expect(await ops.sweep(f.scope, staged.id, 12)).toMatchObject({
        completedTasks: 0,
        allCopiesErased: false,
      });
      expect(
        await admin.$queryRaw`SELECT state,result->>'reason' reason FROM lyraseo_deletion.task WHERE case_id=${staged.id}::uuid AND kind='TEAM_DATA'`,
      ).toEqual([
        { state: "NEEDS_ADAPTER", reason: "BOUNDED_ERASURE_NOT_QUALIFIED" },
      ]);
      expect(
        await admin.$queryRaw`SELECT count(*)::integer n FROM "WorkspaceInvitation" WHERE "workspaceId"=${f.w} AND "revokedAt" IS NULL`,
      ).toEqual([{ n: 2 }]);
      expect(
        await admin.$queryRaw`SELECT "displayName" FROM "WorkspaceBrandingRevision" WHERE "workspaceId"=${f.w}`,
      ).toEqual([{ displayName: "Shared agency branding" }]);
      const [row] = await admin.$queryRaw<
        { requestInput: { items: { input: unknown }[] } }[]
      >`SELECT "requestInput" FROM "AgencyBatchQuote" WHERE id=${f.batch}`;
      expect(row.requestInput.items[0].input).toEqual({
        private: "DELETED_SITE_INPUT",
      });
      expect(row.requestInput.items[1].input).toEqual(f.keepInput);
      await expect(
        maintenance.$queryRaw`SELECT lyraseo_deletion.erase_team(${f.w},${f.s},${staged.id}::uuid)`,
      ).rejects.toThrow();
    });
    it("retains unknown shared agency payloads with an explicit incomplete bounded-adapter state", async () => {
      const f = await fixture(true),
        staged = await stagePrivilegedSyntheticDeletion(
          admin,
          f.actor,
          f.scope,
          f.input,
          f.journal,
        );
      await localSiteDeletionMaintenance(maintenance, { enabled: true }).sweep(
        f.scope,
        staged.id,
        12,
      );
      expect(
        await admin.$queryRaw`SELECT state,result->>'reason' reason FROM lyraseo_deletion.task WHERE case_id=${staged.id}::uuid AND kind='TEAM_DATA'`,
      ).toEqual([
        { state: "NEEDS_ADAPTER", reason: "BOUNDED_ERASURE_NOT_QUALIFIED" },
      ]);
      expect(
        await admin.$queryRaw`SELECT "requestInput"->>'unclassified' marker FROM "AgencyBatchQuote" WHERE id=${f.batch}`,
      ).toEqual([{ marker: "UNKNOWN_SHARED_PAYLOAD" }]);
    });
  },
);
