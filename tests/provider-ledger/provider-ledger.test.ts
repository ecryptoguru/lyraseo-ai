import { profiles, fixtureAnswer } from "./fixtures";
import {
  prepareFixtureAttempt,
  recordAttemptEvidence,
  readProviderLedger,
  closeProviderAttemptPlan,
  settleManagedOperation,
} from "../../packages/db/src/provider-ledger";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { actor } from "../helpers/database";
import {
  admitOperation,
  claimOperation,
} from "../../packages/db/src/accounting";
const name = process.env.LYRA_LEDGER_DB;
if (!name || !/^lyraseo_ledger_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_LEDGER_DATABASE_REQUIRED");
const url = (user: string, password: string) =>
  `postgresql://${user}:${password}@127.0.0.1:54329/${name}`;
const admin = createDatabase(url("postgres", "lyraseo_local_only"));
const runtime = createDatabase(url("lyraseo_runtime", "local_runtime_only"));
const fixture = createDatabase(
  url("lyraseo_ledger_fixture", "local_ledger_only"),
);
const sponsor = { ...actor, userId: "fixture-ledger-owner" };
beforeAll(async () => {
  await admin.productUser.create({ data: { id: sponsor.userId } });
  await admin.workspace.create({
    data: { id: "ledger-workspace", name: "Synthetic ledger" },
  });
  await admin.membership.create({
    data: {
      workspaceId: "ledger-workspace",
      userId: sponsor.userId,
      role: "OWNER",
    },
  });
  await admin.site.create({
    data: {
      id: "ledger-site",
      workspaceId: "ledger-workspace",
      origin: "https://fixture.invalid",
      verifiedAt: new Date(),
    },
  });
});
afterAll(async () => {
  await Promise.all([
    admin.$disconnect(),
    runtime.$disconnect(),
    fixture.$disconnect(),
  ]);
});
let index = 0;
async function operation(
  kind = "GENERATION",
  provider = "AZURE",
  cost = "0.20",
) {
  const current = { ...sponsor, userId: `fixture-ledger-${index}` };
  await admin.productUser.create({ data: { id: current.userId } });
  await admin.membership.create({
    data: {
      workspaceId: "ledger-workspace",
      userId: current.userId,
      role: "OWNER",
    },
  });
  const op = await admitOperation(runtime, current, {
    workspaceId: "ledger-workspace",
    siteId: "ledger-site",
    kind: kind as "GENERATION",
    provider: provider as "AZURE",
    route: "fixture-ledger",
    idempotencyKey: `ledger-${index++}`,
    input: { label: "SYNTHETIC" },
    maximumCost: cost,
    tariffVersion: "synthetic-fixture-v1",
  });
  const lease = await claimOperation(runtime, current, op.id, "fixture");
  return { ...op, fence: lease.fence };
}
it("stores a managed attempt before execution and replays its exact identity", async () => {
  const op = await operation();
  const rows = await admin.$queryRaw<
    { value: unknown }[]
  >`SELECT lyraseo_ledger.enroll_fixture(${op.id},'[{"step":"azure-response","maximum":"0.20"}]'::jsonb) AS value`;
  expect(rows).toHaveLength(1);
  const a = await fixture.$queryRaw<
    { value: { id: string } }[]
  >`SELECT lyraseo_ledger.prepare_attempt(${op.id},${op.fence},'azure-response',${"a".repeat(64)},0) AS value`;
  const b = await fixture.$queryRaw<
    { value: { id: string } }[]
  >`SELECT lyraseo_ledger.prepare_attempt(${op.id},${op.fence},'azure-response',${"a".repeat(64)},0) AS value`;
  expect(a[0].value.id).toBe(b[0].value.id);
});
async function call<T = Record<string, unknown>>(
  db: typeof fixture,
  sql: string,
  values: unknown[] = [],
) {
  const rows = await db.$queryRawUnsafe<{ value: T }[]>(
    `SELECT lyraseo_ledger.${sql} AS value`,
    ...values,
  );
  return rows[0].value;
}
async function managed(
  kind = "GENERATION",
  provider = "AZURE",
  plan = [{ step: "azure-response", maximum: "0.20" }],
  cost = "0.20",
) {
  const op = await operation(kind, provider, cost);
  await call(admin, "enroll_fixture($1,$2::jsonb)", [
    op.id,
    JSON.stringify(plan),
  ]);
  return op;
}
async function prepare(
  op: Awaited<ReturnType<typeof operation>>,
  step = "azure-response",
  revision = 0,
  hash = "a".repeat(64),
) {
  return call<{ id: string; revision: number }>(
    fixture,
    "prepare_attempt($1,$2,$3,$4,$5)",
    [op.id, op.fence, step, hash, revision],
  );
}
async function evidence(
  attemptId: string,
  key: string,
  data: Record<string, unknown>,
) {
  return call<{ revision: number }>(
    fixture,
    "record_evidence($1::uuid,$2,$3::jsonb)",
    [attemptId, key, JSON.stringify(data)],
  );
}
const resolved = (cost: string, outputValid = true, version = 1) => ({
  kind: "RESOLVED",
  accepted: true,
  outputValid,
  cost,
  costVersion: version,
  observedAt: new Date().toISOString(),
});
async function snapshot(opId: string) {
  return call<{
    revision: number;
    evidenceHash: string;
    effectiveCost: string;
    settled: boolean;
  }>(fixture, "snapshot($1)", [opId]);
}
async function settle(opId: string) {
  const s = await snapshot(opId);
  return call(fixture, "settle($1,$2,$3)", [opId, s.revision, s.evidenceHash]);
}
it("holds uncertain exposure, rejects blind replacement, then settles a known charged failure once", async () => {
  const op = await managed();
  const a = await prepare(op);
  await evidence(a.id, `uncertain-${index}`, {
    kind: "UNCERTAIN",
    observedAt: new Date().toISOString(),
  });
  await expect(
    prepare(op, "azure-response", 2, "b".repeat(64)),
  ).rejects.toThrow("RETRY_NOT_ALLOWED");
  await expect(settle(op.id)).rejects.toThrow("PLAN_OPEN");
  await evidence(a.id, `resolved-${index}`, resolved("0.12", false));
  await call(fixture, "close_plan($1,$2)", [op.id, 3]);
  await settle(op.id);
  await settle(op.id);
  const receipt = await admin.usageReceipt.findFirstOrThrow({
    where: { operationId: op.id },
  });
  expect(receipt.amount.toFixed(9)).toBe("0.120000000");
  expect(receipt.acceptedOutput).toBe(false);
  const budgets = await admin.budgetPeriod.findMany({
    where: { userId: op.userId },
  });
  expect(budgets.find((x) => x.bucket === "AZURE")?.spent.toFixed(9)).toBe(
    "0.120000000",
  );
  expect(budgets.every((x) => x.reserved.eq(0))).toBe(true);
});
it("deduplicates exact events, rejects changed evidence and cross-operation event reuse", async () => {
  const op = await managed();
  const a = await prepare(op),
    data = resolved("0.02");
  const key = `same-event-${index}`;
  await evidence(a.id, key, data);
  await evidence(a.id, key, data);
  await expect(evidence(a.id, key, { ...data, cost: "0.03" })).rejects.toThrow(
    "EVENT_CONFLICT",
  );
  const other = await managed();
  const b = await prepare(other);
  await expect(evidence(b.id, key, data)).rejects.toThrow("EVENT_CONFLICT");
});
it("aggregates Search and Extract, applies a sourced signed correction without rewriting a receipt", async () => {
  const op = await managed("RESEARCH", "PARALLEL", [
    { step: "search", maximum: "0.10" },
    { step: "extract", maximum: "0.10" },
  ]);
  const a = await prepare(op, "search");
  await evidence(a.id, `search-${index}`, resolved("0.03"));
  const b = await prepare(op, "extract", 2);
  await evidence(b.id, `extract-${index}`, resolved("0.04"));
  await call(fixture, "close_plan($1,$2)", [op.id, 4]);
  await settle(op.id);
  const original = await admin.usageReceipt.findFirstOrThrow({
    where: { operationId: op.id },
  });
  const e = await evidence(b.id, `correct-${index}`, resolved("0.02", true, 2));
  await call(fixture, "apply_adjustment($1,$2)", [op.id, e.revision]);
  await call(fixture, "apply_adjustment($1,$2)", [op.id, e.revision]);
  expect((await snapshot(op.id)).effectiveCost).toBe("0.050000000");
  expect(
    (
      await admin.usageReceipt.findFirstOrThrow({
        where: { operationId: op.id },
      })
    ).amount.eq(original.amount),
  ).toBe(true);
  const p = await admin.budgetPeriod.findFirstOrThrow({
    where: { userId: op.userId, bucket: "PARALLEL" },
  });
  expect(p.spent.toFixed(9)).toBe("0.050000000");
});
it("rejects runtime and fixture direct SQL/GUC bypasses", async () => {
  const op = await managed();
  await expect(
    runtime.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id',${op.userId},true)`;
      return tx.$executeRawUnsafe(
        `UPDATE "Operation" SET "attemptState"='ACCEPTED' WHERE id=$1`,
        op.id,
      );
    }),
  ).rejects.toThrow("MANAGED_LEDGER_REQUIRED");
  await expect(
    fixture.$executeRawUnsafe(
      `UPDATE "Operation" SET "attemptState"='ACCEPTED' WHERE id=$1`,
      op.id,
    ),
  ).rejects.toThrow();
  await expect(
    call(runtime, "prepare_attempt($1,$2,$3,$4,$5)", [
      op.id,
      op.fence,
      "azure-response",
      "a".repeat(64),
      0,
    ]),
  ).rejects.toThrow();
  await expect(
    fixture.$executeRawUnsafe("SET ROLE lyraseo_ledger_owner"),
  ).rejects.toThrow();
  await expect(
    fixture.$executeRawUnsafe(
      "UPDATE lyraseo_ledger.qualification SET live_enabled=true",
    ),
  ).rejects.toThrow();
});
it("serializes duplicate attempt preparation and settlement over independent connections", async () => {
  const op = await managed();
  const second = createDatabase(
    url("lyraseo_ledger_fixture", "local_ledger_only"),
  );
  try {
    const [a, b] = await Promise.all([
      prepare(op),
      call<{ id: string }>(second, "prepare_attempt($1,$2,$3,$4,$5)", [
        op.id,
        op.fence,
        "azure-response",
        "a".repeat(64),
        0,
      ]),
    ]);
    expect(a.id).toBe(b.id);
    await evidence(a.id, `concurrent-${index}`, resolved("0.03"));
    await call(fixture, "close_plan($1,$2)", [op.id, 2]);
    const s = await snapshot(op.id);
    await Promise.all([
      call(fixture, "settle($1,$2,$3)", [op.id, s.revision, s.evidenceHash]),
      call(second, "settle($1,$2,$3)", [op.id, s.revision, s.evidenceHash]),
    ]);
    expect(
      await admin.usageReceipt.count({ where: { operationId: op.id } }),
    ).toBe(1);
  } finally {
    await second.$disconnect();
  }
});
it("retains the original admission month for late charges and one accepted observation unit", async () => {
  const op = await managed("API_OBSERVATION");
  const a = await prepare(op);
  await evidence(a.id, `observation-${index}`, resolved("0.01"));
  await call(fixture, "close_plan($1,$2)", [op.id, 2]);
  await settle(op.id);
  const rows = await admin.budgetPeriod.findMany({
    where: { userId: op.userId },
  });
  expect(
    rows.find((r) => r.bucket === "API_OBSERVATION")?.spent.toString(),
  ).toBe("1");
  expect(rows.every((r) => r.period === op.period)).toBe(true);
  expect(
    rows.find((r) => r.bucket === "API_OBSERVATION")?.limit.toString(),
  ).toBe("25");
  expect(
    rows.find((r) => r.bucket === "CHATGPT_OBSERVATION")?.limit.toString(),
  ).toBe("100");
  expect(
    rows.find((r) => r.bucket === "GEMINI_OBSERVATION")?.limit.toString(),
  ).toBe("100");
  expect(rows.find((r) => r.bucket === "AZURE")?.limit.toString()).toBe("8");
  expect(rows.find((r) => r.bucket === "COMBINED")?.limit.toString()).toBe(
    "10",
  );
});
it("keyword enrichment uses DataForSEO without an observation count", async () => {
  const op = await managed("KEYWORD_ENRICHMENT", "DATAFORSEO", [
    { step: "keywords", maximum: "0.20" },
  ]);
  const a = await prepare(op, "keywords");
  await evidence(a.id, `keyword-${index}`, resolved("0.01"));
  await call(fixture, "close_plan($1,$2)", [op.id, 2]);
  await settle(op.id);
  const rows = await admin.budgetPeriod.findMany({
    where: { userId: op.userId },
  });
  expect(rows.find((r) => r.bucket === "DATAFORSEO")?.spent.toString()).toBe(
    "0.01",
  );
  expect(
    rows
      .filter((r) => r.bucket.endsWith("OBSERVATION"))
      .every((r) => r.spent.eq(0)),
  ).toBe(true);
});
it("preserves uncertainty after revocation and records late known charges without starting again", async () => {
  const op = await managed();
  const a = await prepare(op);
  await evidence(a.id, `late-uncertain-${index}`, {
    kind: "UNCERTAIN",
    observedAt: new Date().toISOString(),
  });
  await admin.productUser.update({
    where: { id: op.userId },
    data: { suspended: true, securityVersion: { increment: 1 } },
  });
  await expect(
    prepare(op, "azure-response", 2, "b".repeat(64)),
  ).rejects.toThrow("EXECUTION_REVOKED");
  await evidence(a.id, `late-resolved-${index}`, resolved("0.04", false));
  await call(fixture, "close_plan($1,$2)", [op.id, 3]);
  await settle(op.id);
  expect(
    (
      await admin.usageReceipt.findFirstOrThrow({
        where: { operationId: op.id },
      })
    ).amount.toString(),
  ).toBe("0.04");
});
it("requires exact decimal strings, keeps unknown cost unresolved, and rejects contradictory acceptance", async () => {
  const op = await managed();
  const a = await prepare(op);
  await expect(
    evidence(a.id, `float-${index}`, { ...resolved("0.01"), cost: 0.01 }),
  ).rejects.toThrow("INVALID_RESOLUTION");
  await evidence(a.id, `accepted-${index}`, {
    kind: "ACCEPTED",
    taskId: `task-${index}`,
    observedAt: new Date().toISOString(),
  });
  await expect(
    evidence(a.id, `reject-${index}`, {
      ...resolved("0", false),
      accepted: false,
    }),
  ).rejects.toThrow("CONTRADICTORY_EVIDENCE");
  await call(fixture, "close_plan($1,$2)", [op.id, 2]);
  await expect(settle(op.id)).rejects.toThrow("EXPOSURE_UNRESOLVED");
});
it("admits only one definitive failed retry within the original reservation", async () => {
  const op = await managed(
    "GENERATION",
    "AZURE",
    [{ step: "azure-response", maximum: "0.10" }],
    "0.20",
  );
  const a = await prepare(op);
  await evidence(a.id, `retry-failed-${index}`, resolved("0.05", false));
  const b = await prepare(op, "azure-response", 2, "b".repeat(64));
  expect(b.id).not.toBe(a.id);
  await evidence(b.id, `retry-success-${index}`, resolved("0.04"));
  await expect(
    prepare(op, "azure-response", 4, "c".repeat(64)),
  ).rejects.toThrow("RETRY_NOT_ALLOWED");
  await call(fixture, "close_plan($1,$2)", [op.id, 4]);
  await settle(op.id);
  expect((await snapshot(op.id)).effectiveCost).toBe("0.090000000");
});
it("records legitimate overrun corrections, pauses and never credits more than prior accounted spend", async () => {
  const op = await managed();
  const a = await prepare(op);
  await evidence(a.id, `overrun-base-${index}`, resolved("0.10"));
  await call(fixture, "close_plan($1,$2)", [op.id, 2]);
  await settle(op.id);
  const e = await evidence(
    a.id,
    `overrun-correction-${index}`,
    resolved("9.00", true, 2),
  );
  await call(fixture, "apply_adjustment($1,$2)", [op.id, e.revision]);
  expect((await snapshot(op.id)) as unknown).toMatchObject({
    paused: true,
    effectiveCost: "9.000000000",
  });
  const r = await admin.budgetPeriod.findFirstOrThrow({
    where: { userId: op.userId, bucket: "AZURE" },
  });
  expect(r.spent.toString()).toBe("9");
  await expect(
    evidence(a.id, `negative-cost-${index}`, resolved("-1", true, 3)),
  ).rejects.toThrow("INVALID_RESOLUTION");
});
it("rejects stale hashes, plan revisions and modifications of immutable history", async () => {
  const op = await managed();
  const a = await prepare(op);
  await evidence(a.id, `immutable-${index}`, resolved("0.01"));
  await expect(call(fixture, "close_plan($1,$2)", [op.id, 1])).rejects.toThrow(
    "LEDGER_CONFLICT",
  );
  await call(fixture, "close_plan($1,$2)", [op.id, 2]);
  await expect(
    call(fixture, "settle($1,$2,$3)", [op.id, 3, "b".repeat(64)]),
  ).rejects.toThrow("LEDGER_CONFLICT");
  await settle(op.id);
  await expect(
    admin.$executeRawUnsafe(
      "UPDATE lyraseo_ledger.attempt_event SET payload='{}' WHERE attempt_id=$1::uuid",
      a.id,
    ),
  ).rejects.toThrow("IMMUTABLE_LEDGER_EVIDENCE");
  await expect(
    admin.$executeRawUnsafe(
      "UPDATE lyraseo_ledger.settlement SET amount=0 WHERE operation_id=$1",
      op.id,
    ),
  ).rejects.toThrow("IMMUTABLE_LEDGER_EVIDENCE");
});
it("retains accepted POST cost when a zero-cost poll is only transport evidence", async () => {
  const op = await managed("CHATGPT_OBSERVATION", "DATAFORSEO", [
    { step: "consumer-post", maximum: "0.20" },
  ]);
  const a = await prepare(op, "consumer-post");
  await evidence(a.id, `post-${index}`, {
    kind: "ACCEPTED",
    taskId: `consumer-${index}`,
    cost: "0.012",
    costVersion: 1,
    observedAt: new Date().toISOString(),
  });
  await evidence(a.id, `poll-${index}`, {
    kind: "UNCERTAIN",
    taskId: `consumer-${index}`,
    observedAt: new Date().toISOString(),
  });
  await evidence(a.id, `answer-${index}`, resolved("0.012", true, 2));
  await call(fixture, "close_plan($1,$2)", [op.id, 4]);
  await settle(op.id);
  expect((await snapshot(op.id)).effectiveCost).toBe("0.012000000");
  const c = await admin.budgetPeriod.findFirstOrThrow({
    where: { userId: op.userId, bucket: "CHATGPT_OBSERVATION" },
  });
  expect(c.spent.toString()).toBe("1");
});
it("creates recoverable reconciliation before a worker can crash and fences stale completion", async () => {
  const op = await managed();
  await prepare(op);
  await admin.$executeRawUnsafe(
    "UPDATE lyraseo_ledger.reconciliation SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
    op.id,
  );
  const tasks = await call<{ operationId: string; fence: number }[]>(
    fixture,
    "claim_reconciliation($1)",
    [100],
  );
  const job = tasks.find((x) => x.operationId === op.id);
  expect(job).toBeDefined();
  await expect(
    call(fixture, "finish_reconciliation($1,$2,$3)", [
      op.id,
      job!.fence - 1,
      "UNAVAILABLE",
    ]),
  ).rejects.toThrow("STALE_RECONCILIATION");
  await call(fixture, "finish_reconciliation($1,$2,$3)", [
    op.id,
    job!.fence,
    "PROVIDER_PENDING",
  ]);
  const rows = await admin.$queryRawUnsafe<
    { reason: string; tries: number; next_attempt_at: Date }[]
  >(
    "SELECT reason,tries,next_attempt_at FROM lyraseo_ledger.reconciliation WHERE operation_id=$1",
    op.id,
  );
  expect(rows[0].tries).toBe(1);
  expect(rows[0].next_attempt_at.getTime()).toBeGreaterThan(Date.now());
});
it("cancels unstarted work once but preserves incurred exposure after INTENT", async () => {
  const before = await managed();
  await call(fixture, "cancel($1)", [before.id]);
  await call(fixture, "cancel($1)", [before.id]);
  expect(
    (
      await admin.budgetPeriod.findFirstOrThrow({
        where: { userId: before.userId, bucket: "AZURE" },
      })
    ).reserved.toString(),
  ).toBe("0");
  const after = await managed();
  const a = await prepare(after);
  await call(fixture, "cancel($1)", [after.id]);
  expect(
    (
      await admin.budgetPeriod.findFirstOrThrow({
        where: { userId: after.userId, bucket: "AZURE" },
      })
    ).reserved.toString(),
  ).toBe("0.2");
  await expect(
    prepare(after, "azure-response", 1, "b".repeat(64)),
  ).rejects.toThrow();
  await evidence(a.id, `cancel-late-${index}`, resolved("0.03", false));
  await call(fixture, "close_plan($1,$2)", [after.id, 3]);
  await settle(after.id);
  expect(
    (await admin.operation.findUniqueOrThrow({ where: { id: after.id } }))
      .status,
  ).toBe("CANCELLED");
});
it("rejects null concurrency and work-discovery bounds at the SQL boundary", async () => {
  const op = await managed();
  await expect(
    call(fixture, "prepare_attempt($1,$2,$3,$4,$5)", [
      op.id,
      op.fence,
      "azure-response",
      "a".repeat(64),
      null,
    ]),
  ).rejects.toThrow();
  await expect(
    call(fixture, "claim_reconciliation($1)", [null]),
  ).rejects.toThrow("INVALID_LIMIT");
});
it("binds a provider task identity to exactly one attempt within its provider account", async () => {
  const first = await managed();
  const a = await prepare(first);
  const task = `shared-task-${index}`;
  await evidence(a.id, `task-a-${index}`, {
    kind: "ACCEPTED",
    taskId: task,
    observedAt: new Date().toISOString(),
  });
  const second = await managed();
  const b = await prepare(second);
  await expect(
    evidence(b.id, `task-b-${index}`, {
      kind: "ACCEPTED",
      taskId: task,
      observedAt: new Date().toISOString(),
    }),
  ).rejects.toThrow();
});

for (const profile of profiles)
  it(`rehearses network-free ${profile.profile} through production ledger services`, async () => {
    const op = await managed(
      profile.kind,
      profile.provider,
      profile.steps.map((step) => ({ step, maximum: "0.10" })),
      "0.40",
    );
    for (let i = 0; i < profile.steps.length; i++) {
      const current = await readProviderLedger(fixture, op.id);
      const attempt = await prepareFixtureAttempt(fixture, {
        operationId: op.id,
        fence: op.fence,
        step: profile.steps[i],
        requestHash: "d".repeat(64),
        expectedRevision: current.revision,
      });
      await recordAttemptEvidence(
        fixture,
        attempt.id,
        `adapter-${profile.profile}-${index}-${i}`,
        fixtureAnswer(profile, i, new Date().toISOString()),
      );
    }
    const current = await readProviderLedger(fixture, op.id);
    await closeProviderAttemptPlan(fixture, op.id, current.revision);
    const closed = await readProviderLedger(fixture, op.id);
    const receipt = await settleManagedOperation(fixture, {
      operationId: op.id,
      expectedRevision: closed.revision,
      evidenceHash: closed.evidenceHash,
    });
    expect(receipt.classification).toBe("SYNTHETIC");
    expect((await readProviderLedger(fixture, op.id)).settled).toBe(true);
  });
it("replays the original local preparation key after a later retry without returning a newer attempt", async () => {
  const op = await managed(
    "GENERATION",
    "AZURE",
    [{ step: "azure-response", maximum: "0.10" }],
    "0.30",
  );
  const first = await prepare(op);
  await evidence(first.id, `identity-failed-${index}`, resolved("0.01", false));
  const second = await prepare(op, "azure-response", 2, "b".repeat(64));
  const replay = await prepare(op, "azure-response", 0, "a".repeat(64));
  expect(replay.id).toBe(first.id);
  expect(replay.id).not.toBe(second.id);
  expect(replay).toMatchObject({ replayed: true });
});
it("rolls back settlement when a required reserved budget bucket is missing", async () => {
  const op = await managed();
  const a = await prepare(op);
  await evidence(a.id, `missing-budget-${index}`, resolved("0.02"));
  await call(fixture, "close_plan($1,$2)", [op.id, 2]);
  await admin.budgetPeriod.deleteMany({
    where: { userId: op.userId, bucket: "AZURE" },
  });
  await expect(settle(op.id)).rejects.toThrow("BUDGET_STATE_UNAVAILABLE");
  expect(
    await admin.usageReceipt.count({ where: { operationId: op.id } }),
  ).toBe(0);
  expect(
    (await admin.operation.findUniqueOrThrow({ where: { id: op.id } }))
      .actualCost,
  ).toBeNull();
});

// Review round 1: every case uses the gate-owned database and actual restricted logins.
for (const pending of ["INTENT", "UNCERTAIN", "ACCEPTED"] as const)
  it(`keeps aggregate reconciliation discoverable when Extract resolves after Search ${pending}`, async () => {
    const op = await managed(
      "RESEARCH",
      "PARALLEL",
      [
        { step: "search", maximum: "0.10" },
        { step: "extract", maximum: "0.10" },
      ],
      "0.40",
    );
    const search = await prepare(op, "search"),
      extract = await prepare(op, "extract", 1);
    if (pending !== "INTENT")
      await evidence(search.id, `review-pending-${pending}-${index}`, {
        kind: pending,
        observedAt: new Date().toISOString(),
      });
    await evidence(
      extract.id,
      `review-extract-${pending}-${index}`,
      resolved("0.02"),
    );
    const [row] = await admin.$queryRawUnsafe<
      { reason: string; next_attempt_at: Date | null }[]
    >(
      "SELECT reason,next_attempt_at FROM lyraseo_ledger.reconciliation WHERE operation_id=$1",
      op.id,
    );
    expect(row?.reason).not.toBe("RESOLVED");
    expect(row?.next_attempt_at).not.toBeNull();
    await admin.$executeRawUnsafe(
      "UPDATE lyraseo_ledger.reconciliation SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
      op.id,
    );
    const jobs = await call<{ operationId: string }[]>(
      fixture,
      "claim_reconciliation($1)",
      [100],
    );
    expect(jobs.some((job) => job.operationId === op.id)).toBe(true);
    const current = await snapshot(op.id);
    await call(fixture, "close_plan($1,$2)", [op.id, current.revision]);
    await expect(settle(op.id)).rejects.toThrow("EXPOSURE_UNRESOLVED");
  });
for (const closeBeforeResolution of [false, true])
  it(`recovers a crash after the final resolution with plan ${closeBeforeResolution ? "closed" : "open"}`, async () => {
    const op = await managed(),
      attempt = await prepare(op);
    if (closeBeforeResolution)
      await call(fixture, "close_plan($1,$2)", [op.id, 1]);
    await evidence(
      attempt.id,
      `review-final-resolution-${closeBeforeResolution}-${index}`,
      resolved("0.03"),
    );
    const [row] = await admin.$queryRawUnsafe<
      { reason: string; next_attempt_at: Date | null }[]
    >(
      "SELECT reason,next_attempt_at FROM lyraseo_ledger.reconciliation WHERE operation_id=$1",
      op.id,
    );
    expect(row?.reason).toBe("AGGREGATE_PENDING");
    expect(row?.next_attempt_at).not.toBeNull();
    await admin.$executeRawUnsafe(
      "UPDATE lyraseo_ledger.reconciliation SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
      op.id,
    );
    expect(
      (
        await call<{ operationId: string }[]>(
          fixture,
          "claim_reconciliation($1)",
          [100],
        )
      ).some((job) => job.operationId === op.id),
    ).toBe(true);
    if (!closeBeforeResolution) {
      const current = await snapshot(op.id);
      await call(fixture, "close_plan($1,$2)", [op.id, current.revision]);
    }
    await settle(op.id);
    const [done] = await admin.$queryRawUnsafe<
      { reason: string; next_attempt_at: Date | null }[]
    >(
      "SELECT reason,next_attempt_at FROM lyraseo_ledger.reconciliation WHERE operation_id=$1",
      op.id,
    );
    expect(done).toEqual({ reason: "RESOLVED", next_attempt_at: null });
  });
it("derives pending exposure after out-of-order evidence on independent connections", async () => {
  const op = await managed(
      "RESEARCH",
      "PARALLEL",
      [
        { step: "search", maximum: "0.10" },
        { step: "extract", maximum: "0.10" },
      ],
      "0.40",
    ),
    search = await prepare(op, "search"),
    extract = await prepare(op, "extract", 1);
  const second = createDatabase(
    url("lyraseo_ledger_fixture", "local_ledger_only"),
  );
  try {
    await Promise.all([
      evidence(search.id, `review-concurrent-pending-${index}`, {
        kind: "UNCERTAIN",
        observedAt: new Date().toISOString(),
      }),
      call(second, "record_evidence($1::uuid,$2,$3::jsonb)", [
        extract.id,
        `review-concurrent-resolved-${index}`,
        JSON.stringify(resolved("0.02")),
      ]),
    ]);
    const [row] = await admin.$queryRawUnsafe<
      { reason: string; next_attempt_at: Date | null }[]
    >(
      "SELECT reason,next_attempt_at FROM lyraseo_ledger.reconciliation WHERE operation_id=$1",
      op.id,
    );
    expect(row?.reason).not.toBe("RESOLVED");
    expect(row?.next_attempt_at).not.toBeNull();
  } finally {
    await second.$disconnect();
  }
});
async function admitSiblingPair(provider = "AZURE") {
  const actor = { ...sponsor, userId: `fixture-ledger-shared-${index++}` };
  await admin.productUser.create({ data: { id: actor.userId } });
  await admin.membership.create({
    data: {
      workspaceId: "ledger-workspace",
      userId: actor.userId,
      role: "OWNER",
    },
  });
  const operations = [];
  for (const engine of ["AZURE", provider])
    operations.push(
      await admitOperation(runtime, actor, {
        workspaceId: "ledger-workspace",
        siteId: "ledger-site",
        kind: engine === "PARALLEL" ? "RESEARCH" : "GENERATION",
        provider: engine as "AZURE",
        route: "fixture-ledger",
        idempotencyKey: `sibling-${index++}`,
        input: { label: "SYNTHETIC" },
        maximumCost: "0.20",
        tariffVersion: "synthetic-fixture-v1",
      }),
    );
  return { actor, origin: operations[0]!, sibling: operations[1]! };
}
async function leaseAndEnroll(
  op: Awaited<ReturnType<typeof operation>>,
  actor: typeof sponsor,
) {
  const lease = await claimOperation(runtime, actor, op.id, "fixture");
  await call(admin, "enroll_fixture($1,$2::jsonb)", [
    op.id,
    JSON.stringify([{ step: "step", maximum: "0.10" }]),
  ]);
  return { ...op, fence: lease.fence };
}
for (const correction of [false, true])
  for (const combined of [false, true])
    it(`enforces reachable sibling pause after ${correction ? "corrective" : "initial"} ${combined ? "COMBINED" : "provider"} overrun`, async () => {
      const group = await admitSiblingPair(combined ? "PARALLEL" : "AZURE"),
        origin = await leaseAndEnroll(group.origin, group.actor),
        attempt = await prepare(origin, "step"),
        amount = combined ? "10.10" : "9.00";
      await evidence(
        attempt.id,
        `review-overrun-base-${index}`,
        resolved(correction ? "0.02" : amount),
      );
      await call(fixture, "close_plan($1,$2)", [origin.id, 2]);
      await settle(origin.id);
      let sibling: typeof origin | undefined;
      if (correction) {
        sibling = await leaseAndEnroll(group.sibling, group.actor);
        const event = await evidence(
          attempt.id,
          `review-overrun-corrected-${index}`,
          resolved(amount, true, 2),
        );
        await call(fixture, "apply_adjustment($1,$2)", [
          origin.id,
          event.revision,
        ]);
        const second = createDatabase(
          url("lyraseo_ledger_fixture", "local_ledger_only"),
        );
        try {
          await expect(
            call(second, "prepare_attempt($1,$2,$3,$4,$5)", [
              sibling.id,
              sibling.fence,
              "step",
              "b".repeat(64),
              0,
            ]),
          ).rejects.toThrow("BUDGET_PAUSED");
        } finally {
          await second.$disconnect();
        }
      } else
        await expect(
          claimOperation(runtime, group.actor, group.sibling.id, "fixture"),
        ).rejects.toThrow("USER_BUSY");
      const [relation] = await admin.$queryRawUnsafe<{ name: string | null }[]>(
        "SELECT to_regclass('lyraseo_ledger.budget_pause')::text AS name",
      );
      expect(relation?.name).not.toBeNull();
      const pauses = await admin.$queryRawUnsafe<{ bucket: string }[]>(
        "SELECT bucket FROM lyraseo_ledger.budget_pause WHERE user_id=$1 AND period=$2 ORDER BY bucket",
        origin.userId,
        origin.period,
      );
      expect(pauses.map((p) => p.bucket)).toEqual(
        combined ? ["AZURE", "COMBINED"] : ["AZURE"],
      );
      const budgets = await admin.budgetPeriod.findMany({
        where: { userId: origin.userId },
      });
      expect(budgets.find((b) => b.bucket === "AZURE")?.spent.toFixed(9)).toBe(
        combined ? "10.100000000" : "9.000000000",
      );
      expect(
        budgets.find((b) => b.bucket === "COMBINED")?.spent.toFixed(9),
      ).toBe(combined ? "10.100000000" : "9.000000000");
      expect(
        budgets
          .filter((b) => ["PARALLEL", "DATAFORSEO"].includes(b.bucket))
          .every((b) => b.spent.eq(0)),
      ).toBe(true);
      const unrelated = await managed();
      expect((await prepare(unrelated)).id).toBeTruthy();
    });
for (const combined of [false, true])
  it(`defensively blocks a restored coexistent lease after initial ${combined ? "COMBINED" : "provider"} overrun (administrator SQL fixture only)`, async () => {
    const group = await admitSiblingPair(combined ? "PARALLEL" : "AZURE");
    // Current claimOperation permits one active owner job. This intentionally
    // administrator-constructed state tests the ledger SQL boundary defensively;
    // it is not evidence of production reachability or live provider execution.
    const leaseUntil = new Date(Date.now() + 90000);
    const operations = [];
    for (const op of [group.origin, group.sibling]) {
      await admin.operation.update({
        where: { id: op.id },
        data: {
          status: "RUNNING",
          fence: 1,
          leaseOwner: "restored-fixture",
          leaseUntil,
        },
      });
      await call(admin, "enroll_fixture($1,$2::jsonb)", [
        op.id,
        JSON.stringify([{ step: "step", maximum: "0.10" }]),
      ]);
      operations.push({ ...op, fence: 1 });
    }
    const origin = operations[0]!,
      sibling = operations[1]!,
      attempt = await prepare(origin, "step");
    await evidence(
      attempt.id,
      `review-defensive-initial-${index}`,
      resolved(combined ? "10.10" : "9.00"),
    );
    await call(fixture, "close_plan($1,$2)", [origin.id, 2]);
    await settle(origin.id);
    const second = createDatabase(
      url("lyraseo_ledger_fixture", "local_ledger_only"),
    );
    try {
      await expect(
        call(second, "prepare_attempt($1,$2,$3,$4,$5)", [
          sibling.id,
          sibling.fence,
          "step",
          "b".repeat(64),
          0,
        ]),
      ).rejects.toThrow("BUDGET_PAUSED");
    } finally {
      await second.$disconnect();
    }
  });
it("allows only one replacement across both Parallel steps", async () => {
  const op = await managed(
    "RESEARCH",
    "PARALLEL",
    [
      { step: "search", maximum: "0.05" },
      { step: "extract", maximum: "0.05" },
    ],
    "0.40",
  );
  const search = await prepare(op, "search"),
    extract = await prepare(op, "extract", 1);
  await evidence(
    search.id,
    `review-retry-search-failed-${index}`,
    resolved("0.01", false),
  );
  await evidence(
    extract.id,
    `review-retry-extract-failed-${index}`,
    resolved("0.01", false),
  );
  const current = await snapshot(op.id),
    replacement = await prepare(op, "search", current.revision, "b".repeat(64));
  await evidence(
    replacement.id,
    `review-retry-search-replaced-${index}`,
    resolved("0.01"),
  );
  const latest = await snapshot(op.id);
  await expect(
    prepare(op, "extract", latest.revision, "c".repeat(64)),
  ).rejects.toThrow("RETRY_NOT_ALLOWED");
});
it("consumes one operation-wide retry under competing connections and rejects a refreshed second replacement", async () => {
  const op = await managed(
      "RESEARCH",
      "PARALLEL",
      [
        { step: "search", maximum: "0.05" },
        { step: "extract", maximum: "0.05" },
      ],
      "0.40",
    ),
    search = await prepare(op, "search"),
    extract = await prepare(op, "extract", 1);
  await evidence(
    search.id,
    `review-racing-search-${index}`,
    resolved("0.01", false),
  );
  await evidence(
    extract.id,
    `review-racing-extract-${index}`,
    resolved("0.01", false),
  );
  const current = await snapshot(op.id),
    second = createDatabase(url("lyraseo_ledger_fixture", "local_ledger_only"));
  try {
    const result = await Promise.allSettled([
      prepare(op, "search", current.revision, "b".repeat(64)),
      call<{ id: string }>(second, "prepare_attempt($1,$2,$3,$4,$5)", [
        op.id,
        op.fence,
        "extract",
        "c".repeat(64),
        current.revision,
      ]),
    ]);
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const loser = result[0].status === "fulfilled" ? "extract" : "search",
      latest = await snapshot(op.id);
    await expect(
      prepare(op, loser, latest.revision, "d".repeat(64)),
    ).rejects.toThrow("RETRY_NOT_ALLOWED");
    const [count] = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*) FROM lyraseo_ledger.attempt WHERE operation_id=$1 AND ordinal=1",
      op.id,
    );
    expect(Number(count?.count)).toBe(1);
  } finally {
    await second.$disconnect();
  }
});
it("preserves late facts and settlement for an in-flight sibling after a shared pause", async () => {
  const group = await admitSiblingPair(),
    origin = await leaseAndEnroll(group.origin, group.actor),
    a = await prepare(origin, "step");
  await evidence(a.id, `review-late-origin-${index}`, resolved("0.02"));
  await call(fixture, "close_plan($1,$2)", [origin.id, 2]);
  await settle(origin.id);
  const sibling = await leaseAndEnroll(group.sibling, group.actor),
    b = await prepare(sibling, "step");
  const corrected = await evidence(
    a.id,
    `review-late-overrun-${index}`,
    resolved("9.00", true, 2),
  );
  await call(fixture, "apply_adjustment($1,$2)", [
    origin.id,
    corrected.revision,
  ]);
  expect(await snapshot(sibling.id)).toMatchObject({ paused: true });
  const receipt = await evidence(
    b.id,
    `review-late-sibling-${index}`,
    resolved("0.01", false),
  );
  await call(fixture, "close_plan($1,$2)", [sibling.id, receipt.revision]);
  await settle(sibling.id);
  expect(
    (
      await admin.usageReceipt.findFirstOrThrow({
        where: { operationId: sibling.id },
      })
    ).amount.toString(),
  ).toBe("0.01");
  expect(
    (
      await admin.budgetPeriod.findFirstOrThrow({
        where: { userId: origin.userId, bucket: "AZURE" },
      })
    ).spent.toString(),
  ).toBe("9.01");
});
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it("waits for the owner budget transaction before authorizing an admitted sibling", async () => {
  const group = await admitSiblingPair(),
    origin = await leaseAndEnroll(group.origin, group.actor),
    a = await prepare(origin, "step");
  await evidence(a.id, `review-blocking-base-${index}`, resolved("0.02"));
  await call(fixture, "close_plan($1,$2)", [origin.id, 2]);
  await settle(origin.id);
  const sibling = await leaseAndEnroll(group.sibling, group.actor);
  const event = await evidence(
      a.id,
      `review-blocking-overrun-${index}`,
      resolved("9.00", true, 2),
    ),
    written = signal(),
    commit = signal(),
    pidReady = signal();
  let pid = 0;
  const second = createDatabase(
    url("lyraseo_ledger_fixture", "local_ledger_only"),
  );
  const originResult = fixture
    .$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT lyraseo_ledger.apply_adjustment($1,$2)",
          origin.id,
          event.revision,
        );
        written.resolve();
        await commit.promise;
      },
      { timeout: 10000 },
    )
    .then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );
  try {
    await Promise.race([
      written.promise,
      originResult.then((result) => {
        if (!result.ok) throw result.error;
      }),
    ]);
    const siblingResult = second
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
          const rows = await tx.$queryRawUnsafe<{ pid: number }[]>(
            "SELECT pg_backend_pid() AS pid",
          );
          pid = rows[0]!.pid;
          pidReady.resolve();
          return tx.$queryRawUnsafe(
            "SELECT lyraseo_ledger.prepare_attempt($1,$2,$3,$4,$5)",
            sibling.id,
            sibling.fence,
            "step",
            "b".repeat(64),
            0,
          );
        },
        { timeout: 10000 },
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
    await pidReady.promise;
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const rows = await admin.$queryRawUnsafe<{ waiting: boolean }[]>(
        "SELECT wait_event_type='Lock' AND wait_event='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()",
        pid,
      );
      waiting = rows[0]?.waiting === true;
      if (!waiting) await new Promise((r) => setTimeout(r, 10));
    }
    expect(waiting).toBe(true);
    commit.resolve();
    expect(await originResult).toEqual({ ok: true });
    const result = await siblingResult;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain("BUDGET_PAUSED");
  } finally {
    commit.resolve();
    await originResult;
    await second.$disconnect();
  }
});
for (const action of ["cancel", "recover"] as const)
  it(`completes preparation racing generic ${action} without a lock cycle`, async () => {
    const { cancelOperation } =
        await import("../../packages/db/src/accounting"),
      { recoverOperations } = await import("../../packages/db/src/execution");
    const op = await managed(),
      actor = { ...sponsor, userId: op.userId };
    const runtimeUri = new URL(url("lyraseo_runtime", "local_runtime_only")),
      fixtureUri = new URL(url("lyraseo_ledger_fixture", "local_ledger_only"));
    for (const uri of [runtimeUri, fixtureUri])
      uri.searchParams.set(
        "options",
        "-c lock_timeout=3000 -c statement_timeout=5000",
      );
    const service = createDatabase(runtimeUri.href),
      worker = createDatabase(fixtureUri.href);
    try {
      const limits = await worker.$queryRawUnsafe<
        { lock_timeout: string; statement_timeout: string }[]
      >(
        "SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout",
      );
      expect(limits[0]).toEqual({
        lock_timeout: "3s",
        statement_timeout: "5s",
      });
      const result = await Promise.allSettled([
        prepareFixtureAttempt(worker, {
          operationId: op.id,
          fence: op.fence,
          step: "azure-response",
          requestHash: "f".repeat(64),
          expectedRevision: 0,
        }),
        action === "cancel"
          ? cancelOperation(service, actor, op.id)
          : recoverOperations(service, actor, new Date(Date.now() + 120000)),
      ]);
      expect(result[0].status).toBe("fulfilled");
      expect(result[1].status).toBe("rejected");
      if (result[1].status === "rejected") {
        expect(String(result[1].reason)).toContain("MANAGED_LEDGER_REQUIRED");
        expect(String(result[1].reason)).not.toMatch(/deadlock|timeout/i);
      }
    } finally {
      await Promise.all([service.$disconnect(), worker.$disconnect()]);
    }
  });
it("reopens only financial finalization after definitive evidence follows exhausted uncertainty", async () => {
  const op = await managed(),
    a = await prepare(op);
  await admin.$executeRawUnsafe(
    "UPDATE lyraseo_ledger.reconciliation SET tries=12,reason='EXHAUSTED',next_attempt_at=NULL,lease_until=NULL WHERE operation_id=$1",
    op.id,
  );
  await evidence(a.id, `review-exhausted-final-${index}`, resolved("0.02"));
  const [row] = await admin.$queryRawUnsafe<
    { tries: number; reason: string; next_attempt_at: Date | null }[]
  >(
    "SELECT tries,reason,next_attempt_at FROM lyraseo_ledger.reconciliation WHERE operation_id=$1",
    op.id,
  );
  expect(row?.reason).toBe("AGGREGATE_PENDING");
  expect(row?.tries).toBe(0);
  expect(row?.next_attempt_at).not.toBeNull();
  expect((await prepare(op)).id).toBe(a.id);
});
