import type { PrismaClient } from "../generated/client";

/** Internal, network-free fixture ledger. The database verifies session_user,
 * database OID/postmaster enrollment and immutable managed operation identity.
 * This is never a browser Actor, paid dispatch credential or live provider API. */
export type AttemptEvidence = {
  kind: "ACCEPTED" | "UNCERTAIN" | "RESOLVED";
  observedAt: string;
  taskId?: string;
  accepted?: boolean;
  outputValid?: boolean;
  cost?: string;
  costVersion?: number;
  usage?: Partial<
    Record<
      | "inputTokens"
      | "outputTokens"
      | "cachedTokens"
      | "reasoningTokens"
      | "webSearchRequests"
      | "searchRequests"
      | "extractedUrls"
      | "postedTasks",
      number
    >
  >;
};
export type LedgerSnapshot = {
  operationId: string;
  revision: number;
  evidenceHash: string;
  planClosed: boolean;
  paused: boolean;
  settled: boolean;
  effectiveCost: string | null;
  classification: "SYNTHETIC";
};
export async function prepareFixtureAttempt(
  db: PrismaClient,
  input: {
    operationId: string;
    fence: number;
    step: string;
    requestHash: string;
    expectedRevision: number;
  },
) {
  const [row] = await db.$queryRaw<
    {
      value: {
        id: string;
        revision: number;
        state: string;
        correlationId?: string;
        replayed: boolean;
        submissionGranted: boolean;
      };
    }[]
  >`SELECT lyraseo_ledger.prepare_attempt(${input.operationId}::text,${input.fence}::integer,${input.step}::text,${input.requestHash}::text,${input.expectedRevision}::integer) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
export async function recordAttemptEvidence(
  db: PrismaClient,
  attemptId: string,
  sourceKey: string,
  evidence: AttemptEvidence,
) {
  const [row] = await db.$queryRaw<
    { value: { eventId: string; revision: number; replayed?: boolean } }[]
  >`SELECT lyraseo_ledger.record_evidence(${attemptId}::uuid,${sourceKey}::text,${JSON.stringify(evidence)}::jsonb) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
export async function readProviderLedger(
  db: PrismaClient,
  operationId: string,
) {
  const [row] = await db.$queryRaw<
    { value: LedgerSnapshot }[]
  >`SELECT lyraseo_ledger.snapshot(${operationId}::text) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
export async function closeProviderAttemptPlan(
  db: PrismaClient,
  operationId: string,
  expectedRevision: number,
) {
  const [row] = await db.$queryRaw<
    { value: { revision: number; planClosed: true } }[]
  >`SELECT lyraseo_ledger.close_plan(${operationId}::text,${expectedRevision}::integer) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
export async function settleManagedOperation(
  db: PrismaClient,
  input: {
    operationId: string;
    expectedRevision: number;
    evidenceHash: string;
  },
) {
  const [row] = await db.$queryRaw<
    {
      value: {
        settlementId: string;
        amount: string;
        classification: "SYNTHETIC";
      };
    }[]
  >`SELECT lyraseo_ledger.settle(${input.operationId}::text,${input.expectedRevision}::integer,${input.evidenceHash}::text) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
export async function applyProviderAdjustment(
  db: PrismaClient,
  operationId: string,
  expectedRevision: number,
) {
  const [row] = await db.$queryRaw<
    {
      value: {
        adjustmentId: string;
        effectiveCost: string;
        delta?: string;
        replayed?: boolean;
      };
    }[]
  >`SELECT lyraseo_ledger.apply_adjustment(${operationId}::text,${expectedRevision}::integer) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
export async function cancelManagedFixtureOperation(
  db: PrismaClient,
  operationId: string,
) {
  const [row] = await db.$queryRaw<
    {
      value: {
        operationId?: string;
        cancelled?: boolean;
        status?: string;
        replayed?: boolean;
      };
    }[]
  >`SELECT lyraseo_ledger.cancel(${operationId}::text) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
export async function claimProviderReconciliation(
  db: PrismaClient,
  limit = 20,
) {
  const [row] = await db.$queryRaw<
    {
      value: {
        operationId: string;
        fence: number;
        tries: number;
        reason: string;
      }[];
    }[]
  >`SELECT lyraseo_ledger.claim_reconciliation(${limit}::integer) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
export async function finishProviderReconciliation(
  db: PrismaClient,
  input: {
    operationId: string;
    fence: number;
    outcome:
      | "PROVIDER_PENDING"
      | "QUOTA"
      | "SCHEMA_CHANGED"
      | "UNSUPPORTED"
      | "UNAVAILABLE";
  },
) {
  const [row] = await db.$queryRaw<
    { value: { operationId: string; status: string } }[]
  >`SELECT lyraseo_ledger.finish_reconciliation(${input.operationId}::text,${input.fence}::integer,${input.outcome}::text) AS value`;
  if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
  return row.value;
}
