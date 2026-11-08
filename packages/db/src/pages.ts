import { lockLegacyInlineRead } from "./legacy-inline";
import { revisionEligibility, reportFormatStatus } from "./content";
import { siteScope } from "./sites";
/** Stable, explicitly registered URLs and an append-only workflow journal. No acquisition or scoring side effects. */
import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import { normalizeUrl } from "@lyraseo/visibility";
import {
  withActor,
  withEvidenceRead,
  authorizeSiteIn,
  type Actor,
  type Tx,
} from "./context";
import { readAuditRun } from "./audits";
import { readGoogleSearch } from "./gsc";
import {
  checkAccessRevision,
  requireWorkspaceManager,
  requireEligibleAssignee,
  eligibleAssignees,
} from "./tenants";
export type PageScope = { workspaceId: string; siteId: string };
export const PAGE_SITE_LIMIT = 500;
export const PAGE_LIST_LIMIT = 100;
const HISTORY_LIMIT = 100;
async function lock(tx: Tx, scope: PageScope) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${scope.workspaceId} AND id=${scope.siteId} FOR UPDATE`;
}
async function authorize(tx: Tx, actor: Actor, scope: PageScope, edit = false) {
  // This browser-only workflow must never accept bearer credentials passed through a cast.
  if ("credential" in actor) throw new Error("FORBIDDEN");
  return authorizeSiteIn(
    tx,
    actor,
    scope.workspaceId,
    scope.siteId,
    edit ? "edit" : "read",
  );
}
export async function registerPage(
  db: PrismaClient,
  actor: Actor,
  scope: PageScope,
  url: string,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    await checkAccessRevision(tx, actor, scope.workspaceId);
    const site = await authorize(tx, actor, scope, true);
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeUrl(url);
    } catch {
      throw new Error("INVALID_URL");
    }
    if (
      normalizedUrl.length > 2048 ||
      new URL(normalizedUrl).origin !== site.origin
    )
      throw new Error("INVALID_URL");
    await lock(tx, scope);
    const existing = await tx.pageIdentity.findFirst({
      where: { ...siteScope(scope), normalizedUrl },
    });
    if (existing) return existing;
    if (
      (await tx.pageIdentity.count({ where: siteScope(scope) })) >=
      PAGE_SITE_LIMIT
    )
      throw new Error("PAGE_LIMIT");
    return tx.pageIdentity.create({
      data: {
        ...siteScope(scope),
        originalUrl: url,
        normalizedUrl,
        createdBy: actor.userId,
      },
    });
  });
}
export type PageCommand = {
  pageId: string;
  expectedRevision: number;
  idempotencyKey: string;
} & (
  | { action: "change"; note: string; contentDraftId?: string }
  | { action: "claim" | "unassign" }
  | { action: "assign"; assigneeUserId: string | null }
);
export async function changePage(
  db: PrismaClient,
  actor: Actor,
  scope: PageScope,
  input: PageCommand,
) {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 128 ||
    !["change", "claim", "unassign", "assign"].includes(input.action)
  )
    throw new Error("INVALID_CHANGE");
  if (
    input.action === "change" &&
    (typeof input.note !== "string" ||
      !input.note.trim() ||
      input.note.length > 4000 ||
      Buffer.byteLength(input.note, "utf8") > 16000 ||
      (input.contentDraftId !== undefined &&
        (!input.contentDraftId || input.contentDraftId.length > 128)))
  )
    throw new Error("INVALID_CHANGE");
  if (
    input.action === "assign" &&
    input.assigneeUserId !== null &&
    (typeof input.assigneeUserId !== "string" ||
      !input.assigneeUserId ||
      input.assigneeUserId.length > 128)
  )
    throw Error("INVALID_ASSIGNEE");
  const hashInput = (intermediate: boolean) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          pageId: input.pageId,
          expectedRevision: input.expectedRevision,
          action: input.action,
          note: input.action === "change" ? input.note : "",
          ...(input.action === "assign"
            ? { assigneeUserId: input.assigneeUserId }
            : intermediate
              ? { assigneeUserId: null }
              : {}),
          contentDraftId:
            input.action === "change" ? (input.contentDraftId ?? null) : null,
        }),
      )
      .digest("hex");
  const inputHash = hashInput(false);
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, scope);
    await checkAccessRevision(tx, actor, scope.workspaceId);
    await authorize(tx, actor, scope, true);
    const page = await tx.pageIdentity.findFirst({
      where: { ...siteScope(scope), id: input.pageId },
    });
    if (!page) throw new Error("NOT_FOUND");
    const prior = await tx.pageJournal.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        pageId: page.id,
        userId: actor.userId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (prior) {
      // An intermediate local implementation included a null assignee in legacy action hashes.
      // Accept their exact receipts as well as the published hash, without
      // relaxing assignment identity or the other request fields.
      if (
        prior.inputHash !== inputHash &&
        (input.action === "assign" || prior.inputHash !== hashInput(true))
      )
        throw new Error("REVISION_CONFLICT");
      return { page, entry: prior };
    }
    if (input.action === "assign") {
      await requireWorkspaceManager(tx, actor, scope.workspaceId);
      if (input.assigneeUserId !== null)
        await requireEligibleAssignee(
          tx,
          scope.workspaceId,
          scope.siteId,
          input.assigneeUserId,
        );
    }
    if (page.revision !== input.expectedRevision)
      throw new Error("REVISION_CONFLICT");
    if (
      input.action === "claim" &&
      page.assignedTo &&
      page.assignedTo !== actor.userId
    )
      throw new Error("REVISION_CONFLICT");
    if (input.action === "unassign" && page.assignedTo !== actor.userId)
      throw new Error("REVISION_CONFLICT");
    let contentDraftId: string | null = null,
      contentDraftRevision: number | null = null;
    if (input.action === "change" && input.contentDraftId) {
      const draft = await tx.contentDraft.findFirst({
        where: { ...siteScope(scope), id: input.contentDraftId },
        select: { id: true, revision: true },
      });
      if (!draft) throw new Error("INVALID_DRAFT");
      const revision = await tx.contentRevision.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          draftId: draft.id,
          revision: draft.revision,
        },
      });
      if (!revision) throw new Error("INVALID_DRAFT");
      contentDraftId = draft.id;
      contentDraftRevision = draft.revision;
    }
    const updated = await tx.pageIdentity.update({
      where: { id: page.id },
      data: {
        revision: { increment: 1 },
        ...(input.action === "assign"
          ? { assignedTo: input.assigneeUserId }
          : input.action === "claim"
            ? { assignedTo: actor.userId }
            : input.action === "unassign"
              ? { assignedTo: null }
              : {}),
      },
    });
    const entry = await tx.pageJournal.create({
      data: {
        ...siteScope(scope),
        pageId: page.id,
        revision: updated.revision,
        action: input.action,
        note: input.action === "change" ? input.note : "",
        userId: actor.userId,
        assigneeUserId:
          input.action === "assign"
            ? input.assigneeUserId
            : input.action === "claim"
              ? actor.userId
              : null,
        idempotencyKey: input.idempotencyKey,
        inputHash,
        contentDraftId,
        contentDraftRevision,
      },
    });
    return { page: updated, entry };
  });
}
export async function listPages(
  db: PrismaClient,
  actor: Actor,
  scope: PageScope,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorize(tx, actor, scope);
    return {
      pages: await tx.pageIdentity.findMany({
        where: siteScope(scope),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE_LIST_LIMIT,
      }),
      limit: PAGE_LIST_LIMIT,
      siteLimit: PAGE_SITE_LIMIT,
    };
  });
}
// Compact evidence only: raw HTML is omitted at every nesting level, even inside historic provenance.
export async function readPage(
  db: PrismaClient,
  actor: Actor,
  scope: PageScope,
  pageId: string,
) {
  const now = new Date();
  const base = await withEvidenceRead(
    db,
    actor,
    scope,
    "read",
    undefined,
    async (tx) => {
      await authorize(tx, actor, scope);
      const page = await tx.pageIdentity.findFirst({
        where: { ...siteScope(scope), id: pageId },
      });
      if (!page) throw new Error("NOT_FOUND");
      const history = await tx.pageJournal.findMany({
        where: { ...siteScope(scope), pageId },
        orderBy: { revision: "desc" },
        take: HISTORY_LIMIT,
      });
      const runs = await tx.auditRun.findMany({
        where: {
          ...siteScope(scope),
          resultExpiresAt: { gt: now },
          manifest: { array_contains: [page.normalizedUrl] },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
        take: 5,
      });
      const context = await tx.siteContextRevision.findFirst({
        where: siteScope(scope),
        orderBy: { revision: "desc" },
      });
      const drafts = [];
      for (const id of [
        ...new Set(
          history.map((h) => h.contentDraftId).filter((v): v is string => !!v),
        ),
      ].slice(0, 10)) {
        const draft = await tx.contentDraft.findFirst({
          where: { ...siteScope(scope), id },
          select: { id: true, kind: true, revision: true },
        });
        if (draft)
          drafts.push({
            ...draft,
            history: await tx.contentRevision.findMany({
              where: {
                workspaceId: scope.workspaceId,
                draftId: id,
                ...revisionEligibility(draft.revision, now),
                revision: {
                  in: history
                    .filter((h) => h.contentDraftId === id)
                    .map((h) => h.contentDraftRevision!)
                    .filter(Boolean),
                },
              },
              orderBy: { revision: "desc" },
              take: HISTORY_LIMIT,
            }),
          });
      }
      const reportIds = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT lyraseo_report.page_ids(${scope.workspaceId},${scope.siteId},${page.normalizedUrl}) AS id`;
      const reports = await tx.evidenceReport.findMany({
        where: { ...siteScope(scope), id: { in: reportIds.map((r) => r.id) } },
        select: {
          id: true,
          title: true,
          createdAt: true,
          evidenceFormat: true,
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      const reportsWithStatus = await Promise.all(
        reports.map(async (report) => ({
          ...report,
          formatStatus: await reportFormatStatus(tx, scope, report.id),
        })),
      );
      const member = await tx.membership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: scope.workspaceId,
            userId: actor.userId,
          },
        },
      });
      return {
        page,
        history,
        historyLimit: HISTORY_LIMIT,
        context,
        drafts,
        reports: reportsWithStatus,
        runs,
        actor: { userId: actor.userId, canEdit: member?.role !== "VIEWER" },
        assignees:
          member && ["OWNER", "ADMIN"].includes(member.role)
            ? await eligibleAssignees(tx, scope.workspaceId, scope.siteId)
            : [],
      };
    },
  );
  type AuditRead = Awaited<ReturnType<typeof readAuditRun>>;
  const audits: Array<
    Pick<
      AuditRead,
      | "id"
      | "status"
      | "createdAt"
      | "completedAt"
      | "manifest"
      | "methodologyVersion"
      | "evidenceStatus"
      | "actions"
    > & {
      pages: Array<
        Pick<
          AuditRead["pages"][number],
          "requestedUrl" | "evidence" | "provenance"
        >
      >;
      findings: Array<{ scopeKey?: string }>;
    }
  > = [];
  for (const run of base.runs) {
    const evidence = await readAuditRun(
      db,
      actor,
      {
        ...siteScope(scope),
        auditId: run.id,
      },
      "read",
      now,
    );
    const evaluation = evidence.evaluation as {
      rules?: Array<{ scopeKey?: string }>;
    } | null;
    audits.push({
      id: evidence.id,
      status: evidence.status,
      createdAt: evidence.createdAt,
      completedAt: evidence.completedAt,
      manifest: evidence.manifest,
      methodologyVersion: evidence.methodologyVersion,
      evidenceStatus: evidence.evidenceStatus,
      pages: evidence.pages
        .filter((p) => p.requestedUrl === base.page.normalizedUrl)
        .map((p) => ({
          requestedUrl: p.requestedUrl,
          evidence: p.evidence,
          provenance: p.provenance,
        })),
      findings:
        evaluation?.rules?.filter(
          (r) => r.scopeKey === base.page.normalizedUrl,
        ) ?? [],
      actions: evidence.actions.filter(
        (a) => a.scopeKey === base.page.normalizedUrl,
      ),
    });
  }
  const search = await readGoogleSearch(db, actor, scope, now);
  // Services settle their own transactions first. The final scope lock then
  // revalidates retained identities and withholding before building the response.
  // Never hold a pool connection while recursively calling either service.
  return withEvidenceRead(db, actor, scope, "read", undefined, async (tx) => {
    const protectedLegacy = await lockLegacyInlineRead(tx, scope);
    await authorize(tx, actor, scope);
    const decisionAt = new Date();
    const correlations = search.opportunities.filter(
      (o) => o.kind === "demand-and-audit",
    );
    const targetIds = [
      ...new Set([
        ...audits.map((a) => a.id),
        ...correlations
          .map((o) => o.evidence.auditId)
          .filter(
            (id): id is string => typeof id === "string" && id.length <= 128,
          ),
      ]),
    ];
    const current = await tx.auditRun.findMany({
      where: { ...siteScope(scope), id: { in: targetIds } },
      take: 105,
      select: {
        id: true,
        status: true,
        storageFormat: true,
        createdAt: true,
        completedAt: true,
        methodologyVersion: true,
        resultExpiresAt: true,
      },
    });
    const checkedAudits = audits.map((audit) => {
      const row = current.find((r) => r.id === audit.id);
      if (!row || row.resultExpiresAt <= decisionAt)
        throw new Error("SOURCE_EXPIRED");
      if (
        row.status !== audit.status ||
        +row.createdAt !== +audit.createdAt ||
        Number(row.completedAt) !== Number(audit.completedAt) ||
        row.methodologyVersion !== audit.methodologyVersion
      )
        throw new Error("SOURCE_CHANGED");
      return protectedLegacy && row.storageFormat === null
        ? { ...audit, evidenceStatus: "legacy-lineage-withheld", findings: [] }
        : audit;
    });
    let searchWithheld =
      search.auditEvidenceStatus === "legacy-lineage-withheld";
    if (
      protectedLegacy &&
      (await tx.auditRun.findFirst({
        where: {
          ...siteScope(scope),
          status: "COMPLETED",
          storageFormat: null,
          resultExpiresAt: { gt: decisionAt },
        },
        select: { id: true },
      }))
    )
      searchWithheld = true;
    const checkedOpportunities = search.opportunities.filter((opportunity) => {
      if (opportunity.kind !== "demand-and-audit") return true;
      const row = current.find((r) => r.id === opportunity.evidence.auditId);
      if (!row || row.resultExpiresAt <= decisionAt)
        throw new Error("SOURCE_EXPIRED");
      if (
        row.status !== "COMPLETED" ||
        row.createdAt.toISOString() !== opportunity.evidence.auditedAt
      )
        throw new Error("SOURCE_CHANGED");
      if (protectedLegacy && row.storageFormat === null) {
        searchWithheld = true;
        return false;
      }
      return true;
    });
    const { runs: _, ...result } = base;
    return {
      ...result,
      audits: checkedAudits,
      search: {
        source: "Google Search Console" as const,
        coverage: search.coverage,
        auditEvidenceStatus: searchWithheld
          ? "legacy-lineage-withheld"
          : search.auditEvidenceStatus,
        opportunities: checkedOpportunities
          .filter((o) => o.page === base.page.normalizedUrl)
          .slice(0, 100),
        snapshots: search.snapshots
          .filter((s) => s.shape === "page" || s.shape === "query,page")
          .map((s) => ({
            ...s,
            rows: Array.isArray(s.rows)
              ? s.rows.filter((row) => {
                  const keys = (row as { keys?: unknown[] })?.keys;
                  return (
                    Array.isArray(keys) &&
                    keys[s.shape === "page" ? 0 : 1] === base.page.normalizedUrl
                  );
                })
              : [],
          }))
          .filter((s) => s.rows.length),
      },
      ai: {
        scope: "site" as const,
        message:
          "AI observations remain site-level; no page-attributed presence is inferred.",
      },
    };
  });
}
