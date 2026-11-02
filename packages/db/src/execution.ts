import type { PrismaClient } from "../generated/client";
import { type Actor, authorizeSiteIn, withActor, withLedger } from "./context";
import { expireQueued } from "./accounting";

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

/** Quiesced compatibility verdict. Old callers cannot discover or send any event. */
export async function publishOperations(
  _db: PrismaClient,
  _actor: Actor,
  _queue: { send(message: { operationId: string }): Promise<void> },
  _options: { paused: boolean; now?: Date },
) {
  return {
    disposition: "DISABLED" as const,
    published: 0,
    skipped: 0,
    failed: 0,
  };
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
      return 1;
    });
  }
  return { inspected: candidates.length, recovered };
}
