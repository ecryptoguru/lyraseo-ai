import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Role } from "../generated/client";
import {
  withActor,
  requireFreshAuthentication,
  type Actor,
  type ReadActor,
  isTokenActor,
  requireReadScope,
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
export async function membership(
  tx: Tx,
  actor: ReadActor,
  workspaceId: string,
) {
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
  actor: ReadActor,
  workspaceId: string,
) {
  return withActor(db, actor, workspaceId, async (tx) => {
    await requireReadScope(tx, actor, "sites:read");
    const token = isTokenActor(actor)
      ? await tx.apiToken.findUnique({ where: { id: actor.tokenId } })
      : null;
    const member = await membership(tx, actor, workspaceId);
    return tx.site.findMany({
      where: {
        workspaceId,
        ...(token ? { id: { in: token.siteIds } } : {}),
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
  expectedAccessRevision?: number,
) {
  if (role && !["OWNER", "ADMIN", "EDITOR", "VIEWER"].includes(role))
    throw new Error("INVALID_ROLE");
  return withActor(db, actor, workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    await checkAccessRevision(tx, actor, workspaceId, expectedAccessRevision);
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
    await recordAccessEvent(tx, actor, workspaceId, {
      action: role ? "role" : "remove",
      targetUserId: userId,
      previousRole: target.role,
      nextRole: role,
    });
    if (!role || role === "VIEWER")
      await clearAssignments(tx, actor, workspaceId, userId);
    else if (role === "EDITOR" && ["OWNER", "ADMIN"].includes(target.role)) {
      const lostSites = await tx.site.findMany({
        where: { workspaceId, grants: { none: { userId } } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const site of lostSites)
        await clearAssignments(tx, actor, workspaceId, userId, site.id);
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
  expectedAccessRevision?: number,
) =>
  mutate(db, actor, workspaceId, userId, role, token, expectedAccessRevision);
export const removeMember = (
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
  userId: string,
  token?: string,
  expectedAccessRevision?: number,
) =>
  mutate(db, actor, workspaceId, userId, null, token, expectedAccessRevision);
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
  expectedAccessRevision?: number,
) {
  return withActor(db, actor, workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    await checkAccessRevision(tx, actor, workspaceId, expectedAccessRevision);
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
    await recordAccessEvent(tx, actor, workspaceId, {
      action: "grant",
      targetUserId: userId,
      siteId,
    });
    return tx.siteGrant.upsert({
      where: { workspaceId_siteId_userId: { workspaceId, siteId, userId } },
      create: { workspaceId, siteId, userId },
      update: {},
    });
  });
}

/** Called after the workspace lock; user state is re-read after any lock wait. */
export async function checkAccessRevision(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  expected?: number,
) {
  if ("credential" in actor) throw Error("FORBIDDEN");
  const user = await tx.productUser.findUnique({ where: { id: actor.userId } });
  if (!user || user.suspended || user.securityVersion !== actor.securityVersion)
    throw Error("FORBIDDEN");
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace || workspace.deletedAt) throw Error("FORBIDDEN");
  if (
    expected !== undefined &&
    (!Number.isSafeInteger(expected) ||
      expected < 0 ||
      workspace.accessRevision !== expected)
  )
    throw Error("REVISION_CONFLICT");
  return workspace;
}
export async function requireWorkspaceManager(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
) {
  const member = await membership(tx, actor, workspaceId);
  if (!["OWNER", "ADMIN"].includes(member.role)) throw Error("FORBIDDEN");
  return member;
}
export async function recordAccessEvent(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  input: {
    action: string;
    targetUserId?: string;
    siteId?: string;
    previousRole?: string | null;
    nextRole?: string | null;
  },
) {
  const row = await tx.workspace.update({
    where: { id: workspaceId },
    data: { accessRevision: { increment: 1 } },
    select: { accessRevision: true },
  });
  return tx.workspaceAccessEvent.create({
    data: {
      workspaceId,
      actorId: actor.userId,
      ...input,
      accessRevision: row.accessRevision,
    },
  });
}
async function clearAssignments(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  userId: string,
  siteId?: string,
) {
  const issues = await tx.issueAssignment.findMany({
    where: {
      workspaceId,
      assigneeUserId: userId,
      ...(siteId ? { siteId } : {}),
    },
    orderBy: [{ siteId: "asc" }, { id: "asc" }],
  });
  for (const issue of issues) {
    await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${workspaceId} AND id=${issue.siteId} FOR UPDATE`;
    const updated = await tx.issueAssignment.update({
      where: { id: issue.id },
      data: {
        assigneeUserId: null,
        revision: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    await tx.issueAssignmentEvent.create({
      data: {
        workspaceId,
        siteId: issue.siteId,
        assignmentId: issue.id,
        revision: updated.revision,
        actorId: actor.userId,
        assigneeUserId: null,
        idempotencyKey: randomBytes(18).toString("base64url"),
        inputHash: hash(
          JSON.stringify({
            action: "access-revoked",
            issueId: issue.id,
            revision: updated.revision,
            userId,
          }),
        ),
      },
    });
  }
  const pages = await tx.pageIdentity.findMany({
    where: { workspaceId, assignedTo: userId, ...(siteId ? { siteId } : {}) },
    orderBy: [{ siteId: "asc" }, { id: "asc" }],
  });
  for (const page of pages) {
    await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${workspaceId} AND id=${page.siteId} FOR UPDATE`;
    const updated = await tx.pageIdentity.update({
      where: { id: page.id },
      data: { assignedTo: null, revision: { increment: 1 } },
    });
    await tx.pageJournal.create({
      data: {
        workspaceId,
        siteId: page.siteId,
        pageId: page.id,
        revision: updated.revision,
        action: "access-revoked",
        note: "Assignment cleared after access changed.",
        userId: actor.userId,
        assigneeUserId: null,
        idempotencyKey: randomBytes(18).toString("base64url"),
        inputHash: hash(
          JSON.stringify({
            pageId: page.id,
            revision: updated.revision,
            userId,
          }),
        ),
      },
    });
  }
}
export type AccessCommand = {
  workspaceId: string;
  userId: string;
  expectedAccessRevision: number;
} & (
  | { action: "role"; role: Role; stepUpToken?: string }
  | { action: "remove"; stepUpToken?: string }
  | { action: "grant" | "revoke"; siteId: string }
);
export async function manageWorkspaceAccess(
  db: PrismaClient,
  actor: Actor,
  input: AccessCommand,
) {
  if (
    !Number.isSafeInteger(input.expectedAccessRevision) ||
    input.expectedAccessRevision < 0
  )
    throw Error("INVALID_REVISION");
  if (input.action === "role")
    return changeMemberRole(
      db,
      actor,
      input.workspaceId,
      input.userId,
      input.role,
      input.stepUpToken,
      input.expectedAccessRevision,
    );
  if (input.action === "remove")
    return removeMember(
      db,
      actor,
      input.workspaceId,
      input.userId,
      input.stepUpToken,
      input.expectedAccessRevision,
    );
  if (input.action === "grant")
    return grantSite(
      db,
      actor,
      input.workspaceId,
      input.siteId,
      input.userId,
      input.expectedAccessRevision,
    );
  return withActor(db, actor, input.workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
    await checkAccessRevision(
      tx,
      actor,
      input.workspaceId,
      input.expectedAccessRevision,
    );
    await requireWorkspaceManager(tx, actor, input.workspaceId);
    const site = await tx.site.findUnique({
      where: {
        workspaceId_id: { workspaceId: input.workspaceId, id: input.siteId },
      },
    });
    if (
      !site ||
      site.deletedAt ||
      !(await tx.membership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
          },
        },
      }))
    )
      throw Error("NOT_FOUND");
    await tx.siteGrant.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        userId: input.userId,
      },
    });
    const member = await tx.membership.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
      },
    });
    if (member.role !== "OWNER" && member.role !== "ADMIN")
      await clearAssignments(
        tx,
        actor,
        input.workspaceId,
        input.userId,
        input.siteId,
      );
    return recordAccessEvent(tx, actor, input.workspaceId, {
      action: "revoke",
      targetUserId: input.userId,
      siteId: input.siteId,
    });
  });
}
export async function listWorkspaceMembers(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
  paging: { cursor?: string; limit?: number } = {},
) {
  const limit = paging.limit ?? 50;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (paging.cursor !== undefined &&
      (!paging.cursor || paging.cursor.length > 128))
  )
    throw Error("INVALID_PAGING");
  return withActor(db, actor, workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, workspaceId);
    await requireWorkspaceManager(tx, actor, workspaceId);
    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
    });
    const rows = await tx.membership.findMany({
      where: {
        workspaceId,
        ...(paging.cursor ? { userId: { gt: paging.cursor } } : {}),
      },
      orderBy: { userId: "asc" },
      take: limit + 1,
      select: {
        userId: true,
        role: true,
        user: { select: { suspended: true } },
        grants: {
          where: { site: { deletedAt: null } },
          select: { siteId: true },
        },
      },
    });
    const members = rows.slice(0, limit).map((m) => ({
      userId: m.userId,
      role: m.role,
      suspended: m.user.suspended,
      siteIds: m.grants.map((g) => g.siteId),
    }));
    const sites = await tx.site.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { id: "asc" },
      take: 100,
      select: { id: true, origin: true },
    });
    await checkAccessRevision(tx, actor, workspaceId);
    await requireWorkspaceManager(tx, actor, workspaceId);
    return {
      accessRevision: workspace.accessRevision,
      members,
      sites,
      nextCursor: rows.length > limit ? members.at(-1)!.userId : null,
      limit,
    };
  });
}
export async function eligibleAssignees(
  tx: Tx,
  workspaceId: string,
  siteId: string,
) {
  return tx.membership.findMany({
    where: {
      workspaceId,
      user: { suspended: false },
      OR: [
        { role: { in: ["OWNER", "ADMIN"] } },
        { role: "EDITOR", grants: { some: { siteId } } },
      ],
    },
    orderBy: { userId: "asc" },
    take: 100,
    select: { userId: true, role: true },
  });
}
export async function requireEligibleAssignee(
  tx: Tx,
  workspaceId: string,
  siteId: string,
  userId: string,
) {
  const member = await tx.membership.findFirst({
    where: {
      workspaceId,
      userId,
      user: { suspended: false },
      OR: [
        { role: { in: ["OWNER", "ADMIN"] } },
        { role: "EDITOR", grants: { some: { siteId } } },
      ],
    },
    select: { userId: true },
  });
  if (!member) throw Error("INVALID_ASSIGNEE");
}
