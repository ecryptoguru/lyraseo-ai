import type { PrismaClient } from "../generated/client";
import { withActor, type Actor } from "./context";
import {
  assertRecoveryJournal,
  type RecoveryJournal,
} from "./recovery-journal";
import type { HistoryScope } from "./history-retention";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Identity = { incarnation: string; deleted: boolean; origin: string };
type AcceptedCase = {
  id: string;
  receiptHash: string;
  acceptedAt: string;
  deadline: string;
  recordExpiresAt: string;
};
function fresh(actor: Actor) {
  const now = Date.now(),
    auth = Date.parse(actor.authenticatedAt),
    mfa = Date.parse(actor.mfaAuthenticatedAt ?? "");
  if (
    !actor.mfaVerified ||
    !Number.isFinite(auth) ||
    !Number.isFinite(mfa) ||
    auth > now ||
    mfa > now ||
    now - auth > 300000 ||
    now - mfa > 300000
  )
    throw Error("RECENT_AUTH_AND_MFA_REQUIRED");
}
export async function previewSiteDeletion(
  db: PrismaClient,
  actor: Actor,
  scope: HistoryScope,
) {
  if ("credential" in actor) throw Error("FORBIDDEN");
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const [row] = await tx.$queryRaw<
      Array<{ value: Identity }>
    >`SELECT lyraseo_deletion.identity(${scope.workspaceId},${scope.siteId},${actor.securityVersion}::integer) value`;
    if (!row?.value) throw Error("DELETION_SCOPE_UNAVAILABLE");
    return {
      ...row.value,
      scope: { workspaceId: scope.workspaceId, siteId: scope.siteId },
      qualification: "LOCAL_TEST_ONLY" as const,
      consequences: {
        access: "IMMEDIATE",
        localCleanupTargetDays: 7,
        remoteErasure: "UNVERIFIED",
        backupErasure: "UNQUALIFIED",
        allCopiesErased: false,
      },
    };
  });
}
/** Admission is deliberately unavailable: no authoritative DB journal/MFA issuer
 * has been qualified. Existing durable journal entries remain intact for recovery.
 * Neither enabling a TypeScript flag nor setting actor GUCs grants this authority. */
export async function acceptSiteDeletion(
  db: PrismaClient,
  actor: Actor,
  scope: HistoryScope,
  input: {
    caseId: string;
    requestId: string;
    confirmSiteId: string;
    confirmIncarnation: string;
    permanent: true;
  },
  options: {
    journal: RecoveryJournal;
    resolveActor: () => Promise<Actor | null>;
    enabled: boolean;
  },
): Promise<AcceptedCase & { accessBlocked: true; allCopiesErased: false }> {
  if (!options.enabled) throw Error("SITE_DELETION_DISABLED");
  if ("credential" in actor) throw Error("FORBIDDEN");
  assertRecoveryJournal(options.journal);
  if (
    !uuid.test(input.caseId) ||
    !uuid.test(input.requestId) ||
    input.confirmSiteId !== scope.siteId ||
    !uuid.test(input.confirmIncarnation) ||
    input.permanent !== true
  )
    throw Error("DELETION_CONFIRMATION_REQUIRED");
  async function current() {
    const value = await options.resolveActor();
    if (
      !value ||
      value.userId !== actor.userId ||
      value.sessionId !== actor.sessionId ||
      value.securityVersion !== actor.securityVersion
    )
      throw Error("DELETION_ACTOR_CHANGED");
    fresh(value);
    return value;
  }
  const initial = await current(),
    preview = await previewSiteDeletion(db, initial, scope);
  if (preview.incarnation !== input.confirmIncarnation)
    throw Error("DELETION_INCARNATION_CHANGED");
  throw Error("DELETION_ADMISSION_UNQUALIFIED");
}
export function localSiteDeletionMaintenance(
  db: PrismaClient,
  options: { enabled: boolean },
) {
  if (!options.enabled) throw Error("SITE_DELETION_DISABLED");
  return {
    qualification: "LOCAL_TEST_ONLY" as const,
    async status(scope: HistoryScope, id: string) {
      const [row] = await db.$queryRaw<
        Array<{ value: unknown }>
      >`SELECT lyraseo_deletion.status(${scope.workspaceId},${scope.siteId},${id}::uuid) value`;
      if (!row) throw Error("DELETION_CASE_UNAVAILABLE");
      return row.value;
    },
    async sweep(scope: HistoryScope, id: string, limit = 3) {
      const [row] = await db.$queryRaw<
        Array<{ value: { completedTasks: number; allCopiesErased: false } }>
      >`SELECT lyraseo_deletion.sweep(${scope.workspaceId},${scope.siteId},${id}::uuid,${limit}::integer) value`;
      if (!row) throw Error("DELETION_CASE_UNAVAILABLE");
      return row.value;
    },
  };
}
