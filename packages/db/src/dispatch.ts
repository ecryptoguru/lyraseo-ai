import type { PrismaClient } from "../generated/client";

/** B must verify protocol, audience, method, exact path, expiry and raw bytes
 * before constructing a request. The kernel independently binds those bytes to
 * the action and uses session_user for identity. No default/admin connection. */
export type KernelRequest = Readonly<{
  requestId: string;
  audience: string;
  issuedAt: Date;
  expiresAt: Date;
  rawBody: string;
}>;

export type DispatchRef = Readonly<{
  workId: string;
  generation: number;
  claimToken: string;
}>;
type InProgress = { disposition: "IN_PROGRESS" };
type ClaimResult =
  { disposition: "OK" | "PAUSED"; refs: DispatchRef[] } | InProgress;
type DeliveryResult =
  { disposition: "DELIVERED" | "DEFERRED" | "STALE" | "PAUSED" } | InProgress;
type RecoveryResult =
  | {
      disposition: "OK";
      reopened: number;
      suppressed: number;
      reconciliation: number;
    }
  | InProgress;

type CommandClient = Pick<PrismaClient, "$queryRaw">;
async function command<Result>(
  db: CommandClient,
  path: string,
  request: KernelRequest,
) {
  // One statement/transaction for CAS, state transition and replay completion.
  const [row] = await db.$queryRaw<
    { result: Result }[]
  >`SELECT lyraseo_kernel.command(${request.requestId}::uuid,${request.audience}::text,${path}::text,
     ${request.rawBody}::text,${request.issuedAt}::timestamptz,${request.expiresAt}::timestamptz) AS result`;
  return row!.result;
}
export const claimDue = (db: CommandClient, request: KernelRequest) =>
  command<ClaimResult>(db, "/api/internal/runtime/dispatch", request);
export const ackDelivery = (db: CommandClient, request: KernelRequest) =>
  command<DeliveryResult>(db, "/api/internal/runtime/dispatch/ack", request);
export const deferDelivery = (db: CommandClient, request: KernelRequest) =>
  command<DeliveryResult>(db, "/api/internal/runtime/dispatch/defer", request);
export const recoverDue = (db: CommandClient, request: KernelRequest) =>
  command<RecoveryResult>(db, "/api/internal/runtime/recover", request);

declare const controlledBinding: unique symbol;
type ControlledBinding = Readonly<{
  [controlledBinding]: true;
  workId: string;
  generation: number;
  action: "INSPECT_CONTROLLED_AUDIT";
  targetId: string;
  workspaceId: string;
  siteId: string;
  userId: string;
  securityVersion: number;
}>;
/** Read-only; never a credential for a target mutation or provider purchase. */
export async function resolveStepBinding(
  db: PrismaClient,
  workId: string,
  generation: number,
) {
  const [row] = await db.$queryRaw<
    { binding: ControlledBinding | null }[]
  >`SELECT lyraseo_kernel.resolve_step(${workId}::uuid,${generation}::integer) AS binding`;
  return row!.binding;
}

/** Operator connection only. A missing policy has no enabling effect. */
export async function readRuntimePolicy(operator: PrismaClient, key: string) {
  type Policy = {
    key: string;
    enabled: boolean;
    revision: number;
    changedAt: string;
  };
  const [row] = await operator.$queryRaw<
    { policy: Policy | null }[]
  >`SELECT lyraseo_kernel.read_policy(${key}::text) AS policy`;
  return row!.policy;
}
export async function changeRuntimePolicy(
  operator: PrismaClient,
  key: string,
  expectedRevision: number,
  enabled: boolean,
) {
  const [row] = await operator.$queryRaw<
    { revision: number }[]
  >`SELECT lyraseo_kernel.change_policy(${key}::text,${expectedRevision}::integer,${enabled}::boolean) AS revision`;
  return row!.revision;
}
