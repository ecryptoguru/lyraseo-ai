import { randomBytes } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import type { Actor } from "./context";
import {
  projectSandboxSnapshot,
  type SandboxSnapshot,
  type VerifiedBillingEvent,
} from "./sandbox-billing-codecs";
export type StaffView =
  | "billing"
  | "deliveries"
  | "jobs"
  | "operations"
  | "usage"
  | "recovery"
  | "audit"
  | "controls"
  | "search"
  | "privacy";
export type StaffAction =
  | "billing:reconcile"
  | "policy:pause"
  | "recovery:open"
  | "recovery:hold"
  | "recovery:approve"
  | "recovery:deny"
  | "recovery:complete";
export type SupportValue =
  | string
  | number
  | boolean
  | null
  | SupportValue[]
  | { [key: string]: SupportValue };
export type SupportView = {
  actionContextId?: string;
  actionPrincipalId?: string;
  pendingRequests?: {
    requestId: string;
    action?: StaffAction;
    target?: string;
    args?: Record<string, unknown>;
    reason?: string;
    requestState: string;
  }[];
  pauseExecution?: "UNAVAILABLE";
  mode: "SANDBOX";
  recoveryMode: "LOCAL_REHEARSAL";
  productionCommerceEnabled: false;
  permissions: string[];
  nextCursor: string | null;
  limit: number;
  rows: Record<string, SupportValue>[];
  available?: boolean;
  profile?: string;
  allCopiesErased?: false;
};
export async function readStaffView(
  db: PrismaClient,
  actor: Actor,
  view: StaffView,
  cursor?: string,
) {
  const [row] = await db.$queryRaw<
    { value: SupportView }[]
  >`SELECT lyraseo_billing.staff_view(${JSON.stringify(actor)}::jsonb,${view}::text,${cursor ?? null}::text,25::integer) AS value`;
  return row!.value;
}
/** Only trusted Node after verified interactive staff admission receives this DB connection. */
export async function prepareStaffStepUp(
  db: PrismaClient,
  actor: Actor,
  action: StaffAction,
  target: string,
) {
  const token = randomBytes(32).toString("base64url");
  await db.$queryRaw`SELECT lyraseo_billing.issue_step_up(${JSON.stringify(actor)}::jsonb,${action}::text,${target}::text,${token}::text)::text`;
  return token;
}
export async function performStaffAction(
  db: PrismaClient,
  actor: Actor,
  action: StaffAction,
  target: string,
  token: string,
  args: Record<string, unknown>,
  reason: string,
) {
  const [row] = await db.$queryRaw<
    { value: Record<string, unknown> }[]
  >`SELECT lyraseo_billing.staff_action(${JSON.stringify(actor)}::jsonb,${action}::text,${target}::text,${token}::text,${JSON.stringify(args)}::text,${reason}::text) AS value`;
  return row!.value;
}
export async function executeStaffPause(
  operator: PrismaClient,
  intentId: string,
) {
  const [row] = await operator.$queryRaw<
    { value: Record<string, unknown> }[]
  >`SELECT lyraseo_billing.execute_pause(${intentId}::uuid) AS value`;
  return row!.value;
}
export async function persistVerifiedSandboxEvent(
  intake: PrismaClient,
  event: VerifiedBillingEvent,
) {
  const [row] = await intake.$queryRaw<
    { value: { outcome: string; id?: string } }[]
  >`SELECT lyraseo_billing.record_event(${JSON.stringify(event)}::jsonb) AS value`;
  return row!.value;
}
export type SandboxReadBinding = {
  id: string;
  provider: string;
  merchantId: string;
  resourceId: string;
  generation: number;
  fence: number;
  token: string;
};
/** Implementations read an already-bound sandbox resource; this package contains no network provider reader. */
export type SandboxSnapshotReader = (
  binding: Readonly<SandboxReadBinding>,
  signal: AbortSignal,
) => Promise<SandboxSnapshot | null>;
export async function reconcileSandboxBilling(
  db: PrismaClient,
  scope: { provider: string; merchantId: string; resourceId: string },
  reader?: SandboxSnapshotReader,
) {
  const [claimed] = await db.$queryRaw<
    { value: SandboxReadBinding }[]
  >`SELECT lyraseo_billing.claim(${scope.provider}::text,${scope.merchantId}::text,${scope.resourceId}::text) AS value`;
  const claim = claimed!.value;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = reader
      ? await Promise.race([
          reader(Object.freeze(claim), abort.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new Error("READ_TIMEOUT"));
            }, 10000);
          }),
        ])
      : null;
    if (!snapshot) {
      await db.$queryRaw`SELECT lyraseo_billing.defer(${claim.id}::uuid,${claim.fence}::integer,${claim.generation}::integer,${claim.token}::uuid,'READER_UNAVAILABLE'::text)::text`;
      return { state: "UNAVAILABLE", productionEntitled: false };
    }
    const normalized = projectSandboxSnapshot(snapshot);
    const [row] = await db.$queryRaw<
      { value: Record<string, unknown> }[]
    >`SELECT lyraseo_billing.apply_snapshot(${claim.id}::uuid,${claim.fence}::integer,${claim.generation}::integer,${claim.token}::uuid,${JSON.stringify(normalized)}::jsonb) AS value`;
    return row!.value;
  } catch (error) {
    // Defer only a live claim; a newer notice/lease has independent authority.
    try {
      await db.$queryRaw`SELECT lyraseo_billing.defer(${claim.id}::uuid,${claim.fence}::integer,${claim.generation}::integer,${claim.token}::uuid,${error instanceof Error && error.message === "READ_TIMEOUT" ? "READ_TIMEOUT" : "INVALID_SNAPSHOT"}::text)::text`;
    } catch {
      /* stale claim cannot alter new work */
    }
    throw new Error(
      error instanceof Error && error.message === "READ_TIMEOUT"
        ? "BILLING_READ_TIMEOUT"
        : "BILLING_RECONCILIATION_FAILED",
    );
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}
export type SandboxOwnerStatus = {
  mode: "SANDBOX";
  pilotAccess: "FREE";
  checkoutAvailable: false;
  productionEntitled: false;
  pendingIntent: boolean;
  subscriptions: {
    provider: string;
    state: string;
    periodEnd: string | null;
    sandboxEntitled: boolean;
    productionEntitled: false;
    reconciledAt: string;
  }[];
};
export async function readSandboxBillingStatus(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
) {
  const [row] = await db.$queryRaw<
    { value: SandboxOwnerStatus }[]
  >`SELECT lyraseo_billing.owner_status(${JSON.stringify(actor)}::jsonb,${workspaceId}::text) AS value`;
  return row!.value;
}

export async function recordStaffDenied(
  db: PrismaClient,
  actor: Actor,
  action: StaffAction,
  target: string,
) {
  await db.$queryRaw`SELECT lyraseo_billing.staff_denied(${JSON.stringify(actor)}::jsonb,${action}::text,${target}::text)::text`;
}
export type SupportSearchResult = SupportView & {
  nextKind: "SITE" | "USER" | "WORKSPACE" | null;
  nextId: string | null;
};
export async function searchStaffSupport(
  db: PrismaClient,
  actor: Actor,
  input: {
    query: string;
    match: "EXACT" | "PREFIX";
    cursorKind?: "SITE" | "USER" | "WORKSPACE";
    cursorId?: string;
  },
) {
  const [row] = await db.$queryRaw<
    { value: SupportSearchResult }[]
  >`SELECT lyraseo_billing.staff_search(${JSON.stringify(actor)}::jsonb,${input.query}::text,${input.match}::text,${input.cursorKind ?? null}::text,${input.cursorId ?? null}::text,25::integer) AS value`;
  return row!.value;
}
export async function prepareStaffRequest(
  db: PrismaClient,
  actor: Actor,
  input: {
    requestId: string;
    action: StaffAction;
    target: string;
    args: Record<string, unknown>;
    reason: string;
  },
) {
  const [row] = await db.$queryRaw<
    { value: { requestId: string; state: string } }[]
  >`SELECT lyraseo_billing.prepare_request(${JSON.stringify(actor)}::jsonb,${input.requestId}::uuid,${input.action}::text,${input.target}::text,${JSON.stringify(input.args)}::text,${input.reason}::text) AS value`;
  return row!.value;
}
export async function executeStaffRequest(
  db: PrismaClient,
  actor: Actor,
  requestId: string,
) {
  const [row] = await db.$queryRaw<
    { value: Record<string, unknown> }[]
  >`SELECT lyraseo_billing.execute_request(${JSON.stringify(actor)}::jsonb,${requestId}::uuid) AS value`;
  return row!.value;
}
export async function resolveStaffRequest(
  db: PrismaClient,
  actor: Actor,
  requestId: string,
  choice: "STATUS" | "ABANDON",
) {
  const [row] = await db.$queryRaw<
    { value: Record<string, unknown> }[]
  >`SELECT lyraseo_billing.resolve_request(${JSON.stringify(actor)}::jsonb,${requestId}::uuid,${choice}::text) AS value`;
  return row!.value;
}
export async function acknowledgeStaffRequest(
  db: PrismaClient,
  actor: Actor,
  requestId: string,
  resultHash: string,
) {
  const [row] = await db.$queryRaw<
    { value: Record<string, unknown> }[]
  >`SELECT lyraseo_billing.ack_request(${JSON.stringify(actor)}::jsonb,${requestId}::uuid,${resultHash}::text) AS value`;
  return row!.value;
}
