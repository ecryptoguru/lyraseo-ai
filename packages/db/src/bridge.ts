import type { Prisma, PrismaClient } from "../generated/client";
import {
  ackDelivery,
  claimDue,
  deferDelivery,
  recoverDue,
  type KernelRequest,
} from "./dispatch";
import {
  frozenEvaluation,
  validateRawPage,
  type AuditFacts,
} from "./audit-evidence";
import type { AcquisitionReceipt } from "@lyraseo/visibility/acquisition";
import { auditManifest } from "@lyraseo/visibility/url";
import type { PageEvidence } from "@lyraseo/visibility";

type PrivateAttempt = {
  disposition: "ADMITTED";
  proof: string;
  url: string;
  origin: string;
  manifest: string[];
};
type Result = { disposition: "COMPLETED" | "YIELDED" | "IN_PROGRESS" };
type Prepared = AuditFacts & {
  url: string;
  origin: string;
  declarations: unknown;
  priorEvidence: PageEvidence[] | null;
};
const short = { maxWait: 1000, timeout: 8000, statement: 7000 };
type Budget = typeof short;
function remaining(deadline: Date) {
  const ms = deadline.getTime() - Date.now();
  if (!Number.isFinite(ms) || ms < 1) throw new Error("HANDLER_DEADLINE");
  return ms;
}
// The HTTP body, connection-pool wait, previous statements and evaluator all
// consume the same budget. Refresh PostgreSQL's bound before each function.
function inTime<T>(
  db: PrismaClient,
  deadline: Date,
  work: (
    tx: Prisma.TransactionClient,
    boundNext: () => Promise<void>,
  ) => Promise<T>,
  caps: Budget = short,
) {
  const wait = remaining(deadline);
  return db.$transaction(
    async (tx) => {
      const boundNext = async () => {
        await tx.$queryRaw`SELECT set_config('statement_timeout',${String(Math.min(caps.statement, remaining(deadline)))},true)`;
        remaining(deadline);
      };
      await boundNext();
      const result = await work(tx, boundNext);
      remaining(deadline);
      return result;
    },
    {
      maxWait: Math.min(wait, caps.maxWait),
      timeout: Math.min(wait, caps.timeout),
    },
  );
}
const control = {
  "/api/internal/runtime/dispatch": claimDue,
  "/api/internal/runtime/dispatch/ack": ackDelivery,
  "/api/internal/runtime/dispatch/defer": deferDelivery,
  "/api/internal/runtime/recover": recoverDue,
};
export function runBridgeControl(
  db: PrismaClient,
  path: keyof typeof control,
  envelope: KernelRequest,
  deadline: Date,
  check: () => void,
) {
  return inTime(db, deadline, async (tx) => {
    check();
    const result = await control[path](tx, envelope);
    check();
    return result;
  });
}
/** Explicit restricted connection only. Private proof never enters HTTP/logging. */
export async function admitStep(
  db: PrismaClient,
  r: KernelRequest,
  fixtureOrigin: string,
  handlerDeadline = new Date(Date.now() + 45000),
  assertActive?: () => void,
) {
  return inTime(db, handlerDeadline, async (tx) => {
    assertActive?.();
    const [row] = await tx.$queryRaw<
      { result: PrivateAttempt | Result }[]
    >`SELECT lyraseo_audit.admit_step(${r.requestId}::uuid,${r.audience},'/api/internal/runtime/step',${r.rawBody},${r.issuedAt}::timestamptz,${r.expiresAt}::timestamptz,${handlerDeadline}::timestamptz) AS result`;
    const result = row!.result;
    if (result.disposition === "ADMITTED") {
      const normalized = auditManifest(result.manifest, result.origin);
      if (
        result.origin !== fixtureOrigin ||
        normalized.some((url, i) => url !== result.manifest[i]) ||
        !normalized.includes(result.url)
      )
        throw new Error("STALE_TARGET");
    }
    assertActive?.();
    return result;
  });
}
export async function checkStep(
  db: PrismaClient,
  rid: string,
  proof: string,
  deadline = new Date(Date.now() + 650),
) {
  return inTime(
    db,
    deadline,
    async (tx) => {
      await tx.$queryRaw`SELECT lyraseo_audit.check_step(${rid}::uuid,${proof})`;
    },
    { maxWait: 400, timeout: 600, statement: 450 },
  );
}
export async function commitStep(
  db: PrismaClient,
  rid: string,
  attempt: PrivateAttempt,
  receipt: AcquisitionReceipt,
  signal: AbortSignal,
  checkKey: () => void,
  deadline: Date,
) {
  return inTime(db, deadline, async (tx, boundNext) => {
    checkKey();
    signal.throwIfAborted();
    const [row] = await tx.$queryRaw<
      { facts: Prepared }[]
    >`SELECT lyraseo_audit.prepare_step(${rid}::uuid,${attempt.proof}) AS facts`;
    const facts = row!.facts;
    if (facts.url !== receipt.evidence.requestedUrl)
      throw new Error("INVALID_PAGE_EVIDENCE");
    validateRawPage(facts, receipt.evidence, receipt.provenance);
    const evaluation =
      facts.priorEvidence === null
        ? null
        : frozenEvaluation(
            facts,
            facts.origin,
            [...facts.priorEvidence, receipt.evidence].sort((a, b) =>
              a.requestedUrl < b.requestedUrl
                ? -1
                : a.requestedUrl > b.requestedUrl
                  ? 1
                  : 0,
            ),
          );
    checkKey();
    signal.throwIfAborted();
    await boundNext();
    const [done] = await tx.$queryRaw<
      { result: Result }[]
    >`SELECT lyraseo_audit.commit_step(${rid}::uuid,${attempt.proof},${JSON.stringify(receipt)}::json,${evaluation === null ? null : JSON.stringify(evaluation)}::jsonb) AS result`;
    checkKey();
    signal.throwIfAborted();
    return done!.result;
  });
}

export { auditErrorCode } from "./audit-errors";
