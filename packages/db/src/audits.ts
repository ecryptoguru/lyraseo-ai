import { siteScope } from "./sites";
/** Local, unmetered raw acquisition lifecycle. Never admits a paid provider call. */
import { createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "../generated/client";
import {
  normalizeUrl,
  evaluateAudit,
  compareAudits,
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
export type AuditDeclarations = {
  brandName?: string;
  approvedAliases?: string[];
  contextRevisionId?: string;
  contextRevision?: number;
};
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stable(item)]),
        )
      : value;
const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
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
function validFinalUrl(value: unknown, requested: string) {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    return new URL(normalizeUrl(value)).origin === new URL(requested).origin;
  } catch {
    return false;
  }
}
async function lock(tx: Tx, scope: AuditScope) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${scope.siteId} AND "workspaceId"=${scope.workspaceId} FOR UPDATE`;
}
function lease(
  run: { status: string; fence: number; leaseUntil: Date | null },
  fence: number,
) {
  if (
    run.status !== "RUNNING" ||
    run.fence !== fence ||
    !run.leaseUntil ||
    run.leaseUntil.getTime() <= Date.now()
  )
    throw new Error("STALE_LEASE");
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
    let manifest: string[];
    try {
      if (!Array.isArray(input.manifest) || input.manifest.length > 25)
        throw new Error();
      manifest = input.manifest.map(normalizeUrl).sort();
    } catch {
      throw new Error("INVALID_MANIFEST");
    }
    if (new Set(manifest).size !== manifest.length)
      throw new Error("INVALID_MANIFEST");
    const homepage = normalizeUrl(site.origin + "/");
    if (
      !manifest.length ||
      manifest.length > 25 ||
      !manifest.includes(homepage) ||
      manifest.some((url) => new URL(url).origin !== site.origin)
    )
      throw new Error("INVALID_MANIFEST");
    const declarations = input.declarations ?? {};
    if (
      Object.keys(declarations).some(
        (key) => !["brandName", "approvedAliases"].includes(key),
      )
    )
      throw new Error("INVALID_AUDIT_INPUT");
    if (
      (declarations.brandName !== undefined &&
        (typeof declarations.brandName !== "string" ||
          declarations.brandName.length > 512)) ||
      (declarations.approvedAliases !== undefined &&
        (!Array.isArray(declarations.approvedAliases) ||
          declarations.approvedAliases.length > 20 ||
          declarations.approvedAliases.some(
            (alias) => typeof alias !== "string" || alias.length > 512,
          )))
    )
      throw new Error("INVALID_AUDIT_INPUT");
    if (JSON.stringify(declarations).length > 8192)
      throw new Error("INVALID_AUDIT_INPUT");
    const inputHash = fingerprint({
      manifest,
      profile: input.profile,
      declarations,
    });
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
        methodologyVersion: "readiness-v1",
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
export async function claimAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  leaseOwner: string,
) {
  if (!leaseOwner || leaseOwner.length > 128)
    throw new Error("INVALID_LEASE_OWNER");
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    const run = await scoped(tx, actor, scope, "run");
    freshVerification(
      await tx.site.findUniqueOrThrow({ where: { id: scope.siteId } }),
    );
    if (
      run.userId !== actor.userId ||
      run.securityVersion !== actor.securityVersion
    )
      throw new Error("FORBIDDEN");
    if (!["QUEUED", "RUNNING"].includes(run.status))
      throw new Error("AUDIT_TERMINAL");
    if (run.leaseUntil && run.leaseUntil.getTime() > Date.now())
      throw new Error("LEASE_BUSY");
    return tx.auditRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        fence: { increment: 1 },
        leaseOwner,
        leaseUntil: new Date(Date.now() + 90000),
      },
    });
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
    await lock(tx, scope);
    const run = await scoped(tx, actor, scope, "run");
    freshVerification(
      await tx.site.findUniqueOrThrow({ where: { id: scope.siteId } }),
    );
    lease(run, fence);
    if (
      run.userId !== actor.userId ||
      run.securityVersion !== actor.securityVersion
    )
      throw new Error("FORBIDDEN");
    if (
      !(run.manifest as string[]).includes(evidence.requestedUrl) ||
      provenance.requestedUrl !== evidence.requestedUrl ||
      provenance.channel !== "raw-http" ||
      typeof provenance.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(provenance.acquiredAt)) ||
      Date.parse(provenance.acquiredAt) > Date.now() ||
      !validFinalUrl(evidence.finalUrl, evidence.requestedUrl) ||
      !validFinalUrl(provenance.finalUrl, evidence.requestedUrl) ||
      (evidence.finalUrl !== undefined &&
        provenance.finalUrl !== undefined &&
        evidence.finalUrl !== provenance.finalUrl)
    )
      throw new Error("INVALID_PAGE_EVIDENCE");
    if (
      Buffer.byteLength(JSON.stringify(evidence), "utf8") > 262144 ||
      Buffer.byteLength(JSON.stringify(provenance), "utf8") >
        32 * 1024 * 1024 ||
      (typeof provenance.rawHtml === "string" &&
        Buffer.byteLength(provenance.rawHtml, "utf8") > 5 * 1024 * 1024)
    )
      throw new Error("EVIDENCE_TOO_LARGE");
    const existing = await tx.auditPage.findUnique({
      where: {
        auditId_requestedUrl: {
          auditId: run.id,
          requestedUrl: evidence.requestedUrl,
        },
      },
    });
    if (existing) {
      if (
        fingerprint(existing.evidence) !== fingerprint(json(evidence)) ||
        fingerprint(existing.provenance) !== fingerprint(json(provenance))
      )
        throw new Error("IMMUTABLE_EVIDENCE");
      return existing;
    }
    const page = await tx.auditPage.create({
      data: {
        workspaceId: scope.workspaceId,
        auditId: run.id,
        requestedUrl: evidence.requestedUrl,
        evidence: json(evidence),
        provenance: json(provenance),
      },
    });
    await tx.auditRun.update({
      where: { id: run.id },
      data: { leaseUntil: new Date(Date.now() + 90000) },
    });
    return page;
  });
}
export async function finishAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    const run = await scoped(tx, actor, scope, "run");
    freshVerification(
      await tx.site.findUniqueOrThrow({ where: { id: scope.siteId } }),
    );
    lease(run, fence);
    if (
      run.userId !== actor.userId ||
      run.securityVersion !== actor.securityVersion
    )
      throw new Error("FORBIDDEN");
    const pages = await tx.auditPage.findMany({
      where: { auditId: run.id, workspaceId: scope.workspaceId },
      orderBy: { requestedUrl: "asc" },
    });
    if (pages.length !== (run.manifest as string[]).length)
      throw new Error("AUDIT_INCOMPLETE");
    const site = await tx.site.findUniqueOrThrow({
      where: { id: scope.siteId },
    });
    const evaluation = evaluateAudit({
      ...(run.declarations as AuditDeclarations),
      siteOrigin: site.origin,
      manifest: run.manifest as string[],
      pages: pages.map((p) => p.evidence as unknown as PageEvidence),
      methodologyVersion: "readiness-v1",
    });
    return tx.auditRun.update({
      where: { id: run.id },
      data: {
        evaluation: json(evaluation),
        status: "COMPLETED",
        completedAt: new Date(),
        leaseUntil: null,
        leaseOwner: null,
      },
    });
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
      before.evaluation as unknown as AuditEvaluation,
      after.evaluation as unknown as AuditEvaluation,
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
export async function failAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    const run = await scoped(tx, actor, scope, "run");
    lease(run, fence);
    if (
      run.userId !== actor.userId ||
      run.securityVersion !== actor.securityVersion
    )
      throw new Error("FORBIDDEN");
    return tx.auditRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        leaseUntil: null,
        leaseOwner: null,
      },
    });
  });
}
/** Authorized site editors can stop an abandoned run even after its sponsor loses access. */
export async function cancelAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    const run = await scoped(tx, actor, scope, "edit");
    if (!["QUEUED", "RUNNING"].includes(run.status))
      throw new Error("AUDIT_TERMINAL");
    return tx.auditRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        fence: { increment: 1 },
        completedAt: new Date(),
        leaseUntil: null,
        leaseOwner: null,
      },
    });
  });
}

/** Release a bounded page invocation; the next invocation can claim immediately. */
export async function yieldAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    const run = await scoped(tx, actor, scope, "run");
    lease(run, fence);
    if (
      run.userId !== actor.userId ||
      run.securityVersion !== actor.securityVersion
    )
      throw new Error("FORBIDDEN");
    return tx.auditRun.update({
      where: { id: run.id },
      data: {
        status: "QUEUED",
        fence: { increment: 1 },
        leaseUntil: null,
        leaseOwner: null,
      },
    });
  });
}
