import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  admitOperation,
  claimOperation,
} from "../../packages/db/src/accounting";
import {
  readProviderLedger,
  closeProviderAttemptPlan,
  settleManagedOperation,
} from "../../packages/db/src/provider-ledger";
import { createObservationFixture } from "../../apps/lyraseo-web/src/server/providers/observations/fixture";
import { fixtureObservationLedger } from "../../apps/lyraseo-web/src/server/providers/observations/ledger";
import {
  submitObservationFixture,
  pollObservationFixture,
  resumeObservationFixture,
} from "../../apps/lyraseo-web/src/server/providers/observations/orchestrator";
import type { Actor } from "../../packages/db/src/context";
const name = process.env.LYRA_OBSERVATION_DB;
if (!name || !/^lyraseo_ledger_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_OBSERVATION_DATABASE_REQUIRED");
const url = (u: string, p: string) =>
  `postgresql://${u}:${p}@127.0.0.1:54329/${name}`;
const admin = createDatabase(url("postgres", "lyraseo_local_only")),
  runtime = createDatabase(url("lyraseo_runtime", "local_runtime_only")),
  fixtureDb = createDatabase(
    url("lyraseo_ledger_fixture", "local_ledger_only"),
  );
const sponsor: Actor = {
  userId: "fixture-ledger-observations",
  sessionId: "observation-session",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: false,
  authProvider: "supabase",
};
const panel = {
  id: "observation-panel",
  version: 1,
  prompts: [{ id: "p1", text: "Which tools?", label: "neutral" as const }],
  brands: [
    {
      id: "alpha",
      name: "Alpha",
      aliases: ["Alpha"],
      domains: ["alpha.example"],
    },
  ],
};
beforeAll(async () => {
  await admin.productUser.create({ data: { id: sponsor.userId } });
  await admin.workspace.create({
    data: { id: "observation-workspace", name: "Synthetic observations" },
  });
  await admin.membership.create({
    data: {
      workspaceId: "observation-workspace",
      userId: sponsor.userId,
      role: "OWNER",
    },
  });
  await admin.site.create({
    data: {
      id: "observation-site",
      workspaceId: "observation-workspace",
      origin: "https://synthetic.invalid",
      verifiedAt: new Date(),
    },
  });
  await admin.visibilityPanel.create({
    data: {
      ...panel,
      workspaceId: "observation-workspace",
      siteId: "observation-site",
      createdBy: sponsor.userId,
      reviewedBy: sponsor.userId,
      reviewedAt: new Date(),
    },
  });
});
afterAll(async () => {
  await Promise.all([
    admin.$disconnect(),
    runtime.$disconnect(),
    fixtureDb.$disconnect(),
  ]);
});
let index = 0;
async function operation(
  kind = "CHATGPT_OBSERVATION",
  provider = "DATAFORSEO",
) {
  const current = { ...sponsor, userId: `fixture-ledger-observation-${index}` };
  await admin.productUser.create({ data: { id: current.userId } });
  await admin.membership.create({
    data: {
      workspaceId: "observation-workspace",
      userId: current.userId,
      role: "OWNER",
    },
  });
  const op = await admitOperation(runtime, current, {
    workspaceId: "observation-workspace",
    siteId: "observation-site",
    kind: kind as "CHATGPT_OBSERVATION",
    provider: provider as "DATAFORSEO",
    route: "fixture-ledger",
    idempotencyKey: `observation-${index++}`,
    input: { source: "SYNTHETIC", panelId: panel.id },
    maximumCost: "0.003",
    tariffVersion: "synthetic-fixture-v1",
  });
  const lease = await claimOperation(
    runtime,
    current,
    op.id,
    "observation-fixture",
  );
  await admin.$queryRaw`SELECT lyraseo_ledger.enroll_fixture(${op.id},'[{"step":"observation","maximum":"0.003"}]'::jsonb)`;
  return {
    sponsor: current,
    operationId: op.id,
    fence: lease.fence,
    step: "observation",
    expectedRevision: 0,
    panel,
    promptId: "p1",
    promptVersion: "panel-1:p1",
  };
}
it("executes the real restricted ledger bridge, replays polling once and settles a single consumer count", async () => {
  const input = await operation();
  const fixture = createObservationFixture("consumer-chatgpt", "complete");
  const port = fixtureObservationLedger(fixtureDb, fixture, input);
  const submitted = await submitObservationFixture(port, fixture, input);
  expect(submitted.state).toBe("pending");
  const done = await pollObservationFixture(port, fixture, submitted);
  expect(done.state).toBe("complete");
  await pollObservationFixture(port, fixture, submitted);
  const before = await readProviderLedger(fixtureDb, input.operationId);
  expect(before.effectiveCost).toBeNull();
  const closed = await closeProviderAttemptPlan(
    fixtureDb,
    input.operationId,
    before.revision,
  );
  const snap = await readProviderLedger(fixtureDb, input.operationId);
  const settled = await settleManagedOperation(fixtureDb, {
    operationId: input.operationId,
    expectedRevision: closed.revision,
    evidenceHash: snap.evidenceHash,
  });
  expect(settled.amount).toBe("0.001200000");
  expect(settled.classification).toBe("SYNTHETIC");
  const op = await admin.operation.findUniqueOrThrow({
    where: { id: input.operationId },
  });
  expect(op.actualCost?.toString()).toBe("0.0012");
  const count = await admin.budgetPeriod.findFirstOrThrow({
    where: {
      userId: input.sponsor.userId,
      period: op.period,
      bucket: "CHATGPT_OBSERVATION",
    },
  });
  expect(count.spent.toString()).toBe("1");
  expect(await admin.visibilityRun.count()).toBe(0); // no provider bytes enter controlled producer
});
it("rejects a forged panel/profile or runtime principal before an attempt is created", async () => {
  for (const change of [
    { panel: { ...panel, version: 99 } },
    {
      panel: { ...panel, prompts: [{ ...panel.prompts[0]!, text: "Changed" }] },
    },
  ]) {
    const original = await operation();
    const input = { ...original, ...change };
    const fixture = createObservationFixture("consumer-chatgpt", "complete");
    await expect(
      submitObservationFixture(
        fixtureObservationLedger(fixtureDb, fixture, input),
        fixture,
        input,
      ),
    ).rejects.toThrow();
    expect(
      (
        await admin.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM lyraseo_ledger.attempt WHERE operation_id=${input.operationId}`
      )[0]!.count,
    ).toBe(0n);
  }
  const input = await operation();
  const wrong = createObservationFixture("consumer-gemini", "complete");
  await expect(
    submitObservationFixture(
      fixtureObservationLedger(fixtureDb, wrong, input),
      wrong,
      input,
    ),
  ).rejects.toThrow("OBSERVATION_PROFILE_MISMATCH");
  const fixture = createObservationFixture("consumer-chatgpt", "complete");
  await expect(
    submitObservationFixture(
      fixtureObservationLedger(runtime, fixture, input),
      fixture,
      input,
    ),
  ).rejects.toThrow();
});
it("continues recording the original incurred receipt after sponsor revocation but authorizes no replacement/source", async () => {
  const input = await operation("GEMINI_OBSERVATION");
  const fixture = createObservationFixture("consumer-gemini", "complete");
  const port = fixtureObservationLedger(fixtureDb, fixture, input);
  const accepted = await submitObservationFixture(port, fixture, input);
  await admin.productUser.update({
    where: { id: input.sponsor.userId },
    data: { securityVersion: { increment: 1 } },
  });
  const result = await pollObservationFixture(port, fixture, accepted);
  expect(result.state).toBe("complete");
  const snap = await readProviderLedger(fixtureDb, input.operationId);
  expect(snap.revision).toBeGreaterThan(1);
  const replay = await submitObservationFixture(port, fixture, input);
  expect(replay.state).toBe("reconciliation-required");
  expect(await admin.visibilityRun.count()).toBe(0);
  const eligibility = await fixtureDb.$queryRaw<
    { value: { available: boolean; sourcePersistence: boolean } }[]
  >`SELECT lyraseo_observation_binding.provider_source_eligibility() AS value`;
  expect(eligibility[0]!.value).toMatchObject({
    available: false,
    sourcePersistence: false,
  });
  await expect(
    fixtureDb.$executeRaw`UPDATE lyraseo_observation_binding.fixture_attempt SET source_class='ACTUAL'`,
  ).rejects.toThrow();
  await expect(
    fixtureDb.$queryRaw`SELECT * FROM public."VisibilityPanel"`,
  ).rejects.toThrow();
});
it("retains an ambiguous submission and unknown billing without a replacement or invented zero", async () => {
  for (const scenario of ["ambiguous-post", "missing-cost"] as const) {
    const input = await operation();
    const fixture = createObservationFixture("consumer-chatgpt", scenario);
    const port = fixtureObservationLedger(fixtureDb, fixture, input);
    const submitted = await submitObservationFixture(port, fixture, input);
    if (scenario === "missing-cost")
      await pollObservationFixture(port, fixture, submitted);
    const replay = await submitObservationFixture(port, fixture, input);
    expect(replay.state).toBe("reconciliation-required");
    const attempts = await admin.$queryRaw<
      { state: string; cost: string | null }[]
    >`SELECT state,cost::text FROM lyraseo_ledger.attempt WHERE operation_id=${input.operationId}`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.cost).toBeNull();
    expect(attempts[0]!.state).toBe(
      scenario === "ambiguous-post" ? "UNCERTAIN" : "ACCEPTED",
    );
    const snap = await readProviderLedger(fixtureDb, input.operationId);
    const closed = await closeProviderAttemptPlan(
      fixtureDb,
      input.operationId,
      snap.revision,
    );
    const after = await readProviderLedger(fixtureDb, input.operationId);
    await expect(
      settleManagedOperation(fixtureDb, {
        operationId: input.operationId,
        expectedRevision: closed.revision,
        evidenceHash: after.evidenceHash,
      }),
    ).rejects.toThrow();
    expect(
      (
        await admin.operation.findUniqueOrThrow({
          where: { id: input.operationId },
        })
      ).actualCost,
    ).toBeNull();
  }
});
it("settles charged refusal as spend without a completed observation and keeps Azure separate", async () => {
  for (const profile of ["consumer-chatgpt", "azure-sol-api"] as const) {
    const input = await operation(
      profile === "azure-sol-api" ? "API_OBSERVATION" : "CHATGPT_OBSERVATION",
      profile === "azure-sol-api" ? "AZURE" : "DATAFORSEO",
    );
    const fixture = createObservationFixture(profile, "refusal"),
      port = fixtureObservationLedger(fixtureDb, fixture, input);
    const submitted = await submitObservationFixture(port, fixture, input);
    if (profile !== "azure-sol-api")
      await pollObservationFixture(port, fixture, submitted);
    const snap = await readProviderLedger(fixtureDb, input.operationId);
    const closed = await closeProviderAttemptPlan(
      fixtureDb,
      input.operationId,
      snap.revision,
    );
    const after = await readProviderLedger(fixtureDb, input.operationId);
    const settled = await settleManagedOperation(fixtureDb, {
      operationId: input.operationId,
      expectedRevision: closed.revision,
      evidenceHash: after.evidenceHash,
    });
    expect(settled.amount).toBe(
      profile === "azure-sol-api" ? "0.000100000" : "0.001200000",
    );
    const count = await admin.budgetPeriod.findFirstOrThrow({
      where: {
        userId: input.sponsor.userId,
        bucket:
          profile === "azure-sol-api"
            ? "API_OBSERVATION"
            : "CHATGPT_OBSERVATION",
      },
    });
    expect(count.spent.toString()).toBe("0");
  }
});
it("rechecks revocation, lease, proof, pause and tombstone before new fixture submission", async () => {
  for (const reason of [
    "revoked",
    "lease",
    "proof",
    "pause",
    "deleted",
  ] as const) {
    const input = await operation();
    const fixture = createObservationFixture("consumer-chatgpt", "complete"),
      port = fixtureObservationLedger(fixtureDb, fixture, input);
    if (reason === "revoked")
      await admin.productUser.update({
        where: { id: input.sponsor.userId },
        data: { securityVersion: 1 },
      });
    if (reason === "lease")
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE lyraseo_ledger_owner");
        await tx.$executeRaw`UPDATE public."Operation" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE id=${input.operationId}`;
      });
    if (reason === "proof")
      await admin.site.update({
        where: { id: "observation-site" },
        data: { verifiedAt: new Date(Date.now() - 31 * 86400000) },
      });
    if (reason === "pause")
      await admin.$executeRaw`UPDATE lyraseo_ledger.managed_operation SET paused=true WHERE operation_id=${input.operationId}`;
    if (reason === "deleted")
      await admin.site.update({
        where: { id: "observation-site" },
        data: { deletedAt: new Date() },
      });
    await expect(
      submitObservationFixture(port, fixture, input),
    ).rejects.toThrow();
    expect(
      (
        await admin.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM lyraseo_ledger.attempt WHERE operation_id=${input.operationId}`
      )[0]!.count,
    ).toBe(0n);
    await admin.site.update({
      where: { id: "observation-site" },
      data: { verifiedAt: new Date(), deletedAt: null },
    });
  }
});

it("reconstructs only a known durable task after losing the in-memory handle without another prepare or charge", async () => {
  const input = await operation();
  const first = createObservationFixture("consumer-chatgpt", "complete");
  const firstPort = fixtureObservationLedger(fixtureDb, first, input);
  const posted = await submitObservationFixture(firstPort, first, input);
  const recoveredFixture = createObservationFixture(
    "consumer-chatgpt",
    "complete",
  );
  const recoveredPort = fixtureObservationLedger(
    fixtureDb,
    recoveredFixture,
    input,
  );
  const resumed = await resumeObservationFixture(
    recoveredPort,
    recoveredFixture,
    posted.attemptId,
  );
  expect(resumed.taskId).toBe(posted.taskId);
  const result = await pollObservationFixture(
    recoveredPort,
    recoveredFixture,
    resumed,
  );
  expect(result.state).toBe("complete");
  await pollObservationFixture(firstPort, first, posted);
  const attempts = await admin.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) FROM lyraseo_ledger.attempt WHERE operation_id=${input.operationId}`;
  expect(attempts[0]!.count).toBe(1n);
  const otherInput = await operation();
  await expect(
    resumeObservationFixture(
      fixtureObservationLedger(fixtureDb, recoveredFixture, otherInput),
      recoveredFixture,
      posted.attemptId,
    ),
  ).rejects.toThrow("KNOWN_TASK_REQUIRED");
  const wrongFixture = createObservationFixture("consumer-gemini", "complete");
  await expect(
    resumeObservationFixture(
      fixtureObservationLedger(fixtureDb, wrongFixture, input),
      wrongFixture,
      posted.attemptId,
    ),
  ).rejects.toThrow("KNOWN_TASK_REQUIRED");
});

it.each(["submitted", "recovered"] as const)(
  "replays chained polls from a %s handle with the exact original financial payload after clock advances",
  async (origin) => {
    const input = await operation();
    const initialFixture = createObservationFixture(
      "consumer-chatgpt",
      "complete",
    );
    const initialPort = fixtureObservationLedger(
      fixtureDb,
      initialFixture,
      input,
    );
    const admittedAt = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(admittedAt);
    try {
      const submitted = await submitObservationFixture(
        initialPort,
        initialFixture,
        input,
      );
      const fixture =
        origin === "recovered"
          ? createObservationFixture("consumer-chatgpt", "complete")
          : initialFixture;
      const port =
        origin === "recovered"
          ? fixtureObservationLedger(fixtureDb, fixture, input)
          : initialPort;
      const start =
        origin === "recovered"
          ? await resumeObservationFixture(port, fixture, submitted.attemptId)
          : submitted;
      vi.setSystemTime(new Date(admittedAt.getTime() + 1000));
      let current = await pollObservationFixture(port, fixture, start);
      const first = await readProviderLedger(fixtureDb, input.operationId);
      vi.setSystemTime(new Date(admittedAt.getTime() + 2000));
      current = await pollObservationFixture(port, fixture, current);
      vi.setSystemTime(new Date(admittedAt.getTime() + 3000));
      current = await pollObservationFixture(port, fixture, current);
      expect(current.state).toBe("complete");
      expect(current.taskId).toBe(submitted.taskId);
      const replayed = await readProviderLedger(fixtureDb, input.operationId);
      expect(replayed.revision).toBe(first.revision);
      expect(replayed.evidenceHash).toBe(first.evidenceHash);
      const facts = await admin.$queryRaw<
        { payload: { observedAt: string; cost: string }; count: bigint }[]
      >`
        SELECT e.payload, (SELECT count(*) FROM lyraseo_ledger.attempt WHERE operation_id=${input.operationId}) AS count
        FROM lyraseo_ledger.attempt_event e JOIN lyraseo_ledger.attempt a ON a.id=e.attempt_id
        WHERE a.operation_id=${input.operationId} AND e.kind='RESOLVED'`;
      expect(facts).toHaveLength(1);
      expect(facts[0]!.payload.observedAt).toBe(admittedAt.toISOString());
      expect(facts[0]!.payload.cost).toBe("0.0012");
      expect(facts[0]!.count).toBe(1n);
    } finally {
      vi.useRealTimers();
    }
  },
);
