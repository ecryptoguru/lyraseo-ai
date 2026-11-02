import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import {
  authorizeSiteIn,
  requireFreshAuthentication,
  withActor,
  type Actor,
  type ReadScope,
  type TokenActor,
  type Tx,
} from "./context";
export const readScopes = ["sites:read", "audits:read", "search:read"] as const;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Changing the private-pilot allowlist invalidates existing credentials fail-closed. */
export const tokenAccessPolicyHash = (emails: string[]) =>
  hash([...new Set(emails.map((e) => e.toLowerCase()))].sort().join("\n"));
const metadata = {
  id: true,
  workspaceId: true,
  name: true,
  siteIds: true,
  scopes: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
} as const;
/** Fixed keys (issuer/token/global) prevent attacker-generated bucket growth. Counters commit even when authorization fails. */
export async function consumeApiLimit(
  db: PrismaClient,
  key: string,
  limit: number,
  now = new Date(),
) {
  const expires = new Date(now.getTime() + 60000);
  const [row] = await db.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "ApiThrottle"("key","count","expiresAt") VALUES (${key},1,${expires})
    ON CONFLICT ("key") DO UPDATE SET
      "count"=CASE WHEN "ApiThrottle"."expiresAt"<=${now} THEN 1 ELSE LEAST("ApiThrottle"."count"+1,${limit + 1}) END,
      "expiresAt"=CASE WHEN "ApiThrottle"."expiresAt"<=${now} THEN ${expires} ELSE "ApiThrottle"."expiresAt" END
    RETURNING "count"`;
  await db.$executeRaw`DELETE FROM "ApiThrottle" WHERE "key" IN (SELECT "key" FROM "ApiThrottle" WHERE "expiresAt"<=${now} LIMIT 100)`;
  if (!row || row.count > limit) throw new Error("RATE_LIMITED");
}
async function membership(tx: Tx, actor: Actor, workspaceId: string) {
  const member = await tx.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
  });
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!member || !workspace || workspace.deletedAt)
    throw new Error("FORBIDDEN");
}
export async function listApiTokens(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
) {
  await consumeApiLimit(db, `management:${actor.userId}`, 30);
  return withActor(db, actor, workspaceId, async (tx) => {
    await membership(tx, actor, workspaceId);
    return tx.apiToken.findMany({
      where: { createdBy: actor.userId, workspaceId },
      select: metadata,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
  });
}
export type CreateApiToken = {
  workspaceId: string;
  name: string;
  siteIds: string[];
  scopes: ReadScope[];
  expiresInDays?: number;
  requestKey: string;
};
export async function createApiToken(
  db: PrismaClient,
  actor: Actor,
  input: CreateApiToken,
  accessPolicyHash: string,
) {
  await consumeApiLimit(db, `management:${actor.userId}`, 30);
  requireFreshAuthentication(actor);
  const days = input.expiresInDays ?? 90;
  if (
    !input.name.trim() ||
    input.name.length > 80 ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 90 ||
    input.siteIds.length < 1 ||
    input.siteIds.length > 20 ||
    new Set(input.siteIds).size !== input.siteIds.length ||
    !input.scopes.length ||
    input.scopes.length > 3 ||
    new Set(input.scopes).size !== input.scopes.length ||
    input.scopes.some((s) => !readScopes.includes(s)) ||
    !/^[0-9a-f-]{36}$/i.test(input.requestKey) ||
    !/^[0-9a-f]{64}$/.test(accessPolicyHash)
  )
    throw new Error("INVALID_TOKEN");
  return withActor(db, actor, input.workspaceId, async (tx) => {
    // Serialize issue/replay admission for this issuer in this workspace.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`tokens:${actor.userId}:${input.workspaceId}`}))::text`;
    await membership(tx, actor, input.workspaceId);
    for (const siteId of input.siteIds)
      await authorizeSiteIn(tx, actor, input.workspaceId, siteId, "read");
    if (
      await tx.apiToken.findUnique({
        where: {
          createdBy_workspaceId_requestKey: {
            createdBy: actor.userId,
            workspaceId: input.workspaceId,
            requestKey: input.requestKey,
          },
        },
      })
    )
      throw new Error("TOKEN_ALREADY_CREATED");
    if (
      (await tx.apiToken.count({
        where: { createdBy: actor.userId, workspaceId: input.workspaceId },
      })) >= 100
    )
      throw new Error("TOKEN_LIMIT");
    if (
      (await tx.apiToken.count({
        where: {
          createdBy: actor.userId,
          workspaceId: input.workspaceId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      })) >= 20
    )
      throw new Error("TOKEN_LIMIT");
    const secret = `lyra_${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date();
    const token = await tx.apiToken.create({
      data: {
        workspaceId: input.workspaceId,
        createdBy: actor.userId,
        name: input.name.trim(),
        tokenHash: hash(secret),
        securityVersion: actor.securityVersion,
        accessPolicyHash,
        siteIds: input.siteIds,
        scopes: input.scopes,
        requestKey: input.requestKey,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + days * 86400000),
      },
      select: metadata,
    });
    return { token, secret };
  });
}
export async function revokeApiToken(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
  tokenId: string,
) {
  await consumeApiLimit(db, `management:${actor.userId}`, 30);
  requireFreshAuthentication(actor);
  return withActor(db, actor, workspaceId, async (tx) => {
    await membership(tx, actor, workspaceId);
    const token = await tx.apiToken.findFirst({
      where: { id: tokenId, workspaceId, createdBy: actor.userId },
    });
    if (!token) throw new Error("NOT_FOUND");
    if (!token.revokedAt)
      await tx.apiToken.update({
        where: { id: token.id },
        data: { revokedAt: new Date() },
      });
    return { revoked: true };
  });
}
export async function resolveApiToken(
  db: PrismaClient,
  secret: string | null,
  accessPolicyHash: string,
): Promise<TokenActor> {
  // All requests consume the global gate, including rejected credentials, without relying on spoofable IP headers.
  await consumeApiLimit(db, "mcp:global", 600);
  if (!secret || !/^lyra_[A-Za-z0-9_-]{43}$/.test(secret))
    throw new Error("UNAUTHENTICATED");
  const tokenHash = hash(secret);
  const credential = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.token_hash',${tokenHash},true)`;
    const token = await tx.apiToken.findUnique({ where: { tokenHash } });
    if (
      !token ||
      token.revokedAt ||
      token.expiresAt.getTime() <= Date.now() ||
      token.accessPolicyHash !== accessPolicyHash
    )
      throw new Error("UNAUTHENTICATED");
    return {
      credential: "api-token" as const,
      userId: token.createdBy,
      securityVersion: token.securityVersion,
      tokenId: token.id,
      tokenHash,
      workspaceId: token.workspaceId,
    };
  });
  await consumeApiLimit(db, `token:${credential.tokenId}`, 60);
  // Rechecks current suspension/security version, membership and workspace state immediately, then again in every data read.
  await withActor(db, credential, credential.workspaceId, async () => {});
  return credential;
}
