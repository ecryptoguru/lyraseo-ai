import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { PrismaClient } from "../generated/client";
import { withActor, requireFreshAuthentication, type Actor } from "./context";
import {
  checkAccessRevision,
  requireWorkspaceManager,
  recordAccessEvent,
} from "./tenants";
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
function emailDigest(email: string, secret: string) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32)
    throw Error("INVITATIONS_UNAVAILABLE");
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^\S+@\S+\.\S+$/.test(normalized))
    throw Error("INVALID_EMAIL");
  return createHmac("sha256", secret)
    .update("lyraseo-invitation-email-v1\0")
    .update(normalized)
    .digest("hex");
}
/** Server-only: one-time copyable link, no delivery, directory lookup or identity provisioning. */
export async function createWorkspaceInvitation(
  db: PrismaClient,
  actor: Actor,
  input: {
    workspaceId: string;
    email: string;
    role: "EDITOR" | "VIEWER";
    siteIds: string[];
    expectedAccessRevision: number;
  },
  secret: string,
) {
  requireFreshAuthentication(actor);
  if (
    !["EDITOR", "VIEWER"].includes(input.role) ||
    !Array.isArray(input.siteIds) ||
    input.siteIds.length > 100 ||
    new Set(input.siteIds).size !== input.siteIds.length
  )
    throw Error("INVALID_INVITATION");
  const digest = emailDigest(input.email, secret),
    token = randomBytes(32).toString("base64url"),
    now = new Date();
  return withActor(db, actor, input.workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
    await checkAccessRevision(
      tx,
      actor,
      input.workspaceId,
      input.expectedAccessRevision,
    );
    await requireWorkspaceManager(tx, actor, input.workspaceId);
    const sites = await tx.site.count({
      where: {
        workspaceId: input.workspaceId,
        id: { in: input.siteIds },
        deletedAt: null,
      },
    });
    if (sites !== input.siteIds.length) throw Error("NOT_FOUND");
    const invite = await tx.workspaceInvitation.create({
      data: {
        workspaceId: input.workspaceId,
        tokenHash: tokenHash(token),
        invitedEmailDigest: digest,
        role: input.role,
        createdBy: actor.userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 7 * 86400000),
        sites: { create: input.siteIds.map((siteId) => ({ siteId })) },
      },
      select: { id: true, expiresAt: true },
    });
    await recordAccessEvent(tx, actor, input.workspaceId, {
      action: "invite",
      nextRole: input.role,
    });
    return { ...invite, token };
  });
}
export async function listWorkspaceInvitations(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
) {
  return withActor(db, actor, workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, workspaceId);
    await requireWorkspaceManager(tx, actor, workspaceId);
    return tx.workspaceInvitation.findMany({
      where: {
        workspaceId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      select: {
        id: true,
        role: true,
        createdAt: true,
        expiresAt: true,
        sites: { select: { siteId: true } },
      },
    });
  });
}
export async function revokeWorkspaceInvitation(
  db: PrismaClient,
  actor: Actor,
  input: {
    workspaceId: string;
    invitationId: string;
    expectedAccessRevision: number;
  },
) {
  return withActor(db, actor, input.workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
    await checkAccessRevision(
      tx,
      actor,
      input.workspaceId,
      input.expectedAccessRevision,
    );
    await requireWorkspaceManager(tx, actor, input.workspaceId);
    const invite = await tx.workspaceInvitation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.invitationId,
        acceptedAt: null,
        revokedAt: null,
      },
    });
    if (!invite) throw Error("NOT_FOUND");
    await tx.workspaceInvitation.update({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });
    await recordAccessEvent(tx, actor, input.workspaceId, {
      action: "revoke-invitation",
    });
    return { revoked: true };
  });
}
/** identity.email comes only from the same verified provider session as identity.actor. */
export async function acceptWorkspaceInvitation(
  db: PrismaClient,
  identity: { actor: Actor; email: string },
  input: { workspaceId: string; invitationId: string; token: string },
  secret: string,
) {
  const { actor } = identity,
    digest = emailDigest(identity.email, secret);
  if (
    typeof input.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.token)
  )
    throw Error("INVITATION_UNAVAILABLE");
  return withActor(db, actor, input.workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
    await checkAccessRevision(tx, actor, input.workspaceId);
    const invite = await tx.workspaceInvitation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.invitationId,
        tokenHash: tokenHash(input.token),
      },
      include: { sites: true },
    });
    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt <= new Date() ||
      !timingSafeEqual(
        Buffer.from(invite.invitedEmailDigest, "hex"),
        Buffer.from(digest, "hex"),
      )
    )
      throw Error("INVITATION_UNAVAILABLE");
    const inviter = await tx.membership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: invite.createdBy,
        },
      },
      include: { user: { select: { suspended: true } } },
    });
    if (
      !inviter ||
      inviter.user.suspended ||
      !["OWNER", "ADMIN"].includes(inviter.role)
    )
      throw Error("INVITATION_UNAVAILABLE");
    const ids = invite.sites.map((s) => s.siteId);
    if (
      (await tx.site.count({
        where: {
          workspaceId: input.workspaceId,
          id: { in: ids },
          deletedAt: null,
        },
      })) !== ids.length
    )
      throw Error("INVITATION_UNAVAILABLE");
    if (
      await tx.membership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: actor.userId,
          },
        },
      })
    )
      throw Error("INVITATION_UNAVAILABLE");
    await tx.membership.create({
      data: {
        workspaceId: input.workspaceId,
        userId: actor.userId,
        role: invite.role,
        grants: { create: ids.map((siteId) => ({ siteId })) },
      },
    });
    await tx.workspaceInvitation.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedBy: actor.userId },
    });
    await recordAccessEvent(tx, actor, input.workspaceId, {
      action: "accept",
      targetUserId: actor.userId,
      nextRole: invite.role,
    });
    return { workspaceId: input.workspaceId, role: invite.role };
  });
}
