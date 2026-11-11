import { afterAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../packages/db/src";
import {
  createAuditRun,
  claimAuditRun,
  checkpointPrivateAudit,
} from "../../packages/db/src/audits";
import { bindLocalArtifactStore } from "../../packages/db/src/artifact-checkpoint";
import { localAuditArtifactStore } from "../../packages/db/src/artifact-store";
import {
  issueOperationQuote,
  admitQuotedOperation,
} from "../../packages/db/src/accounting";
import {
  captureEvidenceReport,
  createContentDraft,
  setRevisionPin,
  storeEvidenceReport,
} from "../../packages/db/src/content";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  recordVisibilityEvidence,
} from "../../packages/db/src/visibility";
import {
  previewPrivateArtifactExpiry,
  recordPrivateArtifactExpiryPlan,
  applyPrivateArtifactExpiry,
} from "../../packages/db/src/artifact-expiry";
import { acquireRawPage } from "../../packages/visibility/src/acquisition";
import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
import { enrollTestExpiryAuthority } from "../helpers/expiry-authority";

const dbName = process.env.LYRA_EXPIRY_HISTORY_DB_NAME;
const enabled = /^lyraseo_expiry_[a-f0-9]{8,12}$/.test(dbName ?? "");
if (process.env.LYRA_PRIVATE_EXPIRY_REQUIRED === "true" && !enabled)
  throw Error("OWNED_EXPIRY_HISTORY_FIXTURE_REQUIRED");
const base = `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${dbName ?? "postgres"}`;
const role = (name: string, password: string) => {
  const url = new URL(base);
  url.username = name;
  url.password = password;
  return createDatabase(url.href);
};
const admin = createDatabase(base),
  runtime = role("lyraseo_runtime", "local_runtime_only"),
  maintenance = role("lyraseo_artifact_maintenance", "local_expiry_only");
const scope = { workspaceId: "migration-workspace", siteId: "migration-site" };
const actor = {
  userId: "migration-owner",
  sessionId: "fixture-session",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  mfaAuthenticatedAt: new Date().toISOString(),
  authProvider: "supabase" as const,
};
const url = "https://example.com/";
afterAll(() =>
  Promise.all([
    admin.$disconnect(),
    runtime.$disconnect(),
    maintenance.$disconnect(),
  ]),
);
it.runIf(enabled)(
  "preserves non-live financial, dispatch, authored, measurement and unrelated-tenant history across expiry",
  async () => {
    const [owned] = await admin.$queryRaw<
      { owned: boolean; receipts: bigint; operations: bigint }[]
    >`
    SELECT lyraseo_kernel.is_test_database() AS owned,(SELECT count(*) FROM "UsageReceipt") AS receipts,
      (SELECT count(*) FROM "Operation") AS operations`;
    expect(owned).toMatchObject({ owned: true, receipts: 2n, operations: 8n });
    await admin.workspace.create({
      data: { id: "history-unrelated", name: "Unrelated synthetic workspace" },
    });
    await admin.membership.create({
      data: {
        workspaceId: "history-unrelated",
        userId: actor.userId,
        role: "OWNER",
      },
    });
    await admin.site.create({
      data: {
        id: "history-unrelated-site",
        workspaceId: "history-unrelated",
        origin: "https://unrelated.example",
        verifiedAt: new Date(),
      },
    });
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "lyraseo-expiry-history-"),
    );
    const store = await localAuditArtifactStore(root);
    const source = await enrollTestArtifactAuthority(admin, store, [
      scope.workspaceId,
    ]);
    let expiry:
      Awaited<ReturnType<typeof enrollTestExpiryAuthority>> | undefined;
    try {
      bindLocalArtifactStore(runtime, store, source);
      const run = await createAuditRun(runtime, actor, {
        ...scope,
        profile: "LOCAL_RAW_V1",
        idempotencyKey: randomUUID(),
        manifest: [url],
      });
      const target = { ...scope, auditId: run.id };
      const lease = await claimAuditRun(
        runtime,
        actor,
        target,
        "history-local",
      );
      const receipt = await acquireRawPage(url, url, async (address) =>
        address.endsWith("robots.txt")
          ? new Response(null, { status: 404 })
          : new Response("<html><title>History fixture</title></html>", {
              headers: { "content-type": "text/html" },
            }),
      );
      await checkpointPrivateAudit(
        runtime,
        actor,
        target,
        lease.fence,
        receipt,
      );
      const quote = await issueOperationQuote(runtime, actor, {
        ...scope,
        kind: "GENERATION",
        provider: "AZURE",
        route: "content",
        input: { history: "local-fixture" },
        maximumCost: "0.100000000",
        tariffVersion: "synthetic-test-v1",
      });
      await admitQuotedOperation(runtime, actor, {
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      });
      const content = {
        kind: "draft" as const,
        title: "Authored fixture",
        body: "User-authored fixture text",
        assumptions: [],
        citations: [],
        auditIds: [run.id],
        searchSnapshotIds: [],
      };
      const draft = await createContentDraft(runtime, actor, scope, content);
      await setRevisionPin(runtime, actor, scope, draft.id, 1, true);
      const snapshot = await captureEvidenceReport(runtime, actor, scope, {
        auditIds: [run.id],
        searchSnapshotIds: [],
      });
      await storeEvidenceReport(runtime, actor, scope, {
        title: "Retained fixture report",
        snapshot,
        render: async () => ({
          pdf: new Uint8Array([37, 80, 68, 70]),
          csv: "fixture,csv",
        }),
      });
      const panelDraft = await createVisibilityPanel(
        runtime,
        actor,
        scope,
        [{ id: "p", text: "Tools?", label: "neutral" }],
        [
          {
            id: "a",
            name: "Alpha",
            aliases: ["Alpha"],
            domains: ["alpha.com"],
          },
        ],
      );
      const panel = await reviewVisibilityPanel(
        runtime,
        actor,
        scope,
        panelDraft.id,
      );
      await recordVisibilityEvidence(
        runtime,
        actor,
        scope,
        panel.id,
        {
          profile: "consumer-chatgpt",
          provider: "dataforseo",
          model: "fixture",
          modelVersion: "v1",
          retrievalMode: "standard",
          requestedLocale: { language: "en", market: "IN" },
          confirmedLocale: { language: "en", market: "IN" },
          synthetic: true,
          rawAnswerRights: true,
          observedAt: new Date(Date.now() - 86400000).toISOString(),
          slots: [
            {
              promptId: "p",
              state: "successful",
              body: "Alpha synthetic fixture",
              annotations: [],
              providerTaskId: "history-fixture",
              completedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
            },
          ],
        },
        {
          storageFormat: "OBSERVATION_PRIVATE_V1",
          sourceNamespace: "CONTROLLED_FIXTURE_V1",
          recordingKey: randomUUID(),
        },
      );
      const [deadlines] = await admin.$queryRaw<
        { due: Date }[]
      >`SELECT max("expiresAt") AS due FROM "ArtifactBlob"`;
      expiry = await enrollTestExpiryAuthority(
        admin,
        store,
        scope,
        new Date(deadlines!.due.getTime() + 1),
      );
      const tables = [
        "Workspace",
        "Membership",
        "Site",
        "Operation",
        "OperationQuote",
        "BudgetPeriod",
        "UsageReceipt",
        "OutboxEvent",
        "WorkDispatch",
        "InternalRequest",
        "ContentDraft",
        "ContentRevision",
        "ContentRevisionPin",
        "EvidenceReport",
        "AuditRun",
        "AuditPage",
        "AuditPageRetention",
        "VisibilityRun",
        "VisibilityObservationSlot",
      ];
      async function snapshotHistory() {
        const data: Record<string, unknown> = {};
        for (const table of tables) {
          const [row] = await admin.$queryRawUnsafe<{ value: unknown }[]>(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM "${table}" t`,
          );
          data[table] = row!.value;
        }
        const [origins] = await admin.$queryRaw<
          { value: unknown }[]
        >`SELECT jsonb_build_object(
        'stores',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM lyraseo_origin.store_registration s),
        'namespaces',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM lyraseo_origin.store_namespace n),
        'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY blob_id) FROM lyraseo_origin.blob_store_binding b),
        'blobs',(SELECT jsonb_agg(to_jsonb(b)-'state'-'pendingReceipt' ORDER BY id) FROM "ArtifactBlob" b)) AS value`;
        data.origins = origins!.value;
        return {
          data,
          hash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
        };
      }
      const before = await snapshotHistory();
      for (const table of [
        "Operation",
        "OperationQuote",
        "BudgetPeriod",
        "UsageReceipt",
        "OutboxEvent",
        "WorkDispatch",
        "ContentDraft",
        "ContentRevision",
        "ContentRevisionPin",
        "EvidenceReport",
        "AuditRun",
        "VisibilityRun",
      ]) {
        expect((before.data[table] as unknown[]).length, table).toBeGreaterThan(
          0,
        );
      }
      const preview = await previewPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
      );
      expect(
        preview.manifest.filter((item) => item.class === "BLOB"),
      ).toHaveLength(2);
      const plan = await recordPrivateArtifactExpiryPlan(
        maintenance,
        store,
        scope,
        preview.manifest,
        preview.hash,
      );
      const result = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
      );
      expect(result.outcomes.every((item) => item.status === "complete")).toBe(
        true,
      );
      const after = await snapshotHistory();
      expect(after.hash).toBe(before.hash);
      expect(after.data).toEqual(before.data);
      console.log("SYNTHETIC_HISTORY_HASH", before.hash);
    } finally {
      expiry?.revoke();
      await source.revoke();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
