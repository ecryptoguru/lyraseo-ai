import type { Prisma, PrismaClient } from "../generated/client";
export type Actor = {
  userId: string;
  sessionId: string;
  securityVersion: number;
  authenticatedAt: string;
  mfaVerified: boolean;
  authProvider: "supabase";
  mfaAuthenticatedAt?: string;
};
/** Verified bearer credentials never impersonate a browser session. */
export type TokenActor = {
  credential: "api-token";
  userId: string;
  securityVersion: number;
  tokenId: string;
  tokenHash: string;
  workspaceId: string;
};
export type ReadActor = Actor | TokenActor;
export const isTokenActor = (actor: ReadActor): actor is TokenActor =>
  "credential" in actor;
export type ReadScope = "sites:read" | "audits:read" | "search:read";
export async function requireReadScope(
  tx: Tx,
  actor: ReadActor,
  scope: ReadScope,
) {
  if (isTokenActor(actor)) {
    const token = await tx.apiToken.findUnique({
      where: { id: actor.tokenId },
    });
    if (!token?.scopes.includes(scope)) throw new Error("FORBIDDEN");
  }
}
export type Tx = Prisma.TransactionClient;
export async function withActor<T>(
  db: PrismaClient,
  actor: ReadActor,
  workspaceId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id',${actor.userId},true),set_config('app.workspace_id',${workspaceId},true)`;
      const user = await tx.productUser.findUnique({
        where: { id: actor.userId },
      });
      if (
        !user ||
        user.suspended ||
        user.securityVersion !== actor.securityVersion
      )
        throw new Error("FORBIDDEN");
      if (isTokenActor(actor)) {
        const token = await tx.apiToken.findUnique({
          where: { id: actor.tokenId },
        });
        const member = await tx.membership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
        });
        const workspace = await tx.workspace.findUnique({
          where: { id: workspaceId },
        });
        if (
          !token ||
          token.tokenHash !== actor.tokenHash ||
          token.createdBy !== actor.userId ||
          token.workspaceId !== workspaceId ||
          actor.workspaceId !== workspaceId ||
          token.revokedAt ||
          token.expiresAt.getTime() <= Date.now() ||
          token.securityVersion !== user.securityVersion ||
          !member ||
          !workspace ||
          workspace.deletedAt
        )
          throw new Error("FORBIDDEN");
      }
      return work(tx);
    },
    { maxWait: 10000, timeout: 15000 },
  );
}
export async function authorizeSiteIn(
  tx: Tx,
  actor: ReadActor,
  workspaceId: string,
  siteId: string,
  action: "read" | "run" | "edit" | "export",
) {
  if (isTokenActor(actor)) {
    const token = await tx.apiToken.findUnique({
      where: { id: actor.tokenId },
    });
    if (
      action !== "read" ||
      !token?.siteIds.includes(siteId) ||
      token.workspaceId !== workspaceId
    )
      throw new Error("FORBIDDEN");
  }
  const member = await tx.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
  });
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!member || !workspace || workspace.deletedAt)
    throw new Error("FORBIDDEN");
  const site = await tx.site.findUnique({
    where: { workspaceId_id: { workspaceId, id: siteId } },
  });
  if (!site || site.deletedAt) throw new Error("NOT_FOUND");
  if (member.role === "OWNER" || member.role === "ADMIN") return site;
  if (member.role === "VIEWER" && !["read", "export"].includes(action))
    throw new Error("FORBIDDEN");
  if (
    !(await tx.siteGrant.findUnique({
      where: {
        workspaceId_siteId_userId: {
          workspaceId,
          siteId,
          userId: actor.userId,
        },
      },
    }))
  )
    throw new Error("FORBIDDEN");
  return site;
}

/** Internal financial receipt path: revocation must not erase an already incurred charge.
 * Not an authorization helper and never exposed as a customer endpoint. */
export async function withLedger<T>(
  db: PrismaClient,
  userId: string,
  work: (tx: Tx) => Promise<T>,
) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id',${userId},true),set_config('app.workspace_id','',true)`;
      if (!(await tx.productUser.findUnique({ where: { id: userId } })))
        throw new Error("NOT_FOUND");
      return work(tx);
    },
    { maxWait: 10000, timeout: 15000 },
  );
}
export function requireFreshAuthentication(actor: Actor, now = new Date()) {
  const fresh = (value: string | undefined) => {
    const time = Date.parse(value ?? "");
    return (
      Number.isFinite(time) &&
      time <= now.getTime() + 30000 &&
      now.getTime() - time < 600000
    );
  };
  if (
    !fresh(actor.authenticatedAt) ||
    (actor.mfaVerified && !fresh(actor.mfaAuthenticatedAt))
  )
    throw new Error("FRESH_AUTH_REQUIRED");
}
