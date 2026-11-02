import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/client";
/** Call only after provider signature/current-user and invite verification. Never link by email. */
export async function provisionIdentity(db: PrismaClient, subject: string) {
  const where = { provider_subject: { provider: "supabase", subject } };
  const existing = await db.providerIdentity.findUnique({
    where,
    include: { user: true },
  });
  if (existing) return existing.user;
  try {
    return (
      await db.providerIdentity.create({
        data: { provider: "supabase", subject, user: { create: {} } },
        include: { user: true },
      })
    ).user;
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    return (
      await db.providerIdentity.findUniqueOrThrow({
        where,
        include: { user: true },
      })
    ).user;
  }
}
/** Persistent windows anchored to the first attempt, including a full resend cooldown. */
export async function throttle(
  db: PrismaClient,
  scope: string,
  identity: string,
  limit: number,
  windowMs: number,
  now = new Date(),
) {
  const key = createHash("sha256").update(`${scope}:${identity}`).digest("hex");
  const expiresAt = new Date(now.getTime() + windowMs);
  const rows = await db.$queryRaw<
    { count: number }[]
  >`INSERT INTO "AuthThrottle" (key,count,"expiresAt") VALUES (${key},1,${expiresAt}) ON CONFLICT (key) DO UPDATE SET count=CASE WHEN "AuthThrottle"."expiresAt"<=${now} THEN 1 ELSE "AuthThrottle".count+1 END,"expiresAt"=CASE WHEN "AuthThrottle"."expiresAt"<=${now} THEN ${expiresAt} ELSE "AuthThrottle"."expiresAt" END RETURNING count`;
  if (rows[0]!.count > limit) throw new Error("RATE_LIMITED");
}
export type VerifiedSessionHistory = {
  sessionId: string;
  userId: string;
  securityVersion: number;
  createdAt: Date;
  refreshedAt: Date;
  authenticatedAt: Date;
};
/** Accept only authoritative metadata and signed first-factor times from the auth adapter.
 * No browser-supplied timestamps. A page click never advances refreshedAt. */
export async function acceptSessionHistory(
  db: PrismaClient,
  input: VerifiedSessionHistory,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`session:${input.sessionId}`},0))::text`;
    const previous = await tx.productSession.findUnique({
      where: { sessionId: input.sessionId },
    });
    if (previous) {
      if (
        previous.userId !== input.userId ||
        previous.securityVersion !== input.securityVersion
      )
        throw new Error("SESSION_EXPIRED");
      if (now.getTime() - previous.refreshedAt.getTime() >= 7 * 86400000)
        throw new Error("SESSION_EXPIRED");
      if (input.createdAt.getTime() !== previous.createdAt.getTime())
        throw new Error("AUTH_POLICY_UNVERIFIED");
      // Parallel verified requests can arrive out of order. Never rewind history.
      if (input.refreshedAt > previous.refreshedAt)
        return tx.productSession.update({
          where: { sessionId: input.sessionId },
          data: { refreshedAt: input.refreshedAt },
        });
      return previous;
    }
    // First observation must be a genuinely fresh sign-in, not an old refreshed cookie.
    if (
      now.getTime() - input.authenticatedAt.getTime() >= 600000 ||
      input.authenticatedAt.getTime() > now.getTime() + 30000
    )
      throw new Error("FRESH_AUTH_REQUIRED");
    return tx.productSession.create({
      data: {
        sessionId: input.sessionId,
        userId: input.userId,
        securityVersion: input.securityVersion,
        createdAt: input.createdAt,
        refreshedAt: input.refreshedAt,
      },
    });
  });
}
