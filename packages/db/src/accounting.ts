import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type Operation } from "../generated/client";
import {
  withActor,
  withLedger,
  authorizeSiteIn,
  type Actor,
  type Tx,
} from "./context";
type Provider = "AZURE" | "PARALLEL" | "DATAFORSEO";
type Kind =
  | "GENERATION"
  | "RESEARCH"
  | "API_OBSERVATION"
  | "CHATGPT_OBSERVATION"
  | "GEMINI_OBSERVATION"
  | "KEYWORD_ENRICHMENT";
type Admission = {
  workspaceId: string;
  siteId: string;
  kind: Kind;
  provider: Provider;
  route: string;
  idempotencyKey: string;
  input: unknown;
  maximumCost: string;
  tariffVersion: string;
};
const limits: Record<string, string> = {
  COMBINED: "10",
  AZURE: "8",
  PARALLEL: "1",
  DATAFORSEO: "1",
  API_OBSERVATION: "25",
  CHATGPT_OBSERVATION: "100",
  GEMINI_OBSERVATION: "100",
};
const countKinds = new Set([
  "API_OBSERVATION",
  "CHATGPT_OBSERVATION",
  "GEMINI_OBSERVATION",
]);
const terminal = new Set([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);
const money = (value: string) => {
  if (!/^(0|[1-9]\d{0,10})(\.\d{1,9})?$/.test(value))
    throw new Error("INVALID_COST");
  return new Prisma.Decimal(value);
};
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== "object" || !value || seen.has(value))
    throw new Error("INVALID_INPUT");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("INVALID_INPUT");
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => "get" in descriptor || "set" in descriptor,
    )
  )
    throw new Error("INVALID_INPUT");
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error("INVALID_INPUT");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length)
        throw new Error("INVALID_INPUT");
      return `[${Array.from(value, (item) => canonical(item, seen)).join(",")}]`;
    }
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item, seen))
        .join(",") +
      "}"
    );
  } finally {
    seen.delete(value);
  }
}
function storedInput(value: unknown) {
  const normalized = JSON.parse(
    canonical(value),
  ) as Prisma.InputJsonValue | null;
  return normalized === null ? Prisma.JsonNull : normalized;
}
const month = (now: Date) => now.toISOString().slice(0, 7);
async function lockBudget(tx: Tx, actor: Actor, period: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`budget:${actor.userId}`},0))::text`;
  await tx.budgetPeriod.createMany({
    data: Object.keys(limits)
      .sort()
      .map((bucket) => ({
        userId: actor.userId,
        period,
        bucket,
        limit: limits[bucket]!,
      })),
    skipDuplicates: true,
  });
  await tx.$queryRaw`SELECT id FROM "BudgetPeriod" WHERE "userId"=${actor.userId} AND period=${period} ORDER BY bucket FOR UPDATE`;
}
function reservationEntries(
  op: Pick<Operation, "provider" | "kind" | "reservedCost">,
) {
  return [
    { bucket: "COMBINED", amount: op.reservedCost },
    { bucket: op.provider, amount: op.reservedCost },
    ...(countKinds.has(op.kind)
      ? [{ bucket: op.kind, amount: new Prisma.Decimal(1) }]
      : []),
  ];
}
async function operationIn(tx: Tx, actor: Actor, id: string) {
  await tx.$queryRaw`SELECT id FROM "Operation" WHERE id=${id} AND "userId"=${actor.userId} FOR UPDATE`;
  const op = await tx.operation.findFirst({
    where: { id, userId: actor.userId },
  });
  if (!op) throw new Error("NOT_FOUND");
  await tx.$queryRaw`SELECT set_config('app.workspace_id',${op.workspaceId},true)`;
  return op;
}
async function assertLease(
  tx: Tx,
  actor: Actor,
  id: string,
  fence: number,
  now: Date,
) {
  const op = await operationIn(tx, actor, id);
  if (
    op.fence !== fence ||
    !op.leaseUntil ||
    op.leaseUntil <= now ||
    terminal.has(op.status)
  )
    throw new Error("STALE_LEASE");
  if (op.securityVersion !== actor.securityVersion)
    throw new Error("FORBIDDEN");
  if (op.attemptState === "NONE" && op.expiresAt <= now)
    throw new Error("EXPIRED");
  return op;
}
function requireVerified(site: { verifiedAt: Date | null }, now: Date) {
  if (
    !site.verifiedAt ||
    now.getTime() - site.verifiedAt.getTime() > 86400000 ||
    site.verifiedAt.getTime() > now.getTime() + 30000
  )
    throw new Error("SITE_UNVERIFIED");
}
async function admitOperationIn(
  tx: Tx,
  actor: Actor,
  input: Admission,
  now: Date,
  quoteId?: string,
) {
  const requestInput = storedInput(input.input);
  const cost = money(input.maximumCost);
  if (
    cost.lte(0) ||
    !input.tariffVersion ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 128
  )
    throw new Error("INVALID_COST");
  if (
    input.kind === "RESEARCH"
      ? input.provider !== "PARALLEL"
      : [
            "CHATGPT_OBSERVATION",
            "GEMINI_OBSERVATION",
            "KEYWORD_ENRICHMENT",
          ].includes(input.kind)
        ? input.provider !== "DATAFORSEO"
        : input.provider !== "AZURE"
  )
    throw new Error("INVALID_PROVIDER");
  const period = month(now),
    hash = createHash("sha256")
      .update(
        canonical({
          ...input,
          input: requestInput === Prisma.JsonNull ? null : requestInput,
          ...(quoteId ? { quoteId } : {}),
          maximumCost: cost.toFixed(9),
        }),
      )
      .digest("hex");

  const site = await authorizeSiteIn(
    tx,
    actor,
    input.workspaceId,
    input.siteId,
    "run",
  );
  requireVerified(site, now);
  await lockBudget(tx, actor, period);
  const previous = await tx.operation.findUnique({
    where: {
      userId_workspaceId_route_idempotencyKey: {
        userId: actor.userId,
        workspaceId: input.workspaceId,
        route: input.route,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (previous) {
    if (previous.inputHash !== hash) throw new Error("CONFLICT");
    return previous;
  }
  const entries = reservationEntries({
    provider: input.provider,
    kind: input.kind,
    reservedCost: cost,
  });
  for (const entry of entries) {
    const row = await tx.budgetPeriod.findUniqueOrThrow({
      where: {
        userId_period_bucket: {
          userId: actor.userId,
          period,
          bucket: entry.bucket,
        },
      },
    });
    if (row.spent.plus(row.reserved).plus(entry.amount).gt(row.limit))
      throw new Error("BUDGET_EXHAUSTED");
  }
  for (const entry of entries)
    await tx.budgetPeriod.update({
      where: {
        userId_period_bucket: {
          userId: actor.userId,
          period,
          bucket: entry.bucket,
        },
      },
      data: { reserved: { increment: entry.amount } },
    });
  return tx.operation.create({
    data: {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      userId: actor.userId,
      sessionId: actor.sessionId,
      securityVersion: actor.securityVersion,
      kind: input.kind,
      provider: input.provider,
      period,
      route: input.route,
      idempotencyKey: input.idempotencyKey,
      inputHash: hash,
      requestInput,
      tariffVersion: input.tariffVersion,
      reservedCost: cost,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
    },
  });
}
export async function admitOperation(
  db: PrismaClient,
  actor: Actor,
  input: Admission,
  now = new Date(),
) {
  return withActor(db, actor, input.workspaceId, (tx) =>
    admitOperationIn(tx, actor, input, now),
  );
}

/** Trusted server service only. Never pass customer-supplied pricing to this function. */
export async function issueOperationQuote(
  db: PrismaClient,
  actor: Actor,
  input: Omit<Admission, "idempotencyKey"> & { expiresAt?: Date },
  now = new Date(),
) {
  const requestInput = storedInput(input.input);
  const cost = money(input.maximumCost);
  if (cost.lte(0) || !input.tariffVersion || !input.route)
    throw new Error("INVALID_COST");
  const valid =
    input.kind === "RESEARCH"
      ? input.provider === "PARALLEL"
      : [
            "CHATGPT_OBSERVATION",
            "GEMINI_OBSERVATION",
            "KEYWORD_ENRICHMENT",
          ].includes(input.kind)
        ? input.provider === "DATAFORSEO"
        : input.provider === "AZURE";
  if (!valid) throw new Error("INVALID_PROVIDER");
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + 300000);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt.getTime() > now.getTime() + 300000
  )
    throw new Error("INVALID_EXPIRY");
  return withActor(db, actor, input.workspaceId, async (tx) => {
    requireVerified(
      await authorizeSiteIn(tx, actor, input.workspaceId, input.siteId, "run"),
      now,
    );
    return tx.operationQuote.create({
      data: {
        userId: actor.userId,
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        kind: input.kind,
        provider: input.provider,
        route: input.route,
        inputHash: createHash("sha256")
          .update(
            canonical(requestInput === Prisma.JsonNull ? null : requestInput),
          )
          .digest("hex"),
        requestInput,
        maximumCost: cost,
        tariffVersion: input.tariffVersion,
        securityVersion: actor.securityVersion,
        createdAt: now,
        expiresAt,
      },
    });
  });
}

/** Customer admission accepts only an opaque quote and retry key; scope and price stay server-owned. */
export async function admitQuotedOperation(
  db: PrismaClient,
  actor: Actor,
  input: { quoteId: string; idempotencyKey: string },
  now = new Date(),
) {
  if (
    !input.quoteId ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 128
  )
    throw new Error("INVALID_QUOTE");
  return withActor(db, actor, "", async (tx) => {
    await tx.$queryRaw`SELECT id FROM "OperationQuote" WHERE id=${input.quoteId} AND "userId"=${actor.userId} FOR UPDATE`;
    const quote = await tx.operationQuote.findFirst({
      where: { id: input.quoteId, userId: actor.userId },
    });
    if (!quote) throw new Error("NOT_FOUND");
    await tx.$queryRaw`SELECT set_config('app.workspace_id',${quote.workspaceId},true)`;
    requireVerified(
      await authorizeSiteIn(tx, actor, quote.workspaceId, quote.siteId, "run"),
      now,
    );
    if (quote.securityVersion !== actor.securityVersion)
      throw new Error("FORBIDDEN");
    if (quote.consumedOperationId) {
      const previous = await tx.operation.findUniqueOrThrow({
        where: { id: quote.consumedOperationId },
      });
      if (previous.idempotencyKey !== input.idempotencyKey)
        throw new Error("QUOTE_CONSUMED");
      return previous;
    }
    if (quote.expiresAt <= now) throw new Error("QUOTE_EXPIRED");
    if (
      createHash("sha256")
        .update(canonical(quote.requestInput))
        .digest("hex") !== quote.inputHash
    )
      throw new Error("INVALID_QUOTE");
    const operation = await admitOperationIn(
      tx,
      actor,
      {
        workspaceId: quote.workspaceId,
        siteId: quote.siteId,
        kind: quote.kind as Kind,
        provider: quote.provider as Provider,
        route: quote.route,
        idempotencyKey: input.idempotencyKey,
        input: quote.requestInput,
        maximumCost: quote.maximumCost.toFixed(9),
        tariffVersion: quote.tariffVersion,
      },
      now,
      quote.id,
    );
    await tx.operationQuote.update({
      where: { id: quote.id },
      data: { consumedOperationId: operation.id },
    });
    return operation;
  });
}

/** Read the same per-user UTC allowance used for admission, without reserving. */
export async function budgetSnapshotIn(tx: Tx, actor: Actor, now: Date) {
  const period = month(now);
  const rows = await tx.budgetPeriod.findMany({
    where: { userId: actor.userId, period },
  });
  const stored = new Map(rows.map((row) => [row.bucket, row]));
  return Object.keys(limits)
    .sort()
    .map((bucket) => {
      const row = stored.get(bucket);
      return {
        bucket,
        period,
        limit: row?.limit ?? new Prisma.Decimal(limits[bucket]!),
        spent: row?.spent ?? new Prisma.Decimal(0),
        reserved: row?.reserved ?? new Prisma.Decimal(0),
      };
    });
}
export async function budgetSnapshot(
  db: PrismaClient,
  actor: Actor,
  now = new Date(),
) {
  return withActor(db, actor, "", (tx) => budgetSnapshotIn(tx, actor, now));
}
export async function claimOperation(
  db: PrismaClient,
  actor: Actor,
  id: string,
  leaseOwner: string,
  now = new Date(),
) {
  const result = await withActor(db, actor, "", async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`worker:${actor.userId}`},0))::text`;
    const op = await operationIn(tx, actor, id);
    requireVerified(
      await authorizeSiteIn(tx, actor, op.workspaceId, op.siteId, "run"),
      now,
    );
    if (op.securityVersion !== actor.securityVersion)
      throw new Error("FORBIDDEN");
    const busy = await tx.operation.findFirst({
      where: {
        userId: actor.userId,
        id: { not: id },
        status: { in: ["RUNNING", "WAITING_PROVIDER", "RECONCILING"] },
        OR: [{ leaseUntil: { gt: now } }, { attemptState: { not: "NONE" } }],
      },
    });
    if (busy) throw new Error("USER_BUSY");
    if (terminal.has(op.status)) throw new Error("TERMINAL");
    if (op.leaseUntil && op.leaseUntil > now) throw new Error("LEASE_BUSY");
    if (op.status === "RECONCILING" || op.attemptState !== "NONE") {
      await tx.operation.update({
        where: { id },
        data: { status: "RECONCILING", leaseOwner: null, leaseUntil: null },
      });
      return null;
    }
    if (op.cancelRequestedAt) throw new Error("CANCELLED");
    if (op.expiresAt <= now) throw new Error("EXPIRED");
    return tx.operation.update({
      where: { id },
      data: {
        status: "RUNNING",
        leaseOwner,
        leaseUntil: new Date(now.getTime() + 90000),
        fence: { increment: 1 },
      },
    });
  });
  if (!result) throw new Error("RECONCILING");
  return result;
}
export async function renewLease(
  db: PrismaClient,
  actor: Actor,
  id: string,
  fence: number,
  now = new Date(),
) {
  return withActor(db, actor, "", async (tx) => {
    await assertLease(tx, actor, id, fence, now);
    return tx.operation.update({
      where: { id },
      data: { leaseUntil: new Date(now.getTime() + 90000) },
    });
  });
}
export async function beginAttempt(
  db: PrismaClient,
  actor: Actor,
  id: string,
  fence: number,
  now = new Date(),
) {
  return withActor(db, actor, "", async (tx) => {
    const op = await assertLease(tx, actor, id, fence, now);
    requireVerified(
      await authorizeSiteIn(tx, actor, op.workspaceId, op.siteId, "run"),
      now,
    );
    if (op.cancelRequestedAt || op.attemptState !== "NONE")
      throw new Error("ATTEMPT_NOT_ALLOWED");
    return tx.operation.update({
      where: { id },
      data: { attemptState: "INTENT" },
    });
  });
}
/** Internal response recording only; never authorizes a new provider dispatch. */
export async function acceptAttempt(
  db: PrismaClient,
  actor: Actor,
  id: string,
  fence: number,
  taskId: string,
  now = new Date(),
) {
  return withLedger(db, actor.userId, async (tx) => {
    const op = await operationIn(tx, actor, id);
    if (op.fence !== fence || terminal.has(op.status) || !taskId)
      throw new Error("STALE_LEASE");
    if (op.attemptState === "ACCEPTED") {
      if (op.providerTaskId !== taskId) throw new Error("CONFLICT");
      return op;
    }
    if (op.attemptState !== "INTENT") throw new Error("ATTEMPT_NOT_ALLOWED");
    return tx.operation.update({
      where: { id },
      data: {
        attemptState: "ACCEPTED",
        providerTaskId: taskId,
        status:
          op.cancelRequestedAt || !op.leaseUntil || op.leaseUntil <= now
            ? "RECONCILING"
            : "WAITING_PROVIDER",
      },
    });
  });
}

async function releaseIn(
  tx: Tx,
  actor: Actor,
  op: Operation,
  status: "CANCELLED" | "EXPIRED",
) {
  await lockBudget(tx, actor, op.period);
  for (const entry of reservationEntries(op))
    await tx.budgetPeriod.update({
      where: {
        userId_period_bucket: {
          userId: actor.userId,
          period: op.period,
          bucket: entry.bucket,
        },
      },
      data: { reserved: { decrement: entry.amount } },
    });
  await tx.operation.update({
    where: { id: op.id },
    data: { status, settledAt: new Date(), leaseOwner: null, leaseUntil: null },
  });
}
export async function cancelOperation(
  db: PrismaClient,
  actor: Actor,
  id: string,
) {
  return withActor(db, actor, "", async (tx) => {
    const op = await operationIn(tx, actor, id);
    await authorizeSiteIn(tx, actor, op.workspaceId, op.siteId, "run");
    if (terminal.has(op.status)) return op;
    if (op.attemptState === "NONE") {
      await releaseIn(tx, actor, op, "CANCELLED");
    } else
      await tx.operation.update({
        where: { id },
        data: { cancelRequestedAt: new Date(), status: "RECONCILING" },
      });
    return tx.operation.findUniqueOrThrow({ where: { id } });
  });
}
export async function expireQueued(
  db: PrismaClient,
  actor: Actor,
  id: string,
  now = new Date(),
) {
  return withLedger(db, actor.userId, async (tx) => {
    const op = await operationIn(tx, actor, id);
    if (
      ["QUEUED", "RUNNING"].includes(op.status) &&
      op.attemptState === "NONE" &&
      op.expiresAt <= now &&
      (!op.leaseUntil || op.leaseUntil <= now)
    )
      await releaseIn(tx, actor, op, "EXPIRED");
  });
}

export async function settleOperation(
  db: PrismaClient,
  actor: Actor,
  id: string,
  fence: number,
  receipt: { receiptId: string; amount: string; acceptedOutput: boolean },
  now = new Date(),
) {
  const amount = money(receipt.amount);
  if (!receipt.receiptId) throw new Error("INVALID_RECEIPT");
  return withLedger(db, actor.userId, async (tx) => {
    const op = await operationIn(tx, actor, id);
    const previous = await tx.usageReceipt.findUnique({
      where: {
        operationId_provider: { operationId: id, provider: op.provider },
      },
    });
    if (previous) {
      if (
        previous.receiptId !== receipt.receiptId ||
        !previous.amount.eq(amount) ||
        previous.acceptedOutput !== receipt.acceptedOutput
      )
        throw new Error("CONFLICT");
      return previous;
    }
    if (
      op.fence !== fence ||
      op.attemptState !== "ACCEPTED" ||
      terminal.has(op.status)
    )
      throw new Error("STALE_LEASE");
    await tx.$queryRaw`SELECT lyraseo_ledger.apply_budget_change(${id}::text,${amount.toFixed(9)}::numeric,${receipt.acceptedOutput},true)::text`;
    const saved = await tx.usageReceipt.create({
      data: {
        operationId: id,
        workspaceId: op.workspaceId,
        userId: actor.userId,
        provider: op.provider,
        receiptId: receipt.receiptId,
        amount,
        acceptedOutput: receipt.acceptedOutput,
      },
    });
    await tx.operation.update({
      where: { id },
      data: {
        actualCost: amount,
        settledAt: now,
        status: amount.gt(op.reservedCost)
          ? "RECONCILING"
          : op.cancelRequestedAt
            ? "CANCELLED"
            : receipt.acceptedOutput
              ? "COMPLETED"
              : "FAILED",
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    return saved;
  });
}
/** Internal rejection of definitively invalid, unstarted queued work. Never releases uncertain charges. */
export async function cancelInvalidQueuedOperation(
  db: PrismaClient,
  actor: Actor,
  id: string,
  now = new Date(),
) {
  return withLedger(db, actor.userId, async (tx) => {
    const op = await operationIn(tx, actor, id);
    if (op.status !== "QUEUED" || op.attemptState !== "NONE") return false;
    const user = await tx.productUser.findUniqueOrThrow({
      where: { id: actor.userId },
    });
    let invalid =
      user.suspended ||
      op.securityVersion !== user.securityVersion ||
      Boolean(op.cancelRequestedAt);
    try {
      requireVerified(
        await authorizeSiteIn(tx, actor, op.workspaceId, op.siteId, "run"),
        now,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !["FORBIDDEN", "NOT_FOUND", "SITE_UNVERIFIED"].includes(error.message)
      )
        throw error;
      invalid = true;
    }
    if (op.expiresAt <= now) {
      await releaseIn(tx, actor, op, "EXPIRED");
      return true;
    }
    if (!invalid) return false;
    await releaseIn(tx, actor, op, "CANCELLED");
    return true;
  });
}
