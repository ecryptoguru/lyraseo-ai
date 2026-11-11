import { randomUUID } from "node:crypto";
import type { createDatabase } from "@lyraseo/db";
import { authorizeSiteIn, withActor, type Actor } from "@lyraseo/db/context";
import {
  checkpointAuditPage,
  checkpointPrivateAudit,
  claimAuditRun,
  finishAuditRun,
  readAuditRun,
  readAuditProgress,
  yieldAuditRun,
  type AuditScope,
} from "@lyraseo/db/audits";
import {
  runAuditPage,
  type PublicTransport,
} from "@lyraseo/visibility/acquisition";
import { capabilityEnabled } from "@/server/capabilities";
import type { publicHttpsTransport } from "./transport";

async function beforeAbort<T>(signal: AbortSignal, work: () => Promise<T>) {
  signal.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** One bounded page per invocation. Successful checkpoints survive tab closure or restart. */
export async function runRawAuditStep(
  db: ReturnType<typeof createDatabase>,
  actor: Actor,
  scope: AuditScope,
  transport: typeof publicHttpsTransport,
  revalidateActor: () => Promise<Actor>,
  outer?: AbortSignal,
) {
  if (typeof revalidateActor !== "function")
    throw new Error("CURRENT_ACTOR_REQUIRED");
  outer?.throwIfAborted();
  const lease = await claimAuditRun(db, actor, scope, randomUUID());
  const stored = await readAuditProgress(db, actor, scope);
  const captured = new Set(stored.pages.map((page) => page.requestedUrl));
  const next = (stored.manifest as string[]).find((url) => !captured.has(url));
  if (next) {
    const siteOrigin = new URL(next).origin;
    const controller = new AbortController();
    const signal = outer
      ? AbortSignal.any([outer, controller.signal])
      : controller.signal;
    const assertAccess = async (socketSignal = signal) => {
      try {
        socketSignal.throwIfAborted();
        signal.throwIfAborted();
        if (!capabilityEnabled("audits")) throw new Error("FORBIDDEN");
        const fresh = await beforeAbort(socketSignal, revalidateActor);
        if (
          fresh.userId !== actor.userId ||
          fresh.sessionId !== actor.sessionId ||
          fresh.securityVersion !== actor.securityVersion
        )
          throw new Error("FORBIDDEN");
        await beforeAbort(socketSignal, () =>
          withActor(db, fresh, scope.workspaceId, async (tx) => {
            // prepare only checks/locks the current web lease; it writes no evidence.
            await tx.$queryRaw`SELECT lyraseo_audit.web_transition(${scope.siteId}::text,${scope.auditId}::text,${fresh.securityVersion}::integer,'prepare'::text,${lease.fence}::integer,NULL::text,NULL::json)`;
            const site = await authorizeSiteIn(
              tx,
              fresh,
              scope.workspaceId,
              scope.siteId,
              "run",
            );
            const verified = site.verifiedAt?.getTime();
            if (
              !verified ||
              verified > Date.now() ||
              Date.now() - verified > 86400000
            )
              throw new Error("SITE_NOT_VERIFIED");
            if (site.origin !== siteOrigin) throw new Error("FORBIDDEN");
            const current = await tx.auditRun.findFirst({
              where: {
                id: scope.auditId,
                workspaceId: scope.workspaceId,
                siteId: scope.siteId,
              },
              select: {
                status: true,
                fence: true,
                leaseOwner: true,
                leaseUntil: true,
                resultExpiresAt: true,
              },
            });
            if (
              !current ||
              current.status !== "RUNNING" ||
              current.fence !== lease.fence ||
              !lease.leaseOwner ||
              current.leaseOwner !== lease.leaseOwner ||
              !current.leaseUntil ||
              current.leaseUntil.getTime() <= Date.now() ||
              current.resultExpiresAt.getTime() <= Date.now()
            )
              throw new Error("STALE_LEASE");
          }),
        );
        socketSignal.throwIfAborted();
        signal.throwIfAborted();
        if (!capabilityEnabled("audits")) throw new Error("FORBIDDEN");
      } catch (error) {
        // Acquisition converts ordinary transport errors to receipts. Access loss
        // must abort instead, so it can never publish a fabricated failed capture.
        controller.abort(error);
        throw error;
      }
    };
    const boundTransport: PublicTransport = async (url, socketSignal) => {
      await assertAccess(socketSignal);
      return transport(url, socketSignal, () => assertAccess(socketSignal));
    };
    if (lease.storageFormat === "AUDIT_PRIVATE_V1") {
      await runAuditPage(
        next,
        siteOrigin,
        boundTransport,
        async (receipt) => {
          await assertAccess();
          return checkpointPrivateAudit(db, actor, scope, lease.fence, receipt);
        },
        signal,
      );
      return readAuditRun(db, actor, scope);
    }
    await runAuditPage(
      next,
      siteOrigin,
      boundTransport,
      async (receipt) => {
        await assertAccess();
        return checkpointAuditPage(
          db,
          actor,
          scope,
          lease.fence,
          receipt.evidence,
          {
            ...receipt.provenance,
          },
        );
      },
      signal,
    );
    captured.add(next);
  }
  if (captured.size === (stored.manifest as string[]).length) {
    await finishAuditRun(db, actor, scope, lease.fence);
  } else {
    await yieldAuditRun(db, actor, scope, lease.fence);
  }
  return readAuditRun(db, actor, scope);
}
