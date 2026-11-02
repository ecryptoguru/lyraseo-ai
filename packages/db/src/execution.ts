import type { PrismaClient } from "../generated/client";
import { type Actor, authorizeSiteIn, withActor, withLedger } from "./context";
import {
  acknowledgeOutbox,
  cancelInvalidQueuedOperation,
  expireQueued,
  pendingOutbox,
} from "./accounting";

/** Internal queue binding. Messages carry references only, never caller authority. */
export type OperationQueue = {
  send(message: { operationId: string }): Promise<void>;
};

export async function readOperation(
  db: PrismaClient,
  actor: Actor,
  id: string,
) {
  return withActor(db, actor, "", async (tx) => {
    const op = await tx.operation.findFirst({
      where: { id, userId: actor.userId },
    });
    if (!op) throw new Error("NOT_FOUND");
    await tx.$queryRaw`SELECT set_config('app.workspace_id',${op.workspaceId},true)`;
    await authorizeSiteIn(tx, actor, op.workspaceId, op.siteId, "read");
    return {
      id: op.id,
      siteId: op.siteId,
      status: op.status,
      createdAt: op.createdAt,
      expiresAt: op.expiresAt,
      reservedCost: op.reservedCost.toFixed(9),
      actualCost: op.actualCost?.toFixed(9) ?? null,
      cancelRequestedAt: op.cancelRequestedAt,
    };
  });
}

/** Pause is supplied by trusted operator configuration, never request input. */
export async function publishOperations(
  db: PrismaClient,
  actor: Actor,
  queue: OperationQueue,
  options: { paused: boolean; now?: Date },
) {
  const result = { published: 0, skipped: 0, failed: 0 };
  if (options.paused) return result;
  const now = options.now ?? new Date();
  for (const event of await pendingOutbox(db, actor)) {
    // Reauthorize every publication. A queued reference can outlive site grants.
    const permitted = await withActor(db, actor, "", async (tx) => {
      const op = await tx.operation.findFirst({
        where: { id: event.operationId, userId: actor.userId },
      });
      if (
        !op ||
        op.status !== "QUEUED" ||
        op.expiresAt <= now ||
        op.cancelRequestedAt ||
        op.securityVersion !== actor.securityVersion
      )
        return null;
      await tx.$queryRaw`SELECT set_config('app.workspace_id',${op.workspaceId},true)`;
      const site = await authorizeSiteIn(
        tx,
        actor,
        op.workspaceId,
        op.siteId,
        "run",
      );
      return site.verifiedAt &&
        site.verifiedAt <= new Date(now.getTime() + 30000) &&
        now.getTime() - site.verifiedAt.getTime() <= 86400000
        ? op
        : null;
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        ["FORBIDDEN", "NOT_FOUND"].includes(error.message)
      )
        return null;
      throw error;
    });
    if (!permitted) {
      await cancelInvalidQueuedOperation(db, actor, event.operationId, now);
      result.skipped++;
      continue;
    }
    try {
      // A crash between send and acknowledgement intentionally causes redelivery.
      await queue.send({ operationId: event.operationId });
      await acknowledgeOutbox(db, actor, event.id, permitted.fence);
      result.published++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

/** Internal sweep for one persisted owner. Never dispatches or discards uncertain charges. */
export async function recoverOperations(
  db: PrismaClient,
  actor: Actor,
  now = new Date(),
) {
  const candidates = await withLedger(db, actor.userId, (tx) =>
    tx.operation.findMany({
      where: {
        userId: actor.userId,
        OR: [
          { status: "QUEUED", expiresAt: { lte: now } },
          {
            status: { in: ["RUNNING", "WAITING_PROVIDER"] },
            OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
          },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    }),
  );
  let recovered = 0;
  for (const candidate of candidates) {
    await expireQueued(db, actor, candidate.id, now);
    recovered += await withLedger(db, actor.userId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Operation" WHERE id=${candidate.id} AND "userId"=${actor.userId} FOR UPDATE`;
      const op = await tx.operation.findFirst({
        where: { id: candidate.id, userId: actor.userId },
      });
      if (
        !op ||
        !["RUNNING", "WAITING_PROVIDER"].includes(op.status) ||
        (op.leaseUntil && op.leaseUntil > now)
      )
        return 0;
      const uncertain = op.attemptState !== "NONE";
      await tx.operation.update({
        where: { id: op.id },
        data: {
          status: uncertain ? "RECONCILING" : "QUEUED",
          leaseUntil: null,
          leaseOwner: null,
          fence: { increment: uncertain ? 0 : 1 },
        },
      });
      if (!uncertain)
        await tx.outboxEvent.updateMany({
          where: { operationId: op.id },
          data: { deliveredAt: null },
        });
      return 1;
    });
  }
  return { inspected: candidates.length, recovered };
}
