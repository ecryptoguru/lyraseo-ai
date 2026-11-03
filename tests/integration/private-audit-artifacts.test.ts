import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
import {
  witnessedObservation,
  verifiedPublication,
  type ArtifactReservation,
} from "../../packages/db/src/artifact-checkpoint";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, rm, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  createAuditRun,
  readAuditSource as readWithCurrentActor,
  readAuditRun,
  claimAuditRun,
  checkpointPrivateAudit,
  cancelAuditRun,
} from "../../packages/db/src/audits";
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";
import {
  captureEvidenceReport,
  storeEvidenceReport,
} from "../../packages/db/src/content";
import { compactEvaluation } from "../../packages/db/src/saved-evidence";
import { withActor } from "../../packages/db/src/context";
import { frozenEvaluation } from "../../packages/db/src/audit-evidence";
import {
  bindLocalArtifactStore,
  recoverAuditArtifactOrphans,
} from "../../packages/db/src/artifact-checkpoint";
import {
  localAuditArtifactStore,
  faultAfterMutation,
  type AuditArtifactStore,
} from "../../packages/db/src/artifact-store";
import {
  acquireRawPage,
  type AcquisitionReceipt,
} from "../../packages/visibility/src/acquisition";
import {
  adminUrl,
  runtimeUrl,
  actor,
  seedTenants,
  resetDatabase,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
let root: string, store: AuditArtifactStore;
let authority: Awaited<ReturnType<typeof enrollTestArtifactAuthority>>;
const readAuditSource = (
  client: Parameters<typeof readWithCurrentActor>[0],
  current: Parameters<typeof readWithCurrentActor>[1],
  scope: Parameters<typeof readWithCurrentActor>[2],
  url: string,
) => readWithCurrentActor(client, current, scope, url, async () => actor);
const urls = ["https://example.com/", "https://example.com/about"];
const privateText = "RAW_ONLY_49a2c9d95b";
const body = Buffer.from(
  '\uFEFF<html><head><meta name="robots" content="noindex"><title>' +
    privateText +
    '</title></head><body><a href="/about">Read our story</a><a href="/not-sampled">Not sampled</a><script type="application/ld+json">{"name":"' +
    privateText +
    '"}</script></body></html>',
);
const transport = async (u: string) =>
  u.endsWith("robots.txt")
    ? new Response(null, { status: 404 })
    : new Response(body, { headers: { "content-type": "text/html" } });
const create = async (manifest = urls) => {
  const run = await createAuditRun(db, actor, {
    workspaceId: "a",
    siteId: "a-site",
    profile: "LOCAL_RAW_V1",
    idempotencyKey: randomUUID(),
    manifest,
    declarations: {
      pageDeclarations: [
        { requestedUrl: urls[0]!, indexingIntent: "indexable" },
      ],
    },
  });
  return { workspaceId: "a", siteId: "a-site", auditId: run.id };
};
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  root = await mkdtemp(join(await realpath(tmpdir()), "lyraseo-source-"));
  store = await localAuditArtifactStore(root);
  authority = await enrollTestArtifactAuthority(admin);
  bindLocalArtifactStore(db, store, authority);
});
afterEach(async () => {
  await authority?.revoke();
  await store?.close();
  await rm(root, { recursive: true, force: true });
});
afterAll(() => Promise.all([db.$disconnect(), admin.$disconnect()]));
it("persists scoped compact pages, P1 clocks and original bytes; scores the same two observations after a restart", async () => {
  const scope = await create();
  bindLocalArtifactStore(db, faultAfterMutation(store, "put"), authority);
  const first = await runRawAuditStep(db, actor, scope, transport);
  expect(first).toMatchObject({
    status: "QUEUED",
    pages: [{ sourceAvailability: "current" }],
  });
  const [page] = await admin.auditPage.findMany(),
    [ref] = await admin.artifactRef.findMany(),
    [scratch] = await admin.auditEvaluationScratch.findMany();
  expect(ref!.pageId).toBe(page!.id);
  expect(+ref!.expiresAt - +ref!.capturedAt).toBe(30 * 86400000);
  expect(+scratch!.expiresAt).toBe(+ref!.expiresAt);
  expect(JSON.stringify({ page, scratch })).not.toContain(privateText);
  expect(
    Buffer.from(await readAuditSource(db, actor, scope, urls[0]!)),
  ).toEqual(body);
  const restarted = createDatabase(runtimeUrl);
  const restartedStore = await localAuditArtifactStore(root);
  try {
    await expect(
      readAuditSource(restarted, actor, scope, urls[0]!),
    ).rejects.toThrow("ARTIFACT_UNAVAILABLE");
    expect(
      (await readAuditRun(restarted, actor, scope)).pages[0]
        ?.sourceAvailability,
    ).toBe("unavailable");
    bindLocalArtifactStore(restarted, restartedStore, authority);
    expect(
      (await runRawAuditStep(restarted, actor, scope, transport)).status,
    ).toBe("COMPLETED");
  } finally {
    await restartedStore.close();
    await restarted.$disconnect();
  }
  expect(await admin.auditEvaluationScratch.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(2);
  expect(await store.inventoryPage("a", null, 10)).toHaveLength(2);
  const final = await admin.auditRun.findUniqueOrThrow({
    where: { id: scope.auditId },
  });
  const originals = await Promise.all(
    urls.map((u) => acquireRawPage(u, urls[0]!, transport)),
  );
  expect(final.evaluation).toEqual(
    JSON.parse(
      JSON.stringify(
        compactEvaluation(
          frozenEvaluation(
            final,
            "https://example.com",
            originals.map((r) => r.evidence),
          ),
        ),
      ),
    ),
  );
  expect(JSON.stringify(final.evaluation)).not.toContain(privateText);
  await expect(
    readAuditSource(db, actor, { ...scope, siteId: "b-site" }, urls[0]!),
  ).rejects.toThrow();
  const snapshot = await captureEvidenceReport(db, actor, scope, {
    auditIds: [scope.auditId],
    searchSnapshotIds: [],
  });
  expect(snapshot.internalLinks).toHaveLength(1);
  expect(snapshot.internalLinks[0]).toMatchObject({
    url: urls[1],
    anchorText: "Read our story",
    artifactRefId: ref!.id,
    artifactGeneration: ref!.generation,
  });
  expect(JSON.stringify(snapshot)).not.toContain(privateText);
  await storeEvidenceReport(db, actor, scope, {
    title: "Frozen private source",
    snapshot,
    render: async () => ({
      pdf: new Uint8Array([37, 80, 68, 70]),
      csv: "measured",
    }),
  });
  const saved = await admin.evidenceReport.findFirstOrThrow();
  expect(JSON.stringify(saved.snapshot)).not.toContain(privateText);
  const forged = structuredClone(snapshot);
  forged.internalLinks[0]!.sourceFactHash = "f".repeat(64);
  await expect(
    storeEvidenceReport(db, actor, scope, {
      title: "Forged",
      snapshot: forged,
      render: async () => {
        throw Error("unexpected render");
      },
    }),
  ).rejects.toThrow("SOURCE_EXPIRED");
  await expect(
    storeEvidenceReport(db, actor, scope, {
      title: "Source changed while rendering",
      snapshot,
      render: async () => {
        await admin.artifactBlob.update({
          where: { id: ref!.blobId },
          data: { state: "ORPHAN" },
        });
        return { pdf: new Uint8Array(), csv: "" };
      },
    }),
  ).rejects.toThrow("SOURCE_EXPIRED");
  expect(await admin.evidenceReport.count()).toBe(1);
  expect(
    (await readAuditRun(db, actor, scope)).pages[0]?.sourceAvailability,
  ).toBe("unavailable");
  await admin.artifactBlob.update({
    where: { id: ref!.blobId },
    data: { state: "READY" },
  });
  const corrupt = await admin.artifactBlob.findFirstOrThrow({
    where: { requestedUrl: urls[0] },
  });
  const dir = join(root, createHash("sha256").update("a").digest("hex"));
  const file = (await readdir(dir)).find((f) =>
    f.includes(corrupt.storageKey),
  )!;
  await writeFile(join(dir, file), "corrupt");
  await expect(readAuditSource(db, actor, scope, urls[0]!)).rejects.toThrow(
    "ARTIFACT_UNAVAILABLE",
  );
});
it("rejects changed content in a reserved slot, never downgrades a selected checkpoint, and recovers an abandoned generation", async () => {
  const scope = await create(),
    lease = await claimAuditRun(db, actor, scope, "private");
  const receipt = await acquireRawPage(urls[0]!, urls[0]!, transport);
  bindLocalArtifactStore(
    db,
    {
      ...store,
      async putImmutable() {
        throw Error("unavailable");
      },
    },
    authority,
  );
  await expect(
    checkpointPrivateAudit(db, actor, scope, lease.fence, receipt),
  ).rejects.toThrow("ARTIFACT_UNAVAILABLE");
  expect(await admin.artifactBlob.count({ where: { state: "STAGED" } })).toBe(
    1,
  );
  expect(await admin.auditPage.count()).toBe(0);
  const raw = JSON.stringify(receipt);
  const reserve = (data: string) =>
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw`SELECT lyraseo_audit.web_artifact_reserve('a-site',${scope.auditId},0,${lease.fence}::integer,${data}::json)`,
    );
  const changed = structuredClone(receipt);
  changed.provenance.acquiredAt = new Date(
    +new Date(receipt.provenance.acquiredAt) - 1000,
  ).toISOString();
  await expect(reserve(JSON.stringify(changed))).rejects.toThrow(
    /IMMUTABLE_EVIDENCE/,
  );
  await expect(
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw`SELECT lyraseo_audit.web_transition('a-site',${scope.auditId},0,'checkpoint',${lease.fence}::integer,NULL,${raw}::json)`,
    ),
  ).rejects.toThrow(/ARTIFACT_REQUIRED/);
  bindLocalArtifactStore(
    db,
    {
      ...store,
      async putImmutable(v, b) {
        await store.putImmutable(v, b);
        await cancelAuditRun(db, actor, scope);
      },
    },
    authority,
  );
  await expect(
    checkpointPrivateAudit(db, actor, scope, lease.fence, receipt),
  ).rejects.toThrow();
  expect(await admin.auditPage.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
  expect(await admin.artifactBlob.count({ where: { state: "ORPHAN" } })).toBe(
    1,
  );
  expect(
    await recoverAuditArtifactOrphans(
      admin,
      faultAfterMutation(store, "delete"),
      scope.auditId,
    ),
  ).toBe(1);
  expect(await store.inventoryPage("a", null, 10)).toEqual([]);
  await expect(reserve(raw)).rejects.toThrow(/STALE_LEASE/);
});
it("rechecks authorization after object I/O and before delivery", async () => {
  const scope = await create();
  await runRawAuditStep(db, actor, scope, transport);
  bindLocalArtifactStore(
    db,
    {
      ...store,
      async openBounded(v) {
        const bytes = await store.openBounded(v);
        await admin.site.update({
          where: { id: scope.siteId },
          data: { deletedAt: new Date() },
        });
        return bytes;
      },
    },
    authority,
  );
  await expect(readAuditSource(db, actor, scope, urls[0]!)).rejects.toThrow(
    "NOT_FOUND",
  );
});
it("rejects an expired capture, skips storing an unreadable body, and removes active scratch on cancel", async () => {
  const scope = await create(),
    lease = await claimAuditRun(db, actor, scope, "capture");
  const acquire = () =>
    acquireRawPage(urls[0]!, urls[0]!, async (u) =>
      u.endsWith("robots.txt")
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array([255]), {
            headers: { "content-type": "text/html" },
          }),
    );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 30 * 86400000);
  let old: AcquisitionReceipt;
  try {
    old = await acquire();
  } finally {
    vi.useRealTimers();
  }
  await expect(
    checkpointPrivateAudit(db, actor, scope, lease.fence, old),
  ).rejects.toThrow(/SOURCE_EXPIRED/);
  await checkpointPrivateAudit(db, actor, scope, lease.fence, await acquire());
  expect(await admin.artifactBlob.count()).toBe(0);
  expect(await admin.auditEvaluationScratch.count()).toBe(1);
  const run = await readAuditRun(db, actor, scope);
  expect(run.pages[0]).toMatchObject({
    sourceAvailability: "unavailable",
    provenance: {
      sha256: createHash("sha256")
        .update(new Uint8Array([255]))
        .digest("hex"),
    },
  });
  await cancelAuditRun(db, actor, scope);
  expect(await admin.auditEvaluationScratch.count()).toBe(0);
});

it("expires active facts before further acquisition and bounds scratch cleanup", async () => {
  const scope = await create(),
    lease = await claimAuditRun(db, actor, scope, "near-expiry");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 30 * 86400000 + 1800);
  let observed: AcquisitionReceipt;
  try {
    observed = await acquireRawPage(urls[0]!, urls[0]!, transport);
  } finally {
    vi.useRealTimers();
  }
  await checkpointPrivateAudit(db, actor, scope, lease.fence, observed);
  const scratch = await admin.auditEvaluationScratch.findFirstOrThrow();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, +scratch.expiresAt - Date.now()) + 5),
  );
  await expect(readAuditSource(db, actor, scope, urls[0]!)).rejects.toThrow(
    "SOURCE_EXPIRED",
  );
  let hops = 0;
  await expect(
    runRawAuditStep(db, actor, scope, async (u) => {
      hops++;
      return transport(u);
    }),
  ).rejects.toThrow(/SOURCE_EXPIRED/);
  expect(hops).toBe(0);
  expect(await admin.artifactRef.count()).toBe(1);
  expect(
    await admin.$queryRaw`SELECT lyraseo_audit.sweep_scratch(1) AS removed`,
  ).toEqual([{ removed: 1 }]);
  expect(await admin.auditEvaluationScratch.count()).toBe(0);
});
it("rejects a revoked editor between put and publication", async () => {
  const scope = await create(),
    lease = await claimAuditRun(db, actor, scope, "revoked");
  const observed = await acquireRawPage(urls[0]!, urls[0]!, transport);
  bindLocalArtifactStore(
    db,
    {
      ...store,
      async putImmutable(v, b) {
        await store.putImmutable(v, b);
        await admin.membership.update({
          where: {
            workspaceId_userId: { workspaceId: "a", userId: actor.userId },
          },
          data: { role: "EDITOR" },
        });
      },
    },
    authority,
  );
  await expect(
    checkpointPrivateAudit(db, actor, scope, lease.fence, observed),
  ).rejects.toThrow(/FORBIDDEN/);
  expect(await admin.artifactRef.count()).toBe(0);
  expect(await admin.auditPage.count()).toBe(0);
  expect(await admin.artifactBlob.count({ where: { state: "STAGED" } })).toBe(
    1,
  );
});

it("rolls back a final score, source ref and scratch if the source clock expires during terminal publication", async () => {
  const scope = await create([urls[0]!]),
    lease = await claimAuditRun(db, actor, scope, "final-clock");
  await admin.$executeRawUnsafe(`CREATE FUNCTION p2a1_delay_finish() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE deadline timestamptz; BEGIN
 SELECT min("expiresAt") AT TIME ZONE 'UTC' INTO deadline FROM public."AuditEvaluationScratch" WHERE "auditId"=NEW.id;
 PERFORM pg_sleep(greatest(0, extract(epoch FROM deadline-clock_timestamp()))+0.02); RETURN NEW;
 END $$`);
  try {
    await admin.$executeRawUnsafe(
      `CREATE TRIGGER p2a1_final_clock BEFORE UPDATE OF status ON "AuditRun" FOR EACH ROW WHEN(NEW.status='COMPLETED') EXECUTE FUNCTION p2a1_delay_finish()`,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 30 * 86400000 + 1800);
    let receipt: AcquisitionReceipt;
    try {
      receipt = await acquireRawPage(urls[0]!, urls[0]!, transport);
    } finally {
      vi.useRealTimers();
    }
    await expect(
      checkpointPrivateAudit(db, actor, scope, lease.fence, receipt),
    ).rejects.toThrow(/SOURCE_EXPIRED/);
    expect(await admin.artifactRef.count()).toBe(0);
    expect(await admin.auditPage.count()).toBe(0);
    expect(await admin.auditEvaluationScratch.count()).toBe(0);
    expect(
      await admin.auditRun.findUniqueOrThrow({ where: { id: scope.auditId } }),
    ).toMatchObject({ status: "RUNNING", evaluation: null });
  } finally {
    await admin.$executeRawUnsafe("DROP FUNCTION p2a1_delay_finish() CASCADE");
  }
});

it("round1 direct reserve cannot echo a real descriptor as proof of a put or parsed anchors", async () => {
  const scope = await create(),
    lease = await claimAuditRun(db, actor, scope, "no-put");
  const receipt = await acquireRawPage(urls[0]!, urls[0]!, transport);
  const data = (input: unknown) =>
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw<
          { r: ArtifactReservation }[]
        >`SELECT lyraseo_audit.web_artifact_reserve('a-site',${scope.auditId},0,${lease.fence}::integer,${JSON.stringify(input)}::json) AS r`,
    );
  const commit = (input: unknown) =>
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw`SELECT lyraseo_audit.web_artifact_commit('a-site',${scope.auditId},0,${lease.fence}::integer,${JSON.stringify(input)}::json,NULL)`,
    );
  const witnessed = witnessedObservation(
    db,
    lease,
    "web/" + scope.auditId + "/" + lease.fence,
    receipt,
  );
  const forged = structuredClone(witnessed);
  forged.evidence.linkNames[0]!.name = "made up";
  forged.provenance.headers["x-robots-tag"] = "noindex";
  const { restoreOriginalReceipt, originalBody } =
    await import("../../packages/visibility/src/acquisition");
  const reconstructed = await restoreOriginalReceipt(
    forged.provenance,
    originalBody(receipt)!,
  );
  const copied = witnessedObservation(
    db,
    lease,
    "web/" + scope.auditId + "/" + lease.fence,
    reconstructed,
  );
  expect(copied.captureConfirmation).toBeNull();
  await expect(data(copied)).rejects.toThrow(/CONFIRMATION_REQUIRED/);
  await expect(data(forged)).rejects.toThrow(/CONFIRMATION_REQUIRED/);
  await expect(data(receipt)).rejects.toThrow(/CONFIRMATION_REQUIRED/);
  expect(await admin.artifactBlob.count()).toBe(0);
  const [row] = await data(witnessed);
  const reserved = row!.r;
  await expect(
    commit({
      ...receipt,
      storageFormat: "AUDIT_PRIVATE_V1",
      version: reserved.version,
    }),
  ).rejects.toThrow(/CONFIRMATION_REQUIRED/);
  await expect(
    commit({
      ...receipt,
      storageFormat: "AUDIT_PRIVATE_V1",
      version: reserved.version,
      confirmation: witnessed.captureConfirmation,
    }),
  ).rejects.toThrow(/CONFIRMATION_REQUIRED/);
  const confirmed = await verifiedPublication(db, lease, receipt, reserved);
  await expect(
    commit({ ...confirmed, evidence: forged.evidence }),
  ).rejects.toThrow(/INVALID_ARTIFACT|CONFIRMATION_REQUIRED/);
  await expect(
    withActor(
      db,
      actor,
      "a",
      (tx) => tx.$queryRaw`SELECT secret FROM lyraseo_audit.artifact_verifier`,
    ),
  ).rejects.toThrow(/permission denied/);
  expect(await admin.auditPage.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
  expect(await admin.auditEvaluationScratch.count()).toBe(0);
});
it("round1 browser rejects reserving the second page before any object exists", async () => {
  const scope = await create(),
    lease = await claimAuditRun(db, actor, scope, "sequence");
  const receipt = await acquireRawPage(urls[1]!, urls[0]!, transport);
  await expect(
    checkpointPrivateAudit(db, actor, scope, lease.fence, receipt),
  ).rejects.toThrow(/INVALID_PAGE_EVIDENCE/);
  expect(await admin.artifactBlob.count()).toBe(0);
  expect(await store.inventoryPage("a", null, 10)).toEqual([]);
});
it("round1 retired acquired input prevents a second browser fetch or score", async () => {
  const scope = await create();
  await runRawAuditStep(db, actor, scope, transport);
  await admin.artifactBlob.updateMany({ data: { state: "ORPHAN" } });
  let hops = 0;
  await expect(
    runRawAuditStep(db, actor, scope, async (u) => {
      hops++;
      return transport(u);
    }),
  ).rejects.toThrow(/SOURCE_EXPIRED/);
  expect(hops).toBe(0);
  expect(await admin.auditPage.count()).toBe(1);
  expect(
    (await admin.auditRun.findUniqueOrThrow({ where: { id: scope.auditId } }))
      .evaluation,
  ).toBeNull();
});
it.each(["wrong", "truncated"])(
  "round1 attachment rejects %s backend bytes after a valid ticket",
  async (fault) => {
    const scope = await create();
    await runRawAuditStep(db, actor, scope, transport);
    bindLocalArtifactStore(db, {
      ...store,
      async openBounded(v) {
        const good = await store.openBounded(v);
        return fault === "truncated"
          ? good.slice(0, -1)
          : new Uint8Array(good.length);
      },
    });
    await expect(readAuditSource(db, actor, scope, urls[0]!)).rejects.toThrow(
      "ARTIFACT_UNAVAILABLE",
    );
  },
);

it("round1 retirement during browser terminal publication rolls back the last page and score", async () => {
  const scope = await create();
  await runRawAuditStep(db, actor, scope, transport);
  await admin.$executeRawUnsafe(`CREATE FUNCTION p2a1_retire_at_finish() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN UPDATE public."ArtifactBlob" SET state='ORPHAN' WHERE "auditId"=NEW.id AND "requestedUrl"='https://example.com/';RETURN NEW;END $$`);
  try {
    await admin.$executeRawUnsafe(
      `CREATE TRIGGER p2a1_retirement AFTER UPDATE OF status ON "AuditRun" FOR EACH ROW WHEN(NEW.status='COMPLETED') EXECUTE FUNCTION p2a1_retire_at_finish()`,
    );
    await expect(runRawAuditStep(db, actor, scope, transport)).rejects.toThrow(
      /SOURCE_EXPIRED/,
    );
    expect(await admin.auditPage.count()).toBe(1);
    expect(await admin.artifactRef.count()).toBe(1);
    expect(
      (await admin.auditRun.findUniqueOrThrow({ where: { id: scope.auditId } }))
        .evaluation,
    ).toBeNull();
  } finally {
    await admin.$executeRawUnsafe(
      "DROP FUNCTION p2a1_retire_at_finish() CASCADE",
    );
  }
});

it("round1 replacing a qualified backend cannot inherit its signing authority", async () => {
  const scope = await create();
  bindLocalArtifactStore(db, { ...store });
  await expect(runRawAuditStep(db, actor, scope, transport)).rejects.toThrow(
    "ARTIFACT_UNAVAILABLE",
  );
  expect(await admin.auditPage.count()).toBe(0);
  expect(await admin.artifactBlob.count()).toBe(0);
});

it("round1 the attestor checks actual returned object bytes before issuing publication confirmation", async () => {
  const scope = await create();
  bindLocalArtifactStore(
    db,
    {
      ...store,
      async openBounded(v) {
        return new Uint8Array(v.storedLength);
      },
    },
    authority,
  );
  await expect(runRawAuditStep(db, actor, scope, transport)).rejects.toThrow(
    "ARTIFACT_UNAVAILABLE",
  );
  expect(await admin.artifactBlob.count({ where: { state: "STAGED" } })).toBe(
    1,
  );
  expect(await admin.auditPage.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
  expect(await admin.auditEvaluationScratch.count()).toBe(0);
});
