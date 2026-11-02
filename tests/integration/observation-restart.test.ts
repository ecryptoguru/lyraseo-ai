import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { mkdtemp, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  recordVisibilityEvidence,
  type ProviderEvidence,
} from "../../packages/db/src/visibility";
import { addMonthsClamped } from "../../packages/db/src/retention";
import { withActor } from "../../packages/db/src/context";
import { retireObservationAnswers } from "../../packages/db/src/observation-artifacts";
import { normalizeObservation } from "../../packages/db/src/observation-source";
import {
  bindLocalArtifactStore,
  witnessedNormalizedObservation,
  verifiedNormalizedPublication,
  type ObservationReservation,
} from "../../packages/db/src/artifact-checkpoint";
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
import type {
  ObservationPhase,
  ObservationProcessInput,
  ObservationProcessEvent,
} from "../fixtures/runtime/observation-process";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" };
const recording = {
  storageFormat: "OBSERVATION_PRIVATE_V1" as const,
  sourceNamespace: "CONTROLLED_FIXTURE_V1" as const,
  recordingKey: "restart-fixture-1",
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
let root: string,
  store: AuditArtifactStore,
  authority: Awaited<ReturnType<typeof enrollTestArtifactAuthority>>;
type Producer = {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  wait: (
    event: ObservationProcessEvent["event"],
  ) => Promise<ObservationProcessEvent>;
  stop: () => Promise<void>;
  resume: () => void;
};
const producers: Producer[] = [];
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  root = await mkdtemp(
    join(await realpath(tmpdir()), "lyraseo-observation-restart-"),
  );
  store = await localAuditArtifactStore(root);
  authority = await enrollTestArtifactAuthority(admin);
  bindLocalArtifactStore(db, store, authority);
});
afterEach(async () => {
  await Promise.all(producers.splice(0).map((producer) => producer.stop()));
  await authority?.revoke();
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
afterAll(() => Promise.all([db.$disconnect(), admin.$disconnect()]));
async function panel() {
  const value = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  return reviewVisibilityPanel(db, actor, scope, value.id);
}
function evidence(noBody = false): ProviderEvidence {
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
    rawRightsUntil: new Date(Date.now() + 3600000).toISOString(),
    slots: [
      {
        promptId: "p",
        state: noBody ? "failed" : "successful",
        body: noBody ? undefined : "Alpha controlled private restart answer",
        annotations: noBody
          ? []
          : [{ url: "https://alpha.com", start: 0, end: 5 }],
        providerTaskId: "restart-fixture-task",
        completedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        ...(noBody ? { failureReason: "PROVIDER_FAILED" } : {}),
      },
    ],
  };
}
async function boot(
  panelId: string,
  input: ProviderEvidence,
  options: { pauseAt?: ObservationPhase; rejectIO?: boolean } = {},
): Promise<Producer> {
  const require = createRequire(import.meta.url),
    packagePath = require.resolve("vite-node/package.json", {
      paths: [dirname(require.resolve("vitest/package.json"))],
    }),
    cli = resolve(dirname(packagePath), "vite-node.mjs");
  const child = fork(cli, ["tests/fixtures/runtime/observation-process.ts"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  const events: ObservationProcessEvent[] = [],
    pending: {
      event: ObservationProcessEvent["event"];
      resolve: (value: ObservationProcessEvent) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }[] = [];
  let ended = false;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => {
      ended = true;
      for (const waiter of pending.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(Error("CONTROLLED_PRODUCER_EXITED"));
      }
      resolve({ code, signal });
    }),
  );
  child.on("error", () => {
    for (const waiter of pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(Error("CONTROLLED_PRODUCER_FAILED"));
    }
  });
  child.on("message", (value: ObservationProcessEvent) => {
    if (value.event === "configure") {
      const configuration: ObservationProcessInput = {
        root,
        actor,
        panelId,
        evidence: input,
        recording,
        authority: {
          keyId: authority.keyId,
          secret: new Uint8Array(authority.secret),
        },
        ...options,
      };
      child.send(configuration);
      return;
    }
    const index = pending.findIndex((waiter) => waiter.event === value.event);
    if (index >= 0) {
      const waiter = pending.splice(index, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else events.push(value);
  });
  const producer: Producer = {
    child,
    exited,
    wait: async (event) => {
      const index = events.findIndex((value) => value.event === event);
      if (index >= 0) return events.splice(index, 1)[0]!;
      if (ended) throw Error("CONTROLLED_PRODUCER_EXITED");
      return new Promise((resolve, reject) => {
        const waiter = {
          event,
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.splice(pending.indexOf(waiter), 1);
            reject(Error("CONTROLLED_PRODUCER_BOUNDARY_TIMEOUT"));
          }, 10000),
        };
        pending.push(waiter);
      });
    },
    stop: async () => {
      if (!ended) child.kill("SIGKILL");
      await exited;
    },
    resume: () => {
      child.send({ action: "continue" });
    },
  };
  producers.push(producer);
  return producer;
}
async function snapshot() {
  const row = await admin.visibilityRecording.findFirstOrThrow(),
    slots = await admin.visibilityObservationSlot.findMany({
      orderBy: { promptId: "asc" },
    }),
    blobs = await admin.artifactBlob.findMany({ orderBy: { id: "asc" } }),
    refs = await admin.artifactRef.findMany({ orderBy: { id: "asc" } }),
    runs = await admin.visibilityRun.findMany();
  return { row, slots, blobs, refs, runs };
}
function identity(value: Awaited<ReturnType<typeof snapshot>>) {
  const {
    state: _state,
    proof: _proof,
    proofExpiresAt: _deadline,
    retiredAt: _retired,
    ...record
  } = value.row;
  return hash({
    record,
    slots: value.slots.map(({ disposition: _disposition, ...slot }) => slot),
    blobs: value.blobs.map(({ state: _state, ...blob }) => blob),
  });
}
async function assertKilled(producer: Producer) {
  await producer.stop();
  const exit = await producer.exited;
  expect(exit.signal).toBe("SIGKILL");
}
async function assertSuccess(producer: Producer) {
  const result = await producer.wait("result");
  const exit = await producer.exited;
  expect(exit.code).toBe(0);
  return result;
}

it.each(["reserved", "verified-io", "finalized"] as const)(
  "restarts the normalized answer producer after %s without changing immutable identity or publishing twice",
  async (phase) => {
    const p = await panel(),
      input = evidence(),
      first = await boot(p.id, input, { pauseAt: phase });
    expect((await first.wait("barrier")).phase).toBe(phase);
    const before = await snapshot();
    expect(before.row.state).toBe(
      phase === "finalized" ? "FINALIZED" : "STAGED",
    );
    expect(before.runs.length).toBe(phase === "finalized" ? 1 : 0);
    expect(before.refs.length).toBe(phase === "finalized" ? 1 : 0);
    if (phase === "reserved") expect(await readdir(root)).toHaveLength(0);
    else
      expect(
        await store.statVersion({
          workspaceId: before.blobs[0]!.workspaceId,
          storageKey: before.blobs[0]!.storageKey,
          generation: before.blobs[0]!.generation,
          codec: "IDENTITY",
          sourceHash: before.blobs[0]!.sourceHash,
          sourceLength: before.blobs[0]!.sourceLength,
          storedHash: before.blobs[0]!.storedHash,
          storedLength: before.blobs[0]!.storedLength,
        }),
      ).toBe(true);
    await assertKilled(first);
    const second = await boot(p.id, input, { rejectIO: phase === "finalized" });
    expect(second.child.pid).not.toBe(first.child.pid);
    const result = await assertSuccess(second),
      after = await snapshot();
    expect(result.id).toBe(before.row.runId);
    expect(identity(after)).toBe(identity(before));
    expect(after.row.state).toBe("FINALIZED");
    expect(after.runs.length).toBe(1);
    expect(after.refs.length).toBe(1);
    expect(after.blobs[0]!.state).toBe("READY");
    expect(+after.runs[0]!.createdAt).toBe(Date.parse(input.observedAt));
    expect(+after.runs[0]!.rawExpiresAt).toBe(
      Date.parse(input.rawRightsUntil!),
    );
    expect(+after.runs[0]!.resultExpiresAt).toBe(
      +addMonthsClamped(new Date(input.observedAt), 13),
    );
    if (phase === "finalized")
      expect(Object.values(result.io!).every((value) => value === 0)).toBe(
        true,
      );
  },
);
it.each(["reserved", "verified-io", "finalized"] as const)(
  "keeps durable NO_BODY identity across an OS restart after %s",
  async (phase) => {
    const p = await panel(),
      input = evidence(true),
      first = await boot(p.id, input, { pauseAt: phase });
    expect((await first.wait("barrier")).phase).toBe(phase);
    const before = await snapshot();
    expect(before.slots[0]!.disposition).toBe("NO_BODY");
    expect(before.blobs.length).toBe(0);
    await assertKilled(first);
    const changed = structuredClone(input);
    changed.slots[0] = {
      ...changed.slots[0]!,
      state: "successful",
      body: "Replacement answer",
      annotations: [],
    };
    const replacement = await boot(p.id, changed, { rejectIO: true });
    expect((await replacement.wait("error")).code).toBe(
      "IMMUTABLE_OBSERVATION",
    );
    expect((await replacement.exited).code).toBe(1);
    expect(identity(await snapshot())).toBe(identity(before));
    const unchanged = await snapshot();
    expect(unchanged.runs.length).toBe(before.runs.length);
    expect(unchanged.refs.length).toBe(0);
    const second = await boot(p.id, input, { rejectIO: true }),
      result = await assertSuccess(second),
      after = await snapshot();
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(result.id).toBe(before.row.runId);
    expect(identity(after)).toBe(identity(before));
    expect(after.slots[0]!.disposition).toBe("NO_BODY");
    expect(after.runs.length).toBe(1);
    expect(after.refs.length).toBe(0);
    expect(Object.values(result.io!).every((value) => value === 0)).toBe(true);
  },
);
it.each(["reserved", "verified-io", "finalized"] as const)(
  "rejects changed answer facts after a producer restart at %s",
  async (phase) => {
    const p = await panel(),
      input = evidence(),
      first = await boot(p.id, input, { pauseAt: phase });
    await first.wait("barrier");
    const before = await snapshot();
    await assertKilled(first);
    const changed = structuredClone(input);
    changed.slots[0]!.body = "Changed normalized body";
    changed.slots[0]!.annotations = [];
    const second = await boot(p.id, changed, { rejectIO: true });
    expect((await second.wait("error")).code).toBe("IMMUTABLE_OBSERVATION");
    expect((await second.exited).code).toBe(1);
    const after = await snapshot();
    expect(identity(after)).toBe(identity(before));
    expect(after.runs.length).toBe(before.runs.length);
    expect(after.refs.length).toBe(before.refs.length);
  },
);
it.each(["rights-retired", "tombstoned"] as const)(
  "does not resurrect a %s physical generation after killing the producer following verified I/O",
  async (mode) => {
    const p = await panel(),
      input = evidence(),
      first = await boot(p.id, input, { pauseAt: "verified-io" });
    await first.wait("barrier");
    const before = await snapshot();
    await assertKilled(first);
    const blob = before.blobs[0]!,
      version = {
        workspaceId: blob.workspaceId,
        storageKey: blob.storageKey,
        generation: blob.generation,
        codec: "IDENTITY" as const,
        sourceHash: blob.sourceHash,
        sourceLength: blob.sourceLength,
        storedHash: blob.storedHash,
        storedLength: blob.storedLength,
      };
    if (mode === "rights-retired")
      await retireObservationAnswers(db, actor, scope, before.row.runId);
    else await store.deleteExactVersion(version);
    for (let restart = 0; restart < 2; restart++) {
      const next = await boot(p.id, input, {
        rejectIO: mode === "rights-retired",
      });
      expect(next.child.pid).not.toBe(first.child.pid);
      expect((await next.wait("error")).code).toBe(
        mode === "rights-retired"
          ? "OBSERVATION_RETIRED"
          : "ARTIFACT_UNAVAILABLE",
      );
      expect((await next.exited).code).toBe(1);
      const after = await snapshot();
      expect(identity(after)).toBe(identity(before));
      expect(after.runs.length).toBe(0);
      expect(after.refs.length).toBe(0);
      expect(after.blobs[0]!.state).toBe(
        mode === "rights-retired" ? "ORPHAN" : "STAGED",
      );
      if (mode === "tombstoned")
        expect(await store.statVersion(version)).toBe(false);
    }
  },
);
it("rejects the former process's proof after a new producer rotates the reservation fence", async () => {
  const p = await panel(),
    input = evidence(),
    first = await boot(p.id, input, { pauseAt: "verified-io" });
  await first.wait("barrier");
  const before = await snapshot();
  const [saved] = await admin.$queryRaw<
    { reservation: ObservationReservation }[]
  >`SELECT lyraseo_observation.reservation(r) AS reservation FROM "VisibilityRecording" r WHERE r.id=${before.row.id}::uuid`;
  // Independent trusted test controller produces a valid old publication assertion
  // over the actual bytes. No descriptor/proof/confirmation travels over child IPC.
  const source = normalizeObservation(p, input, recording),
    publication = await verifiedNormalizedPublication(
      db,
      source,
      saved!.reservation,
    );
  await assertKilled(first);
  const second = await boot(p.id, input, { pauseAt: "reserved" });
  await second.wait("barrier");
  expect(second.child.pid).not.toBe(first.child.pid);
  const refreshed = await snapshot();
  expect(refreshed.row.proof === before.row.proof).toBe(false);
  expect(identity(refreshed)).toBe(identity(before));
  await expect(
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw`SELECT lyraseo_observation.finalize(${scope.siteId},${before.row.id}::uuid,0,${actor.sessionId},${before.row.proof}::uuid,${JSON.stringify(publication.submitted)}::json,${JSON.stringify(publication.confirmation)}::json)`,
    ),
  ).rejects.toThrow("STALE_OBSERVATION_PROOF");
  expect(await admin.visibilityRun.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
  second.resume();
  expect((await assertSuccess(second)).id).toBe(before.row.runId);
  const after = await snapshot();
  expect(identity(after)).toBe(identity(before));
  expect(after.runs.length).toBe(1);
  expect(after.refs.length).toBe(1);
});
it("denies actual runtime private INSERT even with an exact STAGED compact reservation while preserving legacy INSERT", async () => {
  const p = await panel(),
    input = evidence(),
    source = normalizeObservation(p, input, recording);
  const [context] = await withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw<
          { context: string }[]
        >`SELECT lyraseo_observation.source_context(${scope.siteId},${p.id},0,${actor.sessionId}) AS context`,
    ),
    witness = witnessedNormalizedObservation(db, source, context!.context);
  await withActor(
    db,
    actor,
    "a",
    (tx) =>
      tx.$queryRaw`SELECT lyraseo_observation.reserve(${scope.siteId},${p.id},0,${actor.sessionId},${recording.sourceNamespace},${recording.recordingKey},${JSON.stringify(witness.submitted)}::json,${JSON.stringify(witness.confirmation)}::json)`,
  );
  const before = await snapshot(),
    compact = source.manifest.slots.map(
      ({
        answerHash: _hash,
        answerLength: _length,
        factDigest: _fact,
        ...slot
      }) => slot,
    );
  const [candidate] = await admin.$queryRaw<
    { matches: boolean }[]
  >`SELECT state='STAGED' AND "runId"=${before.row.runId} AND "panelId"=${p.id} AND manifest->>'profile'=${source.manifest.profile} AND manifest->>'cohort'=${source.manifest.cohort} AND manifest->'provenance'=${JSON.stringify(source.manifest.provenance)}::jsonb AND "observedAt"=${new Date(source.manifest.createdAt)} AND "rawExpiresAt"=${new Date(source.manifest.rawExpiresAt)} AND (SELECT jsonb_agg(v-ARRAY['answerHash','answerLength','factDigest'] ORDER BY n) FROM jsonb_array_elements(manifest->'slots') WITH ORDINALITY q(v,n))=${JSON.stringify(compact)}::jsonb AS matches FROM "VisibilityRecording" WHERE id=${before.row.id}::uuid`;
  expect(candidate!.matches).toBe(true);
  await expect(
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$executeRaw`INSERT INTO "VisibilityRun"(id,"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt","storageFormat") VALUES(${before.row.runId},'a','a-site',${p.id},${source.manifest.profile},${source.manifest.cohort},${JSON.stringify(source.manifest.provenance)}::jsonb,${JSON.stringify(compact)}::jsonb,NULL,${new Date(source.manifest.rawExpiresAt)},${new Date(source.manifest.createdAt)},'OBSERVATION_PRIVATE_V1')`,
    ),
  ).rejects.toThrow();
  expect(
    await admin.visibilityRun.count({
      where: { storageFormat: "OBSERVATION_PRIVATE_V1" },
    }),
  ).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
  expect(await admin.artifactBlob.count({ where: { state: "READY" } })).toBe(0);
  expect(identity(await snapshot())).toBe(identity(before));
  const legacy = await recordVisibilityEvidence(db, actor, scope, p.id, input),
    row = await admin.visibilityRun.findUniqueOrThrow({
      where: { id: legacy.id },
    });
  expect(row.storageFormat).toBeNull();
  expect(row.rawAnswers !== null).toBe(true);
  expect(await admin.visibilityRun.count()).toBe(1);
  expect(await admin.artifactRef.count()).toBe(0);
});
