import { siteScope } from "./sites";
import { boundedRawAnchorText } from "@lyraseo/visibility/acquisition";
/** Persisted manual editorial work. Source data is evidence, never executable instructions. */
import type { Prisma, PrismaClient } from "../generated/client";
import {
  compareAudits,
  type AuditComparison,
  type AuditEvaluation,
  type PageEvidence,
} from "@lyraseo/visibility";
import { withActor, authorizeSiteIn, type Actor, type Tx } from "./context";
export type ContentScope = { workspaceId: string; siteId: string };
export type Citation = { sourceId: string; note: string };
export type DraftContent = {
  title: string;
  body: string;
  assumptions: string[];
  citations: Citation[];
};
export type SourceSelection = {
  auditIds: string[];
  searchSnapshotIds: string[];
};
export type ReportComparisonSelection = {
  beforeAuditId: string;
  afterAuditId: string;
};
export type FrozenAuditReference = {
  auditId: string;
  createdAt: string;
  methodologyVersion: string;
  profile: string;
  manifest: string[];
  declarations: unknown;
  contextRevisionId?: string;
  contextRevision?: number;
};
export type FrozenAuditComparison = {
  before: FrozenAuditReference;
  after: FrozenAuditReference;
  compatible: boolean;
  profileComparable: boolean;
  result: AuditComparison;
  counts: Record<Exclude<keyof AuditComparison, "scoreDelta">, number>;
};
export type EvidenceSnapshot = {
  comparison?: FrozenAuditComparison;
  capturedAt: string;
  scope: ContentScope;
  methodology: string;
  context: unknown;
  sources: { sourceId: string; kind: string; data: unknown }[];
  internalLinks: {
    url: string;
    sourceUrl: string;
    anchorText: string;
    basis: string;
  }[];
};
const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function validate(content: DraftContent, snapshot: EvidenceSnapshot) {
  if (
    !content.title?.trim() ||
    content.title.length > 200 ||
    typeof content.body !== "string" ||
    content.body.length > 100000 ||
    !Array.isArray(content.assumptions) ||
    content.assumptions.length > 50 ||
    content.assumptions.some((v) => typeof v !== "string" || v.length > 1000) ||
    !Array.isArray(content.citations) ||
    content.citations.length > 100 ||
    content.citations.some(
      (v) =>
        !snapshot.sources.some((s) => s.sourceId === v.sourceId) ||
        typeof v.note !== "string" ||
        !v.note.trim() ||
        v.note.length > 1000,
    )
  )
    throw new Error("INVALID_CONTENT");
}
// Keep the immutable references resolvable in a saved report without duplicating the response body.
function compactReceipt(value: unknown) {
  const p = value as Record<string, unknown>;
  return {
    acquiredAt: p.acquiredAt,
    sha256: p.sha256,
    finalUrl: p.finalUrl,
    status: p.status,
    redirects: p.redirects,
    error: p.error,
    robotsPolicy: p.robotsPolicy,
  };
}
async function capture(
  tx: Tx,
  scope: ContentScope,
  selection: SourceSelection,
  pair?: ReportComparisonSelection,
): Promise<EvidenceSnapshot> {
  if (
    !Array.isArray(selection.auditIds) ||
    !Array.isArray(selection.searchSnapshotIds) ||
    selection.auditIds.length > 5 ||
    selection.searchSnapshotIds.length > 5 ||
    (!selection.auditIds.length && !selection.searchSnapshotIds.length)
  )
    throw new Error("INVALID_SOURCES");
  if (
    pair &&
    (pair.beforeAuditId === pair.afterAuditId ||
      !selection.auditIds.includes(pair.beforeAuditId) ||
      !selection.auditIds.includes(pair.afterAuditId) ||
      new Set(selection.auditIds).size !== selection.auditIds.length ||
      new Set(selection.searchSnapshotIds).size !==
        selection.searchSnapshotIds.length)
  )
    throw new Error("INVALID_COMPARISON");
  const comparisons = new Map<
    string,
    { reference: FrozenAuditReference; evaluation: AuditEvaluation }
  >();
  const sources: EvidenceSnapshot["sources"] = [],
    links: EvidenceSnapshot["internalLinks"] = [];
  for (const id of new Set(selection.auditIds)) {
    const run = await tx.auditRun.findFirst({
      where: { ...siteScope(scope), id, status: "COMPLETED" },
    });
    if (!run || !run.evaluation) throw new Error("INVALID_SOURCE");
    if (Date.now() - run.createdAt.getTime() >= 30 * 86400000)
      throw new Error("SOURCE_EXPIRED");
    const pages = await tx.auditPage.findMany({
      where: { workspaceId: scope.workspaceId, auditId: id },
      orderBy: { requestedUrl: "asc" },
    });
    if (pair && [pair.beforeAuditId, pair.afterAuditId].includes(run.id)) {
      const evaluation = {
        ...(run.evaluation as unknown as AuditEvaluation),
        profile: run.profile,
        declarations: run.declarations as AuditEvaluation["declarations"],
      };
      comparisons.set(run.id, {
        evaluation,
        reference: {
          auditId: run.id,
          createdAt: run.createdAt.toISOString(),
          methodologyVersion: run.methodologyVersion,
          profile: run.profile,
          manifest: run.manifest as string[],
          declarations: run.declarations,
          contextRevisionId: evaluation.contextRevisionId,
          contextRevision: evaluation.contextRevision,
        },
      });
    }
    sources.push({
      sourceId: `audit:${run.id}`,
      kind: "raw-http-audit",
      data: {
        id: run.id,
        createdAt: run.createdAt,
        methodologyVersion: run.methodologyVersion,
        profile: run.profile,
        declarations: run.declarations,
        evaluation: run.evaluation,
        pages: pages.map((p) => ({
          id: p.id,
          url: p.requestedUrl,
          evidence: p.evidence,
          channel: "raw-http",
          ...(run.methodologyVersion === "readiness-v2"
            ? { receipt: compactReceipt(p.provenance) }
            : {}),
        })),
      },
    });
    const acquired = new Set(
      pages
        .filter((p) => (p.evidence as unknown as PageEvidence).acquired)
        .map((p) => p.requestedUrl),
    );
    for (const p of pages) {
      const evidence = p.evidence as unknown as PageEvidence;
      if (!evidence.acquired) continue;
      for (const anchor of evidence.linkNames ?? []) {
        if (links.length >= 100) break;
        try {
          const target = new URL(anchor.href, p.requestedUrl);
          target.hash = "";
          if (
            !acquired.has(target.href) ||
            target.href === p.requestedUrl ||
            !anchor.name.trim()
          )
            continue;
          links.push({
            url: target.href,
            sourceUrl: p.requestedUrl,
            anchorText: boundedRawAnchorText(anchor.name),
            basis: `audit:${id}; observed raw HTML anchor between acquired pages; rendered DOM unobserved`,
          });
        } catch {
          /* Invalid source links are not candidates. */
        }
      }
    }
  }
  for (const id of new Set(selection.searchSnapshotIds)) {
    const snapshot = await tx.searchSnapshot.findFirst({
      where: { ...siteScope(scope), id },
    });
    if (!snapshot) throw new Error("INVALID_SOURCE");
    if (Date.now() - snapshot.importedAt.getTime() >= 30 * 86400000)
      throw new Error("SOURCE_EXPIRED");
    const rows = snapshot.rows as unknown[];
    sources.push({
      sourceId: `gsc:${id}`,
      kind: "google-search-console",
      data: {
        ...snapshot,
        rows: rows.slice(0, 100),
        reportCoverage: {
          importedRows: rows.length,
          includedRows: Math.min(rows.length, 100),
          selection:
            "first 100 saved rows; not the complete property or complete import",
          importStatus: snapshot.status,
        },
      },
    });
  }
  const context = await tx.siteContextRevision.findFirst({
    where: siteScope(scope),
    orderBy: { revision: "desc" },
  });
  let comparison: FrozenAuditComparison | undefined;
  if (pair) {
    const before = comparisons.get(pair.beforeAuditId),
      after = comparisons.get(pair.afterAuditId);
    if (
      !before ||
      !after ||
      before.reference.createdAt > after.reference.createdAt
    )
      throw new Error("INVALID_COMPARISON");
    const result = compareAudits(before.evaluation, after.evaluation);
    const profileComparable =
      before.reference.profile === after.reference.profile;
    if (!profileComparable) result.scoreDelta = null;
    comparison = {
      before: before.reference,
      after: after.reference,
      result,
      profileComparable,
      compatible:
        before.reference.methodologyVersion ===
          after.reference.methodologyVersion && profileComparable,
      counts: {
        resolved: result.resolved.length,
        new: result.new.length,
        persistent: result.persistent.length,
        improved: result.improved.length,
        worsened: result.worsened.length,
        unevaluated: result.unevaluated.length,
      },
    };
  }
  const result = {
    ...(comparison ? { comparison } : {}),
    capturedAt: new Date().toISOString(),
    scope: siteScope(scope),
    methodology:
      "editorial-evidence-v1; selected saved evidence only; raw HTTP is not rendered-page evidence; GSC coverage is limited to imported rows and dates",
    context: context ?? null,
    sources,
    internalLinks: links,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 1000000)
    throw new Error("INVALID_SOURCE_SIZE");
  return json(result) as unknown as EvidenceSnapshot;
}
export async function captureEditorialEvidence(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  selection: SourceSelection,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    return capture(tx, scope, selection);
  });
}
/** Report capture authorizes both creation and export before reading saved evidence. */
export async function captureEvidenceReport(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  selection: SourceSelection & { comparison?: ReportComparisonSelection },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "export");
    if (
      new Set(selection.auditIds).size !== selection.auditIds.length ||
      new Set(selection.searchSnapshotIds).size !==
        selection.searchSnapshotIds.length
    )
      throw new Error("INVALID_SOURCES");
    return capture(tx, scope, selection, selection.comparison);
  });
}
export async function createContentDraft(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  input: DraftContent & SourceSelection & { kind: "brief" | "draft" },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    if (!["brief", "draft"].includes(input.kind))
      throw new Error("INVALID_CONTENT");
    const snapshot = await capture(tx, scope, input);
    validate(input, snapshot);
    const draft = await tx.contentDraft.create({
      data: { ...siteScope(scope), kind: input.kind, snapshot: json(snapshot) },
    });
    const revision = await tx.contentRevision.create({
      data: {
        workspaceId: scope.workspaceId,
        draftId: draft.id,
        revision: 1,
        userId: actor.userId,
        content: json({
          title: input.title,
          body: input.body,
          assumptions: input.assumptions,
          citations: input.citations,
        }),
      },
    });
    return { ...draft, history: [revision] };
  });
}
export async function saveContentDraft(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  input: DraftContent & { draftId: string; expectedRevision: number },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    const draft = await tx.contentDraft.findFirst({
      where: { ...siteScope(scope), id: input.draftId },
    });
    if (!draft) throw new Error("NOT_FOUND");
    validate(input, draft.snapshot as unknown as EvidenceSnapshot);
    const updated = await tx.contentDraft.updateMany({
      where: {
        ...siteScope(scope),
        id: draft.id,
        revision: input.expectedRevision,
      },
      data: { revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error("REVISION_CONFLICT");
    return tx.contentRevision.create({
      data: {
        workspaceId: scope.workspaceId,
        draftId: draft.id,
        revision: input.expectedRevision + 1,
        userId: actor.userId,
        content: json({
          title: input.title,
          body: input.body,
          assumptions: input.assumptions,
          citations: input.citations,
        }),
      },
    });
  });
}
export async function readContentDrafts(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  draftId?: string,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "read");
    const drafts = await tx.contentDraft.findMany({
      where: { ...siteScope(scope), ...(draftId ? { id: draftId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    if (draftId && !drafts.length) throw new Error("NOT_FOUND");
    return Promise.all(
      drafts.map(async (draft) => ({
        ...draft,
        history: await tx.contentRevision.findMany({
          where: { workspaceId: scope.workspaceId, draftId: draft.id },
          orderBy: { revision: "desc" },
          take: draftId ? 100 : 1,
        }),
      })),
    );
  });
}
export async function storeEvidenceReport(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  input: {
    title: string;
    snapshot: EvidenceSnapshot;
    pdf: Uint8Array;
    csv: string;
  },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "export");
    if (
      !input.title.trim() ||
      input.title.length > 200 ||
      input.snapshot.scope.workspaceId !== scope.workspaceId ||
      input.snapshot.scope.siteId !== scope.siteId ||
      input.pdf.length > 10 * 1024 * 1024 ||
      Buffer.byteLength(input.csv) > 10 * 1024 * 1024
    )
      throw new Error("INVALID_REPORT");
    return tx.evidenceReport.create({
      data: {
        ...siteScope(scope),
        title: input.title,
        snapshot: json(input.snapshot),
        pdf: new Uint8Array(input.pdf),
        csv: input.csv,
      },
      select: { id: true, title: true, createdAt: true },
    });
  });
}
export async function readEvidenceReports(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  reportId?: string,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(
      tx,
      actor,
      scope.workspaceId,
      scope.siteId,
      reportId ? "export" : "read",
    );
    if (reportId) {
      const report = await tx.evidenceReport.findFirst({
        where: { ...siteScope(scope), id: reportId },
      });
      if (!report) throw new Error("NOT_FOUND");
      return report;
    }
    return tx.evidenceReport.findMany({
      where: siteScope(scope),
      select: { id: true, title: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });
}
