import {
  artifactStore,
  attestArtifactReceipt,
  verifiedPublication,
  witnessedObservation,
  artifactOriginKeyId,
  verifyReturnedBytes,
  type ArtifactReservation,
  STORAGE,
} from "./artifact-checkpoint";
import { compactEvaluation } from "./saved-evidence";
import type { ArtifactVersion } from "./artifact-store";
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
import {
  restoreOriginalReceipt,
  restoreUnavailableReceipt,
  type AcquisitionReceipt,
} from "@lyraseo/visibility/acquisition";
import { auditManifest } from "@lyraseo/visibility/url";
import type { PageEvidence } from "@lyraseo/visibility";

type PrivateAttempt = {
  disposition: "ADMITTED";
  privateSource?: boolean;
  pendingSource?: boolean;
  proof: string;
  url: string;
  origin: string;
  manifest: string[];
};
type PendingSource = {
  version: ArtifactVersion;
  provenance: AcquisitionReceipt["provenance"];
  unavailable?: undefined;
};
type PendingMode =
  | PendingSource
  | { unavailable: AcquisitionReceipt; version?: undefined }
  | { version?: undefined; unavailable?: undefined };
async function sourceMode(
  tx: Prisma.TransactionClient,
  rid: string,
  proof: string,
) {
  const [row] = await tx.$queryRaw<
    { selected: PendingMode | null }[]
  >`SELECT lyraseo_audit.step_artifact_mode(${rid}::uuid,${proof}) AS selected`;
  return row!.selected;
}
type Result = { disposition: "COMPLETED" | "YIELDED" | "IN_PROGRESS" };
type Prepared = AuditFacts & {
  url: string;
  origin: string;
  declarations: unknown;
  storageFormat?: string;
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
export type HandoffBinding = {
  url: string;
  connectionUrl: string;
  generation: number;
  body: string;
  bodyHash: string;
  kind: "WORDPRESS" | "WEBHOOK";
  eventId: string | null;
  cipher: string;
  keyId: string | null;
  previousCipher: string | null;
  previousKeyId: string | null;
  workspaceId: string;
  siteId: string;
};
type HandoffAttempt =
  | { disposition: "ADMITTED"; proof: string; kind: "WORDPRESS" | "WEBHOOK" }
  | { disposition: "COMPLETED" | "IN_PROGRESS" | "STALE" };

// Called only by the separately enrolled fixture runtime. The database resolves
// the opaque queue reference; neither the carrier nor the request chooses a URL.
export function resolveHandoff(
  db: PrismaClient,
  workId: string,
  generation: number,
  deadline: Date,
) {
  return inTime(db, deadline, async (tx) => {
    const [row] = await tx.$queryRaw<
      { found: boolean }[]
    >`SELECT lyraseo_handoff.resolve_delivery(${workId}::uuid,${generation}::integer) AS found`;
    return row!.found;
  });
}
export function admitHandoff(
  db: PrismaClient,
  r: KernelRequest,
  deadline: Date,
  check: () => void,
) {
  return inTime(db, deadline, async (tx) => {
    check();
    const [row] = await tx.$queryRaw<
      { result: HandoffAttempt }[]
    >`SELECT lyraseo_handoff.admit_step(${r.requestId}::uuid,${r.audience},'/api/internal/runtime/step',${r.rawBody},${r.issuedAt}::timestamptz,${r.expiresAt}::timestamptz,${deadline}::timestamptz) AS result`;
    check();
    return row!.result;
  });
}
export function checkHandoff(
  db: PrismaClient,
  rid: string,
  proof: string,
  deadline: Date,
) {
  return inTime(
    db,
    deadline,
    async (tx) => {
      const [row] = await tx.$queryRaw<
        { result: HandoffBinding }[]
      >`SELECT lyraseo_handoff.check_step(${rid}::uuid,${proof}) AS result`;
      return row!.result;
    },
    { maxWait: 400, timeout: 600, statement: 450 },
  );
}
export function finishHandoff(
  db: PrismaClient,
  rid: string,
  proof: string,
  receipt: {
    outcome: string;
    status: number | null;
    code: string;
    remote: number | null;
    editor: string | null;
  },
  deadline: Date,
  check: () => void,
) {
  return inTime(db, deadline, async (tx) => {
    check();
    const [row] = await tx.$queryRaw<
      { result: { disposition: "COMPLETED" } }[]
    >`SELECT lyraseo_handoff.finish_step(${rid}::uuid,${proof},${receipt.outcome},${receipt.status}::integer,${receipt.code},${receipt.remote}::bigint,${receipt.editor}) AS result`;
    check();
    return row!.result;
  });
}
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
      const mode = await sourceMode(tx, r.requestId, result.proof);
      if (mode) {
        result.privateSource = true;
        result.pendingSource = !!mode.version || !!mode.unavailable;
      }
      if (result.privateSource && !artifactStore(db))
        throw Error("ARTIFACT_UNAVAILABLE");
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
/** Private scoped ticket from admission, never exposed over the bridge or to the Queue. */
export async function restoreStepSource(
  db: PrismaClient,
  rid: string,
  proof: string,
  deadline: Date,
) {
  const pending = await inTime(db, deadline, (tx) =>
    sourceMode(tx, rid, proof),
  );
  if (pending?.unavailable) {
    await checkStep(db, rid, proof, deadline);
    return restoreUnavailableReceipt(pending.unavailable);
  }
  if (!pending?.version) throw Error("ARTIFACT_UNAVAILABLE");
  const store = artifactStore(db);
  if (!store) throw Error("ARTIFACT_UNAVAILABLE");
  const bytes = await store
    .recoverReservedVersion(pending.version)
    .catch(() => {
      throw Error("ARTIFACT_UNAVAILABLE");
    });
  await checkStep(db, rid, proof, deadline);
  return restoreOriginalReceipt(
    pending.provenance,
    verifyReturnedBytes(pending.version, bytes),
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
  const store = artifactStore(db);
  let publication: Awaited<ReturnType<typeof verifiedPublication>> | undefined;
  if (store && attempt.privateSource) {
    const run = {
      manifest: attempt.manifest,
      methodologyVersion: "readiness-v2",
      profile: "CONTROLLED_RAW_TEST_V1",
    };
    const origin = await inTime(db, deadline, async (tx) => {
      checkKey();
      signal.throwIfAborted();
      const [row] = await tx.$queryRaw<
        { origin: string }[]
      >`SELECT lyraseo_origin.step_context(${rid}::uuid,${attempt.proof},${artifactOriginKeyId(db)}) AS origin`;
      return row!.origin;
    });
    const raw = JSON.stringify(
      await witnessedObservation(db, run, "step/" + rid, receipt, origin),
    );
    const reservation = await inTime(db, deadline, async (tx) => {
      checkKey();
      signal.throwIfAborted();
      const [row] = await tx.$queryRaw<
        { result: ArtifactReservation }[]
      >`SELECT lyraseo_audit.step_artifact_reserve(${rid}::uuid,${attempt.proof},${raw}::json) AS result`;
      return row!.result;
    });
    publication = await verifiedPublication(db, run, receipt, reservation);
    checkKey();
    signal.throwIfAborted();
  }
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
    const isPrivate = facts.storageFormat === STORAGE;
    if (isPrivate && !publication) throw Error("ARTIFACT_UNAVAILABLE");
    const current = isPrivate
      ? attestArtifactReceipt(facts, receipt).scratch
      : receipt.evidence;
    const data = isPrivate ? publication! : receipt;
    const evaluation =
      facts.priorEvidence === null
        ? null
        : frozenEvaluation(
            facts,
            facts.origin,
            [...facts.priorEvidence, current].sort((a, b) =>
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
    >`SELECT lyraseo_audit.commit_step(${rid}::uuid,${attempt.proof},${JSON.stringify(data)}::json,${evaluation === null ? null : JSON.stringify(isPrivate ? compactEvaluation(evaluation) : evaluation)}::jsonb) AS result`;
    checkKey();
    signal.throwIfAborted();
    return done!.result;
  });
}

export { auditErrorCode } from "./audit-errors";
