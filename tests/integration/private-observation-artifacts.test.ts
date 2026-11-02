import { beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../packages/db/src";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  recordVisibilityEvidence,
  readVisibility,
  type ProviderEvidence,
} from "../../packages/db/src/visibility";
import {
  readObservationAnswer as readWithCurrentActor,
  retireObservationAnswers,
} from "../../packages/db/src/observation-artifacts";
import { bindLocalArtifactStore } from "../../packages/db/src/artifact-checkpoint";
import {
  localAuditArtifactStore,
  type AuditArtifactStore,
} from "../../packages/db/src/artifact-store";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" };
let root: string,
  store: AuditArtifactStore,
  authority: Awaited<ReturnType<typeof enrollTestArtifactAuthority>>;
// Trusted controlled fixture identity; production route passes fresh resolveActor instead.
const readObservationAnswer = (
  db_: Parameters<typeof readWithCurrentActor>[0],
  actor_: Parameters<typeof readWithCurrentActor>[1],
  scope_: Parameters<typeof readWithCurrentActor>[2],
  runId: string,
  promptId: string,
) =>
  readWithCurrentActor(
    db_,
    actor_,
    scope_,
    runId,
    promptId,
    async () => actor_ as typeof actor,
  );
const recording = {
  storageFormat: "OBSERVATION_PRIVATE_V1" as const,
  sourceNamespace: "CONTROLLED_FIXTURE_V1" as const,
  recordingKey: "fixture-observation-1",
};
const sentinel = "ANSWER_PRIVATE_SENTINEL_883b";
function evidence(): ProviderEvidence {
  return {
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
        body: "Alpha " + sentinel,
        annotations: [{ url: "https://alpha.com/citation", start: 0, end: 5 }],
        providerTaskId: "fixture-task",
        completedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
    ],
  };
}
async function panel() {
  const p = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  return reviewVisibilityPanel(db, actor, scope, p.id);
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  root = await mkdtemp(join(await realpath(tmpdir()), "lyraseo-observation-"));
  store = await localAuditArtifactStore(root);
  authority = await enrollTestArtifactAuthority(admin);
  bindLocalArtifactStore(db, store, authority);
});
afterEach(async () => {
  await authority?.revoke();
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
afterAll(() => Promise.all([db.$disconnect(), admin.$disconnect()]));
it("atomically stores one private normalized answer, compact metrics, exact P1 clocks and immutable idempotent replay", async () => {
  const p = await panel(),
    e = evidence(),
    run = await recordVisibilityEvidence(db, actor, scope, p.id, e, recording);
  const saved = await admin.visibilityRun.findUniqueOrThrow({
      where: { id: run.id },
    }),
    blobs = await admin.artifactBlob.findMany(),
    refs = await admin.artifactRef.findMany();
  expect(saved.storageFormat).toBe("OBSERVATION_PRIVATE_V1");
  expect(saved.rawAnswers).toBeNull();
  expect(blobs).toHaveLength(1);
  expect(refs).toHaveLength(1);
  expect(blobs[0]!.auditId).toBeNull();
  expect(refs[0]!.ownerKind).toBe("VISIBILITY_SLOT");
  expect(JSON.stringify(saved)).not.toContain(sentinel);
  expect(JSON.stringify(saved)).not.toContain("annotations");
  expect(+saved.createdAt).toBe(Date.parse(e.observedAt));
  expect(+saved.rawExpiresAt).toBe(Date.parse(e.observedAt) + 90 * 86400000);
  const detail = await readVisibility(db, actor, scope, run.id);
  expect(detail.runs[0]!.rawAnswers).toBeNull();
  expect(detail.runs[0]!.summary!.brands.a!.mention.rate).toBe(1);
  expect(detail.runs[0]).toHaveProperty(
    "rawAvailability.0.state",
    "retained-parsed",
  );
  const read = await readObservationAnswer(db, actor, scope, run.id, "p");
  expect(JSON.stringify(read.answer)).toContain(sentinel);
  expect(JSON.stringify(read)).not.toContain("storageKey");
  bindLocalArtifactStore(
    db,
    {
      ...store,
      putImmutable: async () => {
        throw Error("unexpected-reacquisition");
      },
    },
    authority,
  );
  expect(
    await recordVisibilityEvidence(db, actor, scope, p.id, e, recording),
  ).toEqual({ id: run.id, storageFormat: "OBSERVATION_PRIVATE_V1" });
  await expect(
    recordVisibilityEvidence(
      db,
      actor,
      scope,
      p.id,
      {
        ...e,
        observedAt: new Date(Date.parse(e.observedAt) + 1).toISOString(),
      },
      recording,
    ),
  ).rejects.toThrow("IMMUTABLE_OBSERVATION");
  await expect(
    admin.visibilityRun.update({
      where: { id: run.id },
      data: { rawAnswers: [sentinel] },
    }),
  ).rejects.toThrow();
  expect(await admin.visibilityRun.count()).toBe(1);
});
it("does not publish any run or refs after injected storage failure; exact retry keeps logical/physical clocks", async () => {
  const p = await panel(),
    e = evidence();
  bindLocalArtifactStore(
    db,
    {
      ...store,
      putImmutable: async () => {
        throw Error();
      },
    },
    authority,
  );
  await expect(
    recordVisibilityEvidence(db, actor, scope, p.id, e, recording),
  ).rejects.toThrow("ARTIFACT_UNAVAILABLE");
  const first = await admin.artifactBlob.findFirstOrThrow();
  expect(await admin.visibilityRun.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
  bindLocalArtifactStore(db, store, authority);
  await recordVisibilityEvidence(db, actor, scope, p.id, e, recording);
  const second = await admin.artifactBlob.findFirstOrThrow();
  expect([
    second.id,
    second.generation,
    +second.capturedAt,
    +second.expiresAt,
  ]).toEqual([first.id, first.generation, +first.capturedAt, +first.expiresAt]);
});
it("keeps no-body identity immutable and maps failure text without leaking raw sentinels", async () => {
  const p = await panel(),
    e = evidence();
  e.slots = [
    {
      ...e.slots[0]!,
      state: "failed",
      body: undefined,
      annotations: [],
      failureReason: sentinel,
    },
  ];
  const run = await recordVisibilityEvidence(
    db,
    actor,
    scope,
    p.id,
    e,
    recording,
  );
  expect(await admin.artifactBlob.count()).toBe(0);
  const slot = await admin.visibilityObservationSlot.findFirstOrThrow();
  expect(slot.disposition).toBe("NO_BODY");
  expect(JSON.stringify(await admin.visibilityRun.findMany())).not.toContain(
    sentinel,
  );
  expect(
    (await readObservationAnswer(db, actor, scope, run.id, "p")).availability
      .reason,
  ).toBe("NO_BODY");
  await expect(
    recordVisibilityEvidence(
      db,
      actor,
      scope,
      p.id,
      {
        ...e,
        slots: [{ ...e.slots[0]!, state: "successful", body: "Changed body" }],
      },
      recording,
    ),
  ).rejects.toThrow("IMMUTABLE_OBSERVATION");
});
it.each(["same-length", "truncated"])(
  "rejects %s bytes returned by an injected backend",
  async (variant) => {
    const p = await panel(),
      run = await recordVisibilityEvidence(
        db,
        actor,
        scope,
        p.id,
        evidence(),
        recording,
      );
    bindLocalArtifactStore(
      db,
      {
        ...store,
        openBounded: async (version) => {
          const bytes = await store.openBounded(version);
          if (variant === "truncated") return bytes.slice(1);
          bytes[bytes.length - 1] ^= 1;
          return bytes;
        },
      },
      authority,
    );
    const result = await readObservationAnswer(db, actor, scope, run.id, "p");
    expect(result.answer).toBeNull();
    expect(result.availability.reason).toBe("ARTIFACT_CORRUPT");
  },
);
it("rights retirement during read returns no bytes while compact metrics remain", async () => {
  const p = await panel(),
    run = await recordVisibilityEvidence(
      db,
      actor,
      scope,
      p.id,
      evidence(),
      recording,
    );
  bindLocalArtifactStore(
    db,
    {
      ...store,
      openBounded: async (version) => {
        const bytes = await store.openBounded(version);
        await retireObservationAnswers(db, actor, scope, run.id);
        return bytes;
      },
    },
    authority,
  );
  const result = await readObservationAnswer(db, actor, scope, run.id, "p");
  expect(result.answer).toBeNull();
  expect(result.availability.state).toBe("rights-unavailable");
  expect(
    (await readVisibility(db, actor, scope, run.id)).runs[0]!.summary!.brands.a!
      .mention.rate,
  ).toBe(1);
  expect((await admin.artifactBlob.findFirstOrThrow()).state).toBe("ORPHAN");
});
it("grant revocation during read and bearer credentials deny every answer byte", async () => {
  const p = await panel(),
    run = await recordVisibilityEvidence(
      db,
      actor,
      scope,
      p.id,
      evidence(),
      recording,
    ),
    viewer = { ...actor, userId: "viewer" };
  bindLocalArtifactStore(
    db,
    {
      ...store,
      openBounded: async (version) => {
        const bytes = await store.openBounded(version);
        await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
        return bytes;
      },
    },
    authority,
  );
  await expect(
    readObservationAnswer(db, viewer, scope, run.id, "p"),
  ).rejects.toThrow();
  await expect(
    readObservationAnswer(
      db,
      {
        credential: "api-token",
        userId: "owner",
        securityVersion: 0,
        tokenId: "none",
        tokenHash: "none",
        workspaceId: "a",
      },
      scope,
      run.id,
      "p",
    ),
  ).rejects.toThrow("FORBIDDEN");
});

// The DB login can reserve a descriptor but cannot mint either independent assertion.
import { withActor } from "../../packages/db/src/context";
import { normalizeObservation } from "../../packages/db/src/observation-source";
import {
  witnessedNormalizedObservation,
  verifiedNormalizedPublication,
  type ObservationReservation,
} from "../../packages/db/src/artifact-checkpoint";
async function staged(p: Awaited<ReturnType<typeof panel>>, e = evidence()) {
  const source = normalizeObservation(p, e, recording);
  const [context] = await withActor(
    db,
    actor,
    "a",
    (tx) =>
      tx.$queryRaw<
        { context: string }[]
      >`SELECT lyraseo_observation.source_context(${scope.siteId},${p.id},0,${actor.sessionId}) AS context`,
  );
  const witness = witnessedNormalizedObservation(db, source, context!.context);
  const reserve = () =>
    withActor(db, actor, "a", async (tx) => {
      const [row] = await tx.$queryRaw<
        { reservation: ObservationReservation }[]
      >`SELECT lyraseo_observation.reserve(${scope.siteId},${p.id},0,${actor.sessionId},${recording.sourceNamespace},${recording.recordingKey},${JSON.stringify(witness.submitted)}::json,${JSON.stringify(witness.confirmation)}::json) AS reservation`;
      return row!.reservation;
    });
  const reservation = await reserve();
  return { source, witness, reservation, reserve };
}
async function finalize(
  reservation: ObservationReservation,
  submitted: unknown,
  confirmation: unknown,
) {
  return withActor(
    db,
    actor,
    "a",
    (tx) =>
      tx.$queryRaw`SELECT lyraseo_observation.finalize(${scope.siteId},${reservation.id}::uuid,0,${actor.sessionId},${reservation.proof}::uuid,${JSON.stringify(submitted)}::json,${JSON.stringify(confirmation)}::json)`,
  );
}
it("requires separate source and physical publication confirmations under the actual restricted logins", async () => {
  const p = await panel(),
    e = evidence(),
    source = normalizeObservation(p, e, recording);
  const data = { evidence: source.manifest, provenance: source.provenance };
  await expect(
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw`SELECT lyraseo_observation.reserve(${scope.siteId},${p.id},0,${actor.sessionId},${recording.sourceNamespace},${recording.recordingKey},${JSON.stringify(data)}::json,'{}'::json)`,
    ),
  ).rejects.toThrow("CONFIRMATION_REQUIRED");
  expect(await admin.visibilityRecording.count()).toBe(0);
  const pending = await staged(p, e);
  await expect(
    finalize(pending.reservation, pending.witness.submitted, {}),
  ).rejects.toThrow("CONFIRMATION_REQUIRED");
  await expect(
    finalize(
      pending.reservation,
      pending.witness.submitted,
      pending.witness.confirmation,
    ),
  ).rejects.toThrow("CONFIRMATION_REQUIRED");
  const fabricated = structuredClone(pending.witness.submitted);
  fabricated.evidence.slots[0]!.extraction.a!.mention = false;
  await expect(
    finalize(pending.reservation, fabricated, pending.witness.confirmation),
  ).rejects.toThrow("IMMUTABLE_OBSERVATION");
  for (const role of [
    "lyraseo_runtime",
    "lyraseo_dispatch",
    "lyraseo_identity",
  ]) {
    const password =
      role === "lyraseo_runtime"
        ? "local_runtime_only"
        : role === "lyraseo_dispatch"
          ? "local_dispatch_only"
          : "local_identity_only";
    const login = createDatabase(
      adminUrl.replace("postgres:lyraseo_local_only", `${role}:${password}`),
    );
    try {
      await expect(
        login.$queryRaw`SELECT secret FROM lyraseo_audit.artifact_verifier`,
      ).rejects.toThrow();
      await expect(
        login.$queryRaw`INSERT INTO "ArtifactRef" DEFAULT VALUES`,
      ).rejects.toThrow();
      if (role !== "lyraseo_runtime")
        await expect(
          login.$queryRaw`SELECT lyraseo_observation.finalize('a-site',${pending.reservation.id}::uuid,0,'test-session',${pending.reservation.proof}::uuid,${JSON.stringify(data)}::json,'{}'::json)`,
        ).rejects.toThrow();
    } finally {
      await login.$disconnect();
    }
  }
  expect(await admin.visibilityRun.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
  expect((await admin.artifactBlob.findFirstOrThrow()).state).toBe("STAGED");
});
it("rotates stale reservation proof without changing the observation or physical generation", async () => {
  const pending = await staged(await panel()),
    pub = await verifiedNormalizedPublication(
      db,
      pending.source,
      pending.reservation,
    ),
    next = await pending.reserve();
  expect(next.proof).not.toBe(pending.reservation.proof);
  expect(next.versions).toEqual(pending.reservation.versions);
  await expect(
    finalize(pending.reservation, pub.submitted, pub.confirmation),
  ).rejects.toThrow("STALE_OBSERVATION_PROOF");
  expect(await admin.visibilityRun.count()).toBe(0);
});
it("reparses and rejects forged backend bytes before issuing publication confirmation", async () => {
  const pending = await staged(await panel());
  bindLocalArtifactStore(
    db,
    {
      ...store,
      openBounded: async (version) => {
        const bytes = await store.openBounded(version);
        bytes[0] ^= 1;
        return bytes;
      },
    },
    authority,
  );
  await expect(
    verifiedNormalizedPublication(db, pending.source, pending.reservation),
  ).rejects.toThrow("ARTIFACT_UNAVAILABLE");
  expect(await admin.visibilityRun.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
});
it("cancellation during physical I/O denies publication and leaves tracked orphan work", async () => {
  const p = await panel(),
    e = evidence();
  bindLocalArtifactStore(
    db,
    {
      ...store,
      openBounded: async (version) => {
        const bytes = await store.openBounded(version),
          pending = await admin.visibilityRecording.findFirstOrThrow();
        await retireObservationAnswers(db, actor, scope, pending.runId);
        return bytes;
      },
    },
    authority,
  );
  await expect(
    recordVisibilityEvidence(db, actor, scope, p.id, e, recording),
  ).rejects.toThrow("OBSERVATION_RETIRED");
  expect(await admin.visibilityRun.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
  expect((await admin.artifactBlob.findFirstOrThrow()).state).toBe("ORPHAN");
  bindLocalArtifactStore(db, store, authority);
  await expect(
    recordVisibilityEvidence(db, actor, scope, p.id, e, recording),
  ).rejects.toThrow("OBSERVATION_RETIRED");
});
it("security epoch revocation during I/O denies every final write", async () => {
  const p = await panel();
  bindLocalArtifactStore(
    db,
    {
      ...store,
      openBounded: async (version) => {
        const bytes = await store.openBounded(version);
        await admin.productUser.update({
          where: { id: "owner" },
          data: { securityVersion: 1 },
        });
        return bytes;
      },
    },
    authority,
  );
  await expect(
    recordVisibilityEvidence(db, actor, scope, p.id, evidence(), recording),
  ).rejects.toThrow("FORBIDDEN");
  expect(await admin.visibilityRun.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
});
it("rolls back run, slots and READY refs together when the last final write fails", async () => {
  const p = await panel(),
    e = evidence();
  await admin.$executeRawUnsafe(
    `CREATE FUNCTION public.observation_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_FINAL_WRITE'; END $$`,
  );
  await admin.$executeRawUnsafe(
    `CREATE TRIGGER observation_test_fail AFTER INSERT ON "ArtifactRef" FOR EACH ROW EXECUTE FUNCTION public.observation_test_fail()`,
  );
  try {
    await expect(
      recordVisibilityEvidence(db, actor, scope, p.id, e, recording),
    ).rejects.toThrow("INJECTED_FINAL_WRITE");
    expect(await admin.visibilityRun.count()).toBe(0);
    expect(await admin.artifactRef.count()).toBe(0);
    expect((await admin.artifactBlob.findFirstOrThrow()).state).toBe("STAGED");
    expect(
      (await admin.visibilityObservationSlot.findFirstOrThrow()).disposition,
    ).toBe("STAGED");
  } finally {
    await admin.$executeRawUnsafe(
      'DROP TRIGGER observation_test_fail ON "ArtifactRef"',
    );
    await admin.$executeRawUnsafe(
      "DROP FUNCTION public.observation_test_fail()",
    );
  }
  await recordVisibilityEvidence(db, actor, scope, p.id, e, recording);
  expect(await admin.visibilityRun.count()).toBe(1);
  expect(await admin.artifactRef.count()).toBe(1);
});
it("missing raw and backend outage remain explicit while compact evidence survives", async () => {
  const p = await panel(),
    e = evidence(),
    run = await recordVisibilityEvidence(db, actor, scope, p.id, e, recording);
  bindLocalArtifactStore(
    db,
    { ...store, statVersion: async () => false },
    authority,
  );
  expect(
    (await readObservationAnswer(db, actor, scope, run.id, "p")).availability
      .reason,
  ).toBe("MISSING_BLOB");
  bindLocalArtifactStore(
    db,
    {
      ...store,
      openBounded: async () => {
        throw Error();
      },
    },
    authority,
  );
  expect(
    (await readObservationAnswer(db, actor, scope, run.id, "p")).availability
      .reason,
  ).toBe("BACKEND_UNAVAILABLE");
  expect(
    (await readVisibility(db, actor, scope, run.id)).runs[0]!.summary!.brands.a!
      .mention.rate,
  ).toBe(1);
});
it("retains the immutable compact identity on expired-rights replay without touching storage", async () => {
  const p = await panel(),
    e = evidence();
  e.rawRightsUntil = new Date(Date.now() + 1500).toISOString();
  const run = await recordVisibilityEvidence(
      db,
      actor,
      scope,
      p.id,
      e,
      recording,
    ),
    original = await admin.visibilityRun.findUniqueOrThrow({
      where: { id: run.id },
    });
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, Date.parse(e.rawRightsUntil!) - Date.now() + 5),
    ),
  );
  const [clock] = await admin.$queryRaw<
    { expired: boolean }[]
  >`SELECT clock_timestamp()>=${new Date(e.rawRightsUntil)} AS expired`;
  expect(clock!.expired).toBe(true);
  bindLocalArtifactStore(
    db,
    {
      ...store,
      statVersion: async () => {
        throw Error("unexpected-reacquisition");
      },
      putImmutable: async () => {
        throw Error("unexpected-reacquisition");
      },
    },
    authority,
  );
  expect(
    await recordVisibilityEvidence(db, actor, scope, p.id, e, recording),
  ).toEqual({ id: run.id, storageFormat: "OBSERVATION_PRIVATE_V1" });
  expect(
    (await readObservationAnswer(db, actor, scope, run.id, "p")).availability
      .state,
  ).toBe("expired");
  expect(+original.rawExpiresAt).toBe(Date.parse(e.rawRightsUntil!));
  expect(await admin.visibilityRun.count()).toBe(1);
});
it("supports the 25-slot engineering maximum with distinct per-answer generations", async () => {
  const prompts = Array.from({ length: 25 }, (_, i) => ({
    id: `p${i}`,
    text: `Tools ${i}?`,
    label: "neutral" as const,
  }));
  const p = await createVisibilityPanel(db, actor, scope, prompts, [
    { id: "a", name: "Alpha", aliases: ["Alpha"], domains: [] },
  ]);
  await reviewVisibilityPanel(db, actor, scope, p.id);
  const e = evidence();
  e.slots = prompts.map((p) => ({
    ...e.slots[0]!,
    promptId: p.id,
    body: "No brand here",
    annotations: [],
  }));
  await recordVisibilityEvidence(db, actor, scope, p.id, e, recording);
  const refs = await admin.artifactRef.findMany(),
    blobs = await admin.artifactBlob.findMany();
  expect(refs).toHaveLength(25);
  expect(new Set(blobs.map((x) => x.generation)).size).toBe(25);
});
it("rejects facts normalized against forged reviewed-panel aliases even with a valid independent source MAC", async () => {
  const p = await panel(),
    e = evidence(),
    forged = {
      ...p,
      brands: [{ id: "a", name: "Alpha", aliases: ["Different"], domains: [] }],
    };
  const source = normalizeObservation(forged, e, recording);
  const [context] = await withActor(
    db,
    actor,
    "a",
    (tx) =>
      tx.$queryRaw<
        { context: string }[]
      >`SELECT lyraseo_observation.source_context(${scope.siteId},${p.id},0,${actor.sessionId}) AS context`,
  );
  const witness = witnessedNormalizedObservation(db, source, context!.context);
  await expect(
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw`SELECT lyraseo_observation.reserve(${scope.siteId},${p.id},0,${actor.sessionId},${recording.sourceNamespace},${recording.recordingKey},${JSON.stringify(witness.submitted)}::json,${JSON.stringify(witness.confirmation)}::json)`,
    ),
  ).rejects.toThrow();
  expect(await admin.visibilityRecording.count()).toBe(0);
  expect(await admin.artifactBlob.count()).toBe(0);
});
it("serializes the source deadline as an explicit UTC instant under a different SQL timezone", async () => {
  const p = await panel(),
    e = evidence(),
    run = await recordVisibilityEvidence(db, actor, scope, p.id, e, recording);
  const ticket = await withActor(db, actor, "a", async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kolkata'");
    const [row] = await tx.$queryRaw<
      { ticket: { deadline: string } }[]
    >`SELECT lyraseo_observation.ticket(${scope.siteId},${run.id},'p',0,${actor.sessionId}) AS ticket`;
    return row!.ticket;
  });
  expect(ticket.deadline).toMatch(/(?:Z|[+-]\d\d:\d\d)$/);
  expect(Date.parse(ticket.deadline)).toBe(
    Date.parse(e.observedAt) + 90 * 86400000,
  );
});
