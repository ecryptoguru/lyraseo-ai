/** Reviewed declarations are customer facts, never inferred model output. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient, Prisma } from "../generated/client";
import { normalizeUrl } from "@lyraseo/visibility";
import { withActor, authorizeSiteIn, type Actor, type Tx } from "./context";
export type SiteScope = { workspaceId: string; siteId: string };
/** Runtime projection: TypeScript structural types do not strip command fields. */
export const siteScope = (s: SiteScope): SiteScope => ({
  workspaceId: s.workspaceId,
  siteId: s.siteId,
});
export type SiteContext = {
  audience: string;
  positioning: string;
  conversionGoal: string;
  brandName: string;
  approvedAliases: string[];
  competitors: string[];
  keyPages: string[];
  supportedClaims: string[];
  editorialPreferences: string;
};
export const emptySiteContext = (): SiteContext => ({
  audience: "",
  positioning: "",
  conversionGoal: "",
  brandName: "",
  approvedAliases: [],
  competitors: [],
  keyPages: [],
  supportedClaims: [],
  editorialPreferences: "",
});
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
async function lock(tx: Tx, scope: SiteScope) {
  await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${scope.siteId} AND "workspaceId"=${scope.workspaceId} FOR UPDATE`;
}
async function manager(tx: Tx, actor: Actor, workspaceId: string) {
  const member = await tx.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
  });
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (
    !workspace ||
    workspace.deletedAt ||
    !member ||
    !["OWNER", "ADMIN"].includes(member.role)
  )
    throw new Error("FORBIDDEN");
}
export async function createSite(
  db: PrismaClient,
  actor: Actor,
  input: { workspaceId: string; origin: string },
) {
  let origin: string;
  try {
    const normalized = normalizeUrl(input.origin);
    const url = new URL(normalized);
    if (
      url.pathname !== "/" ||
      new URL(input.origin).pathname !== "/" ||
      new URL(input.origin).search ||
      new URL(input.origin).hash
    )
      throw new Error();
    origin = url.origin;
  } catch {
    throw new Error("INVALID_SITE_ORIGIN");
  }
  return withActor(db, actor, input.workspaceId, async (tx) => {
    await manager(tx, actor, input.workspaceId);
    return tx.site.create({ data: { workspaceId: input.workspaceId, origin } });
  });
}
export async function issueSiteChallenge(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    await manager(tx, actor, scope.workspaceId);
    const site = await authorizeSiteIn(
      tx,
      actor,
      scope.workspaceId,
      scope.siteId,
      "edit",
    );
    await tx.siteVerificationChallenge.updateMany({
      where: { ...siteScope(scope), consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const token = randomBytes(32).toString("base64url");
    const challenge = await tx.siteVerificationChallenge.create({
      data: {
        ...siteScope(scope),
        tokenHash: hash(token),
        issuedBy: actor.userId,
        sessionId: actor.sessionId,
        securityVersion: actor.securityVersion,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    return {
      id: challenge.id,
      token,
      expiresAt: challenge.expiresAt,
      url: site.origin + "/.well-known/lyraseo-verification.txt",
    };
  });
}
/** INTERNAL ONLY. observe must be the server's pinned public HTTPS fetch, never a request body. */
export async function verifySiteChallenge(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  challengeId: string,
  observe: (
    url: string,
    beforeSocket: () => Promise<void>,
  ) => Promise<{ url: string; status: number; body: string }>,
  refreshActor: () => Promise<Actor>,
) {
  const pendingUrl = (current: Actor) =>
    withActor(db, current, scope.workspaceId, async (tx) => {
      await manager(tx, current, scope.workspaceId);
      const site = await authorizeSiteIn(
        tx,
        current,
        scope.workspaceId,
        scope.siteId,
        "edit",
      );
      const challenge = await tx.siteVerificationChallenge.findFirst({
        where: {
          id: challengeId,
          ...siteScope(scope),
          issuedBy: current.userId,
          sessionId: current.sessionId,
          securityVersion: current.securityVersion,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!challenge) throw new Error("INVALID_SITE_CHALLENGE");
      return site.origin + "/.well-known/lyraseo-verification.txt";
    });
  const url = await pendingUrl(actor);
  const currentActor = async () => {
    const current = await refreshActor();
    if (
      current.userId !== actor.userId ||
      current.sessionId !== actor.sessionId ||
      current.securityVersion !== actor.securityVersion
    )
      throw new Error("FORBIDDEN");
    return current;
  };
  let checked = false;
  let checking = false;
  const response = await observe(url, async () => {
    if (checked || checking) throw new Error("INVALID_SITE_PROOF");
    checking = true;
    try {
      const current = await currentActor();
      if ((await pendingUrl(current)) !== url)
        throw new Error("INVALID_SITE_CHALLENGE");
      checked = true;
    } finally {
      checking = false;
    }
  });
  if (!checked) throw new Error("INVALID_SITE_PROOF");
  await currentActor();
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    await manager(tx, actor, scope.workspaceId);
    const site = await authorizeSiteIn(
      tx,
      actor,
      scope.workspaceId,
      scope.siteId,
      "edit",
    );
    if (
      response.url !== url ||
      url !== site.origin + "/.well-known/lyraseo-verification.txt" ||
      response.status !== 200 ||
      typeof response.body !== "string" ||
      !/^[A-Za-z0-9_-]{43}\s*$/.test(response.body) ||
      response.body.length > 256
    )
      throw new Error("INVALID_SITE_PROOF");
    const current = await tx.siteVerificationChallenge.findFirst({
      where: {
        id: challengeId,
        ...siteScope(scope),
        issuedBy: actor.userId,
        sessionId: actor.sessionId,
        securityVersion: actor.securityVersion,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    const observedHash = hash(response.body.trim());
    if (
      !current ||
      current.tokenHash.length !== 64 ||
      !timingSafeEqual(
        Buffer.from(current.tokenHash, "hex"),
        Buffer.from(observedHash, "hex"),
      )
    )
      throw new Error("INVALID_SITE_CHALLENGE");
    const consumed = await tx.siteVerificationChallenge.updateMany({
      where: {
        id: challengeId,
        ...siteScope(scope),
        issuedBy: actor.userId,
        sessionId: actor.sessionId,
        securityVersion: actor.securityVersion,
        tokenHash: hash(response.body.trim()),
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new Error("INVALID_SITE_CHALLENGE");
    return tx.site.update({
      where: { id: site.id },
      data: { verifiedAt: new Date() },
    });
  });
}
function validateContext(
  input: SiteContext,
  origin: string,
): Prisma.InputJsonValue {
  const defaults = emptySiteContext();
  if (
    !input ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).some((k) => !Object.hasOwn(defaults, k)) ||
    Object.keys(defaults).some((k) => !Object.hasOwn(input, k))
  )
    throw new Error("INVALID_SITE_CONTEXT");
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(defaults[key as keyof SiteContext])) {
      if (
        !Array.isArray(value) ||
        value.length > 25 ||
        Array.from(value).some(
          (v) => typeof v !== "string" || !v.trim() || v.length > 2048,
        )
      )
        throw new Error("INVALID_SITE_CONTEXT");
    } else if (
      typeof value !== "string" ||
      value.length > (key === "brandName" ? 512 : 4096)
    )
      throw new Error("INVALID_SITE_CONTEXT");
  }
  try {
    for (const page of input.keyPages)
      if (new URL(normalizeUrl(page)).origin !== origin) throw new Error();
  } catch {
    throw new Error("INVALID_SITE_CONTEXT");
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 32768)
    throw new Error("INVALID_SITE_CONTEXT");
  return JSON.parse(JSON.stringify(input));
}
export async function reviewSiteContext(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  expectedRevision: number,
  content: SiteContext,
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error("INVALID_CONTEXT_REVISION");
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    const site = await authorizeSiteIn(
      tx,
      actor,
      scope.workspaceId,
      scope.siteId,
      "edit",
    );
    const data = validateContext(content, site.origin);
    const latest = await tx.siteContextRevision.findFirst({
      where: siteScope(scope),
      orderBy: { revision: "desc" },
    });
    if ((latest?.revision ?? 0) !== expectedRevision)
      throw new Error("CONTEXT_REVISION_CONFLICT");
    return tx.siteContextRevision.create({
      data: {
        ...siteScope(scope),
        revision: expectedRevision + 1,
        content: data,
        reviewedBy: actor.userId,
      },
    });
  });
}
export async function readSiteContextRevisions(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "read");
    return tx.siteContextRevision.findMany({
      where: siteScope(scope),
      orderBy: { revision: "desc" },
      take: 100,
    });
  });
}
