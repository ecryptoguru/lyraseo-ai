import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Role } from "../generated/client";
import {
  withActor,
  requireFreshAuthentication,
  type Actor,
  type Tx,
} from "./context";
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function issueStepUp(
  db: PrismaClient,
  actor: Actor,
  action: string,
  resourceId: string,
  now = new Date(),
) {
  requireFreshAuthentication(actor, now);
  const token = randomBytes(32).toString("base64url");
  await withActor(db, actor, resourceId, (tx) =>
    tx.stepUpGrant.create({
      data: {
        tokenHash: hash(token),
        userId: actor.userId,
        sessionId: actor.sessionId,
        action,
        resourceId,
        expiresAt: new Date(now.getTime() + 600000),
      },
    }),
  );
  return token;
}
async function consume(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  token?: string,
) {
  if (!token) throw new Error("STEP_UP_REQUIRED");
  const result = await tx.stepUpGrant.updateMany({
    where: {
      tokenHash: hash(token),
      userId: actor.userId,
      sessionId: actor.sessionId,
      action: "manage-owner",
      resourceId: workspaceId,
      expiresAt: { gt: new Date() },
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  });
  if (result.count !== 1) throw new Error("STEP_UP_REQUIRED");
}
async function membership(tx: Tx, actor: Actor, workspaceId: string) {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
  });
  const member = await tx.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
  });
  if (!workspace || workspace.deletedAt || !member)
    throw new Error("FORBIDDEN");
  return member;
}
export async function listSites(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
) {
  return withActor(db, actor, workspaceId, async (tx) => {
    const member = await membership(tx, actor, workspaceId);
    return tx.site.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(["OWNER", "ADMIN"].includes(member.role)
          ? {}
          : { grants: { some: { userId: actor.userId } } }),
      },
      orderBy: { id: "asc" },
    });
  });
}
async function mutate(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
  userId: string,
  role: Role | null,
  token?: string,
) {
  if (role && !["OWNER", "ADMIN", "EDITOR", "VIEWER"].includes(role))
    throw new Error("INVALID_ROLE");
  return withActor(db, actor, workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    const caller = await membership(tx, actor, workspaceId);
    const target = await tx.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!target) throw new Error("NOT_FOUND");
    if (!["OWNER", "ADMIN"].includes(caller.role)) throw new Error("FORBIDDEN");
    if (target.role === "OWNER" || role === "OWNER") {
      if (caller.role !== "OWNER") throw new Error("FORBIDDEN");
      await consume(tx, actor, workspaceId, token);
      if (
        target.role === "OWNER" &&
        role !== "OWNER" &&
        (await tx.membership.count({
          where: {
            workspaceId,
            role: "OWNER",
            userId: { not: userId },
            user: { suspended: false },
          },
        })) === 0
      )
        throw new Error("LAST_OWNER");
    }
    if (role)
      return tx.membership.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role },
      });
    await tx.siteGrant.deleteMany({ where: { workspaceId, userId } });
    return tx.membership.delete({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
  });
}
export const changeMemberRole = (
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
  userId: string,
  role: Role,
  token?: string,
) => mutate(db, actor, workspaceId, userId, role, token);
export const removeMember = (
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
  userId: string,
  token?: string,
) => mutate(db, actor, workspaceId, userId, null, token);
export async function listWorkspaces(db: PrismaClient, actor: Actor) {
  return withActor(db, actor, "", async (tx) => {
    const memberships = await tx.membership.findMany({
      where: { userId: actor.userId },
      orderBy: { workspaceId: "asc" },
    });
    const result = [];
    for (const member of memberships) {
      await tx.$queryRaw`SELECT set_config('app.workspace_id',${member.workspaceId},true)`;
      const workspace = await tx.workspace.findUnique({
        where: { id: member.workspaceId },
      });
      if (workspace && !workspace.deletedAt)
        result.push({ ...workspace, role: member.role });
    }
    return result;
  });
}
export async function createWorkspace(
  db: PrismaClient,
  actor: Actor,
  name: string,
) {
  const clean = name.trim();
  if (!clean || clean.length > 100) throw new Error("INVALID_NAME");
  const id = randomBytes(18).toString("base64url");
  return withActor(db, actor, id, (tx) =>
    tx.workspace.create({
      data: {
        id,
        name: clean,
        memberships: { create: { userId: actor.userId, role: "OWNER" } },
      },
    }),
  );
}
export async function grantSite(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
  siteId: string,
  userId: string,
) {
  return withActor(db, actor, workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    const caller = await membership(tx, actor, workspaceId);
    if (!["OWNER", "ADMIN"].includes(caller.role)) throw new Error("FORBIDDEN");
    const site = await tx.site.findUnique({
      where: { workspaceId_id: { workspaceId, id: siteId } },
    });
    if (
      !site ||
      site.deletedAt ||
      !(await tx.membership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
      }))
    )
      throw new Error("NOT_FOUND");
    return tx.siteGrant.upsert({
      where: { workspaceId_siteId_userId: { workspaceId, siteId, userId } },
      create: { workspaceId, siteId, userId },
      update: {},
    });
  });
}
