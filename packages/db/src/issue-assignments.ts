import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import {
  withActor,
  authorizeSiteIn,
  withEvidenceRead,
  type Actor,
} from "./context";
import {
  checkAccessRevision,
  requireWorkspaceManager,
  requireEligibleAssignee,
} from "./tenants";
type Scope = { workspaceId: string; siteId: string };
export async function assignAuditIssue(
  db: PrismaClient,
  actor: Actor,
  scope: Scope,
  input: {
    auditId: string;
    ruleId: string;
    scopeKey: string;
    assigneeUserId: string | null;
    expectedRevision: number;
    idempotencyKey: string;
  },
) {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 128 ||
    !input.ruleId ||
    input.ruleId.length > 128 ||
    !input.scopeKey ||
    input.scopeKey.length > 2048 ||
    (input.assigneeUserId !== null &&
      (!input.assigneeUserId || input.assigneeUserId.length > 128))
  )
    throw Error("INVALID_ISSUE");
  const inputHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${scope.workspaceId} AND id=${scope.siteId} FOR UPDATE`;
    await checkAccessRevision(tx, actor, scope.workspaceId);
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    await requireWorkspaceManager(tx, actor, scope.workspaceId);
    const prior = await tx.issueAssignmentEvent.findUnique({
      where: {
        workspaceId_siteId_actorId_idempotencyKey: {
          ...scope,
          actorId: actor.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior) {
      if (prior.inputHash !== inputHash) throw Error("REVISION_CONFLICT");
      return tx.issueAssignment.findUniqueOrThrow({
        where: { id: prior.assignmentId },
      });
    }
    if (input.assigneeUserId !== null)
      await requireEligibleAssignee(
        tx,
        scope.workspaceId,
        scope.siteId,
        input.assigneeUserId,
      );
    const run = await tx.auditRun.findFirst({
      where: {
        ...scope,
        id: input.auditId,
        resultExpiresAt: { gt: new Date() },
      },
      select: { evaluation: true },
    });
    const rules = (
      run?.evaluation as
        | { rules?: { ruleId: string; scopeKey: string; outcome: string }[] }
        | undefined
    )?.rules;
    if (
      !rules?.some(
        (rule) =>
          rule.ruleId === input.ruleId &&
          rule.scopeKey === input.scopeKey &&
          ["FAIL", "WARNING"].includes(rule.outcome),
      )
    )
      throw Error("INVALID_ISSUE");
    const key = {
        ...scope,
        auditId: input.auditId,
        ruleId: input.ruleId,
        scopeKey: input.scopeKey,
      },
      current = await tx.issueAssignment.findUnique({
        where: { workspaceId_siteId_auditId_ruleId_scopeKey: key },
      });
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw Error("REVISION_CONFLICT");
    const assignment = current
      ? await tx.issueAssignment.update({
          where: { id: current.id },
          data: {
            revision: { increment: 1 },
            assigneeUserId: input.assigneeUserId,
            updatedAt: new Date(),
          },
        })
      : await tx.issueAssignment.create({
          data: { ...key, revision: 1, assigneeUserId: input.assigneeUserId },
        });
    await tx.issueAssignmentEvent.create({
      data: {
        ...scope,
        assignmentId: assignment.id,
        revision: assignment.revision,
        actorId: actor.userId,
        assigneeUserId: input.assigneeUserId,
        idempotencyKey: input.idempotencyKey,
        inputHash,
      },
    });
    return assignment;
  });
}
export async function listAuditAssignments(
  db: PrismaClient,
  actor: Actor,
  scope: Scope,
  auditId: string,
) {
  return withEvidenceRead(db, actor, scope, "read", undefined, (tx) =>
    tx.issueAssignment.findMany({
      where: { ...scope, auditId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
  );
}
/** An exact identity lookup cannot confuse a bounded list omission with absence. */
export async function readAuditAssignment(
  db: PrismaClient,
  actor: Actor,
  scope: Scope,
  input: { auditId: string; ruleId: string; scopeKey: string },
) {
  return withEvidenceRead(db, actor, scope, "read", undefined, (tx) =>
    tx.issueAssignment.findUnique({
      where: {
        workspaceId_siteId_auditId_ruleId_scopeKey: { ...scope, ...input },
      },
    }),
  );
}
