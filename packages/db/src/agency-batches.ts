import { randomUUID } from "node:crypto";
import { fingerprint } from "./audit-evidence";
import {
  Prisma,
  type PrismaClient,
  type OperationQuote,
} from "../generated/client";
import { withActor, authorizeSiteIn, type Actor, type Tx } from "./context";
import { checkAccessRevision, membership } from "./tenants";
import { admitQuotedOperation, type issueOperationQuote } from "./accounting";
export type BatchItem = {
  siteId: string;
  kind: Parameters<typeof issueOperationQuote>[2]["kind"];
  input: unknown;
};
type QuoteItem = {
  siteId: string;
  ordinal: number;
  quoteId: string | null;
  maximumCost: string | null;
  provider: string | null;
  tariffVersion: string | null;
  status: "QUOTED" | "UNAVAILABLE";
  errorCode: string | null;
};
export type BatchPreview = {
  batchQuoteId: string;
  expiresAt: string;
  inputHash: string;
  confirmationHash: string;
  items: QuoteItem[];
  totalsByProvider: Record<string, string>;
  combinedMaximum: string | null;
  currency: "USD";
  budgetOwnerId: string;
  unavailable: boolean;
};
const digest = fingerprint;
/** issuer is a trusted server dependency, never a route/body option. Absent qualifications produce unavailable, never $0. */
export async function issueAgencyBatchQuote(
  db: PrismaClient,
  actor: Actor,
  input: { workspaceId: string; items: BatchItem[] },
  issuer?: (item: BatchItem) => Promise<OperationQuote>,
): Promise<BatchPreview> {
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 10 ||
    new Set(input.items.map((i) => i.siteId)).size !== input.items.length
  )
    throw Error("INVALID_BATCH");
  if (
    input.items.some(
      (item) =>
        !item.siteId ||
        item.siteId.length > 128 ||
        ![
          "GENERATION",
          "RESEARCH",
          "API_OBSERVATION",
          "CHATGPT_OBSERVATION",
          "GEMINI_OBSERVATION",
          "KEYWORD_ENRICHMENT",
        ].includes(item.kind),
    )
  )
    throw Error("INVALID_BATCH");
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 100000) throw Error("INVALID_BATCH");
  const request = JSON.parse(serialized) as typeof input;
  await withActor(db, actor, input.workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, input.workspaceId);
    for (const item of request.items)
      await authorizeSiteIn(tx, actor, input.workspaceId, item.siteId, "run");
  });
  const items: QuoteItem[] = [],
    totals: Record<string, Prisma.Decimal> = {},
    createdAt = new Date();
  let expiresAt = new Date(createdAt.getTime() + 300000);
  for (const [ordinal, item] of request.items.entries()) {
    if (!issuer) {
      items.push({
        siteId: item.siteId,
        ordinal,
        quoteId: null,
        maximumCost: null,
        provider: null,
        tariffVersion: null,
        status: "UNAVAILABLE",
        errorCode: "PROVIDER_UNQUALIFIED",
      });
      continue;
    }
    const quote = await issuer(item);
    if (
      quote.workspaceId !== input.workspaceId ||
      quote.siteId !== item.siteId ||
      quote.userId !== actor.userId ||
      quote.securityVersion !== actor.securityVersion ||
      quote.kind !== item.kind ||
      digest(quote.requestInput) !== digest(item.input) ||
      quote.maximumCost.lte(0) ||
      quote.expiresAt <= new Date()
    )
      throw Error("INVALID_QUOTE");
    if (quote.expiresAt < expiresAt) expiresAt = quote.expiresAt;
    totals[quote.provider] = (
      totals[quote.provider] ?? new Prisma.Decimal(0)
    ).plus(quote.maximumCost);
    items.push({
      siteId: item.siteId,
      ordinal,
      quoteId: quote.id,
      maximumCost: quote.maximumCost.toFixed(9),
      provider: quote.provider,
      tariffVersion: quote.tariffVersion,
      status: "QUOTED",
      errorCode: null,
    });
  }
  const id = randomUUID(),
    inputHash = digest(request),
    unavailable = items.some((i) => i.status === "UNAVAILABLE"),
    totalsByProvider = Object.fromEntries(
      Object.entries(totals).map(([provider, total]) => [
        provider,
        total.toFixed(9),
      ]),
    );
  const combinedMaximum = unavailable
    ? null
    : Object.values(totals)
        .reduce((n, v) => n.plus(v), new Prisma.Decimal(0))
        .toFixed(9);
  const preview = {
    batchQuoteId: id,
    expiresAt: expiresAt.toISOString(),
    inputHash,
    items,
    totalsByProvider,
    combinedMaximum,
    currency: "USD" as const,
    budgetOwnerId: actor.userId,
    unavailable,
  };
  const confirmationHash = digest(preview);
  await withActor(db, actor, input.workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, input.workspaceId);
    for (const item of request.items)
      await authorizeSiteIn(tx, actor, input.workspaceId, item.siteId, "run");
    await tx.$executeRaw`INSERT INTO "AgencyBatchQuote"(id,"workspaceId","userId","securityVersion","requestInput","inputHash","confirmationHash",preview,"createdAt","expiresAt") VALUES(${id},${input.workspaceId},${actor.userId},${actor.securityVersion},${JSON.stringify(request)}::jsonb,${inputHash},${confirmationHash},${JSON.stringify(preview)}::jsonb,${createdAt},${expiresAt})`;
    for (const item of items)
      await tx.$executeRaw`INSERT INTO "AgencyBatchItem"("batchQuoteId","workspaceId","userId","siteId",ordinal,"quoteId",status,"errorCode") VALUES(${id},${input.workspaceId},${actor.userId},${item.siteId},${item.ordinal},${item.quoteId},${item.status},${item.errorCode})`;
  });
  return { ...preview, confirmationHash };
}
type BatchRow = {
  id: string;
  workspaceId: string;
  userId: string;
  securityVersion: number;
  confirmationHash: string;
  confirmationKey: string | null;
  confirmedAt: Date | null;
  expiresAt: Date;
  preview: Omit<BatchPreview, "confirmationHash">;
};
type ItemRow = {
  batchQuoteId: string;
  workspaceId: string;
  userId: string;
  siteId: string;
  ordinal: number;
  quoteId: string | null;
  operationId: string | null;
  status: string;
  errorCode: string | null;
};
async function loadBatch(db: PrismaClient, actor: Actor, id: string) {
  return withActor(db, actor, "", async (tx) => {
    const [row] = await tx.$queryRaw<
      BatchRow[]
    >`SELECT * FROM "AgencyBatchQuote" WHERE id=${id} AND "userId"=${actor.userId}`;
    if (!row) throw Error("NOT_FOUND");
    await tx.$queryRaw`SELECT set_config('app.workspace_id',${row.workspaceId},true)`;
    await checkAccessRevision(tx, actor, row.workspaceId);
    await membership(tx, actor, row.workspaceId);
    return row;
  });
}
const childKey = (batchId: string, ordinal: number) =>
  `batch:${digest({ id: batchId, ordinal }).slice(0, 48)}`;
/** Financial recovery reads an existing commitment; it never authorizes new site work. */
async function committedChildIn(
  tx: Tx,
  actor: Actor,
  batch: BatchRow,
  item: ItemRow,
  lock = false,
) {
  if (!item.quoteId) return null;
  if (lock)
    await tx.$queryRaw`SELECT id FROM "OperationQuote" WHERE id=${item.quoteId} AND "userId"=${actor.userId} FOR UPDATE`;
  const quote = await tx.operationQuote.findFirst({
    where: {
      id: item.quoteId,
      userId: actor.userId,
      workspaceId: batch.workspaceId,
      siteId: item.siteId,
    },
    select: { consumedOperationId: true },
  });
  if (!quote) throw Error("NOT_FOUND");
  if (!quote.consumedOperationId) return null;
  const operation = await tx.operation.findFirst({
    where: {
      id: quote.consumedOperationId,
      userId: actor.userId,
      workspaceId: batch.workspaceId,
      siteId: item.siteId,
      idempotencyKey: childKey(batch.id, item.ordinal),
    },
    select: { id: true },
  });
  if (!operation) throw Error("REVISION_CONFLICT");
  return operation.id;
}
async function reconcileChild(
  db: PrismaClient,
  actor: Actor,
  batch: BatchRow,
  item: ItemRow,
  outcome?: {
    operationId: string | null;
    status: "PENDING" | "REJECTED";
    errorCode: string | null;
  },
) {
  return withActor(db, actor, batch.workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, batch.workspaceId);
    await membership(tx, actor, batch.workspaceId);
    // The quote lock serializes the absence check with independent child admission.
    const committed = await committedChildIn(tx, actor, batch, item, true);
    if (outcome?.operationId && committed !== outcome.operationId)
      throw Error("ADMISSION_UNAVAILABLE");
    if (!committed && !outcome) return null;
    const status = committed ? "ADMITTED" : outcome!.status,
      errorCode = committed ? null : outcome!.errorCode;
    await tx.$executeRaw`UPDATE "AgencyBatchItem" SET "operationId"=COALESCE("operationId",${committed}),status=CASE WHEN "operationId" IS NOT NULL THEN 'ADMITTED' ELSE ${status} END,"errorCode"=CASE WHEN "operationId" IS NOT NULL THEN NULL ELSE ${errorCode} END WHERE "batchQuoteId"=${batch.id} AND ordinal=${item.ordinal} AND "userId"=${actor.userId}`;
    return committed;
  });
}
export async function confirmAgencyBatch(
  db: PrismaClient,
  actor: Actor,
  input: {
    batchQuoteId: string;
    confirmationHash: string;
    idempotencyKey: string;
  },
) {
  if (
    !input.idempotencyKey ||
    input.idempotencyKey.length > 128 ||
    !/^[a-f0-9]{64}$/.test(input.confirmationHash)
  )
    throw Error("INVALID_BATCH");
  const found = await loadBatch(db, actor, input.batchQuoteId);
  const batch = await withActor(db, actor, found.workspaceId, async (tx) => {
    const [row] = await tx.$queryRaw<
      BatchRow[]
    >`SELECT * FROM "AgencyBatchQuote" WHERE id=${input.batchQuoteId} AND "userId"=${actor.userId} FOR UPDATE`;
    await checkAccessRevision(tx, actor, found.workspaceId);
    if (
      !row ||
      row.securityVersion !== actor.securityVersion ||
      row.confirmationHash !== input.confirmationHash ||
      digest(row.preview) !== row.confirmationHash
    )
      throw Error("REVISION_CONFLICT");
    if (row.confirmationKey && row.confirmationKey !== input.idempotencyKey)
      throw Error("REVISION_CONFLICT");
    if (!row.confirmedAt && row.expiresAt <= new Date())
      throw Error("QUOTE_EXPIRED");
    if (!row.confirmedAt)
      await tx.$executeRaw`UPDATE "AgencyBatchQuote" SET "confirmedAt"=clock_timestamp() AT TIME ZONE 'UTC',"confirmationKey"=${input.idempotencyKey} WHERE id=${row.id}`;
    return row;
  });
  const items = await withActor(
    db,
    actor,
    batch.workspaceId,
    (tx) =>
      tx.$queryRaw<
        ItemRow[]
      >`SELECT * FROM "AgencyBatchItem" WHERE "batchQuoteId"=${batch.id} AND "userId"=${actor.userId} ORDER BY ordinal`,
  );
  for (const item of items) {
    if (!item.quoteId || item.operationId) continue;
    // Heal even a previously misclassified item before considering a new admission.
    if (await reconcileChild(db, actor, batch, item)) continue;
    if (!["QUOTED", "PENDING"].includes(item.status)) continue;
    let operationId: string | null = null,
      status: "PENDING" | "REJECTED" = "PENDING",
      errorCode: string | null = null;
    try {
      const operation = await admitQuotedOperation(db, actor, {
        quoteId: item.quoteId,
        idempotencyKey: childKey(batch.id, item.ordinal),
      });
      operationId = operation.id;
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      errorCode = [
        "BUDGET_EXHAUSTED",
        "QUOTE_EXPIRED",
        "FORBIDDEN",
        "NOT_FOUND",
        "CAPACITY_EXHAUSTED",
        "QUOTE_CONSUMED",
      ].includes(code)
        ? code
        : "ADMISSION_UNAVAILABLE";
      status = [
        "BUDGET_EXHAUSTED",
        "QUOTE_EXPIRED",
        "CAPACITY_EXHAUSTED",
      ].includes(errorCode)
        ? "REJECTED"
        : "PENDING";
    }
    await reconcileChild(db, actor, batch, item, {
      operationId,
      status,
      errorCode,
    });
  }
  return readAgencyBatch(db, actor, batch.id);
}
export async function readAgencyBatch(
  db: PrismaClient,
  actor: Actor,
  id: string,
) {
  const batch = await loadBatch(db, actor, id);
  return withActor(db, actor, batch.workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, batch.workspaceId);
    const rows = await tx.$queryRaw<
      ItemRow[]
    >`SELECT * FROM "AgencyBatchItem" WHERE "batchQuoteId"=${id} AND "userId"=${actor.userId} ORDER BY ordinal`;
    const items = [];
    let total = new Prisma.Decimal(0);
    for (const row of rows) {
      const committed = await committedChildIn(tx, actor, batch, row),
        operationId = committed ?? row.operationId,
        status = committed ? "ADMITTED" : row.status;
      const preview = batch.preview.items.find(
        (i) => i.ordinal === row.ordinal,
      );
      // This is the actor's existing financial commitment, including hidden site items.
      if (status === "ADMITTED" && operationId && preview?.maximumCost)
        total = total.plus(preview.maximumCost);
      try {
        await authorizeSiteIn(tx, actor, batch.workspaceId, row.siteId, "read");
      } catch {
        items.push({
          ordinal: row.ordinal,
          status: "ACCESS_UNAVAILABLE",
          operationId: null,
          errorCode: "FORBIDDEN",
        });
        continue;
      }
      items.push({
        ordinal: row.ordinal,
        siteId: row.siteId,
        status,
        operationId,
        errorCode: committed ? null : row.errorCode,
      });
    }
    return {
      batchId: id,
      items,
      admittedTotal: total.toFixed(9),
      currency: "USD" as const,
    };
  });
}
