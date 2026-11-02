import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  issueOperationQuote,
  admitQuotedOperation,
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
const request = () => ({
  workspaceId: "a",
  siteId: "a-site",
  kind: "GENERATION" as const,
  provider: "AZURE" as const,
  route: "content",
  input: { revision: 1 },
  maximumCost: "0.123456789",
  tariffVersion: "synthetic-test-v1",
});
const admit = (quoteId: string, idempotencyKey = "retry") =>
  admitQuotedOperation(db, actor, { quoteId, idempotencyKey });
it("persists trusted scope and exact cost and replays one reservation/outbox", async () => {
  const quote = await issueOperationQuote(db, actor, request());
  expect(quote.maximumCost.toFixed(9)).toBe("0.123456789");
  expect(quote.requestInput).toEqual(request().input);
  expect(quote.inputHash).toMatch(/^[a-f0-9]{64}$/);
  const op = await admit(quote.id);
  expect(op.siteId).toBe("a-site");
  expect(op.requestInput).toEqual(request().input);
  expect(op.reservedCost.toFixed(9)).toBe("0.123456789");
  expect((await admit(quote.id)).id).toBe(op.id);
  await expect(admit(quote.id, "changed")).rejects.toThrow("QUOTE_CONSUMED");
  expect(await admin.operation.count()).toBe(1);
  expect(await admin.outboxEvent.count()).toBe(1);
  const archive = await admin.outboxEvent.findUniqueOrThrow({
    where: { operationId: op.id },
  });
  expect(
    await admin.workDispatch.findUniqueOrThrow({
      where: { operationId: op.id },
    }),
  ).toMatchObject({
    archiveId: archive.id,
    eligibility: "QUARANTINED",
    disposition: "INERT",
    nextAttemptAt: null,
  });
  expect(
    (await budgetSnapshot(db, actor))
      .find((x) => x.bucket === "AZURE")
      ?.reserved.toFixed(9),
  ).toBe("0.123456789");
});
it("rejects expired quotes at the exact deadline without reserving", async () => {
  const now = new Date();
  const quote = await issueOperationQuote(
    db,
    actor,
    { ...request(), expiresAt: new Date(now.getTime() + 1000) },
    now,
  );
  await expect(
    admitQuotedOperation(
      db,
      actor,
      { quoteId: quote.id, idempotencyKey: "expired" },
      quote.expiresAt,
    ),
  ).rejects.toThrow("QUOTE_EXPIRED");
  expect(await admin.budgetPeriod.count()).toBe(0);
  expect(await admin.outboxEvent.count()).toBe(0);
});
it("rejects another user's quote and reauthorizes revoked site access", async () => {
  const quote = await issueOperationQuote(db, actor, request());
  await expect(
    admitQuotedOperation(
      db,
      { ...actor, userId: "other" },
      { quoteId: quote.id, idempotencyKey: "stolen" },
    ),
  ).rejects.toThrow("NOT_FOUND");
  await admin.membership.delete({
    where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
  });
  await expect(admit(quote.id)).rejects.toThrow("FORBIDDEN");
  await expect(issueOperationQuote(db, actor, request())).rejects.toThrow(
    "FORBIDDEN",
  );
  expect(await admin.operation.count()).toBe(0);
});
it("rejects stale security versions even for a newly authenticated actor", async () => {
  const quote = await issueOperationQuote(db, actor, request());
  await admin.productUser.update({
    where: { id: actor.userId },
    data: { securityVersion: 1 },
  });
  await expect(admit(quote.id)).rejects.toThrow("FORBIDDEN");
  await expect(
    admitQuotedOperation(
      db,
      { ...actor, securityVersion: 1 },
      { quoteId: quote.id, idempotencyKey: "new-session" },
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("atomically consumes once under simultaneous different keys on separate connections", async () => {
  const quote = await issueOperationQuote(db, actor, request());
  const other = createDatabase(runtimeUrl);
  try {
    const results = await Promise.allSettled([
      admit(quote.id, "first"),
      admitQuotedOperation(other, actor, {
        quoteId: quote.id,
        idempotencyKey: "second",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .map((r) => String(r.reason)),
    ).toEqual(["Error: QUOTE_CONSUMED"]);
    expect(await admin.operation.count()).toBe(1);
    expect(await admin.outboxEvent.count()).toBe(1);
  } finally {
    await other.$disconnect();
  }
});
it("rolls back consumption when the budget cannot reserve and rejects key collisions", async () => {
  const expensive = await issueOperationQuote(db, actor, {
    ...request(),
    maximumCost: "8.000000001",
  });
  await expect(admit(expensive.id)).rejects.toThrow("BUDGET_EXHAUSTED");
  expect(
    (
      await admin.operationQuote.findUniqueOrThrow({
        where: { id: expensive.id },
      })
    ).consumedOperationId,
  ).toBeNull();
  expect(await admin.budgetPeriod.count()).toBe(0);
  const first = await issueOperationQuote(db, actor, request());
  await admit(first.id);
  const second = await issueOperationQuote(db, actor, request());
  await expect(admit(second.id)).rejects.toThrow("CONFLICT");
  expect(
    (await admin.operationQuote.findUniqueOrThrow({ where: { id: second.id } }))
      .consumedOperationId,
  ).toBeNull();
});
it("rejects cross-workspace site issuance and revoked verification", async () => {
  await expect(
    issueOperationQuote(db, actor, { ...request(), siteId: "b-site" }),
  ).rejects.toThrow("NOT_FOUND");
  const quote = await issueOperationQuote(db, actor, request());
  await admin.site.update({
    where: { id: "a-site" },
    data: { verifiedAt: null },
  });
  await expect(admit(quote.id)).rejects.toThrow("SITE_UNVERIFIED");
});

it("ignores forged admission pricing and scope and hides quotes without actor context", async () => {
  const quote = await issueOperationQuote(db, actor, request());
  expect(await db.operationQuote.findMany()).toEqual([]);
  const forged = {
    quoteId: quote.id,
    idempotencyKey: "forged-fields",
    workspaceId: "b",
    siteId: "b-site",
    maximumCost: "0.000000001",
    tariffVersion: "customer-pricing",
  };
  const op = await admitQuotedOperation(db, actor, forged);
  expect(op.workspaceId).toBe("a");
  expect(op.siteId).toBe("a-site");
  expect(op.reservedCost.toFixed(9)).toBe("0.123456789");
  expect(op.tariffVersion).toBe("synthetic-test-v1");
});

it("rejects non-JSON input without creating a quote or reservation", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = new Array(1);
  for (const input of [
    undefined,
    { missing: undefined },
    [undefined],
    { value: NaN },
    Infinity,
    new Date(),
    cyclic,
    sparse,
    BigInt(1),
  ]) {
    await expect(
      issueOperationQuote(db, actor, { ...request(), input }),
    ).rejects.toThrow("INVALID_INPUT");
  }
  expect(await admin.operationQuote.count()).toBe(0);
  expect(await admin.budgetPeriod.count()).toBe(0);
});
it("preserves normalized nested JSON and null input for executable work", async () => {
  const input = { nested: [null, true, { z: 2, a: "value" }], value: 0 };
  const quote = await issueOperationQuote(db, actor, { ...request(), input });
  expect(quote.requestInput).toEqual(input);
  expect((await admit(quote.id)).requestInput).toEqual(input);
  const nil = await issueOperationQuote(db, actor, {
    ...request(),
    input: null,
  });
  expect((await admit(nil.id, "null-input")).requestInput).toBeNull();
});
