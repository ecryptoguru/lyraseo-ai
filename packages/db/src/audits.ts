import { auditErrorCode } from "./audit-errors";
import {
  fingerprint,
  validateRawPage,
  frozenEvaluation,
} from "./audit-evidence";
import { auditManifest } from "@lyraseo/visibility/url";
import { siteScope } from "./sites";
/** Local, unmetered raw acquisition lifecycle. Never admits a paid provider call. */
import type { PrismaClient, Prisma } from "../generated/client";
import {
  compareAudits,
  validateDeclarations,
  type ReadinessDeclarations,
  type PageEvidence,
  type AuditEvaluation,
} from "@lyraseo/visibility";
import {
  withActor,
  authorizeSiteIn,
  type Actor,
  type ReadActor,
  requireReadScope,
  type Tx,
} from "./context";
export type AuditScope = {
  workspaceId: string;
  siteId: string;
  auditId: string;
};
export type AuditDeclarations = ReadinessDeclarations & {
  contextRevisionId?: string;
  contextRevision?: number;
};
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function scoped(
  tx: Tx,
  actor: ReadActor,
  scope: AuditScope,
  action: "read" | "run" | "edit" | "export",
) {
  await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, action);
  const run = await tx.auditRun.findFirst({
    where: {
      id: scope.auditId,
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
    },
  });
  if (!run) throw new Error("NOT_FOUND");
  return run;
}
function freshVerification(site: { verifiedAt: Date | null }) {
  const verified = site.verifiedAt?.getTime();
  if (!verified || verified > Date.now() || Date.now() - verified > 86400000)
    throw new Error("SITE_NOT_VERIFIED");
}
async function lock(tx: Tx, scope: AuditScope) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${scope.siteId} AND "workspaceId"=${scope.workspaceId} FOR UPDATE`;
}
export async function createAuditRun(
  db: PrismaClient,
  actor: Actor,
  input: {
    workspaceId: string;
    siteId: string;
    idempotencyKey: string;
    manifest: string[];
    profile: "LOCAL_RAW_V1";
    declarations?: AuditDeclarations;
  },
) {
  if (
    !input.idempotencyKey ||
    input.idempotencyKey.length > 128 ||
    input.profile !== "LOCAL_RAW_V1"
  )
    throw new Error("INVALID_AUDIT_INPUT");
  return withActor(db, actor, input.workspaceId, async (tx) => {
    await lock(tx, { ...input, auditId: "" });
    const site = await authorizeSiteIn(
      tx,
      actor,
      input.workspaceId,
      input.siteId,
      "run",
    );
    freshVerification(site);
    const manifest = auditManifest(input.manifest, site.origin);
    const previous = await tx.auditRun.findUnique({
      where: {
        workspaceId_siteId_userId_idempotencyKey: {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          userId: actor.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (previous?.methodologyVersion === "readiness-v1") {
      const historicalHash = fingerprint({
        manifest,
        profile: input.profile,
        declarations: input.declarations ?? {},
      });
      if (previous.inputHash !== historicalHash)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return previous;
    }
    const declarations = validateDeclarations(
      input.declarations ?? {},
      manifest,
      site.origin,
    );
    const inputHash = fingerprint({
      manifest,
      profile: input.profile,
      declarations,
    });
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return previous;
    }
    const context = await tx.siteContextRevision.findFirst({
      where: { workspaceId: input.workspaceId, siteId: input.siteId },
      orderBy: { revision: "desc" },
    });
    const contextContent = context?.content as
      { brandName?: string; approvedAliases?: string[] } | undefined;
    const frozenDeclarations = context
      ? {
          brandName: contextContent?.brandName,
          approvedAliases: contextContent?.approvedAliases,
          ...declarations,
          contextRevisionId: context.id,
          contextRevision: context.revision,
        }
      : declarations;
    if (
      await tx.auditRun.findFirst({
        where: {
          workspaceId: input.workspaceId,
          status: { in: ["QUEUED", "RUNNING"] },
        },
      })
    )
      throw new Error("AUDIT_ALREADY_ACTIVE");
    return tx.auditRun.create({
      data: {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        userId: actor.userId,
        securityVersion: actor.securityVersion,
        idempotencyKey: input.idempotencyKey,
        inputHash,
        manifest: json(manifest),
        profile: input.profile,
        declarations: json(frozenDeclarations),
        methodologyVersion: "readiness-v2",
      },
    });
  });
}
export async function listAuditRuns(
  db: PrismaClient,
  actor: ReadActor,
  scope: Omit<AuditScope, "auditId">,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await requireReadScope(tx, actor, "audits:read");
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "read");
    return tx.auditRun.findMany({
      where: siteScope(scope),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
  });
}
export async function readAuditRun(
  db: PrismaClient,
  actor: ReadActor,
  scope: AuditScope,
  action: "read" | "export" = "read",
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await requireReadScope(tx, actor, "audits:read");
    const run = await scoped(tx, actor, scope, action);
    const pages = await tx.auditPage.findMany({
      where: { auditId: run.id, workspaceId: scope.workspaceId },
      orderBy: { requestedUrl: "asc" },
    });
    const actions = await tx.issueAction.findMany({
      where: { auditId: run.id, workspaceId: scope.workspaceId },
      orderBy: { createdAt: "asc" },
    });
    // Raw evidence is temporary even while compact historical results remain available.
    return {
      ...run,
      pages: pages.map((page) => {
        const provenance = { ...(page.provenance as Record<string, unknown>) };
        if (Date.now() - page.createdAt.getTime() >= 30 * 86400000)
          delete provenance.rawHtml;
        return { ...page, provenance };
      }),
      actions,
    };
  });
}
// Browser-only fixed storage adapter. Its caller must already be in the scoped
// web transaction; the SQL guard independently binds and locks that actor.
async function webTransition(
  tx: Tx,
  actor: Actor,
  scope: AuditScope,
  action: string,
  fence: number | null = null,
  owner: string | null = null,
  data: unknown = null,
) {
  if ("credential" in actor) throw new Error("FORBIDDEN");
  const [row] = await tx.$queryRaw<
    { id: string }[]
  >`SELECT lyraseo_audit.web_transition(
   ${scope.siteId}::text,${scope.auditId}::text,${actor.securityVersion}::integer,${action}::text,
   ${fence}::integer,${owner}::text,${data === null ? null : JSON.stringify(data)}::json) AS id`.catch(
    (error: unknown) => {
      const code = auditErrorCode(error);
      if (code) throw new Error(code);
      throw error;
    },
  );
  return row!.id;
}
export async function claimAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  leaseOwner: string,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const id = await webTransition(tx, actor, scope, "claim", null, leaseOwner);
    return tx.auditRun.findUniqueOrThrow({ where: { id } });
  });
}
export async function checkpointAuditPage(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
  evidence: PageEvidence,
  provenance: Record<string, unknown>,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const id = await webTransition(tx, actor, scope, "prepare", fence);
    validateRawPage(
      await tx.auditRun.findUniqueOrThrow({ where: { id } }),
      evidence,
      provenance,
    );
    const pageId = await webTransition(
      tx,
      actor,
      scope,
      "checkpoint",
      fence,
      null,
      { evidence, provenance },
    );
    return tx.auditPage.findUniqueOrThrow({ where: { id: pageId } });
  });
}
export async function finishAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const id = await webTransition(tx, actor, scope, "prepare", fence);
    const run = await tx.auditRun.findUniqueOrThrow({ where: { id } });
    const pages = await tx.auditPage.findMany({
      where: { auditId: id },
      select: { evidence: true },
      orderBy: { requestedUrl: "asc" },
    });
    const site = await tx.site.findUniqueOrThrow({
      where: { id: scope.siteId },
    });
    const evaluation = frozenEvaluation(
      run,
      site.origin,
      pages.map((p) => p.evidence as unknown as PageEvidence),
    );
    await webTransition(tx, actor, scope, "finish", fence, null, evaluation);
    return tx.auditRun.findUniqueOrThrow({ where: { id } });
  });
}
export async function compareAuditRuns(
  db: PrismaClient,
  actor: ReadActor,
  scope: AuditScope,
  beforeAuditId: string,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await requireReadScope(tx, actor, "audits:read");
    const after = await scoped(tx, actor, scope, "read"),
      before = await scoped(
        tx,
        actor,
        { ...scope, auditId: beforeAuditId },
        "read",
      );
    if (!before.evaluation || !after.evaluation)
      throw new Error("AUDIT_INCOMPLETE");
    const result = compareAudits(
      {
        ...(before.evaluation as unknown as AuditEvaluation),
        profile: before.profile,
        declarations: before.declarations as AuditDeclarations,
      },
      {
        ...(after.evaluation as unknown as AuditEvaluation),
        profile: after.profile,
        declarations: after.declarations as AuditDeclarations,
      },
    );
    if (before.profile !== after.profile) result.scoreDelta = null;
    return { ...result, profileComparable: before.profile === after.profile };
  });
}
export async function reviewAuditIssue(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  input: {
    ruleId: string;
    scopeKey: string;
    disposition: "OPEN" | "REVIEWED" | "DISMISSED";
    reason: string;
  },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const run = await scoped(tx, actor, scope, "edit");
    if (!run.evaluation) throw new Error("AUDIT_INCOMPLETE");
    const evaluation = run.evaluation as unknown as AuditEvaluation;
    if (
      !evaluation.rules.some(
        (r) =>
          r.ruleId === input.ruleId &&
          r.scopeKey === input.scopeKey &&
          ["WARNING", "FAIL"].includes(r.outcome),
      ) ||
      !["OPEN", "REVIEWED", "DISMISSED"].includes(input.disposition) ||
      !input.reason.trim() ||
      input.reason.length > 512
    )
      throw new Error("INVALID_ISSUE_ACTION");
    return tx.issueAction.create({
      data: {
        ruleId: input.ruleId,
        scopeKey: input.scopeKey,
        disposition: input.disposition,
        reason: input.reason,
        userId: actor.userId,
        workspaceId: scope.workspaceId,
        auditId: run.id,
      },
    });
  });
}
/** Terminates a failed controlled acquisition without publishing a partial score. */
async function endLease(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  action: "fail" | "yield" | "cancel",
  fence: number | null,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const id = await webTransition(tx, actor, scope, action, fence);
    return tx.auditRun.findUniqueOrThrow({ where: { id } });
  });
}
export function failAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return endLease(db, actor, scope, "fail", fence);
}
export function yieldAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return endLease(db, actor, scope, "yield", fence);
}
/** Authorized editors can stop another sponsor's abandoned run across profiles. */
export function cancelAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
) {
  return endLease(db, actor, scope, "cancel", null);
}
