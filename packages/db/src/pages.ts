import { revisionEligibility } from "./content";
import { siteScope } from "./sites";
/** Stable, explicitly registered URLs and an append-only workflow journal. No acquisition or scoring side effects. */
import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import { normalizeUrl } from "@lyraseo/visibility";
import { withActor, authorizeSiteIn, type Actor, type Tx } from "./context";
import { readAuditRun } from "./audits";
import { readGoogleSearch } from "./gsc";
export type PageScope = { workspaceId: string; siteId: string };
export const PAGE_SITE_LIMIT = 500;
export const PAGE_LIST_LIMIT = 100;
const HISTORY_LIMIT = 100;
async function lock(tx: Tx, scope: PageScope) {
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
    !["change", "claim", "unassign"].includes(input.action)
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
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        pageId: input.pageId,
        expectedRevision: input.expectedRevision,
        action: input.action,
        note: input.action === "change" ? input.note : "",
        contentDraftId:
          input.action === "change" ? (input.contentDraftId ?? null) : null,
      }),
    )
    .digest("hex");
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorize(tx, actor, scope, true);
    await lock(tx, scope);
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
      if (prior.inputHash !== inputHash) throw new Error("REVISION_CONFLICT");
      return { page, entry: prior };
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
        ...(input.action === "claim"
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
  const base = await withActor(db, actor, scope.workspaceId, async (tx) => {
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
    const reports = await tx.evidenceReport.findMany({
      where: {
        ...siteScope(scope),
        snapshot: {
          path: ["sources"],
          array_contains: [
            {
              kind: "raw-http-audit",
              data: { pages: [{ url: page.normalizedUrl }] },
            },
          ],
        },
      },
      select: { id: true, title: true, createdAt: true, evidenceFormat: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
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
      reports,
      runs,
      actor: { userId: actor.userId, canEdit: member?.role !== "VIEWER" },
    };
  });
  const audits = [];
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
  // Recheck current authorization after composing independently authorized evidence services.
  await withActor(db, actor, scope.workspaceId, (tx) =>
    authorize(tx, actor, scope),
  );
  const { runs: _, ...result } = base;
  return {
    ...result,
    audits,
    search: {
      source: "Google Search Console" as const,
      coverage: search.coverage,
      opportunities: search.opportunities
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
}
