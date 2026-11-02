import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  admitOperation,
  claimOperation,
  beginAttempt,
  acceptAttempt,
  settleOperation,
  cancelOperation,
  expireQueued,
  budgetSnapshot,
} from "../../packages/db/src/accounting";
import {
  actor,
  resetDatabase,
  seedTenants,
  runtimeUrl,
  adminUrl,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
const request = (id: string, cost = "0.30") => ({
  workspaceId: "a",
  siteId: "a-site",
  kind: "GENERATION" as const,
  provider: "AZURE" as const,
  route: "content",
  idempotencyKey: id,
  input: { revision: 1 },
  maximumCost: cost,
  tariffVersion: "synthetic-test-v1",
});
it("does not overspend under simultaneous admissions on separate connections", async () => {
  const second = createDatabase(runtimeUrl);
  try {
    await admitOperation(db, actor, request("initial", "7.60"));
    const results = await Promise.allSettled([
      admitOperation(db, actor, request("a")),
      admitOperation(second, actor, request("b")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await admin.operation.count()).toBe(2);
    expect(await admin.outboxEvent.count()).toBe(2);
    const rows = await budgetSnapshot(db, actor);
    expect(rows.find((r) => r.bucket === "AZURE")?.reserved.toString()).toBe(
      "7.9",
    );
  } finally {
    await second.$disconnect();
  }
});
it("replays same key/input once, rejecting changed scope or cost", async () => {
  const a = await admitOperation(db, actor, request("same"));
  const b = await admitOperation(db, actor, request("same"));
  expect(a.id).toBe(b.id);
  await expect(
    admitOperation(db, actor, { ...request("same"), input: { revision: 2 } }),
  ).rejects.toThrow("CONFLICT");
  expect(await admin.outboxEvent.count()).toBe(1);
});
it("records actual cost once even for failed output and releases unused commitment", async () => {
  const op = await admitOperation(db, actor, request("settle"));
  const lease = await claimOperation(db, actor, op.id, "worker");
  await beginAttempt(db, actor, op.id, lease.fence);
  await acceptAttempt(db, actor, op.id, lease.fence, "task-1");
  const receipt = {
    receiptId: "receipt-1",
    amount: "0.12",
    acceptedOutput: false,
  };
  await settleOperation(db, actor, op.id, lease.fence, receipt);
  await settleOperation(db, actor, op.id, lease.fence, receipt);
  const rows = await budgetSnapshot(db, actor);
  expect(rows.find((r) => r.bucket === "AZURE")?.spent.toString()).toBe("0.12");
  expect(rows.find((r) => r.bucket === "AZURE")?.reserved.toString()).toBe("0");
  expect(await admin.usageReceipt.count()).toBe(1);
});
it("cancels undispatched jobs without spending, but retains accepted commitments", async () => {
  const a = await admitOperation(db, actor, request("cancel"));
  await cancelOperation(db, actor, a.id);
  expect(
    (await admin.operation.findUniqueOrThrow({ where: { id: a.id } })).status,
  ).toBe("CANCELLED");
  const b = await admitOperation(db, actor, request("accepted"));
  const lease = await claimOperation(db, actor, b.id, "worker");
  await beginAttempt(db, actor, b.id, lease.fence);
  await cancelOperation(db, actor, b.id);
  expect(
    (await admin.operation.findUniqueOrThrow({ where: { id: b.id } })).status,
  ).toBe("RECONCILING");
  expect(
    (await budgetSnapshot(db, actor))
      .find((r) => r.bucket === "AZURE")
      ?.reserved.toString(),
  ).toBe("0.3");
});
it("prevents stale workers from writing after lease fencing changes", async () => {
  const op = await admitOperation(db, actor, request("fence"));
  const first = await claimOperation(db, actor, op.id, "first");
  await admin.operation.update({
    where: { id: op.id },
    data: { leaseUntil: new Date(0) },
  });
  const second = await claimOperation(db, actor, op.id, "second");
  expect(second.fence).toBeGreaterThan(first.fence);
  await expect(beginAttempt(db, actor, op.id, first.fence)).rejects.toThrow(
    "STALE_LEASE",
  );
});
it("keeps uncertain provider acceptance reconciling after a crash", async () => {
  const op = await admitOperation(db, actor, request("unknown"));
  const lease = await claimOperation(db, actor, op.id, "one");
  await beginAttempt(db, actor, op.id, lease.fence);
  await admin.operation.update({
    where: { id: op.id },
    data: { leaseUntil: new Date(0) },
  });
  await expect(claimOperation(db, actor, op.id, "two")).rejects.toThrow(
    "RECONCILING",
  );
  expect(
    (await admin.operation.findUniqueOrThrow({ where: { id: op.id } })).status,
  ).toBe("RECONCILING");
});
it("releases expired queued work but does not erase accepted work", async () => {
  const op = await admitOperation(db, actor, request("expire"));
  await admin.operation.update({
    where: { id: op.id },
    data: { expiresAt: new Date(0) },
  });
  await expireQueued(db, actor, op.id);
  expect(
    (await budgetSnapshot(db, actor))
      .find((r) => r.bucket === "AZURE")
      ?.reserved.toString(),
  ).toBe("0");
});
it("enforces per-user observation allowances across workspaces", async () => {
  for (let i = 0; i < 25; i++)
    await admitOperation(db, actor, {
      ...request(`obs-${i}`, "0.001"),
      kind: "API_OBSERVATION",
      workspaceId: i % 2 ? "b" : "a",
      siteId: i % 2 ? "b-site" : "a-site",
    });
  await expect(
    admitOperation(db, actor, {
      ...request("obs-26", "0.001"),
      kind: "API_OBSERVATION",
    }),
  ).rejects.toThrow("BUDGET_EXHAUSTED");
});
it("denies tampered owner, unverified sites and deleted/suspended scopes", async () => {
  await expect(
    admitOperation(db, { ...actor, userId: "viewer" }, request("viewer")),
  ).rejects.toThrow("FORBIDDEN");
  await admin.site.update({
    where: { id: "a-site" },
    data: { verifiedAt: null },
  });
  await expect(
    admitOperation(db, actor, request("unverified")),
  ).rejects.toThrow("SITE_UNVERIFIED");
});
it("uses exact decimal costs and rejects invalid or negative estimates", async () => {
  await expect(
    admitOperation(db, actor, request("bad", "NaN")),
  ).rejects.toThrow("INVALID_COST");
  await expect(admitOperation(db, actor, request("neg", "-1"))).rejects.toThrow(
    "INVALID_COST",
  );
  await expect(
    admitOperation(db, actor, request("tiny", "0.0000000001")),
  ).rejects.toThrow("INVALID_COST");
});
it("records an unavoidable accepted charge after account suspension", async () => {
  const op = await admitOperation(db, actor, request("suspended-charge"));
  const lease = await claimOperation(db, actor, op.id, "worker");
  await beginAttempt(db, actor, op.id, lease.fence);
  await acceptAttempt(
    db,
    actor,
    op.id,
    lease.fence,
    "accepted-before-suspension",
  );
  await admin.productUser.update({
    where: { id: actor.userId },
    data: { suspended: true, securityVersion: 1 },
  });
  await settleOperation(db, actor, op.id, lease.fence, {
    receiptId: "late-charge",
    amount: "0.12",
    acceptedOutput: false,
  });
  expect(
    (
      await admin.budgetPeriod.findFirstOrThrow({
        where: { userId: actor.userId, bucket: "AZURE" },
      })
    ).spent.toString(),
  ).toBe("0.12");
  await expect(
    admitOperation(db, actor, request("no-new-work")),
  ).rejects.toThrow("FORBIDDEN");
});
it("permits one running expensive job per user across workspaces", async () => {
  const a = await admitOperation(db, actor, request("one"));
  const b = await admitOperation(db, actor, {
    ...request("two"),
    workspaceId: "b",
    siteId: "b-site",
  });
  const results = await Promise.allSettled([
    claimOperation(db, actor, a.id, "one"),
    claimOperation(db, actor, b.id, "two"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
it("blocks legacy archive reads and acknowledgements while fencing duplicate execution", async () => {
  const op = await admitOperation(db, actor, request("outbox"));
  await expect(db.outboxEvent.findMany()).rejects.toThrow(/denied/);
  await expect(
    db.outboxEvent.updateMany({ data: { deliveredAt: new Date() } }),
  ).rejects.toThrow(/denied/);
  await claimOperation(db, actor, op.id, "worker");
  await expect(claimOperation(db, actor, op.id, "duplicate")).rejects.toThrow(
    "LEASE_BUSY",
  );
});
it("settles against the original UTC month and records overruns honestly", async () => {
  const prior = new Date();
  prior.setUTCDate(1);
  prior.setUTCHours(0, 0, 0, 0);
  const next = new Date(prior);
  next.setUTCMonth(next.getUTCMonth() + 1);
  await admin.site.update({
    where: { id: "a-site" },
    data: { verifiedAt: prior },
  });
  const op = await admitOperation(db, actor, request("month"), prior);
  const lease = await claimOperation(db, actor, op.id, "worker", prior);
  await beginAttempt(db, actor, op.id, lease.fence, prior);
  await acceptAttempt(db, actor, op.id, lease.fence, "task", prior);
  await settleOperation(
    db,
    actor,
    op.id,
    lease.fence,
    { receiptId: "overrun", amount: "0.40", acceptedOutput: true },
    next,
  );
  const previous = await admin.budgetPeriod.findFirstOrThrow({
    where: {
      userId: actor.userId,
      period: prior.toISOString().slice(0, 7),
      bucket: "AZURE",
    },
  });
  expect(previous.spent.toString()).toBe("0.4");
  expect(
    (await budgetSnapshot(db, actor, next))
      .find((b) => b.bucket === "AZURE")!
      .spent.toString(),
  ).toBe("0");
  expect(
    (await admin.operation.findUniqueOrThrow({ where: { id: op.id } })).status,
  ).toBe("RECONCILING");
});
it("records known acceptance after lease expiry and revocation without redispatch", async () => {
  const op = await admitOperation(db, actor, request("late-accept"));
  const lease = await claimOperation(db, actor, op.id, "worker");
  await beginAttempt(db, actor, op.id, lease.fence);
  await admin.operation.update({
    where: { id: op.id },
    data: { leaseUntil: new Date(0) },
  });
  await admin.productUser.update({
    where: { id: actor.userId },
    data: { suspended: true, securityVersion: 1 },
  });
  await admin.site.update({
    where: { id: op.siteId },
    data: { deletedAt: new Date() },
  });
  await acceptAttempt(db, actor, op.id, lease.fence, "late-task");
  const receipt = {
    receiptId: "late-receipt",
    amount: "0.1",
    acceptedOutput: false,
  };
  const saved = await settleOperation(db, actor, op.id, lease.fence, receipt);
  expect(await settleOperation(db, actor, op.id, lease.fence, receipt)).toEqual(
    saved,
  );
  for (const change of [
    { receiptId: "different" },
    { acceptedOutput: true },
    { amount: "0.2" },
  ])
    await expect(
      settleOperation(db, actor, op.id, lease.fence, { ...receipt, ...change }),
    ).rejects.toThrow("CONFLICT");
  await expect(
    admin.usageReceipt.update({
      where: { id: saved.id },
      data: { amount: "0" },
    }),
  ).rejects.toThrow("IMMUTABLE_HISTORY");
  await expect(
    admin.usageReceipt.delete({ where: { id: saved.id } }),
  ).rejects.toThrow("IMMUTABLE_HISTORY");
  const balances = await admin.budgetPeriod.findMany({
    where: { bucket: { in: ["COMBINED", "AZURE"] } },
  });
  expect(
    balances.map((b) => [b.spent.toFixed(9), b.reserved.toFixed(9)]),
  ).toEqual([
    ["0.100000000", "0.000000000"],
    ["0.100000000", "0.000000000"],
  ]);
  expect(await admin.usageReceipt.count()).toBe(1);
  expect(
    await admin.workDispatch.findUniqueOrThrow({
      where: { operationId: op.id },
    }),
  ).toMatchObject({ disposition: "SUPPRESSED" });
  expect(
    (await admin.operation.findUniqueOrThrow({ where: { id: op.id } }))
      .providerTaskId,
  ).toBe("late-task");
});
it("releases expired work that crashed after claim but before dispatch intent", async () => {
  const op = await admitOperation(db, actor, request("pre-intent-crash"));
  await claimOperation(db, actor, op.id, "crashed");
  await admin.operation.update({
    where: { id: op.id },
    data: { leaseUntil: new Date(0), expiresAt: new Date(0) },
  });
  await expireQueued(db, actor, op.id);
  expect(
    (await budgetSnapshot(db, actor))
      .find((b) => b.bucket === "AZURE")!
      .reserved.toString(),
  ).toBe("0");
});
it("refuses dispatch after ownership proof is revoked", async () => {
  const op = await admitOperation(db, actor, request("revoked-proof"));
  const lease = await claimOperation(db, actor, op.id, "worker");
  await admin.site.update({
    where: { id: "a-site" },
    data: { verifiedAt: null },
  });
  await expect(beginAttempt(db, actor, op.id, lease.fence)).rejects.toThrow(
    "SITE_UNVERIFIED",
  );
});

it("returns default budgets without creating rows on a read", async () => {
  const rows = await budgetSnapshot(db, actor);
  expect(rows).toHaveLength(7);
  expect(rows.find((r) => r.bucket === "COMBINED")?.limit.toString()).toBe(
    "10",
  );
  expect(await admin.budgetPeriod.count()).toBe(0);
});
it("refuses dispatch after the operation deadline even with a live lease", async () => {
  const op = await admitOperation(db, actor, request("deadline"));
  const lease = await claimOperation(db, actor, op.id, "worker");
  await admin.operation.update({
    where: { id: op.id },
    data: { expiresAt: new Date(0) },
  });
  await expect(beginAttempt(db, actor, op.id, lease.fence)).rejects.toThrow(
    "EXPIRED",
  );
});
it("does not dispatch an old operation after account security changes", async () => {
  const op = await admitOperation(db, actor, request("security-change"));
  const lease = await claimOperation(db, actor, op.id, "worker");
  await admin.productUser.update({
    where: { id: actor.userId },
    data: { securityVersion: 1 },
  });
  await expect(
    beginAttempt(db, { ...actor, securityVersion: 1 }, op.id, lease.fence),
  ).rejects.toThrow("FORBIDDEN");
});
