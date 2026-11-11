import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { createDatabase } from "../../packages/db/src";
import {
  createAuditRun,
  claimAuditRun,
  cancelAuditRun,
  checkpointPrivateAudit,
  readAuditSource,
} from "../../packages/db/src/audits";
import {
  bindLocalArtifactStore,
  recoverAuditArtifactOrphans,
} from "../../packages/db/src/artifact-checkpoint";
import {
  readObservationAnswer,
  retireObservationAnswers,
} from "../../packages/db/src/observation-artifacts";
import {
  localAuditArtifactStore,
  faultAfterMutation,
  localArtifactFaultFacade,
  inspectLocalArtifactAbsence,
  type ArtifactVersion,
} from "../../packages/db/src/artifact-store";
import { withActor } from "../../packages/db/src/context";
import {
  applyPrivateArtifactExpiry,
  bindLocalExpiryAuthority,
  unbindLocalExpiryAuthority,
  previewPrivateArtifactExpiry,
  recordPrivateArtifactExpiryPlan,
  privateArtifactExpiryStatus,
  pausePrivateArtifactExpiry,
} from "../../packages/db/src/artifact-expiry";
import { acquireRawPage } from "../../packages/visibility/src/acquisition";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  recordVisibilityEvidence,
  type ProviderEvidence,
} from "../../packages/db/src/visibility";
import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
import { enrollTestExpiryAuthority } from "../helpers/expiry-authority";
import {
  actor,
  adminUrl,
  resetDatabase,
  runtimeUrl,
  seedTenants,
} from "../helpers/database";

const owned = /^lyraseo_expiry_[a-f0-9]{8,12}$/.test(
  process.env.LYRA_TEST_DB_NAME ?? "",
);
if (process.env.LYRA_PRIVATE_EXPIRY_REQUIRED === "true" && !owned)
  throw Error("OWNED_EXPIRY_FIXTURE_REQUIRED");
const maintenanceUrl = adminUrl.replace(
  "postgres:lyraseo_local_only",
  "lyraseo_artifact_maintenance:local_expiry_only",
);
const admin = createDatabase(adminUrl),
  runtime = createDatabase(runtimeUrl),
  maintenance = createDatabase(maintenanceUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
const url = "https://example.com/";
const raw = Buffer.from("<html><body>EXPIRY_PRIVATE_BODY</body></html>");
async function runCli(
  command: string,
  args: string[],
  config: unknown,
  manifest?: unknown,
  expectInvalidOption = false,
) {
  const child = spawn(
    process.execPath,
    ["scripts/privacy-artifacts.mjs", command, ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LYRA_PRIVATE_EXPIRY_ENABLED: "true",
        LYRA_PRIVATE_EXPIRY_CONFIG_FD: "3",
      },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const output: Buffer[] = [],
    errors: Buffer[] = [],
    inputErrors: NodeJS.ErrnoException[] = [];
  child.stdout.on("data", (part: Buffer) => output.push(part));
  child.stderr.on("data", (part: Buffer) => errors.push(part));
  child.stdio[3]!.on("error", (error: NodeJS.ErrnoException) =>
    inputErrors.push(error),
  );
  child.stdio[4]!.on("error", (error: NodeJS.ErrnoException) =>
    inputErrors.push(error),
  );
  child.stdio[3]!.end(JSON.stringify(config));
  child.stdio[4]!.end(manifest === undefined ? "" : JSON.stringify(manifest));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const error = Buffer.concat(errors).toString();
  if (
    inputErrors.length &&
    !(
      expectInvalidOption &&
      code !== null &&
      code !== 0 &&
      error.includes("INVALID_PRIVATE_EXPIRY_OPTION") &&
      inputErrors.every((e) => ["ECONNRESET", "EPIPE"].includes(e.code ?? ""))
    )
  )
    throw inputErrors[0];
  return {
    code,
    output: Buffer.concat(output).toString(),
    error,
  };
}
let root: string,
  store: Awaited<ReturnType<typeof localAuditArtifactStore>>,
  source: Awaited<ReturnType<typeof enrollTestArtifactAuthority>>,
  expiry: Awaited<ReturnType<typeof enrollTestExpiryAuthority>>;

describe.runIf(owned)("controlled local private artifact expiry", () => {
  beforeEach(async () => {
    await admin.$executeRawUnsafe(
      'TRUNCATE TABLE "ArtifactExpiryEvent","ArtifactExpiryItem","ArtifactExpiryPlan",lyraseo_expiry.absence_verifier,lyraseo_expiry.environment CASCADE',
    );
    await resetDatabase();
    await seedTenants();
    root = await mkdtemp(join(await realpath(tmpdir()), "lyraseo-expiry-"));
    store = await localAuditArtifactStore(root);
    source = await enrollTestArtifactAuthority(admin, store, ["a"]);
    bindLocalArtifactStore(runtime, store, source);
  });
  afterEach(async () => {
    expiry?.revoke();
    await source?.revoke();
    await store?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterAll(() =>
    Promise.all([
      admin.$disconnect(),
      runtime.$disconnect(),
      maintenance.$disconnect(),
    ]),
  );

  async function readyAudit(manifest = [url]) {
    const run = await createAuditRun(runtime, actor, {
      ...scope,
      profile: "LOCAL_RAW_V1",
      idempotencyKey: randomUUID(),
      manifest,
    });
    const target = { ...scope, auditId: run.id };
    const lease = await claimAuditRun(runtime, actor, target, "expiry-test");
    const receipt = await acquireRawPage(url, url, async (address) =>
      address.endsWith("robots.txt")
        ? new Response(null, { status: 404 })
        : new Response(raw, { headers: { "content-type": "text/html" } }),
    );
    await checkpointPrivateAudit(runtime, actor, target, lease.fence, receipt);
    const [blob] = await admin.$queryRaw<
      { id: string; expiresAt: Date; storageKey: string; generation: string }[]
    >`SELECT id,"expiresAt","storageKey",generation FROM "ArtifactBlob" WHERE "auditId"=${run.id}`;
    if (!blob) throw Error("TEST_BLOB_MISSING");
    return { target, blob, lease };
  }

  async function readyObservation() {
    const draft = await createVisibilityPanel(
      runtime,
      actor,
      scope,
      [{ id: "p", text: "Tools?", label: "neutral" }],
      [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
    );
    const panel = await reviewVisibilityPanel(runtime, actor, scope, draft.id);
    const evidence: ProviderEvidence = {
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
          body: "Alpha EXPIRY_OBSERVATION_SENTINEL",
          annotations: [],
          providerTaskId: "expiry-race",
          completedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        },
      ],
    };
    const run = await recordVisibilityEvidence(
      runtime,
      actor,
      scope,
      panel.id,
      evidence,
      {
        storageFormat: "OBSERVATION_PRIVATE_V1",
        sourceNamespace: "CONTROLLED_FIXTURE_V1",
        recordingKey: randomUUID(),
      },
    );
    const [blob] = await admin.$queryRaw<{ id: string; expiresAt: Date }[]>`
      SELECT id,"expiresAt" FROM "ArtifactBlob" WHERE "ownerKind"='VISIBILITY_SLOT'`;
    return { run, blob: blob! };
  }

  it("blocks the final observation ticket behind expiry and releases no buffered answer", async () => {
    const { run, blob } = await readyObservation();
    const [snapshot] = await admin.$queryRaw<{ value: unknown }[]>`
      SELECT to_jsonb(v) AS value FROM "VisibilityRun" v WHERE id=${run.id}`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    let releaseRead!: () => void,
      buffered!: () => void,
      releaseClaim!: () => void,
      claimed!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    const bufferedGate = new Promise<void>((resolve) => (buffered = resolve));
    const claimGate = new Promise<void>((resolve) => (releaseClaim = resolve));
    const claimedGate = new Promise<void>((resolve) => (claimed = resolve));
    const facade = localArtifactFaultFacade(store, {
      after: async (operation) => {
        if (operation === "read") {
          buffered();
          await readGate;
        }
      },
    });
    bindLocalArtifactStore(runtime, facade, source);
    const read = readObservationAnswer(
      runtime,
      actor,
      scope,
      run.id,
      "p",
      async () => actor,
    );
    await Promise.race([
      bufferedGate,
      delay(10000).then(() => {
        throw Error("BUFFER_TIMEOUT");
      }),
    ]);
    const blocker = maintenance.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item!.id}::uuid,${plan.hash})`;
        claimed();
        await claimGate;
      },
      { timeout: 10000 },
    );
    try {
      await claimedGate;
      releaseRead();
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [row] = await admin.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_runtime'
            AND wait_event_type='Lock') AS waiting`;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await delay(50);
      }
      expect(waiting).toBe(true);
    } finally {
      releaseRead();
      releaseClaim();
      await blocker;
    }
    const result = await read;
    expect(result.answer).toBeNull();
    expect(JSON.stringify(result)).not.toContain("EXPIRY_OBSERVATION_SENTINEL");
    const [after] = await admin.$queryRaw<
      { value: unknown }[]
    >`SELECT to_jsonb(v) AS value FROM "VisibilityRun" v WHERE id=${run.id}`;
    expect(after).toEqual(snapshot);
  });

  it("serializes real observation retirement behind an expiry claim", async () => {
    const { run, blob } = await readyObservation();
    const [before] = await admin.$queryRaw<
      { value: unknown }[]
    >`SELECT to_jsonb(v) AS value FROM "VisibilityRun" v WHERE id=${run.id}`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (locked = resolve));
    const claim = maintenance.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item!.id}::uuid,${plan.hash})`;
        locked();
        await held;
      },
      { timeout: 10000 },
    );
    await started;
    const retire = retireObservationAnswers(runtime, actor, scope, run.id);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [row] = await admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT FROM pg_stat_activity
          WHERE datname=current_database() AND usename='lyraseo_runtime' AND wait_event_type='Lock') AS waiting`;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await delay(50);
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await claim;
    }
    await retire;
    const result = await readObservationAnswer(
      runtime,
      actor,
      scope,
      run.id,
      "p",
      async () => actor,
    );
    expect(result.answer).toBeNull();
    expect(result.availability.state).toBe("rights-unavailable");
    const [after] = await admin.$queryRaw<
      { value: unknown }[]
    >`SELECT to_jsonb(v) AS value FROM "VisibilityRun" v WHERE id=${run.id}`;
    expect(after).toEqual(before);
  });

  it("rejects a paused observation finalization after expiry claims its staged generation", async () => {
    let release!: () => void, written!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (written = resolve));
    const facade = localArtifactFaultFacade(store, {
      after: async (operation) => {
        if (operation === "put") {
          written();
          await held;
        }
      },
    });
    bindLocalArtifactStore(runtime, facade, source);
    const writer = readyObservation().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        started,
        delay(10000).then(() => {
          throw Error("PUT_TIMEOUT");
        }),
      ]);
      const [blob] = await admin.$queryRaw<
        { id: string; expiresAt: Date; state: string }[]
      >`
        SELECT id,"expiresAt",state FROM "ArtifactBlob" WHERE "ownerKind"='VISIBILITY_SLOT'`;
      expect(blob?.state).toBe("STAGED");
      expiry = await enrollTestExpiryAuthority(
        admin,
        store,
        scope,
        new Date(blob!.expiresAt.getTime() + 1),
      );
      const preview = await previewPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
      );
      const plan = await recordPrivateArtifactExpiryPlan(
        maintenance,
        store,
        scope,
        preview.manifest,
        preview.hash,
      );
      const applied = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
      );
      expect(applied.outcomes[0]?.status).toBe("complete");
      release();
      const failedWriter = await writer;
      expect("error" in failedWriter && String(failedWriter.error)).toMatch(
        /ARTIFACT_UNAVAILABLE|STALE_OBSERVATION_PROOF|OBSERVATION_RETIRED/,
      );
      const [result] = await admin.$queryRaw<
        { runs: bigint; refs: bigint; state: string }[]
      >`
        SELECT (SELECT count(*) FROM "VisibilityRun") AS runs,(SELECT count(*) FROM "ArtifactRef" WHERE "blobId"=${blob!.id}::uuid) AS refs,
          (SELECT state FROM "ArtifactBlob" WHERE id=${blob!.id}::uuid) AS state`;
      expect(result).toMatchObject({ runs: 0n, refs: 0n, state: "DELETED" });
    } finally {
      release();
      await writer;
    }
  });

  it("keeps retired future observation bytes unavailable until their original due deadline", async () => {
    const { run, blob } = await readyObservation();
    const [before] = await admin.$queryRaw<
      { value: unknown }[]
    >`SELECT to_jsonb(v) AS value FROM "VisibilityRun" v WHERE id=${run.id}`;
    await retireObservationAnswers(runtime, actor, scope, run.id);
    const read = await readObservationAnswer(
      runtime,
      actor,
      scope,
      run.id,
      "p",
      async () => actor,
    );
    expect(read.answer).toBeNull();
    expect(read.availability.state).toBe("rights-unavailable");
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() - 1),
    );
    const early = await previewPrivateArtifactExpiry(maintenance, store, scope);
    expect(early.manifest.some((item) => item.class === "BLOB")).toBe(false);
    const [orphan] = await admin.$queryRaw<
      { state: string }[]
    >`SELECT state FROM "ArtifactBlob" WHERE id=${blob.id}::uuid`;
    expect(orphan?.state).toBe("ORPHAN");
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${blob.expiresAt.toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
    const due = await previewPrivateArtifactExpiry(maintenance, store, scope);
    expect(due.manifest.some((item) => item.class === "BLOB")).toBe(true);
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      due.manifest,
      due.hash,
    );
    const applied = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
    );
    expect(applied.outcomes[0]?.status).toBe("complete");
    const [after] = await admin.$queryRaw<
      { value: unknown }[]
    >`SELECT to_jsonb(v) AS value FROM "VisibilityRun" v WHERE id=${run.id}`;
    expect(after).toEqual(before);
  });

  it("prevents a paused checkpoint from publishing after its due scratch and sources expire", async () => {
    const secondUrl = "https://example.com/second";
    const { target } = await readyAudit([url, secondUrl]);
    const lease = await claimAuditRun(
      runtime,
      actor,
      target,
      "expiry-checkpoint-second",
    );
    const receipt = await acquireRawPage(
      secondUrl,
      secondUrl,
      async (address) =>
        address.endsWith("robots.txt")
          ? new Response(null, { status: 404 })
          : new Response(raw, { headers: { "content-type": "text/html" } }),
    );
    let release!: () => void, written!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (written = resolve));
    const facade = localArtifactFaultFacade(store, {
      after: async (operation) => {
        if (operation === "put") {
          written();
          await held;
        }
      },
    });
    bindLocalArtifactStore(runtime, facade, source);
    const checkpoint = checkpointPrivateAudit(
      runtime,
      actor,
      target,
      lease.fence,
      receipt,
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        started,
        checkpoint.then((result) => {
          throw Error(
            "CHECKPOINT_EARLY: " +
              ("error" in result ? String(result.error) : "completed"),
          );
        }),
        delay(10000).then(() => {
          throw Error("CHECKPOINT_PUT_TIMEOUT");
        }),
      ]);
      const rows = await admin.$queryRaw<
        { expiresAt: Date }[]
      >`SELECT "expiresAt" FROM "ArtifactBlob" WHERE "auditId"=${target.auditId}`;
      expect(rows).toHaveLength(2);
      const dueAt = Math.max(...rows.map((row) => row.expiresAt.getTime())) + 1;
      expiry = await enrollTestExpiryAuthority(
        admin,
        store,
        scope,
        new Date(dueAt),
      );
      const preview = await previewPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
      );
      expect(preview.manifest.some((item) => item.class === "SCRATCH")).toBe(
        true,
      );
      const plan = await recordPrivateArtifactExpiryPlan(
        maintenance,
        store,
        scope,
        preview.manifest,
        preview.hash,
      );
      const applied = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
      );
      expect(
        applied.outcomes.every((outcome) => outcome.status === "complete"),
      ).toBe(true);
      release();
      const failedCheckpoint = await checkpoint;
      expect(
        "error" in failedCheckpoint && String(failedCheckpoint.error),
      ).toMatch(/ARTIFACT_UNAVAILABLE|SOURCE_EXPIRED/);
      const [state] = await admin.$queryRaw<
        { status: string; evaluation: unknown; scratch: bigint; refs: bigint }[]
      >`
        SELECT a.status,a.evaluation,(SELECT count(*) FROM "AuditEvaluationScratch" WHERE "auditId"=a.id) AS scratch,
         (SELECT count(*) FROM "ArtifactRef" WHERE "auditId"=a.id) AS refs FROM "AuditRun" a WHERE a.id=${target.auditId}`;
      expect(state).toMatchObject({
        status: "RUNNING",
        evaluation: null,
        scratch: 0n,
        refs: 0n,
      });
    } finally {
      release();
      await checkpoint;
    }
  });

  it("pauses new claims while reconciling begun work and requires a new plan to resume", async () => {
    const first = await readyAudit(),
      second = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(
        Math.max(
          first.blob.expiresAt.getTime(),
          second.blob.expiresAt.getTime(),
        ) + 1,
      ),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const items = await admin.$queryRaw<
      { id: string; blobId: string }[]
    >`SELECT id,"blobId" FROM "ArtifactExpiryItem" WHERE class='BLOB' ORDER BY id`;
    const [claimed] = await maintenance.$queryRaw<
      { result: { token: string; version: ArtifactVersion } }[]
    >`
      SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${items[0]!.id}::uuid,${plan.hash}) AS result`;
    await store.deleteExactVersion(claimed!.result.version);
    await pausePrivateArtifactExpiry(maintenance, store, scope, plan.planId);
    await expect(
      maintenance.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${items[1]!.id}::uuid,${plan.hash})`,
    ).rejects.toThrow("EXPIRY_PLAN_INACTIVE");
    const begun = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
      100,
      true,
    );
    expect(begun.outcomes).toHaveLength(1);
    expect(begun.outcomes[0]?.status).toBe("complete");
    const [pending] = await admin.$queryRaw<
      { state: string }[]
    >`SELECT state FROM "ArtifactBlob" WHERE id=${items[1]!.blobId}::uuid`;
    expect(pending?.state).toBe("READY");
    const next = await previewPrivateArtifactExpiry(maintenance, store, scope);
    const replacement = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      next.manifest,
      next.hash,
    );
    expect(replacement.planId).not.toBe(plan.planId);
    const finished = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      replacement.planId,
      replacement.hash,
    );
    expect(finished.outcomes[0]?.status).toBe("complete");
  });

  it("rejects an originally expired synthetic plan and replans without rewriting clocks", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const normal = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [normalClock] = await admin.$queryRaw<
      { plannedAt: Date; expiresAt: Date }[]
    >`SELECT "plannedAt","expiresAt" FROM "ArtifactExpiryPlan" WHERE id=${normal.planId}::uuid`;
    // Admin-only disposable fixture: the new row is originally expired; no existing clock is updated.
    const [expired] = await admin.$queryRaw<
      { id: string }[]
    >`INSERT INTO "ArtifactExpiryPlan"
      ("policyVersion","workspaceId","siteId","environmentId","databaseOid","postmasterStartedAt","storeId","namespaceId","plannedAt","expiresAt",manifest,"manifestHash")
      SELECT "policyVersion","workspaceId","siteId","environmentId","databaseOid","postmasterStartedAt","storeId","namespaceId",
        clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',manifest,"manifestHash"
      FROM "ArtifactExpiryPlan" WHERE id=${normal.planId}::uuid RETURNING id`;
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`UPDATE "ArtifactExpiryItem" SET "currentPlanId"=${expired!.id}::uuid WHERE "currentPlanId"=${normal.planId}::uuid RETURNING id`;
    await expect(
      maintenance.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${expired!.id}::uuid,${item!.id}::uuid,${normal.hash})`,
    ).rejects.toThrow("EXPIRY_PLAN_INACTIVE");
    const [still] = await admin.$queryRaw<
      { plannedAt: Date; expiresAt: Date }[]
    >`SELECT "plannedAt","expiresAt" FROM "ArtifactExpiryPlan" WHERE id=${normal.planId}::uuid`;
    expect(still).toEqual(normalClock);
    const replacement = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    expect(
      (
        await applyPrivateArtifactExpiry(
          maintenance,
          store,
          scope,
          replacement.planId,
          replacement.hash,
        )
      ).outcomes[0]?.status,
    ).toBe("complete");
  });

  it("reads the referenced generation after an older fence abandoned its staged upload", async () => {
    const run = await createAuditRun(runtime, actor, {
      ...scope,
      profile: "LOCAL_RAW_V1",
      idempotencyKey: randomUUID(),
      manifest: [url],
    });
    const target = { ...scope, auditId: run.id };
    const first = await claimAuditRun(runtime, actor, target, "abandoned");
    const acquire = () =>
      acquireRawPage(url, url, async (address) =>
        address.endsWith("robots.txt")
          ? new Response(null, { status: 404 })
          : new Response(raw, { headers: { "content-type": "text/html" } }),
      );
    bindLocalArtifactStore(
      runtime,
      localArtifactFaultFacade(store, {
        before: (operation) => {
          if (operation === "put") throw Error("put-unavailable");
        },
      }),
      source,
    );
    await expect(
      checkpointPrivateAudit(
        runtime,
        actor,
        target,
        first.fence,
        await acquire(),
      ),
    ).rejects.toThrow();
    // Private checkpoint has no generic yield: reacquire only after the real 90-second lease.
    await delay(Math.max(0, first.leaseUntil!.getTime() - Date.now()) + 250);
    bindLocalArtifactStore(runtime, store, source);
    const second = await claimAuditRun(runtime, actor, target, "new-fence");
    expect(second.fence).toBeGreaterThan(first.fence);
    await checkpointPrivateAudit(
      runtime,
      actor,
      target,
      second.fence,
      await acquire(),
    );
    const rows = await admin.$queryRaw<
      { id: string; state: string; referenced: boolean }[]
    >`
      SELECT b.id,b.state,EXISTS(SELECT FROM "ArtifactRef" f WHERE f."blobId"=b.id AND f.generation=b.generation) AS referenced
      FROM "ArtifactBlob" b WHERE b."auditId"=${target.auditId} ORDER BY b."createdAt"`;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.referenced).toBe(false);
    expect(rows[1]).toMatchObject({ state: "READY", referenced: true });
    const read = await readAuditSource(
      runtime,
      actor,
      target,
      url,
      async () => actor,
    );
    expect(read).toBeTruthy();
  }, 110000);

  it("preserves a pending retry deadline across replanning", async () => {
    const { blob } = await readyAudit();
    const faulty = faultAfterMutation(store, "delete");
    expiry = await enrollTestExpiryAuthority(
      admin,
      faulty,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      faulty,
      scope,
    );
    const first = await recordPrivateArtifactExpiryPlan(
      maintenance,
      faulty,
      scope,
      preview.manifest,
      preview.hash,
    );
    expect(
      (
        await applyPrivateArtifactExpiry(
          maintenance,
          faulty,
          scope,
          first.planId,
          first.hash,
        )
      ).outcomes[0]?.status,
    ).toBe("pending");
    const [before] = await admin.$queryRaw<
      { id: string; nextRetryAt: Date }[]
    >`SELECT id,"nextRetryAt" FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    const second = await recordPrivateArtifactExpiryPlan(
      maintenance,
      faulty,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [after] = await admin.$queryRaw<
      { nextRetryAt: Date }[]
    >`SELECT "nextRetryAt" FROM "ArtifactExpiryItem" WHERE id=${before!.id}::uuid`;
    expect(after?.nextRetryAt).toEqual(before?.nextRetryAt);
    expect(
      (
        await applyPrivateArtifactExpiry(
          maintenance,
          faulty,
          scope,
          second.planId,
          second.hash,
          100,
          true,
        )
      ).attempted,
    ).toBe(0);
    await delay(Math.max(0, before!.nextRetryAt.getTime() - Date.now()) + 250);
    expect(
      (
        await applyPrivateArtifactExpiry(
          maintenance,
          faulty,
          scope,
          second.planId,
          second.hash,
          100,
          true,
        )
      ).outcomes[0]?.status,
    ).toBe("complete");
  }, 45000);

  it("rejects another enrolled site's plan before blob or transient mutation", async () => {
    const siteB = { workspaceId: "a", siteId: "a-second-site" };
    const bUrl = "https://second.example/";
    await admin.site.create({
      data: {
        id: siteB.siteId,
        workspaceId: "a",
        origin: "https://second.example",
        verifiedAt: new Date(),
      },
    });
    const run = await createAuditRun(runtime, actor, {
      ...siteB,
      profile: "LOCAL_RAW_V1",
      idempotencyKey: randomUUID(),
      manifest: [bUrl],
    });
    const target = { ...siteB, auditId: run.id };
    const lease = await claimAuditRun(runtime, actor, target, "scope-b");
    const receipt = await acquireRawPage(bUrl, bUrl, async (address) =>
      address.endsWith("robots.txt")
        ? new Response(null, { status: 404 })
        : new Response(raw, { headers: { "content-type": "text/html" } }),
    );
    await checkpointPrivateAudit(runtime, actor, target, lease.fence, receipt);
    const [blob] = await admin.$queryRaw<
      { id: string; expiresAt: Date }[]
    >`SELECT id,"expiresAt" FROM "ArtifactBlob" WHERE "auditId"=${run.id}`;
    await admin.$executeRaw`INSERT INTO "ArtifactBlob"("workspaceId","siteId","auditId","requestedUrl","pageId",fence,"capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state,"pendingReceipt")
      SELECT "workspaceId","siteId","auditId",'https://example.com/scope-b-metadata',gen_random_uuid(),fence,"capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",'STAGED','{"headers":{"x":"private"}}'::jsonb FROM "ArtifactBlob" WHERE id=${blob!.id}::uuid`;
    const due = new Date(blob!.expiresAt.getTime() + 1);
    expiry = await enrollTestExpiryAuthority(admin, store, scope, due);
    const bStore = localArtifactFaultFacade(store, {});
    const bAuthority = await enrollTestExpiryAuthority(
      admin,
      bStore,
      siteB,
      due,
    );
    try {
      const preview = await previewPrivateArtifactExpiry(
        maintenance,
        bStore,
        siteB,
      );
      expect(new Set(preview.manifest.map((item) => item.class))).toEqual(
        new Set(["BLOB", "PENDING_RECEIPT"]),
      );
      const plan = await recordPrivateArtifactExpiryPlan(
        maintenance,
        bStore,
        siteB,
        preview.manifest,
        preview.hash,
      );
      const mutableScope = { ...scope };
      const frozenPreview = previewPrivateArtifactExpiry(
        maintenance,
        store,
        mutableScope,
      );
      mutableScope.siteId = siteB.siteId;
      expect((await frozenPreview).manifest).toHaveLength(0);
      await expect(
        privateArtifactExpiryStatus(maintenance, scope, plan.planId),
      ).rejects.toThrow();
      await expect(
        pausePrivateArtifactExpiry(maintenance, store, scope, plan.planId),
      ).rejects.toThrow();
      const bItems = await admin.$queryRaw<
        { id: string; class: string }[]
      >`SELECT id,class FROM "ArtifactExpiryItem" WHERE "currentPlanId"=${plan.planId}::uuid`;
      expect(new Set(bItems.map((item) => item.class))).toEqual(
        new Set(["BLOB", "PENDING_RECEIPT"]),
      );
      for (const item of bItems) {
        await expect(
          maintenance.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item.id}::uuid,${plan.hash})`,
        ).rejects.toThrow();
        await expect(
          maintenance.$queryRaw`SELECT lyraseo_expiry.reconcile_claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item.id}::uuid,${plan.hash})`,
        ).rejects.toThrow();
      }
      const snapshot = await admin.$queryRaw<
        { value: unknown }[]
      >`SELECT jsonb_build_object('blobs',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM "ArtifactBlob" b WHERE "siteId"=${siteB.siteId}),
        'refs',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM "ArtifactRef" f WHERE "siteId"=${siteB.siteId}),
        'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM "ArtifactExpiryItem" i WHERE "currentPlanId"=${plan.planId}::uuid),
        'control',(SELECT jsonb_build_array(rotation,"classCursors") FROM "ArtifactExpiryPlan" WHERE id=${plan.planId}::uuid)) AS value`;
      await expect(
        applyPrivateArtifactExpiry(
          maintenance,
          store,
          scope,
          plan.planId,
          plan.hash,
        ),
      ).rejects.toThrow();
      const after = await admin.$queryRaw<
        typeof snapshot
      >`SELECT jsonb_build_object('blobs',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM "ArtifactBlob" b WHERE "siteId"=${siteB.siteId}),
        'refs',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM "ArtifactRef" f WHERE "siteId"=${siteB.siteId}),
        'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM "ArtifactExpiryItem" i WHERE "currentPlanId"=${plan.planId}::uuid),
        'control',(SELECT jsonb_build_array(rotation,"classCursors") FROM "ArtifactExpiryPlan" WHERE id=${plan.planId}::uuid)) AS value`;
      expect(after).toEqual(snapshot);
    } finally {
      bAuthority.revoke();
    }
  });

  it("stops before claims when its authority changes during item selection", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (locked = resolve));
    const blocker = admin.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ArtifactExpiryPlan" WHERE id=${plan.planId}::uuid FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 10000 },
    );
    await started;
    const applying = applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      let waiting = false;
      for (let i = 0; i < 50; i++) {
        const [row] = await admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT FROM pg_stat_activity
        WHERE datname=current_database() AND usename='lyraseo_artifact_maintenance' AND wait_event_type='Lock') AS waiting`;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await delay(50);
      }
      expect(waiting).toBe(true);
      unbindLocalExpiryAuthority(store);
    } finally {
      release();
      await blocker;
    }
    const result = await applying;
    expect("error" in result && String(result.error)).toContain(
      "EXPIRY_AUTHORITY_CHANGED",
    );
    const [state] = await admin.$queryRaw<
      { state: string; refs: bigint; events: bigint }[]
    >`
      SELECT b.state,(SELECT count(*) FROM "ArtifactRef" WHERE "blobId"=b.id) AS refs,
      (SELECT count(*) FROM "ArtifactExpiryEvent") AS events FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(state).toMatchObject({ state: "READY", refs: 1n, events: 0n });
  });

  it("pause waits for a claim already past its final plan recheck", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    const lockId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 7),
      16,
    );
    await admin.$executeRawUnsafe(
      `CREATE FUNCTION expiry_test_pause_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockId}); RETURN OLD; END $$`,
    );
    await admin.$executeRawUnsafe(
      `CREATE TRIGGER expiry_test_pause_barrier BEFORE DELETE ON "ArtifactRef" FOR EACH ROW EXECUTE FUNCTION expiry_test_pause_barrier()`,
    );
    let release!: () => void, held!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (held = resolve));
    const blocker = admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId}::bigint)`;
        held();
        await gate;
      },
      { timeout: 10000 },
    );
    await ready;
    const claim =
      maintenance.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item!.id}::uuid,${plan.hash})`.then(
        (value) => value,
      );
    let pause: Promise<unknown> | undefined;
    try {
      let waiting = false;
      for (let i = 0; i < 50; i++) {
        const [row] = await admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_artifact_maintenance' AND wait_event='advisory') AS waiting`;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await delay(50);
      }
      expect(waiting).toBe(true);
      let returned = false;
      pause = pausePrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
      ).then((value) => {
        returned = true;
        return value;
      });
      await delay(300);
      expect(returned).toBe(false);
    } finally {
      release();
      await blocker;
      await claim;
      await pause;
      await admin.$executeRawUnsafe(
        "DROP FUNCTION expiry_test_pause_barrier() CASCADE",
      );
    }
    expect(
      (await privateArtifactExpiryStatus(maintenance, scope, plan.planId))
        .paused,
    ).toBe(true);
  });

  it("handles an early invalid-option rejection while config delivery is in flight", async () => {
    const rejected = await runCli(
      "artifact-plan",
      ["--as-of", "2100-01-01"],
      { fixture: "x".repeat(1_000_000) },
      undefined,
      true,
    );
    expect(rejected.code).not.toBe(0);
    expect(rejected.error).toContain("INVALID_PRIVATE_EXPIRY_OPTION");
  });

  it("keeps dry-run read-only, then withdraws due bytes after source-secret revocation", async () => {
    const { target, blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    await admin.$executeRaw`INSERT INTO "ArtifactBlob"("workspaceId","siteId","auditId","requestedUrl","pageId",fence,
      "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state,"pendingReceipt")
      SELECT "workspaceId","siteId","auditId",'https://example.com/unbound',gen_random_uuid(),fence,
        "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",'STAGED',
        '{"headers":{"content-type":"text/html"}}'::jsonb
      FROM "ArtifactBlob" WHERE id=${blob.id}::uuid`;
    const before = await admin.$queryRaw<
      { plans: bigint; events: bigint; refs: bigint }[]
    >`SELECT (SELECT count(*) FROM "ArtifactExpiryPlan") AS plans,
       (SELECT count(*) FROM "ArtifactExpiryEvent") AS events,
       (SELECT count(*) FROM "ArtifactRef") AS refs`;
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(preview.manifest.some((v) => v.class === "BLOB")).toBe(true);
    expect(preview.manifest.some((v) => v.class === "PENDING_RECEIPT")).toBe(
      true,
    );
    expect(preview.items.some((v) => v.reason === "UNBOUND")).toBe(true);
    const afterPreview = await admin.$queryRaw<
      typeof before
    >`SELECT (SELECT count(*) FROM "ArtifactExpiryPlan") AS plans,
       (SELECT count(*) FROM "ArtifactExpiryEvent") AS events,
       (SELECT count(*) FROM "ArtifactRef") AS refs`;
    expect(afterPreview).toEqual(before);
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [privateKey] = await admin.$queryRaw<
      { secret_hex: string }[]
    >`SELECT encode(secret,'hex') AS secret_hex FROM lyraseo_expiry.absence_verifier WHERE id=${expiry.keyId}::uuid`;
    const cliConfig = {
      databaseUrl: maintenanceUrl,
      root,
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      keyId: expiry.keyId,
      secretHex: privateKey!.secret_hex,
      origin: expiry.origin,
    };
    const cliStatus = await runCli(
      "artifact-status",
      ["--plan-id", plan.planId],
      cliConfig,
    );
    expect(cliStatus.code, cliStatus.error).toBe(0);
    expect(JSON.parse(cliStatus.output).qualification).toBe(
      "LOCAL_TEST_ONLY_ACTIVE_STORE_P2B1",
    );
    const deniedAsOf = await runCli(
      "artifact-plan",
      ["--as-of", "2100-01-01"],
      cliConfig,
      undefined,
      true,
    );
    expect(deniedAsOf.code).not.toBe(0);
    expect(deniedAsOf.error).toContain("INVALID_PRIVATE_EXPIRY_OPTION");
    await source.revoke();
    const applied = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
    );
    expect(applied.outcomes.every((x) => x.status === "complete")).toBe(true);
    const [state] = await admin.$queryRaw<
      { state: string; ref_count: bigint; proof_count: bigint }[]
    >`SELECT b.state,(SELECT count(*) FROM "ArtifactRef" WHERE "blobId"=b.id) AS ref_count,
      (SELECT count(*) FROM "ArtifactExpiryEvent" WHERE outcome='COMPLETE' AND "proofDigest" IS NOT NULL) AS proof_count
      FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(state).toMatchObject({
      state: "DELETED",
      ref_count: 0n,
      proof_count: 1n,
    });
    const status = await privateArtifactExpiryStatus(
      maintenance,
      scope,
      plan.planId,
    );
    expect(status.scopeResidual).toMatchObject({
      dueQualified: 0,
      dueBlocked: 1,
    });
    const [unbound] = await admin.$queryRaw<
      { pending: boolean }[]
    >`SELECT "pendingReceipt" IS NOT NULL AS pending FROM "ArtifactBlob" WHERE "requestedUrl"='https://example.com/unbound'`;
    expect(unbound?.pending).toBe(false);
    await expect(
      readAuditSource(runtime, actor, target, url, async () => actor),
    ).rejects.toThrow();
    expect(await store.inventoryPage("a", null, 10)).toEqual([]);
    expect(createHash("sha256").update(raw).digest("hex")).toHaveLength(64);
  });

  it("isolates expiry functions and secrets across actual restricted logins", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const identities = [
      ["lyraseo_runtime", "local_runtime_only"],
      ["lyraseo_identity", "local_identity_only"],
      ["lyraseo_dispatch", "local_dispatch_only"],
      ["lyraseo_operator", "local_operator_only"],
      ["anon", "local_anon_only"],
      ["authenticated", "local_authenticated_only"],
      ["lyraseo_artifact_maintenance", "local_expiry_only"],
    ];
    for (const [name, password] of identities) {
      const connection = new URL(adminUrl);
      connection.username = name!;
      connection.password = password!;
      const client = createDatabase(connection.href);
      try {
        const [session] = await client.$queryRaw<
          { session_user: string; current_user: string }[]
        >`SELECT session_user,current_user`;
        expect(session).toEqual({ session_user: name, current_user: name });
        for (const table of [
          'public."ArtifactExpiryPlan"',
          'public."ArtifactExpiryItem"',
          'public."ArtifactExpiryEvent"',
          "lyraseo_expiry.environment",
          "lyraseo_expiry.absence_verifier",
        ]) {
          await expect(
            client.$queryRawUnsafe(`SELECT * FROM ${table}`),
          ).rejects.toThrow();
          await expect(
            client.$queryRawUnsafe(`SELECT id FROM ${table}`),
          ).rejects.toThrow();
          const [relation] = await admin.$queryRaw<
            { oid: number }[]
          >`SELECT ${table}::regclass::oid::int AS oid`;
          const [column] = await client.$queryRaw<{ forbidden: boolean }[]>`
            SELECT has_any_column_privilege(current_user,${relation!.oid}::oid,'SELECT,INSERT,UPDATE') AS forbidden`;
          expect(column?.forbidden).toBe(false);
          await expect(
            client.$executeRawUnsafe(`INSERT INTO ${table} DEFAULT VALUES`),
          ).rejects.toThrow();
          await expect(
            client.$executeRawUnsafe(`UPDATE ${table} SET id=id`),
          ).rejects.toThrow();
          await expect(
            client.$executeRawUnsafe(`DELETE FROM ${table}`),
          ).rejects.toThrow();
        }
        const [functions] = await client.$queryRaw<{ names: string[] }[]>`
          SELECT coalesce(array_agg(p.proname::text ORDER BY p.proname),'{}'::text[]) AS names
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='lyraseo_expiry' AND has_function_privilege(current_user,p.oid,'EXECUTE')`;
        expect(functions?.names).toEqual(
          name === "lyraseo_artifact_maintenance"
            ? [
                "claim",
                "complete",
                "next_items",
                "pause",
                "preview",
                "reconcile_claim",
                "record_pending",
                "record_plan",
                "status",
              ]
            : [],
        );
        await expect(
          client.$queryRaw`SELECT secret FROM lyraseo_audit.artifact_verifier`,
        ).rejects.toThrow();
        await expect(
          client.$executeRawUnsafe("SET ROLE lyraseo_expiry_owner"),
        ).rejects.toThrow();
        if (name !== "lyraseo_artifact_maintenance") {
          await expect(
            client.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT set_config('app.workspace_id','a',true),set_config('app.actor_id','owner',true),set_config('search_path','lyraseo_expiry,public,pg_catalog',true)`;
              return tx.$queryRaw`SELECT lyraseo_expiry.preview(${JSON.stringify(scope)}::jsonb,100,NULL)`;
            }),
          ).rejects.toThrow();
          await expect(
            client.$queryRaw`SELECT lyraseo_expiry.status(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid)`,
          ).rejects.toThrow();
        } else {
          await expect(
            client.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT set_config('app.workspace_id','a',true),set_config('app.actor_id','owner',true),set_config('search_path','public,lyraseo_expiry,pg_catalog',true)`;
              return tx.$queryRaw`SELECT lyraseo_expiry.preview('{"workspaceId":"b","siteId":"b-site"}'::jsonb,100,NULL)`;
            }),
          ).rejects.toThrow();
          await expect(
            client.$queryRaw`SELECT lyraseo_expiry.status(${JSON.stringify(scope)}::jsonb,${randomUUID()}::uuid)`,
          ).rejects.toThrow();
          await expect(
            client.$queryRaw`SELECT lyraseo_expiry.verify_mac(${randomUUID()}::uuid,${randomUUID()}::uuid,'x','x')`,
          ).rejects.toThrow();
          const spoof = await client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              "CREATE TEMP TABLE expiry_search_path_probe(id integer)",
            );
            await tx.$executeRawUnsafe(
              "CREATE FUNCTION pg_temp.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '1900-01-01'::timestamptz $$",
            );
            await tx.$queryRaw`SELECT set_config('search_path','pg_temp,public,pg_catalog',true)`;
            const [row] = await tx.$queryRaw<
              { result: { databaseNow: string } }[]
            >`
              SELECT lyraseo_expiry.preview(${JSON.stringify(scope)}::jsonb,100,NULL) AS result`;
            return row!.result;
          });
          expect(new Date(spoof.databaseNow).getUTCFullYear()).toBeGreaterThan(
            2020,
          );
        }
      } finally {
        await client.$disconnect();
      }
    }
    const [state] = await admin.$queryRaw<{ state: string; refs: bigint }[]>`
      SELECT b.state,(SELECT count(*) FROM "ArtifactRef" WHERE "blobId"=b.id) AS refs
      FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(state).toMatchObject({ state: "READY", refs: 1n });
  });

  it("rejects a real previously valid plan after its scope enrollment is revoked", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET workspace_id='b',site_id='b-site' WHERE id=(SELECT "environmentId" FROM "ArtifactExpiryPlan" WHERE id=${plan.planId}::uuid)`;
    await expect(
      privateArtifactExpiryStatus(maintenance, scope, plan.planId),
    ).rejects.toThrow();
    await expect(
      maintenance.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.workspace_id','a',true),set_config('app.actor_id','owner',true)`;
        return tx.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item!.id}::uuid,${plan.hash})`;
      }),
    ).rejects.toThrow();
    const [state] = await admin.$queryRaw<
      { state: string; refs: bigint; events: bigint }[]
    >`
      SELECT b.state,(SELECT count(*) FROM "ArtifactRef" WHERE "blobId"=b.id) AS refs,
        (SELECT count(*) FROM "ArtifactExpiryEvent") AS events FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(state).toMatchObject({ state: "READY", refs: 1n, events: 0n });
  });

  it("runs the private-FD CLI lifecycle against the enrolled store", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const [key] = await admin.$queryRaw<{ secret_hex: string }[]>`
      SELECT encode(secret,'hex') AS secret_hex FROM lyraseo_expiry.absence_verifier WHERE id=${expiry.keyId}::uuid`;
    const config = {
      databaseUrl: maintenanceUrl,
      root,
      ...scope,
      keyId: expiry.keyId,
      secretHex: key!.secret_hex,
      origin: expiry.origin,
    };
    const invoke = async (
      command: string,
      args: string[] = [],
      manifest?: unknown,
    ) => {
      const result = await runCli(command, args, config, manifest);
      expect(result.code, result.error).toBe(0);
      return JSON.parse(result.output);
    };
    const preview = await invoke("artifact-plan");
    expect(
      preview.manifest.some((item: { class: string }) => item.class === "BLOB"),
    ).toBe(true);
    const plan = await invoke(
      "artifact-record-plan",
      ["--manifest-fd", "4", "--hash", preview.hash],
      preview.manifest,
    );
    const applied = await invoke("artifact-apply", [
      "--plan-id",
      plan.planId,
      "--hash",
      plan.hash,
    ]);
    expect(
      applied.outcomes.some(
        (outcome: { status: string }) => outcome.status === "complete",
      ),
    ).toBe(true);
    const status = await invoke("artifact-status", ["--plan-id", plan.planId]);
    expect(status.selectedPlan.complete).toBeGreaterThan(0);
    const paused = await invoke("artifact-pause", ["--plan-id", plan.planId]);
    expect(paused.paused).toBe(true);
    const reconciled = await invoke("artifact-reconcile", [
      "--plan-id",
      plan.planId,
      "--hash",
      plan.hash,
    ]);
    expect(reconciled.attempted).toBe(0);
    const [state] = await admin.$queryRaw<
      { state: string }[]
    >`SELECT state FROM "ArtifactBlob" WHERE id=${blob.id}::uuid`;
    expect(state?.state).toBe("DELETED");
  });

  it.each([
    ["after committed mark", "before", "delete"],
    ["after physical deletion", "after", "delete"],
    ["after absence inspection before CAS", "after", "absence"],
  ])(
    "recovers a killed process %s",
    async (_name, phase, operation) => {
      const { blob } = await readyAudit();
      expiry = await enrollTestExpiryAuthority(
        admin,
        store,
        scope,
        new Date(blob.expiresAt.getTime() + 1),
      );
      const preview = await previewPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
      );
      const plan = await recordPrivateArtifactExpiryPlan(
        maintenance,
        store,
        scope,
        preview.manifest,
        preview.hash,
      );
      const [key] = await admin.$queryRaw<{ secret_hex: string }[]>`
      SELECT encode(secret,'hex') AS secret_hex FROM lyraseo_expiry.absence_verifier WHERE id=${expiry.keyId}::uuid`;
      const config = {
        databaseUrl: maintenanceUrl,
        root,
        ...scope,
        keyId: expiry.keyId,
        secretHex: key!.secret_hex,
        origin: expiry.origin,
        planId: plan.planId,
        hash: plan.hash,
        phase,
        operation,
      };
      const child = spawn(
        process.execPath,
        ["tests/fixtures/expiry/killable-apply.mjs"],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "pipe"] },
      );
      const errors: Buffer[] = [];
      child.stderr.on("data", (part: Buffer) => errors.push(part));
      child.stdio[3]!.end(JSON.stringify(config));
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            child.stdout.once("data", (part: Buffer) =>
              part.toString().includes("BOUNDARY")
                ? resolve()
                : reject(Error("INVALID_BOUNDARY")),
            );
            child.once("exit", (code) =>
              reject(
                Error(
                  `EARLY_EXIT ${code}: ${Buffer.concat(errors).toString()}`,
                ),
              ),
            );
          }),
          delay(10000).then(() => {
            throw Error("BOUNDARY_TIMEOUT");
          }),
        ]);
      } finally {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) =>
          child.once("close", () => resolve()),
        );
      }
      const [marked] = await admin.$queryRaw<
        { state: string; status: string; leaseUntil: Date }[]
      >`
      SELECT b.state,i.status,i."leaseUntil" FROM "ArtifactBlob" b JOIN "ArtifactExpiryItem" i ON i."blobId"=b.id
      WHERE b.id=${blob.id}::uuid AND i.class='BLOB'`;
      expect(marked).toMatchObject({ state: "ORPHAN", status: "CLAIMED" });
      const first = await runCli(
        "artifact-reconcile",
        ["--plan-id", plan.planId, "--hash", plan.hash],
        config,
      );
      expect(first.code, first.error).toBe(0);
      const outcome = JSON.parse(first.output).outcomes[0]?.status;
      if (phase === "before") {
        expect(outcome).toBe("inflight");
        // A dead process cannot surrender its live lease. Wait for the actual deadline.
        await delay(
          Math.max(0, marked!.leaseUntil.getTime() - Date.now()) + 250,
        );
        const retry = await runCli(
          "artifact-reconcile",
          ["--plan-id", plan.planId, "--hash", plan.hash],
          config,
        );
        expect(retry.code, retry.error).toBe(0);
        expect(JSON.parse(retry.output).outcomes[0]?.status).toBe("complete");
      } else {
        expect(outcome).toBe("complete");
      }
      const [completed] = await admin.$queryRaw<
        { state: string; proofs: bigint }[]
      >`
      SELECT b.state,(SELECT count(*) FROM "ArtifactExpiryEvent" e WHERE e."itemId"=i.id AND e."proofDigest" IS NOT NULL) AS proofs
      FROM "ArtifactBlob" b JOIN "ArtifactExpiryItem" i ON i."blobId"=b.id WHERE b.id=${blob.id}::uuid AND i.class='BLOB'`;
      expect(completed).toMatchObject({ state: "DELETED", proofs: 1n });
    },
    330000,
  );

  it("denies restricted direct table access and prevents two plans from claiming one live generation", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    await expect(
      maintenance.$queryRaw`SELECT secret FROM lyraseo_expiry.absence_verifier`,
    ).rejects.toThrow();
    await expect(
      runtime.$queryRaw`SELECT lyraseo_expiry.preview('{}'::jsonb,1,NULL)`,
    ).rejects.toThrow();
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const first = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const second = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    await expect(
      maintenance.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${first.planId}::uuid,
        (SELECT id FROM "ArtifactExpiryItem" LIMIT 1),${first.hash})`,
    ).rejects.toThrow();
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    const [claim] = await maintenance.$queryRaw<
      {
        result: { token: string; workerToken: string; signingPrefix: string };
      }[]
    >`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${second.planId}::uuid,${item!.id}::uuid,${second.hash}) AS result`;
    expect(claim?.result.token).toBeTruthy();
    const [stored] = await admin.$queryRaw<{ workerTokenHash: string }[]>`
      SELECT "workerTokenHash" FROM "ArtifactExpiryItem" WHERE id=${item!.id}::uuid`;
    expect(stored?.workerTokenHash).toBe(
      createHash("sha256").update(claim!.result.workerToken).digest("hex"),
    );
    expect(stored?.workerTokenHash).not.toBe(claim!.result.workerToken);
    expect(claim!.result.signingPrefix).not.toContain(
      claim!.result.workerToken,
    );
    expect(claim!.result.signingPrefix).not.toContain(stored!.workerTokenHash);
    const [visible] = await admin.$queryRaw<{ facts: unknown }[]>`
      SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(p)) FROM "ArtifactExpiryPlan" p),
        'events',(SELECT jsonb_agg(to_jsonb(e)) FROM "ArtifactExpiryEvent" e)) AS facts`;
    expect(JSON.stringify(visible?.facts)).not.toContain(
      claim!.result.workerToken,
    );
    expect(JSON.stringify(visible?.facts)).not.toContain(
      stored!.workerTokenHash,
    );
    expect(
      JSON.stringify(
        await privateArtifactExpiryStatus(maintenance, scope, second.planId),
      ),
    ).not.toContain(claim!.result.workerToken);
    await expect(
      maintenance.$executeRaw`SELECT lyraseo_expiry.record_pending(${claim!.result.token}::uuid,${randomUUID()}::uuid,'ABSENCE_UNCERTAIN')`,
    ).rejects.toThrow();
    await expect(
      recordPrivateArtifactExpiryPlan(
        maintenance,
        store,
        scope,
        preview.manifest,
        preview.hash,
      ),
    ).rejects.toThrow();
    await maintenance.$executeRaw`SELECT lyraseo_expiry.record_pending(${claim!.result.token}::uuid,${claim!.result.workerToken}::uuid,'ABSENCE_UNCERTAIN')`;
    const [retry] = await admin.$queryRaw<
      { nextRetryAt: Date }[]
    >`SELECT "nextRetryAt" FROM "ArtifactExpiryItem" WHERE id=${item!.id}::uuid`;
    const third = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    await expect(
      maintenance.$queryRaw`SELECT lyraseo_expiry.complete(${claim!.result.token}::uuid,'{}'::jsonb)`,
    ).rejects.toThrow();
    await expect(
      maintenance.$executeRaw`SELECT lyraseo_expiry.record_pending(${claim!.result.token}::uuid,${claim!.result.workerToken}::uuid,'ABSENCE_UNCERTAIN')`,
    ).rejects.toThrow();
    await delay(Math.max(0, retry!.nextRetryAt.getTime() - Date.now()) + 250);
    const applied = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      third.planId,
      third.hash,
      100,
      true,
    );
    expect(applied.outcomes.every((x) => x.status === "complete")).toBe(true);
    const [carrier] = await admin.$queryRaw<
      { carriers: bigint; attempts: bigint }[]
    >`SELECT count(*) AS carriers,max("attemptSequence") AS attempts FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    expect(carrier).toMatchObject({ carriers: 1n, attempts: 2n });
    const [cleared] = await admin.$queryRaw<
      { workerTokenHash: string | null }[]
    >`
      SELECT "workerTokenHash" FROM "ArtifactExpiryItem" WHERE id=${item!.id}::uuid`;
    expect(cleared?.workerTokenHash).toBeNull();
  }, 45000);

  it("reconciles a lost delete acknowledgement from a fresh signed absence witness", async () => {
    const { blob } = await readyAudit();
    const faulty = faultAfterMutation(store, "delete");
    expiry = await enrollTestExpiryAuthority(
      admin,
      faulty,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      faulty,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      faulty,
      scope,
      preview.manifest,
      preview.hash,
    );
    const uncertain = await applyPrivateArtifactExpiry(
      maintenance,
      faulty,
      scope,
      plan.planId,
      plan.hash,
    );
    expect(uncertain.outcomes).toEqual([
      { itemId: uncertain.outcomes[0]?.itemId, status: "pending" },
    ]);
    const [before] = await admin.$queryRaw<
      { state: string; proofs: bigint }[]
    >`SELECT b.state,(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs
      FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(before).toMatchObject({ state: "ORPHAN", proofs: 0n });
    const [retryAt] = await admin.$queryRaw<{ nextRetryAt: Date }[]>`
      SELECT "nextRetryAt" FROM "ArtifactExpiryItem" WHERE "blobId"=${blob.id}::uuid AND class='BLOB'`;
    await delay(Math.max(0, retryAt!.nextRetryAt.getTime() - Date.now()) + 250);
    const recovered = await applyPrivateArtifactExpiry(
      maintenance,
      faulty,
      scope,
      plan.planId,
      plan.hash,
      100,
      true,
    );
    expect(recovered.outcomes[0]?.status).toBe("complete");
    const [after] = await admin.$queryRaw<
      { state: string; attempts: bigint; proofs: bigint }[]
    >`SELECT b.state,i."attemptSequence" AS attempts,
      (SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs
      FROM "ArtifactBlob" b JOIN "ArtifactExpiryItem" i ON i."blobId"=b.id WHERE b.id=${blob.id}::uuid`;
    expect(after).toMatchObject({ state: "DELETED", attempts: 2n, proofs: 1n });
  }, 45000);

  it("final audit ticket waits for the target lock and rejects a just-orphaned source", async () => {
    const { target, blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (locked = resolve));
    const claimer = maintenance.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item!.id}::uuid,${plan.hash})`;
        locked();
        await held;
      },
      { timeout: 10000 },
    );
    await started;
    const ticket = withActor(runtime, actor, scope.workspaceId, async (tx) => {
      const [row] = await tx.$queryRaw<
        { ticket: unknown }[]
      >`SELECT lyraseo_audit.source_ticket(${scope.siteId},${target.auditId},${url},0) AS ticket`;
      return row?.ticket;
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let ticketWaiting = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const [state] = await admin.$queryRaw<
        { waiting: boolean }[]
      >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND
          usename='lyraseo_runtime' AND wait_event_type='Lock') AS waiting`;
      if (state?.waiting) {
        ticketWaiting = true;
        break;
      }
      await delay(20);
    }
    release();
    await claimer;
    expect(ticketWaiting).toBe(true);
    expect(await ticket).toEqual({ value: null });
  });

  it("skips a busy first target and rotates to due metadata in the next bounded batch", async () => {
    const first = await readyAudit();
    const second = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(
        Math.max(
          first.blob.expiresAt.getTime(),
          second.blob.expiresAt.getTime(),
        ) + 1,
      ),
    );
    await admin.$executeRaw`INSERT INTO "ArtifactBlob"("workspaceId","siteId","auditId","requestedUrl","pageId",fence,
      "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state,"pendingReceipt")
      SELECT "workspaceId","siteId","auditId",'https://example.com/metadata',gen_random_uuid(),fence,
        "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",'STAGED',
        '{"headers":{"content-type":"text/html"}}'::jsonb
      FROM "ArtifactBlob" WHERE id=${second.blob.id}::uuid`;
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    // Select a blob on the first audit and metadata on the second, so the
    // held target cannot also block the independent class we expect to advance.
    const manifest = preview.manifest.filter(
      (item) =>
        item.id === `BLOB:${first.blob.id}:${first.blob.generation}` ||
        item.class === "PENDING_RECEIPT",
    );
    expect(manifest.map((item) => item.class).sort()).toEqual([
      "BLOB",
      "PENDING_RECEIPT",
    ]);
    const [hashRow] = await admin.$queryRaw<{ hash: string }[]>`
      SELECT encode(sha256(convert_to(${JSON.stringify(manifest)}::jsonb::text,'UTF8')),'hex') AS hash`;
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      manifest,
      hashRow!.hash,
    );
    const head = { auditId: first.target.auditId };
    const [metadataTarget] = await admin.$queryRaw<{ auditId: string }[]>`
      SELECT b."auditId" FROM "ArtifactExpiryItem" i JOIN "ArtifactBlob" b ON b.id=i."blobId"
      WHERE i."currentPlanId"=${plan.planId}::uuid AND i.class='PENDING_RECEIPT'`;
    expect(metadataTarget?.auditId).toBe(second.target.auditId);
    expect(metadataTarget?.auditId).not.toBe(head.auditId);
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (locked = resolve));
    const blocker = admin.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AuditRun" WHERE id=${head!.auditId} FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 10000 },
    );
    await started;
    try {
      const busy = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
        1,
      );
      expect(busy.outcomes[0]?.status).toBe("blocked");
      const busyStatus = await privateArtifactExpiryStatus(
        maintenance,
        scope,
        plan.planId,
      );
      expect(busyStatus.selectedPlan).toMatchObject({ complete: 0, ready: 2 });
      expect(busyStatus.scopeResidual).toMatchObject({
        dueQualified: expect.any(Number),
      });
      expect(
        (busyStatus.scopeResidual as { dueQualified: number }).dueQualified,
      ).toBeGreaterThan(0);
      expect(
        (busyStatus.scopeResidual as { oldestUnresolved: string })
          .oldestUnresolved,
      ).toBeTruthy();
      const metadata = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
        1,
      );
      expect(metadata.outcomes[0]?.status).toBe("complete");
      const [receipt] = await admin.$queryRaw<
        { pending: boolean }[]
      >`SELECT "pendingReceipt" IS NOT NULL AS pending FROM "ArtifactBlob" WHERE "requestedUrl"='https://example.com/metadata'`;
      expect(receipt?.pending).toBe(false);
    } finally {
      release();
      await blocker;
    }
    const remainder = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
      100,
    );
    expect(remainder.outcomes.every((x) => x.status === "complete")).toBe(true);
    expect(
      (await privateArtifactExpiryStatus(maintenance, scope, plan.planId))
        .selectedPlan,
    ).toMatchObject({ complete: 2, ready: 0 });
  });

  it("rejects a different valid root, fabricated facade, and foreign scope", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const [key] = await admin.$queryRaw<{ secret: Uint8Array }[]>`
      SELECT secret FROM lyraseo_expiry.absence_verifier WHERE id=${expiry.keyId}::uuid`;
    const alternateRoot = await mkdtemp(
      join(await realpath(tmpdir()), "lyraseo-expiry-wrong-root-"),
    );
    const alternate = await localAuditArtifactStore(alternateRoot);
    const copied = { ...store };
    try {
      for (const candidate of [alternate, copied]) {
        bindLocalExpiryAuthority(candidate, {
          keyId: expiry.keyId,
          secret: key!.secret,
          scope,
          origin: expiry.origin,
        });
        await expect(
          previewPrivateArtifactExpiry(maintenance, candidate, scope),
        ).rejects.toThrow();
        unbindLocalExpiryAuthority(candidate);
      }
      await expect(maintenance.$queryRaw`SELECT lyraseo_expiry.preview(
        '{"workspaceId":"b","siteId":"b-site"}'::jsonb,100,NULL)`).rejects.toThrow();
      const [state] = await admin.$queryRaw<{ state: string; refs: bigint }[]>`
        SELECT b.state,(SELECT count(*) FROM "ArtifactRef" WHERE "blobId"=b.id) AS refs
        FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
      expect(state).toMatchObject({ state: "READY", refs: 1n });
    } finally {
      unbindLocalExpiryAuthority(alternate);
      unbindLocalExpiryAuthority(copied);
      await alternate.close();
      await rm(alternateRoot, { recursive: true, force: true });
    }
  });

  it("does not qualify withdrawal signed by an unenrolled expiry authority", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const fake = localArtifactFaultFacade(store, {});
    bindLocalExpiryAuthority(fake, {
      keyId: randomUUID(),
      secret: Buffer.alloc(32, 19),
      scope,
      origin: expiry.origin,
    });
    try {
      const outcome = await applyPrivateArtifactExpiry(
        maintenance,
        fake,
        scope,
        plan.planId,
        plan.hash,
      );
      expect(outcome.outcomes[0]?.status).toBe("pending");
      const [state] = await admin.$queryRaw<
        { state: string; proofs: bigint }[]
      >`
        SELECT b.state,(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs
        FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
      expect(state).toMatchObject({ state: "ORPHAN", proofs: 0n });
    } finally {
      unbindLocalExpiryAuthority(fake);
    }
  });

  it("serializes ref reattachment against expiry and forbids resurrection", async () => {
    const { blob } = await readyAudit();
    const [original] = await admin.$queryRaw<{ value: unknown }[]>`
      SELECT to_jsonb(r) AS value FROM "ArtifactRef" r WHERE r."blobId"=${blob.id}::uuid`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    let release!: () => void, claimed!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (claimed = resolve));
    const claim = maintenance.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item!.id}::uuid,${plan.hash})`;
        claimed();
        await held;
      },
      { timeout: 10000 },
    );
    await started;
    const insert =
      admin.$executeRaw`INSERT INTO "ArtifactRef" SELECT * FROM jsonb_populate_record(NULL::"ArtifactRef",${JSON.stringify(original!.value)}::jsonb)`.then(
        () => ({ ok: true }),
        (error) => ({ error }),
      );
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [row] = await admin.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT FROM pg_stat_activity
          WHERE datname=current_database() AND usename='postgres' AND wait_event_type='Lock') AS waiting`;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await delay(50);
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await claim;
    }
    expect(await insert).toHaveProperty("error");
    const failedInsert = await insert;
    expect("error" in failedInsert && String(failedInsert.error)).toContain(
      "INVALID_SOURCE_BINDING",
    );
    await expect(
      admin.$executeRaw`UPDATE "ArtifactBlob" SET state='READY' WHERE id=${blob.id}::uuid`,
    ).rejects.toThrow("IMMUTABLE_ARTIFACT_LIFECYCLE");
    const [state] = await admin.$queryRaw<{ state: string; refs: bigint }[]>`
      SELECT b.state,(SELECT count(*) FROM "ArtifactRef" WHERE "blobId"=b.id) AS refs FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(state).toMatchObject({ state: "ORPHAN", refs: 0n });
  });

  it("keeps old unqualified orphan recovery compatible while reconciling due DELETED proof", async () => {
    const run = await createAuditRun(runtime, actor, {
      ...scope,
      profile: "LOCAL_RAW_V1",
      idempotencyKey: randomUUID(),
      manifest: [url],
    });
    const target = { ...scope, auditId: run.id };
    const lease = await claimAuditRun(runtime, actor, target, "legacy-orphan");
    const receipt = await acquireRawPage(url, url, async (address) =>
      address.endsWith("robots.txt")
        ? new Response(null, { status: 404 })
        : new Response(raw, { headers: { "content-type": "text/html" } }),
    );
    const facade = localArtifactFaultFacade(store, {
      after: async (operation) => {
        if (operation === "put") await cancelAuditRun(runtime, actor, target);
      },
    });
    bindLocalArtifactStore(runtime, facade, source);
    await expect(
      checkpointPrivateAudit(runtime, actor, target, lease.fence, receipt),
    ).rejects.toThrow();
    const [orphan] = await admin.$queryRaw<
      { id: string; expiresAt: Date; state: string }[]
    >`SELECT id,"expiresAt",state FROM "ArtifactBlob" WHERE "auditId"=${target.auditId}`;
    expect(orphan?.state).toBe("ORPHAN");
    expect(
      await recoverAuditArtifactOrphans(
        admin,
        faultAfterMutation(store, "delete"),
        target.auditId,
      ),
    ).toBe(1);
    const [unqualified] = await admin.$queryRaw<
      { state: string; proofs: bigint }[]
    >`
      SELECT state,(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs FROM "ArtifactBlob" WHERE id=${orphan!.id}::uuid`;
    expect(unqualified).toMatchObject({ state: "DELETED", proofs: 0n });
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(orphan!.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(preview.manifest.some((item) => item.class === "BLOB")).toBe(true);
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
      100,
      true,
    );
    expect(result.outcomes[0]?.status).toBe("complete");
    const [qualified] = await admin.$queryRaw<
      { state: string; proofs: bigint }[]
    >`
      SELECT state,(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs FROM "ArtifactBlob" WHERE id=${orphan!.id}::uuid`;
    expect(qualified).toMatchObject({ state: "DELETED", proofs: 1n });
  });

  it("does not mistake a locked reference for an absent reference", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (locked = resolve));
    const blocker = admin.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ArtifactRef" WHERE "blobId"=${blob.id}::uuid FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 10000 },
    );
    await started;
    try {
      const blocked = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
      );
      expect(blocked.outcomes[0]?.status).toBe("blocked");
      const [state] = await admin.$queryRaw<{ state: string; refs: bigint }[]>`
        SELECT b.state,(SELECT count(*) FROM "ArtifactRef" WHERE "blobId"=b.id) AS refs
        FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
      expect(state).toMatchObject({ state: "READY", refs: 1n });
    } finally {
      release();
      await blocker;
    }
    const retried = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
    );
    expect(retried.outcomes[0]?.status).toBe("complete");
  });

  it("settles both selected items when a bound blob carries a due pending receipt", async () => {
    const { blob } = await readyAudit();
    await admin.$executeRaw`UPDATE "ArtifactBlob" SET "pendingReceipt"='{"headers":{"content-type":"text/html"}}'::jsonb WHERE id=${blob.id}::uuid`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(new Set(preview.manifest.map((item) => item.class))).toEqual(
      new Set(["BLOB", "PENDING_RECEIPT"]),
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
    );
    const status = await privateArtifactExpiryStatus(
      maintenance,
      scope,
      plan.planId,
    );
    expect(status.selectedPlan).toMatchObject({
      complete: 2,
      ready: 0,
      pending: 0,
      claimed: 0,
    });
  });

  it("co-completes a receipt selected by another plan and accepts its stale batch claim", async () => {
    const { blob } = await readyAudit();
    await admin.$executeRaw`UPDATE "ArtifactBlob" SET "pendingReceipt"='{"headers":{"content-type":"text/html"}}'::jsonb WHERE id=${blob.id}::uuid`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const recordClass = async (className: string) => {
      const manifest = preview.manifest.filter(
        (item) => item.class === className,
      );
      expect(manifest).toHaveLength(1);
      const [hash] = await admin.$queryRaw<{ value: string }[]>`
        SELECT encode(sha256(convert_to(${JSON.stringify(manifest)}::jsonb::text,'UTF8')),'hex') AS value`;
      return recordPrivateArtifactExpiryPlan(
        maintenance,
        store,
        scope,
        manifest,
        hash!.value,
      );
    };
    const blobPlan = await recordClass("BLOB");
    const receiptPlan = await recordClass("PENDING_RECEIPT");
    const [selected] = await maintenance.$queryRaw<
      { result: { items: { id: string }[] } }[]
    >`
      SELECT lyraseo_expiry.next_items(${JSON.stringify(scope)}::jsonb,${receiptPlan.planId}::uuid,${receiptPlan.hash},1,NULL::uuid) AS result`;
    const staleItem = selected!.result.items[0]!.id;
    const applied = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      blobPlan.planId,
      blobPlan.hash,
    );
    expect(applied.outcomes[0]?.status).toBe("complete");
    const [stale] = await maintenance.$queryRaw<
      { result: { status: string } }[]
    >`
      SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${receiptPlan.planId}::uuid,${staleItem}::uuid,${receiptPlan.hash}) AS result`;
    expect(stale?.result.status).toBe("COMPLETE");
    expect(
      (
        await privateArtifactExpiryStatus(
          maintenance,
          scope,
          receiptPlan.planId,
        )
      ).selectedPlan,
    ).toMatchObject({ complete: 1, ready: 0 });
    const [event] = await admin.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM "ArtifactExpiryEvent" WHERE "planId"=${receiptPlan.planId}::uuid
      AND "itemId"=${staleItem}::uuid AND outcome='COMPLETE' AND reason='TRANSIENT_REMOVED'`;
    expect(event?.count).toBe(1n);
  });

  it("drains a multi-batch pending receipt backlog without hiding unselected residuals", async () => {
    const { blob } = await readyAudit();
    await admin.$executeRaw`INSERT INTO "ArtifactBlob"("workspaceId","siteId","auditId","requestedUrl","pageId",fence,
      "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state,"pendingReceipt")
      SELECT "workspaceId","siteId","auditId",'https://example.com/backlog/'||n,gen_random_uuid(),fence,
        "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",'STAGED',
        '{"headers":{"content-type":"text/html"}}'::jsonb
      FROM "ArtifactBlob" CROSS JOIN generate_series(1,12) n WHERE id=${blob.id}::uuid`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(
      preview.manifest.filter((item) => item.class === "PENDING_RECEIPT"),
    ).toHaveLength(12);
    const firstHalf = preview.manifest
      .filter((item) => item.class === "PENDING_RECEIPT")
      .slice(0, 6);
    const [hash] = await admin.$queryRaw<{ value: string }[]>`
      SELECT encode(sha256(convert_to(${JSON.stringify(firstHalf)}::jsonb::text,'UTF8')),'hex') AS value`;
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      firstHalf,
      hash!.value,
    );
    const before = await privateArtifactExpiryStatus(
      maintenance,
      scope,
      plan.planId,
    );
    expect(before.scopeResidual).toMatchObject({ dueUnselected: 7 });
    for (let batch = 0; batch < 3; batch++) {
      const applied = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
        2,
      );
      expect(applied.outcomes).toHaveLength(2);
      expect(
        applied.outcomes.every((outcome) => outcome.status === "complete"),
      ).toBe(true);
    }
    const after = await privateArtifactExpiryStatus(
      maintenance,
      scope,
      plan.planId,
    );
    expect(after.selectedPlan).toMatchObject({ complete: 6 });
    expect(after.scopeResidual).toMatchObject({
      dueUnselected: 7,
      dueBlocked: 12,
    });
    const [remaining] = await admin.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM "ArtifactBlob" WHERE "pendingReceipt" IS NOT NULL`;
    expect(remaining?.count).toBe(6n);
  });

  it("reports a pending carrier from another plan in scope residuals", async () => {
    const first = await readyAudit(),
      second = await readyAudit();
    await admin.$executeRaw`INSERT INTO "ArtifactBlob"("workspaceId","siteId","auditId","requestedUrl","pageId",fence,
      "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state)
      SELECT "workspaceId","siteId","auditId",'https://example.com/status-unbound',gen_random_uuid(),fence,
        "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",'STAGED' FROM "ArtifactBlob" WHERE id=${first.blob.id}::uuid`;
    const faulty = faultAfterMutation(store, "delete");
    expiry = await enrollTestExpiryAuthority(
      admin,
      faulty,
      scope,
      new Date(
        Math.max(
          first.blob.expiresAt.getTime(),
          second.blob.expiresAt.getTime(),
        ) + 1,
      ),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      faulty,
      scope,
    );
    const recordBlob = async (id: string) => {
      const selected = preview.manifest.filter(
        (item) => item.class === "BLOB" && item.id.includes(id),
      );
      expect(selected).toHaveLength(1);
      const [hash] = await admin.$queryRaw<
        { value: string }[]
      >`SELECT encode(sha256(convert_to(${JSON.stringify(selected)}::jsonb::text,'UTF8')),'hex') AS value`;
      return recordPrivateArtifactExpiryPlan(
        maintenance,
        faulty,
        scope,
        selected,
        hash!.value,
      );
    };
    const pendingPlan = await recordBlob(first.blob.id),
      otherPlan = await recordBlob(second.blob.id);
    const pending = await applyPrivateArtifactExpiry(
      maintenance,
      faulty,
      scope,
      pendingPlan.planId,
      pendingPlan.hash,
    );
    expect(pending.outcomes[0]?.status).toBe("pending");
    const [event] = await admin.$queryRaw<{ reason: string }[]>`
      SELECT reason FROM "ArtifactExpiryEvent" WHERE "itemId"=${pending.outcomes[0]!.itemId}::uuid AND outcome='PENDING'`;
    expect(event?.reason).toBe("BACKEND_UNAVAILABLE");
    const status = await privateArtifactExpiryStatus(
      maintenance,
      scope,
      otherPlan.planId,
    );
    expect(status.scopeResidual).toMatchObject({
      duePending: 1,
      dueClaimed: 0,
      dueUnbound: 1,
      dueBlocked: 1,
      dueUnselected: 1,
    });
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE "currentPlanId"=${otherPlan.planId}::uuid`;
    await maintenance.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${otherPlan.planId}::uuid,${item!.id}::uuid,${otherPlan.hash})`;
    expect(
      (await privateArtifactExpiryStatus(maintenance, scope, otherPlan.planId))
        .scopeResidual,
    ).toMatchObject({ duePending: 1, dueClaimed: 1, dueUnbound: 1 });
  });

  it("rotates all four classes across limited batches while one failed blob retries", async () => {
    const first = await readyAudit();
    // A completed audit can have a historical scratch residual; the second is active.
    await admin.$executeRaw`INSERT INTO "AuditEvaluationScratch"("workspaceId","auditId","pageId","expiresAt",facts)
      SELECT "workspaceId","auditId","pageId","rawExpiresAt",'{}'::jsonb FROM "AuditPageRetention" WHERE "auditId"=${first.target.auditId}`;
    const second = await readyAudit([url, "https://example.com/other"]);
    for (const audit of [first, second]) {
      await admin.$executeRaw`INSERT INTO "ArtifactBlob"("workspaceId","siteId","auditId","requestedUrl","pageId",fence,
        "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state,"pendingReceipt")
        SELECT "workspaceId","siteId","auditId",'https://example.com/mixed/'||gen_random_uuid(),gen_random_uuid(),fence,
          "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",'STAGED',
          '{"headers":{"content-type":"text/html"}}'::jsonb FROM "ArtifactBlob" WHERE id=${audit.blob.id}::uuid`;
      const [noBody] = await admin.$queryRaw<
        { id: string }[]
      >`INSERT INTO "AuditRun"
        (id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion",status)
        VALUES(${randomUUID()},${scope.workspaceId},${scope.siteId},${actor.userId},0,${randomUUID()},'mixed-backlog',
           '["https://example.com/no-body"]'::jsonb,'CONTROLLED_RAW_TEST_V1','{}'::jsonb,'fixture','FAILED') RETURNING id`;
      const [work] = await admin.$queryRaw<
        { id: string }[]
      >`INSERT INTO "WorkDispatch"("workspaceId","siteId","userId","admittedSecurityVersion","auditId","targetKind",capability,profile,eligibility,"admittedAt","expiresAt",disposition,"nextAttemptAt")
        SELECT "workspaceId","siteId","userId","securityVersion",id,'AUDIT_RAW','audits',profile,'CONTROLLED_TEST',
          "createdAt" AT TIME ZONE 'UTC',("createdAt" AT TIME ZONE 'UTC')+interval '1 hour','PENDING',clock_timestamp() FROM "AuditRun" WHERE id=${noBody!.id} RETURNING id`;
      await admin.$executeRaw`INSERT INTO lyraseo_audit.unavailable_observation(work_id,generation,url,audit_id,fact_hash,expires_at,receipt)
        VALUES(${work!.id}::uuid,1,'https://example.com/no-body',${noBody!.id},${"c".repeat(64)},${audit.blob.expiresAt},'{"evidence":{},"provenance":{}}'::jsonb)`;
    }
    const faulty = faultAfterMutation(store, "delete");
    expiry = await enrollTestExpiryAuthority(
      admin,
      faulty,
      scope,
      new Date(
        Math.max(
          first.blob.expiresAt.getTime(),
          second.blob.expiresAt.getTime(),
        ) + 1,
      ),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      faulty,
      scope,
    );
    const selected = [
      "BLOB",
      "PENDING_RECEIPT",
      "SCRATCH",
      "UNAVAILABLE",
    ].flatMap((className) =>
      preview.manifest.filter((item) => item.class === className).slice(0, 2),
    );
    expect(selected).toHaveLength(8);
    for (const className of [
      "BLOB",
      "PENDING_RECEIPT",
      "SCRATCH",
      "UNAVAILABLE",
    ])
      expect(selected.filter((item) => item.class === className)).toHaveLength(
        2,
      );
    const [hash] = await admin.$queryRaw<
      { value: string }[]
    >`SELECT encode(sha256(convert_to(${JSON.stringify(selected)}::jsonb::text,'UTF8')),'hex') AS value`;
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      faulty,
      scope,
      selected,
      hash!.value,
    );
    const seen: string[] = [];
    for (let batch = 0; batch < 8; batch++) {
      const result = await applyPrivateArtifactExpiry(
        maintenance,
        faulty,
        scope,
        plan.planId,
        plan.hash,
        1,
      );
      expect(result.outcomes).toHaveLength(1);
      const [item] = await admin.$queryRaw<
        { class: string }[]
      >`SELECT class FROM "ArtifactExpiryItem" WHERE id=${result.outcomes[0]!.itemId}::uuid`;
      seen.push(item!.class);
      expect(["pending", "complete"]).toContain(result.outcomes[0]!.status);
    }
    for (const className of [
      "BLOB",
      "PENDING_RECEIPT",
      "SCRATCH",
      "UNAVAILABLE",
    ])
      expect(seen.filter((value) => value === className)).toHaveLength(2);
    const status = await privateArtifactExpiryStatus(
      maintenance,
      scope,
      plan.planId,
    );
    expect(status.selectedPlan).toMatchObject({ complete: 7, pending: 1 });
    expect(status.scopeResidual).toMatchObject({ dueBlocked: 2 });
    const [retry] = await admin.$queryRaw<
      { nextRetryAt: Date }[]
    >`SELECT "nextRetryAt" FROM "ArtifactExpiryItem" WHERE status='PENDING'`;
    await delay(Math.max(0, retry!.nextRetryAt.getTime() - Date.now()) + 250);
    const reconciled = await applyPrivateArtifactExpiry(
      maintenance,
      faulty,
      scope,
      plan.planId,
      plan.hash,
      1,
      true,
    );
    expect(reconciled.outcomes[0]?.status).toBe("complete");
    expect(
      (await privateArtifactExpiryStatus(maintenance, scope, plan.planId))
        .selectedPlan,
    ).toMatchObject({ complete: 8, pending: 0 });
  }, 60000);

  it("paginates beyond 100 candidates and enforces the immutable plan cap", async () => {
    const { blob } = await readyAudit();
    await admin.$executeRaw`INSERT INTO "ArtifactBlob"("workspaceId","siteId","auditId","requestedUrl","pageId",fence,
      "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state,"pendingReceipt")
      SELECT "workspaceId","siteId","auditId",'https://example.com/page-cap/'||n,gen_random_uuid(),fence,
        "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",'STAGED',
        '{"headers":{"content-type":"text/html"}}'::jsonb FROM "ArtifactBlob" CROSS JOIN generate_series(1,101) n WHERE id=${blob.id}::uuid`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    let cursor: string | null = null;
    const all: { class: string; id: string }[] = [];
    let pages = 0;
    do {
      const page = await previewPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        100,
        cursor,
      );
      expect(page.items.length).toBeLessThanOrEqual(100);
      all.push(...page.manifest);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(cursor).toBeNull();
    expect(pages).toBeGreaterThan(2);
    const pending = all.filter((item) => item.class === "PENDING_RECEIPT");
    expect(pending).toHaveLength(101);
    const makeHash = async (manifest: typeof pending) => {
      const [row] = await admin.$queryRaw<
        { value: string }[]
      >`SELECT encode(sha256(convert_to(${JSON.stringify(manifest)}::jsonb::text,'UTF8')),'hex') AS value`;
      return row!.value;
    };
    await expect(
      recordPrivateArtifactExpiryPlan(
        maintenance,
        store,
        scope,
        pending,
        await makeHash(pending),
      ),
    ).rejects.toThrow();
    const selected = pending.slice(0, 100),
      hash = await makeHash(selected);
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      selected,
      hash,
    );
    expect(plan.count).toBe(100);
    const [before] = await admin.$queryRaw<
      { manifest: unknown; manifestHash: string }[]
    >`SELECT manifest,"manifestHash" FROM "ArtifactExpiryPlan" WHERE id=${plan.planId}::uuid`;
    for (let batch = 0; batch < 5; batch++) {
      const result = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
        20,
      );
      expect(result.outcomes).toHaveLength(20);
      expect(result.outcomes.every((item) => item.status === "complete")).toBe(
        true,
      );
    }
    const [after] = await admin.$queryRaw<
      (typeof before)[]
    >`SELECT manifest,"manifestHash" FROM "ArtifactExpiryPlan" WHERE id=${plan.planId}::uuid`;
    expect(after).toEqual(before);
    const status = await privateArtifactExpiryStatus(
      maintenance,
      scope,
      plan.planId,
    );
    expect(status.selectedPlan).toMatchObject({ complete: 100 });
    expect(status.scopeResidual).toMatchObject({
      dueUnselected: 2,
      dueBlocked: 101,
    });
    expect(
      (status.scopeResidual as { oldestUnresolved: string }).oldestUnresolved,
    ).toBeTruthy();
  }, 60000);

  it("uses millisecond-exact source deadlines across classes and database timezones", async () => {
    const { target, blob } = await readyAudit([
      url,
      "https://example.com/pending",
    ]);
    await admin.$executeRaw`INSERT INTO "ArtifactBlob"("workspaceId","siteId","auditId","requestedUrl","pageId",fence,
      "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state,"pendingReceipt")
      SELECT "workspaceId","siteId","auditId",'https://example.com/clock-pending',gen_random_uuid(),fence,
        "capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",'STAGED',
        '{"headers":{"content-type":"text/html"}}'::jsonb FROM "ArtifactBlob" WHERE id=${blob.id}::uuid`;
    const [beforeClock] = await admin.$queryRaw<
      { value: unknown }[]
    >`SELECT jsonb_build_object('captured',"capturedAt",'expires',"expiresAt",'fact',"factHash") AS value FROM "ArtifactBlob" WHERE id=${blob.id}::uuid`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() - 1),
    );
    const at = async (offset: number, zone: string) => {
      await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${new Date(blob.expiresAt.getTime() + offset).toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
      return maintenance.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('TimeZone',${zone},true)`;
        const [row] = await tx.$queryRaw<
          { result: { items: { class: string }[] } }[]
        >`
          SELECT lyraseo_expiry.preview(${JSON.stringify(scope)}::jsonb,100,NULL) AS result`;
        return row!.result.items.map((item) => item.class).sort();
      });
    };
    expect(await at(-1, "Asia/Kolkata")).toEqual([]);
    const exact = await at(0, "Asia/Kolkata");
    expect(exact).toEqual(["BLOB", "BLOB", "PENDING_RECEIPT", "SCRATCH"]);
    expect(await at(1, "UTC")).toEqual(exact);
    const [afterClock] = await admin.$queryRaw<
      { value: unknown }[]
    >`SELECT jsonb_build_object('captured',"capturedAt",'expires',"expiresAt",'fact',"factHash") AS value FROM "ArtifactBlob" WHERE id=${blob.id}::uuid`;
    expect(afterClock).toEqual(beforeClock);
    await cancelAuditRun(runtime, actor, target);
    const [noBody] = await admin.$queryRaw<
      { id: string }[]
    >`INSERT INTO "AuditRun"
      (id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion")
      VALUES(${randomUUID()},${scope.workspaceId},${scope.siteId},${actor.userId},0,${randomUUID()},'clock-unavailable',
        '["https://example.com/no-body"]'::jsonb,'CONTROLLED_RAW_TEST_V1','{}'::jsonb,'fixture') RETURNING id`;
    const [work] = await admin.$queryRaw<
      { id: string }[]
    >`INSERT INTO "WorkDispatch"("workspaceId","siteId","userId","admittedSecurityVersion","auditId","targetKind",capability,profile,eligibility,"admittedAt","expiresAt",disposition,"nextAttemptAt")
      SELECT "workspaceId","siteId","userId","securityVersion",id,'AUDIT_RAW','audits',profile,'CONTROLLED_TEST',
      "createdAt" AT TIME ZONE 'UTC',("createdAt" AT TIME ZONE 'UTC')+interval '1 hour','PENDING',clock_timestamp() FROM "AuditRun" WHERE id=${noBody!.id} RETURNING id`;
    await admin.$executeRaw`INSERT INTO lyraseo_audit.unavailable_observation(work_id,generation,url,audit_id,fact_hash,expires_at,receipt)
      VALUES(${work!.id}::uuid,1,'https://example.com/no-body',${noBody!.id},${"d".repeat(64)},${blob.expiresAt},'{"evidence":{},"provenance":{}}'::jsonb)`;
    expect((await at(-1, "UTC")).includes("UNAVAILABLE")).toBe(false);
    expect((await at(0, "Asia/Kolkata")).includes("UNAVAILABLE")).toBe(true);
    expect((await at(1, "UTC")).includes("UNAVAILABLE")).toBe(true);
  });

  it("classifies before and at the persisted 30-day audit boundary without changing source clocks", async () => {
    const { blob } = await readyAudit();
    const [original] = await admin.$queryRaw<
      { capturedAt: Date; expiresAt: Date; factHash: string }[]
    >`SELECT "capturedAt","expiresAt","factHash" FROM "ArtifactBlob" WHERE id=${blob.id}::uuid`;
    expect(blob.expiresAt.getTime() - original!.capturedAt.getTime()).toBe(
      30 * 86400000,
    );
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() - 1),
    );
    const before = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(before.items.some((v) => v.class === "BLOB")).toBe(false);
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${blob.expiresAt.toISOString()}::timestamp
      WHERE workspace_id=${scope.workspaceId} AND site_id=${scope.siteId}`;
    const exact = await previewPrivateArtifactExpiry(maintenance, store, scope);
    expect(exact.manifest.some((v) => v.class === "BLOB")).toBe(true);
    const [unchanged] = await admin.$queryRaw<
      (typeof original)[]
    >`SELECT "capturedAt","expiresAt","factHash" FROM "ArtifactBlob" WHERE id=${blob.id}::uuid`;
    expect(unchanged).toEqual(original);
  });

  it("uses persisted shorter rights and 90-day visibility deadlines for exact generations", async () => {
    const draft = await createVisibilityPanel(
      runtime,
      actor,
      scope,
      [{ id: "p", text: "Tools?", label: "neutral" }],
      [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
    );
    const panel = await reviewVisibilityPanel(runtime, actor, scope, draft.id);
    const observedAt = new Date(Date.now() - 86400000).toISOString();
    const evidence = (rawRightsUntil?: string): ProviderEvidence => ({
      profile: "consumer-chatgpt",
      provider: "dataforseo",
      model: "fixture",
      modelVersion: "v1",
      retrievalMode: "standard",
      requestedLocale: { language: "en", market: "IN" },
      confirmedLocale: { language: "en", market: "IN" },
      synthetic: true,
      rawAnswerRights: true,
      observedAt,
      rawRightsUntil,
      slots: [
        {
          promptId: "p",
          state: "successful",
          body: "Alpha private answer",
          annotations: [],
          providerTaskId: "fixture-expiry-task",
          completedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        },
      ],
    });
    const zonedBlobCount = async (zone: string) =>
      maintenance.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('TimeZone',${zone},true)`;
        const [row] = await tx.$queryRaw<
          { result: { manifest: { class: string }[] } }[]
        >`
        SELECT lyraseo_expiry.preview(${JSON.stringify(scope)}::jsonb,100,NULL) AS result`;
        return row!.result.manifest.filter((item) => item.class === "BLOB")
          .length;
      });
    const shorter = new Date(Date.now() + 2 * 86400000).toISOString();
    await recordVisibilityEvidence(
      runtime,
      actor,
      scope,
      panel.id,
      evidence(shorter),
      {
        storageFormat: "OBSERVATION_PRIVATE_V1",
        sourceNamespace: "CONTROLLED_FIXTURE_V1",
        recordingKey: "expiry-short",
      },
    );
    await recordVisibilityEvidence(
      runtime,
      actor,
      scope,
      panel.id,
      evidence(),
      {
        storageFormat: "OBSERVATION_PRIVATE_V1",
        sourceNamespace: "CONTROLLED_FIXTURE_V1",
        recordingKey: "expiry-ninety",
      },
    );
    const rows = await admin.$queryRaw<
      { id: string; expiresAt: Date; capturedAt: Date }[]
    >`SELECT id,"expiresAt","capturedAt" FROM "ArtifactBlob" WHERE "ownerKind"='VISIBILITY_SLOT' ORDER BY "expiresAt"`;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.expiresAt.getTime()).toBe(Date.parse(shorter));
    expect(rows[1]!.expiresAt.getTime() - rows[1]!.capturedAt.getTime()).toBe(
      90 * 86400000,
    );
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(rows[0]!.expiresAt.getTime() - 1),
    );
    expect(
      (await previewPrivateArtifactExpiry(maintenance, store, scope)).manifest,
    ).toHaveLength(0);
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${rows[0]!.expiresAt.toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
    expect(await zonedBlobCount("Asia/Kolkata")).toBe(1);
    const shortPreview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(
      shortPreview.manifest.filter((v) => v.class === "BLOB"),
    ).toHaveLength(1);
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${new Date(rows[0]!.expiresAt.getTime() + 1).toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
    expect(
      (
        await previewPrivateArtifactExpiry(maintenance, store, scope)
      ).manifest.filter((v) => v.class === "BLOB"),
    ).toHaveLength(1);
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${rows[0]!.expiresAt.toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
    const shortPlan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      shortPreview.manifest,
      shortPreview.hash,
    );
    expect(
      (
        await applyPrivateArtifactExpiry(
          maintenance,
          store,
          scope,
          shortPlan.planId,
          shortPlan.hash,
        )
      ).outcomes[0]?.status,
    ).toBe("complete");
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${new Date(rows[1]!.expiresAt.getTime() - 1).toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
    expect(
      (
        await previewPrivateArtifactExpiry(maintenance, store, scope)
      ).manifest.filter((v) => v.class === "BLOB"),
    ).toHaveLength(0);
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${rows[1]!.expiresAt.toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
    expect(await zonedBlobCount("Asia/Kolkata")).toBe(1);
    const ninetyPreview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(
      ninetyPreview.manifest.filter((v) => v.class === "BLOB"),
    ).toHaveLength(1);
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${new Date(rows[1]!.expiresAt.getTime() + 1).toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
    expect(
      (
        await previewPrivateArtifactExpiry(maintenance, store, scope)
      ).manifest.filter((v) => v.class === "BLOB"),
    ).toHaveLength(1);
    await admin.$executeRaw`UPDATE lyraseo_expiry.environment SET fixture_eligibility_at=${rows[1]!.expiresAt.toISOString()}::timestamp WHERE workspace_id=${scope.workspaceId}`;
    const ninetyPlan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      ninetyPreview.manifest,
      ninetyPreview.hash,
    );
    expect(
      (
        await applyPrivateArtifactExpiry(
          maintenance,
          store,
          scope,
          ninetyPlan.planId,
          ninetyPlan.hash,
        )
      ).outcomes[0]?.status,
    ).toBe("complete");
  });

  it("cleans future-dated residuals only for actual completed and failed audits", async () => {
    const completed = await readyAudit();
    const failed = await readyAudit([url, "https://example.com/not-yet"]);
    await cancelAuditRun(runtime, actor, failed.target);
    const ids = [completed.target.auditId, failed.target.auditId];
    const statuses = await admin.$queryRaw<
      { status: string }[]
    >`SELECT status FROM "AuditRun" WHERE id IN (${ids[0]},${ids[1]}) ORDER BY status`;
    expect(statuses.map((row) => row.status)).toEqual(["COMPLETED", "FAILED"]);
    for (const auditId of ids) {
      // Explicit disposable residuals, inserted after the real terminal trigger has run.
      await admin.$executeRaw`INSERT INTO "AuditEvaluationScratch"("workspaceId","auditId","pageId","expiresAt",facts)
        SELECT "workspaceId","auditId","pageId","rawExpiresAt",'{}'::jsonb FROM "AuditPageRetention" WHERE "auditId"=${auditId}`;
      const [controlled] = await admin.$queryRaw<
        { id: string }[]
      >`INSERT INTO "AuditRun"
        (id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion")
        VALUES(${randomUUID()},${scope.workspaceId},${scope.siteId},${actor.userId},0,${randomUUID()},'terminal-residual',
          '["https://example.com/terminal-residual"]'::jsonb,'CONTROLLED_RAW_TEST_V1','{}'::jsonb,'fixture') RETURNING id`;
      const [work] = await admin.$queryRaw<
        { id: string }[]
      >`INSERT INTO "WorkDispatch"("workspaceId","siteId","userId","admittedSecurityVersion","auditId","targetKind",capability,profile,eligibility,"admittedAt","expiresAt",disposition,"nextAttemptAt")
        SELECT "workspaceId","siteId","userId","securityVersion",id,'AUDIT_RAW','audits',profile,'CONTROLLED_TEST',
          "createdAt" AT TIME ZONE 'UTC',("createdAt" AT TIME ZONE 'UTC')+interval '1 hour','PENDING',clock_timestamp() FROM "AuditRun" WHERE id=${controlled!.id} RETURNING id`;
      const terminalStatus = auditId === ids[0] ? "COMPLETED" : "FAILED";
      await admin.$executeRaw`UPDATE "AuditRun" SET status=${terminalStatus} WHERE id=${controlled!.id}`;
      await admin.$executeRaw`INSERT INTO lyraseo_audit.unavailable_observation(work_id,generation,url,audit_id,fact_hash,expires_at,receipt)
        VALUES(${work!.id}::uuid,1,'https://example.com/terminal-residual',${controlled!.id},${"b".repeat(64)},${completed.blob.expiresAt},'{"evidence":{},"provenance":{}}'::jsonb)`;
    }
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(
        Math.min(
          completed.blob.expiresAt.getTime(),
          failed.blob.expiresAt.getTime(),
        ) - 1,
      ),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(
      preview.items.filter(
        (item) => item.reason === "TERMINAL" && item.class === "SCRATCH",
      ),
    ).toHaveLength(2);
    expect(
      preview.items.filter(
        (item) => item.reason === "TERMINAL" && item.class === "UNAVAILABLE",
      ),
    ).toHaveLength(2);
    expect(preview.manifest.some((item) => item.class === "BLOB")).toBe(false);
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
      2,
    );
    expect(result.outcomes.every((item) => item.status === "complete")).toBe(
      true,
    );
    const next = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
      2,
    );
    expect(next.outcomes.every((item) => item.status === "complete")).toBe(
      true,
    );
    const [remaining] = await admin.$queryRaw<
      { scratch: bigint; unavailable: bigint }[]
    >`
      SELECT (SELECT count(*) FROM "AuditEvaluationScratch") AS scratch,(SELECT count(*) FROM lyraseo_audit.unavailable_observation) AS unavailable`;
    expect(remaining).toMatchObject({ scratch: 0n, unavailable: 0n });
  });

  it("removes due audit scratch and unavailable receipts through their exact audit generation", async () => {
    const { target, blob } = await readyAudit();
    const [page] = await admin.$queryRaw<
      {
        workspaceId: string;
        auditId: string;
        pageId: string;
        rawExpiresAt: Date;
      }[]
    >`SELECT "workspaceId","auditId","pageId","rawExpiresAt" FROM "AuditPageRetention" WHERE "auditId"=${target.auditId}`;
    expect(page).toBeTruthy();
    await admin.$executeRaw`INSERT INTO "AuditEvaluationScratch"("workspaceId","auditId","pageId","expiresAt",facts)
      VALUES(${page!.workspaceId},${page!.auditId},${page!.pageId},${page!.rawExpiresAt},'{}'::jsonb)`;
    const [noBody] = await admin.$queryRaw<
      { id: string }[]
    >`INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion")
       VALUES(${randomUUID()},${scope.workspaceId},${scope.siteId},${actor.userId},0,${randomUUID()},'synthetic-expiry',
         '["https://example.com/no-body"]'::jsonb,'CONTROLLED_RAW_TEST_V1','{}'::jsonb,'fixture') RETURNING id`;
    const [work] = await admin.$queryRaw<
      { id: string }[]
    >`INSERT INTO "WorkDispatch"("workspaceId","siteId","userId","admittedSecurityVersion","auditId","targetKind",capability,profile,eligibility,"admittedAt","expiresAt",disposition,"nextAttemptAt")
       SELECT "workspaceId","siteId","userId","securityVersion",id,'AUDIT_RAW','audits',profile,'CONTROLLED_TEST',
         "createdAt" AT TIME ZONE 'UTC',("createdAt" AT TIME ZONE 'UTC')+interval '1 hour','PENDING',clock_timestamp() FROM "AuditRun" WHERE id=${noBody.id}
       RETURNING id`;
    await admin.$executeRaw`INSERT INTO lyraseo_audit.unavailable_observation
      (work_id,generation,url,audit_id,fact_hash,expires_at,receipt)
      VALUES(${work!.id}::uuid,1,'https://example.com/no-body',${noBody.id},${"a".repeat(64)},
        ${blob.expiresAt},'{"evidence":{},"provenance":{}}'::jsonb)`;
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(new Set(preview.manifest.map((v) => v.class))).toEqual(
      new Set(["BLOB", "SCRATCH", "UNAVAILABLE"]),
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const applied = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
    );
    expect(applied.outcomes.every((x) => x.status === "complete")).toBe(true);
    const [remaining] = await admin.$queryRaw<
      { scratch: bigint; unavailable: bigint }[]
    >`SELECT (SELECT count(*) FROM "AuditEvaluationScratch" WHERE "auditId"=${target.auditId}) AS scratch,
        (SELECT count(*) FROM lyraseo_audit.unavailable_observation WHERE audit_id=${noBody.id}) AS unavailable`;
    expect(remaining).toMatchObject({ scratch: 0n, unavailable: 0n });
  });

  it("expires persisted scratch while its audit is still active", async () => {
    const { target, blob } = await readyAudit([
      url,
      "https://example.com/about",
    ]);
    const [before] = await admin.$queryRaw<
      { status: string; scratch: bigint }[]
    >`SELECT a.status,(SELECT count(*) FROM "AuditEvaluationScratch" s WHERE s."auditId"=a.id) AS scratch
       FROM "AuditRun" a WHERE a.id=${target.auditId}`;
    expect(["QUEUED", "RUNNING"]).toContain(before?.status);
    expect(before?.scratch).toBe(1n);
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    expect(preview.manifest.some((v) => v.class === "SCRATCH")).toBe(true);
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const applied = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
    );
    expect(applied.outcomes.every((x) => x.status === "complete")).toBe(true);
    const [after] = await admin.$queryRaw<
      { status: string; scratch: bigint }[]
    >`SELECT a.status,(SELECT count(*) FROM "AuditEvaluationScratch" s WHERE s."auditId"=a.id) AS scratch
       FROM "AuditRun" a WHERE a.id=${target.auditId}`;
    expect(after).toMatchObject({ status: before!.status, scratch: 0n });
  });

  it("keeps a live worker lease when a separate reconciler sees present bytes", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [key] = await admin.$queryRaw<{ secret: Uint8Array }[]>`
      SELECT secret FROM lyraseo_expiry.absence_verifier WHERE id=${expiry.keyId}::uuid`;
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (reached = resolve));
    const facade = localArtifactFaultFacade(store, {
      before: async (operation) => {
        if (operation === "delete") {
          reached();
          await held;
        }
      },
    });
    bindLocalExpiryAuthority(facade, {
      keyId: expiry.keyId,
      secret: key!.secret,
      scope,
      origin: expiry.origin,
    });
    const worker = applyPrivateArtifactExpiry(
      maintenance,
      facade,
      scope,
      plan.planId,
      plan.hash,
    );
    try {
      await Promise.race([
        started,
        delay(10000).then(() => {
          throw Error("DELETE_PAUSE_TIMEOUT");
        }),
      ]);
      const [before] = await admin.$queryRaw<
        {
          id: string;
          token: string;
          leaseUntil: Date;
          currentPlanId: string;
          status: string;
        }[]
      >`
        SELECT id,token,"leaseUntil","currentPlanId",status FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
      expect(before?.status).toBe("CLAIMED");
      const config = {
        databaseUrl: maintenanceUrl,
        root,
        ...scope,
        keyId: expiry.keyId,
        secretHex: Buffer.from(key!.secret).toString("hex"),
        origin: expiry.origin,
      };
      const reconcile = await runCli(
        "artifact-reconcile",
        ["--plan-id", plan.planId, "--hash", plan.hash],
        config,
      );
      expect(reconcile.code, reconcile.error).toBe(0);
      expect(JSON.parse(reconcile.output).outcomes[0]?.status).toBe("inflight");
      const [inspection] = await maintenance.$queryRaw<
        {
          result: { token: string; workerToken?: string; inspectOnly: boolean };
        }[]
      >`
        SELECT lyraseo_expiry.reconcile_claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${before!.id}::uuid,${plan.hash}) AS result`;
      expect(inspection?.result).toMatchObject({
        token: before!.token,
        inspectOnly: true,
      });
      expect(inspection?.result.workerToken).toBeUndefined();
      expect(JSON.stringify(inspection)).not.toContain("workerTokenHash");
      expect(
        JSON.stringify(
          await privateArtifactExpiryStatus(maintenance, scope, plan.planId),
        ),
      ).not.toContain("workerToken");
      expect(reconcile.output).not.toContain("workerToken");
      const brokenInspector = localArtifactFaultFacade(store, {
        before: (operation) => {
          if (operation === "absence") throw Error("INSPECTION_UNAVAILABLE");
        },
      });
      bindLocalExpiryAuthority(brokenInspector, {
        keyId: expiry.keyId,
        secret: key!.secret,
        scope,
        origin: expiry.origin,
      });
      try {
        const uncertain = await applyPrivateArtifactExpiry(
          maintenance,
          brokenInspector,
          scope,
          plan.planId,
          plan.hash,
          100,
          true,
        );
        expect(uncertain.outcomes[0]?.status).toBe("inflight");
      } finally {
        unbindLocalExpiryAuthority(brokenInspector);
      }
      await expect(
        maintenance.$executeRaw`SELECT lyraseo_expiry.record_pending(${before!.token}::uuid,${randomUUID()}::uuid,'ABSENCE_UNCERTAIN')`,
      ).rejects.toThrow();
      await expect(
        maintenance.$executeRaw`SELECT lyraseo_expiry.record_pending(${before!.token}::uuid,NULL::uuid,'ABSENCE_UNCERTAIN')`,
      ).rejects.toThrow();
      const [after] = await admin.$queryRaw<(typeof before)[]>`
        SELECT id,token,"leaseUntil","currentPlanId",status FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
      expect(after).toEqual(before);
      await expect(
        recordPrivateArtifactExpiryPlan(
          maintenance,
          store,
          scope,
          preview.manifest,
          preview.hash,
        ),
      ).rejects.toThrow();
      await expect(
        maintenance.$queryRaw`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${before!.id}::uuid,${plan.hash})`,
      ).rejects.toThrow();
    } finally {
      release();
      await worker;
      unbindLocalExpiryAuthority(facade);
    }
    const result = await worker;
    expect(result.outcomes[0]?.status).toBe("complete");
  });

  it("fences a late delete acknowledgement after a real expired-lease takeover", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [key] = await admin.$queryRaw<{ secret: Uint8Array }[]>`
      SELECT secret FROM lyraseo_expiry.absence_verifier WHERE id=${expiry.keyId}::uuid`;
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (reached = resolve));
    const facade = localArtifactFaultFacade(store, {
      after: async (operation) => {
        if (operation === "delete") {
          reached();
          await held;
        }
      },
    });
    bindLocalExpiryAuthority(facade, {
      keyId: expiry.keyId,
      secret: key!.secret,
      scope,
      origin: expiry.origin,
    });
    const oldApply = applyPrivateArtifactExpiry(
      maintenance,
      facade,
      scope,
      plan.planId,
      plan.hash,
    );
    try {
      await Promise.race([
        started,
        delay(10000).then(() => {
          throw Error("DELETE_ACK_TIMEOUT");
        }),
      ]);
      const [old] = await admin.$queryRaw<
        {
          id: string;
          token: string;
          leaseUntil: Date;
          attemptSequence: bigint;
        }[]
      >`
        SELECT id,token,"leaseUntil","attemptSequence" FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
      expect(old?.attemptSequence).toBe(1n);
      // Wait for PostgreSQL's actual five-minute lease. Do not alter any clock or lease.
      await delay(Math.max(0, old!.leaseUntil.getTime() - Date.now()) + 250);
      const [newClaim] = await maintenance.$queryRaw<
        {
          result: { token: string; sequence: number; reconcileFirst: boolean };
        }[]
      >`
        SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${old!.id}::uuid,${plan.hash}) AS result`;
      expect(newClaim?.result.token).not.toBe(old!.token);
      expect(Number(newClaim?.result.sequence)).toBe(2);
      expect(newClaim?.result.reconcileFirst).toBe(true);
      release();
      const late = await oldApply;
      expect(late.outcomes[0]?.status).toBe("blocked");
      const [before] = await admin.$queryRaw<
        { state: string; proofs: bigint; token: string }[]
      >`
        SELECT b.state,i.token,(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs
        FROM "ArtifactBlob" b JOIN "ArtifactExpiryItem" i ON i."blobId"=b.id WHERE b.id=${blob.id}::uuid AND i.class='BLOB'`;
      expect(before).toMatchObject({
        state: "ORPHAN",
        proofs: 0n,
        token: newClaim!.result.token,
      });
      const recovered = await applyPrivateArtifactExpiry(
        maintenance,
        store,
        scope,
        plan.planId,
        plan.hash,
        100,
        true,
      );
      expect(recovered.outcomes[0]?.status).toBe("complete");
      const [after] = await admin.$queryRaw<
        { state: string; proofs: bigint; attemptSequence: bigint }[]
      >`
        SELECT b.state,i."attemptSequence",(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs
        FROM "ArtifactBlob" b JOIN "ArtifactExpiryItem" i ON i."blobId"=b.id WHERE b.id=${blob.id}::uuid AND i.class='BLOB'`;
      expect(after).toMatchObject({
        state: "DELETED",
        proofs: 1n,
        attemptSequence: 2n,
      });
    } finally {
      release();
      await oldApply.catch(() => undefined);
      unbindLocalExpiryAuthority(facade);
    }
  }, 330000);

  it("rejects altered proof authority and attempt fields after a real absence inspection", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    const [row] = await maintenance.$queryRaw<
      {
        result: {
          token: string;
          planId: string;
          itemId: string;
          sequence: number;
          signingPrefix: string;
          version: ArtifactVersion;
        };
      }[]
    >`
      SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item!.id}::uuid,${plan.hash}) AS result`;
    const claim = row!.result;
    await store.deleteExactVersion(claim.version);
    const absence = await inspectLocalArtifactAbsence(store, claim.version);
    expect(absence).toBe("marker");
    const [key] = await admin.$queryRaw<{ secret: Uint8Array }[]>`
      SELECT secret FROM lyraseo_expiry.absence_verifier WHERE id=${expiry.keyId}::uuid`;
    const inspectedAt = new Date().toISOString();
    const mac = (prefix: string) =>
      createHmac("sha256", key!.secret)
        .update(prefix + "\n" + inspectedAt + "\n" + absence)
        .digest("hex");
    const valid = {
      keyId: expiry.keyId,
      itemId: claim.itemId,
      planId: claim.planId,
      token: claim.token,
      sequence: String(claim.sequence),
      inspectedAt,
      absence,
      mac: mac(claim.signingPrefix),
    };
    for (const forged of [
      { ...valid, keyId: randomUUID() },
      { ...valid, itemId: randomUUID() },
      { ...valid, planId: randomUUID() },
      { ...valid, token: randomUUID() },
      { ...valid, sequence: String(Number(claim.sequence) + 1) },
      { ...valid, mac: mac(claim.signingPrefix + "\nwrong-generation") },
      { ...valid, mac: "0".repeat(64) },
      { ...valid, absence: "missing" },
    ]) {
      await expect(
        maintenance.$queryRaw`SELECT lyraseo_expiry.complete(${claim.token}::uuid,${JSON.stringify(forged)}::jsonb)`,
      ).rejects.toThrow();
    }
    await expect(
      maintenance.$queryRaw`SELECT lyraseo_expiry.complete(${randomUUID()}::uuid,${JSON.stringify(valid)}::jsonb)`,
    ).rejects.toThrow();
    const [before] = await admin.$queryRaw<{ state: string; proofs: bigint }[]>`
      SELECT b.state,(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs
      FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(before).toMatchObject({ state: "ORPHAN", proofs: 0n });
    await maintenance.$queryRaw`SELECT lyraseo_expiry.complete(${claim.token}::uuid,${JSON.stringify(valid)}::jsonb)`;
    const [after] = await admin.$queryRaw<{ state: string; proofs: bigint }[]>`
      SELECT b.state,(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proofs
      FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(after).toMatchObject({ state: "DELETED", proofs: 1n });
  });

  it("rejects a stale or mismatched signed proof before qualified completion", async () => {
    const { blob } = await readyAudit();
    expiry = await enrollTestExpiryAuthority(
      admin,
      store,
      scope,
      new Date(blob.expiresAt.getTime() + 1),
    );
    const preview = await previewPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
    );
    const plan = await recordPrivateArtifactExpiryPlan(
      maintenance,
      store,
      scope,
      preview.manifest,
      preview.hash,
    );
    const [item] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ArtifactExpiryItem" WHERE class='BLOB'`;
    const [row] = await maintenance.$queryRaw<
      {
        result: {
          token: string;
          workerToken: string;
          planId: string;
          itemId: string;
          sequence: number;
          signingPrefix: string;
        };
      }[]
    >`SELECT lyraseo_expiry.claim(${JSON.stringify(scope)}::jsonb,${plan.planId}::uuid,${item!.id}::uuid,${plan.hash}) AS result`;
    const claim = row!.result;
    const [key] = await admin.$queryRaw<
      { secret: Uint8Array }[]
    >`SELECT secret FROM lyraseo_expiry.absence_verifier WHERE id=${expiry.keyId}::uuid`;
    const proof = (inspectedAt: string, prefix = claim.signingPrefix) => ({
      keyId: expiry.keyId,
      itemId: claim.itemId,
      planId: claim.planId,
      token: claim.token,
      sequence: String(claim.sequence),
      inspectedAt,
      absence: "marker",
      mac: createHmac("sha256", key!.secret)
        .update(prefix + "\n" + inspectedAt + "\nmarker")
        .digest("hex"),
    });
    const stale = proof(new Date(Date.now() - 3 * 60000).toISOString());
    await expect(
      maintenance.$queryRaw`SELECT lyraseo_expiry.complete(${claim.token}::uuid,${JSON.stringify(stale)}::jsonb)`,
    ).rejects.toThrow();
    const wrongGeneration = proof(
      new Date().toISOString(),
      claim.signingPrefix + "\nwrong-generation",
    );
    await expect(
      maintenance.$queryRaw`SELECT lyraseo_expiry.complete(${claim.token}::uuid,${JSON.stringify(wrongGeneration)}::jsonb)`,
    ).rejects.toThrow();
    const [state] = await admin.$queryRaw<
      { state: string; proof_count: bigint }[]
    >`SELECT b.state,(SELECT count(*) FROM "ArtifactExpiryEvent" WHERE "proofDigest" IS NOT NULL) AS proof_count
       FROM "ArtifactBlob" b WHERE b.id=${blob.id}::uuid`;
    expect(state).toMatchObject({ state: "ORPHAN", proof_count: 0n });
    await maintenance.$executeRaw`SELECT lyraseo_expiry.record_pending(${claim.token}::uuid,${claim.workerToken}::uuid,'ABSENCE_UNCERTAIN')`;
    const [retryAt] = await admin.$queryRaw<{ nextRetryAt: Date }[]>`
      SELECT "nextRetryAt" FROM "ArtifactExpiryItem" WHERE id=${item!.id}::uuid`;
    await delay(Math.max(0, retryAt!.nextRetryAt.getTime() - Date.now()) + 250);
    const recovered = await applyPrivateArtifactExpiry(
      maintenance,
      store,
      scope,
      plan.planId,
      plan.hash,
      100,
      true,
    );
    expect(recovered.outcomes[0]?.status).toBe("complete");
  }, 45000);
});
