import {
  captureWorkspaceBranding,
  type FrozenWorkspaceBranding,
} from "./branding";
import {
  buildEditorialTemplate,
  contextCitationId,
  editorialEvidenceFingerprint,
} from "./editorial-assistance";
export { buildEditorialTemplate } from "./editorial-assistance";
import { lockLegacyInlineRead } from "./legacy-inline";
import { legacyProjection } from "./legacy-evidence";
import { withEvidenceRead } from "./context";
import { obj, projectSnapshot, SAVED_FORMAT } from "./saved-evidence";
export { projectSnapshot } from "./saved-evidence";
import { pageReceipts } from "./page-receipts";
import { readable } from "./retention";
import { fingerprint } from "./audit-evidence";
import { Prisma as Sql } from "../generated/client";
import { siteScope } from "./sites";
import { boundedRawAnchorText } from "@lyraseo/visibility/acquisition";
/** Persisted manual editorial work. Source data is evidence, never executable instructions. */
import type { Prisma, PrismaClient } from "../generated/client";
import {
  compareAudits,
  type AuditComparison,
  type AuditEvaluation,
} from "@lyraseo/visibility";
import {
  withActor,
  authorizeSiteIn,
  verifyActorIn,
  type Actor,
  type Tx,
} from "./context";
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
export type ReportTemplate = "founder" | "editor" | "agency";
export type EvidenceSnapshot = {
  reportTemplate?: ReportTemplate;
  reportBranding?: FrozenWorkspaceBranding;
  format?: string;
  comparisonUnavailable?: boolean;
  historicalComparisonCounts?: Partial<FrozenAuditComparison["counts"]>;
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
    sourceId?: string;
    sourcePageId?: string;
    artifactRefId?: string;
    artifactGeneration?: string;
    sourceFactHash?: string;
    rawExpiresAt?: string;
    basis: string;
  }[];
};
const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function validate(content: DraftContent, sourceIds: ReadonlySet<string>) {
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
        !sourceIds.has(v.sourceId) ||
        typeof v.note !== "string" ||
        !v.note.trim() ||
        v.note.length > 1000,
    )
  )
    throw new Error("INVALID_CONTENT");
}
type SourceAnchor = {
  pageId: string;
  rawExpiresAt: Date;
  url: string;
  href: string;
  name: string;
  total: number;
  artifactRefId?: string;
  artifactGeneration?: string;
  sourceFactHash?: string;
};
function privateAnchors(
  tx: Tx,
  s: ContentScope,
  auditId: string,
  epoch: number,
) {
  return tx.$queryRaw<
    SourceAnchor[]
  >`SELECT * FROM lyraseo_audit.private_anchors(${s.siteId},${auditId},${epoch}::integer)`;
}
async function capture(
  tx: Tx,
  scope: ContentScope,
  selection: SourceSelection,
  epoch: number,
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
  const legacyInlineEnrolled = await lockLegacyInlineRead(tx, scope);
  const now = new Date();
  const comparisons = new Map<
    string,
    { reference: FrozenAuditReference; evaluation: AuditEvaluation }
  >();
  const sources: EvidenceSnapshot["sources"] = [],
    links: EvidenceSnapshot["internalLinks"] = [];
  for (const id of new Set(selection.auditIds)) {
    if (
      legacyInlineEnrolled &&
      (await tx.auditRun.count({
        where: {
          ...siteScope(scope),
          id,
          status: "COMPLETED",
          storageFormat: null,
        },
      }))
    )
      throw new Error("LEGACY_EVIDENCE_WITHHELD");
    const run = await tx.auditRun.findFirst({
      where: { ...siteScope(scope), id, status: "COMPLETED" },
    });
    if (!run || !run.evaluation) throw new Error("INVALID_SOURCE");
    if (legacyInlineEnrolled && run.storageFormat === null)
      throw new Error("LEGACY_EVIDENCE_WITHHELD");
    if (!readable(now, run.resultExpiresAt)) throw new Error("SOURCE_EXPIRED");
    const pages = await pageReceipts(tx, { ...scope, auditId: id }, now);
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
    // The extractor stores canonical absolute hrefs; accept only links between two acquired pages.
    const anchors =
      run.storageFormat === "AUDIT_PRIVATE_V1"
        ? await privateAnchors(tx, scope, id, epoch)
        : await tx.$queryRaw<SourceAnchor[]>`
      SELECT p.id AS "pageId",t."rawExpiresAt",p."requestedUrl" AS url,d."requestedUrl" AS href,left(link->>'name',512) AS name,(count(*) OVER())::integer AS total
      FROM "AuditPage" p JOIN "AuditPageRetention" t ON t."pageId"=p.id AND t."auditId"=p."auditId" AND t."workspaceId"=p."workspaceId"
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.evidence->'linkNames')='array'
        THEN p.evidence->'linkNames' ELSE '[]'::jsonb END) WITH ORDINALITY a(link,ord)
      JOIN "AuditPage" d ON d."auditId"=p."auditId" AND d."workspaceId"=p."workspaceId"
        AND d."requestedUrl"=split_part(link->>'href','#',1) AND d.id<>p.id AND d.evidence->'acquired'='true'::jsonb
      WHERE p."workspaceId"=${scope.workspaceId} AND p."auditId"=${id} AND t."rawExpiresAt">${now}
        AND p.evidence->'acquired'='true'::jsonb AND jsonb_typeof(link->'name')='string' AND btrim(link->>'name')<>''
      ORDER BY p."requestedUrl",ord LIMIT 100`;
    for (const a of anchors) {
      links.push({
        url: a.href,
        sourceUrl: a.url,
        sourceId: "audit:" + id,
        sourcePageId: a.pageId,
        artifactRefId: a.artifactRefId,
        artifactGeneration: a.artifactGeneration,
        sourceFactHash: a.sourceFactHash,
        rawExpiresAt: a.rawExpiresAt.toISOString(),
        anchorText: boundedRawAnchorText(a.name),
        basis:
          "audit:" +
          id +
          "; observed raw HTML anchor between acquired pages; rendered DOM unobserved",
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
        resultExpiresAt: run.resultExpiresAt,
        manifest: run.manifest,
        omittedLinks: (anchors[0]?.total ?? 0) - anchors.length,
        pages: pages.map((p) => ({
          id: p.id,
          url: p.requestedUrl,
          channel: "raw-http",
          receipt: p.provenance,
        })),
      },
    });
  }
  for (const id of new Set(selection.searchSnapshotIds)) {
    const snapshot = await tx.searchSnapshot.findFirst({
      where: { ...siteScope(scope), id },
      select: {
        id: true,
        property: true,
        startDate: true,
        endDate: true,
        status: true,
        shape: true,
        importedAt: true,
        resultExpiresAt: true,
      },
    });
    if (!snapshot) throw new Error("INVALID_SOURCE");
    if (!readable(now, snapshot.resultExpiresAt))
      throw new Error("SOURCE_EXPIRED");
    // Each group refers to exactly one provider shape and window. Unknown/empty values remain null.
    const [metrics] = await tx.$queryRaw<
      Array<{
        importedRows: number;
        clicks: number | null;
        impressions: number | null;
      }>
    >`
      SELECT count(*)::integer AS "importedRows",
        CASE WHEN count(*)=count(*) FILTER(WHERE jsonb_typeof(r->'clicks')='number') THEN sum((r->>'clicks')::double precision) END AS clicks,
        CASE WHEN count(*)=count(*) FILTER(WHERE jsonb_typeof(r->'impressions')='number') THEN sum((r->>'impressions')::double precision) END AS impressions
      FROM "SearchSnapshot" s CROSS JOIN LATERAL jsonb_array_elements(s.rows) r
      WHERE s."workspaceId"=${scope.workspaceId} AND s."siteId"=${scope.siteId} AND s.id=${id} AND s."resultExpiresAt">${now}`;
    sources.push({
      sourceId: "gsc:" + id,
      kind: "google-search-console",
      data: {
        ...snapshot,
        metrics: { clicks: metrics?.clicks, impressions: metrics?.impressions },
        reportCoverage: { importedRows: metrics?.importedRows },
      },
    });
  }
  const context = await tx.siteContextRevision.findFirst({
    where: siteScope(scope),
    orderBy: { revision: "desc" },
    select: { id: true, revision: true },
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
  return projectSnapshot(result);
}
export async function captureEditorialEvidence(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  selection: SourceSelection,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    return capture(tx, scope, selection, actor.securityVersion);
  });
}
/** Report capture authorizes both creation and export before reading saved evidence. */
export async function captureEvidenceReport(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  selection: SourceSelection & {
    comparison?: ReportComparisonSelection;
    reportTemplate?: ReportTemplate;
    brandingRevision?: number;
  },
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
    if (
      selection.reportTemplate &&
      !["founder", "editor", "agency"].includes(selection.reportTemplate)
    )
      throw new Error("INVALID_REPORT_TEMPLATE");
    const snapshot = await capture(
      tx,
      scope,
      selection,
      actor.securityVersion,
      selection.comparison,
    );
    const branding = await captureWorkspaceBranding(
      tx,
      scope,
      selection.brandingRevision,
    );
    return projectSnapshot({
      ...snapshot,
      ...(branding ? { reportBranding: branding } : {}),
      ...(selection.reportTemplate
        ? { reportTemplate: selection.reportTemplate }
        : {}),
    });
  });
}
/** Preview only: no draft, provider job or charge is created. */
export async function previewEditorialAssistance(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  input: SourceSelection & { kind: "brief" | "draft" },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lockSite(tx, scope);
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    const snapshot = await capture(tx, scope, input, actor.securityVersion);
    const contextId = obj(snapshot.context).id;
    if (typeof contextId !== "string")
      throw new Error("REVIEWED_CONTEXT_REQUIRED");
    const reviewed = await tx.siteContextRevision.findFirst({
      where: { ...siteScope(scope), id: contextId },
      select: { content: true },
    });
    if (!reviewed) throw new Error("REVIEWED_CONTEXT_REQUIRED");
    await verifySources(tx, scope, snapshot, new Date(), actor.securityVersion);
    await verifyActorIn(tx, actor, scope.workspaceId);
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    return buildEditorialTemplate(
      snapshot,
      reviewed.content as unknown as import("./sites").SiteContext,
      input.kind,
    );
  });
}
export async function createContentDraft(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  input: DraftContent &
    SourceSelection & {
      kind: "brief" | "draft";
      expectedContextRevisionId?: string;
      expectedEvidenceFingerprint?: string;
    },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    if (!["brief", "draft"].includes(input.kind))
      throw new Error("INVALID_CONTENT");
    await lockSite(tx, scope);
    await verifyActorIn(tx, actor, scope.workspaceId);
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    const snapshot = await capture(tx, scope, input, actor.securityVersion);
    if (
      input.expectedContextRevisionId !== undefined &&
      obj(snapshot.context).id !== input.expectedContextRevisionId
    )
      throw new Error("CONTEXT_REVISION_CONFLICT");
    if (
      input.expectedEvidenceFingerprint !== undefined &&
      editorialEvidenceFingerprint(snapshot) !==
        input.expectedEvidenceFingerprint
    )
      throw new Error("SOURCE_CHANGED");
    await verifySources(tx, scope, snapshot, new Date(), actor.securityVersion);
    validate(
      input,
      new Set([
        ...snapshot.sources.map((s) => s.sourceId),
        ...[contextCitationId(snapshot.context)].filter(
          (id): id is string => !!id,
        ),
      ]),
    );
    const draft = await tx.contentDraft.create({
      data: {
        ...siteScope(scope),
        kind: input.kind,
        evidenceFormat: SAVED_FORMAT,
        snapshot: json(snapshot),
      },
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
    await verifySources(tx, scope, snapshot, new Date(), actor.securityVersion);
    await verifyActorIn(tx, actor, scope.workspaceId);
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
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
      select: { id: true, evidenceFormat: true },
    });
    if (!draft) throw new Error("NOT_FOUND");
    // Editing authored text must not copy or require a readable historical source blob.
    // Keep already-authored citations editable even for an undecodable legacy source.
    const refs = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT src->>'sourceId' AS id FROM "ContentDraft" d
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.snapshot->'sources')='array'
        THEN d.snapshot->'sources' ELSE '[]'::jsonb END) src
      WHERE d."workspaceId"=${scope.workspaceId} AND d."siteId"=${scope.siteId} AND d.id=${draft.id}
        AND jsonb_typeof(src->'sourceId')='string' AND length(src->>'sourceId')<=256
      UNION SELECT citation->>'sourceId' FROM "ContentDraft" d
      JOIN "ContentRevision" r ON r."workspaceId"=d."workspaceId" AND r."draftId"=d.id AND r.revision=d.revision
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.content->'citations')='array' THEN r.content->'citations' ELSE '[]'::jsonb END) citation
      WHERE d."workspaceId"=${scope.workspaceId} AND d."siteId"=${scope.siteId} AND d.id=${draft.id}
        AND jsonb_typeof(citation->'sourceId')='string' AND length(citation->>'sourceId')<=256`;
    validate(input, new Set(refs.map((r) => r.id)));
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
async function lockSite(tx: Tx, s: ContentScope) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${s.workspaceId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${s.workspaceId} AND id=${s.siteId} FOR SHARE`;
}
async function sourceAvailability(
  tx: Tx,
  s: ContentScope,
  snapshot: EvidenceSnapshot,
  now: Date,
) {
  return Promise.all(
    snapshot.sources.map(async (source) => {
      const data = obj(source.data),
        isAudit =
          source.kind === "raw-http-audit" || source.kind === "raw-http",
        id = source.sourceId.slice(source.sourceId.indexOf(":") + 1);
      const row = isAudit
        ? await tx.auditRun.findFirst({
            where: { ...siteScope(s), id },
            select: { createdAt: true, resultExpiresAt: true },
          })
        : await tx.searchSnapshot.findFirst({
            where: { ...siteScope(s), id },
            select: { importedAt: true, resultExpiresAt: true },
          });
      const anchor = isAudit ? data.createdAt : data.importedAt;
      const matches =
        row &&
        typeof anchor === "string" &&
        +new Date(anchor) ===
          +("createdAt" in row ? row.createdAt : row.importedAt);
      let status: "current" | "expired" | "disconnected" | "unavailable" =
        "unavailable";
      if (matches && row)
        status = readable(now, row.resultExpiresAt) ? "current" : "expired";
      else if (
        typeof data.resultExpiresAt === "string" &&
        !readable(now, data.resultExpiresAt)
      )
        status = "expired";
      else if (
        !isAudit &&
        !row &&
        !(await tx.googleConnection.count({ where: siteScope(s) }))
      )
        status = "disconnected";
      return { sourceId: source.sourceId, status };
    }),
  );
}
async function verifySources(
  tx: Tx,
  s: ContentScope,
  snapshot: EvidenceSnapshot,
  now: Date,
  epoch: number,
) {
  const states = await sourceAvailability(tx, s, snapshot, now);
  if (!states.length || states.some((x) => x.status !== "current"))
    throw new Error("SOURCE_EXPIRED");
  if (!snapshot.internalLinks.length) return;
  const pages = await tx.auditPageRetention.findMany({
    where: {
      workspaceId: s.workspaceId,
      pageId: {
        in: snapshot.internalLinks.flatMap((l) =>
          l.sourcePageId ? [l.sourcePageId] : [],
        ),
      },
      page: { audit: { siteId: s.siteId } },
      rawExpiresAt: { gt: now },
    },
    select: {
      pageId: true,
      auditId: true,
      rawExpiresAt: true,
      page: {
        select: {
          requestedUrl: true,
          audit: { select: { storageFormat: true } },
        },
      },
    },
  });
  const byId = new Map(pages.map((p) => [p.pageId, p]));
  const artifactAudits = new Set(
    pages
      .filter((p) => p.page.audit.storageFormat === "AUDIT_PRIVATE_V1")
      .map((p) => p.auditId),
  );
  const anchors = (
    await Promise.all(
      [...artifactAudits].map((id) => privateAnchors(tx, s, id, epoch)),
    )
  ).flat();
  for (const link of snapshot.internalLinks) {
    const page = link.sourcePageId && byId.get(link.sourcePageId);
    if (
      !page ||
      link.sourceId !== "audit:" + page.auditId ||
      page.page.requestedUrl !== link.sourceUrl ||
      page.rawExpiresAt?.toISOString() !== link.rawExpiresAt ||
      (page.page.audit.storageFormat === "AUDIT_PRIVATE_V1" &&
        !anchors.some(
          (a) =>
            a.pageId === page.pageId &&
            a.url === link.sourceUrl &&
            a.href === link.url &&
            a.artifactRefId === link.artifactRefId &&
            a.artifactGeneration === link.artifactGeneration &&
            a.sourceFactHash === link.sourceFactHash &&
            a.rawExpiresAt.toISOString() === link.rawExpiresAt,
        ))
    )
      throw new Error("SOURCE_EXPIRED");
  }
}
export function revisionEligibility(
  head: number,
  now: Date,
): Prisma.ContentRevisionWhereInput {
  return {
    OR: [
      { revision: head },
      { pin: { isNot: null } },
      { historyExpiresAt: { gt: now } },
    ],
  };
}
export async function setRevisionPin(
  db: PrismaClient,
  actor: Actor,
  s: ContentScope,
  draftId: string,
  revision: number,
  pinned: boolean,
) {
  return withActor(db, actor, s.workspaceId, async (tx) => {
    if ("credential" in actor) throw new Error("FORBIDDEN");
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "edit");
    const [draft] = await tx.$queryRaw<
      Array<{ revision: number }>
    >`SELECT revision FROM "ContentDraft" WHERE "workspaceId"=${s.workspaceId} AND "siteId"=${s.siteId} AND id=${draftId} FOR UPDATE`;
    if (!draft) throw new Error("NOT_FOUND");
    const key = { workspaceId: s.workspaceId, draftId, revision };
    if (
      !(await tx.contentRevision.count({
        where: { ...key, ...revisionEligibility(draft.revision, new Date()) },
      }))
    )
      throw new Error("REVISION_UNAVAILABLE");
    if (pinned)
      await tx.contentRevisionPin.createMany({
        data: { ...key, pinnedBy: actor.userId },
        skipDuplicates: true,
      });
    else await tx.contentRevisionPin.deleteMany({ where: key });
    const available =
      pinned ||
      !!(await tx.contentRevision.count({
        where: { ...key, ...revisionEligibility(draft.revision, new Date()) },
      }));
    const pin = pinned
      ? await tx.contentRevisionPin.findFirstOrThrow({
          where: key,
          select: { pinnedAt: true, pinnedBy: true },
        })
      : null;
    return { revision, pinned, available, pin };
  });
}
async function savedSnapshot(
  tx: Tx,
  s: ContentScope,
  row: { id: string; evidenceFormat: string | null },
  table: "ContentDraft" | "EvidenceReport",
) {
  if (
    table === "ContentDraft" &&
    row.evidenceFormat !== SAVED_FORMAT &&
    (await lockLegacyInlineRead(tx, s))
  )
    throw new Error("LEGACY_EVIDENCE_WITHHELD");
  const from =
    table === "ContentDraft"
      ? Sql.sql`"ContentDraft"`
      : Sql.sql`"EvidenceReport"`;
  const projection =
    row.evidenceFormat === SAVED_FORMAT ? Sql.sql`snapshot` : legacyProjection;
  // This point lookup walks bounded JSON paths. Compiling the field expressions with JIT
  // costs far more than evaluating them once. The setting ends with this transaction.
  if (row.evidenceFormat !== SAVED_FORMAT)
    await tx.$executeRaw`SET LOCAL jit = off`;
  const [record] =
    table === "EvidenceReport"
      ? await tx.$queryRaw<
          Array<{ value: unknown }>
        >`SELECT lyraseo_report.snapshot(${s.workspaceId},${s.siteId},${row.id}) AS value`
      : await tx.$queryRaw<Array<{ value: unknown }>>(Sql.sql`
    SELECT ${projection} AS value FROM ${from} WHERE "workspaceId"=${s.workspaceId} AND "siteId"=${s.siteId} AND id=${row.id}`);
  const projected: EvidenceSnapshot = projectSnapshot(
    record?.value,
    row.evidenceFormat === SAVED_FORMAT ? "saved" : "legacy-sql",
  );
  if (row.evidenceFormat === SAVED_FORMAT) {
    if (
      obj(record?.value).format !== SAVED_FORMAT ||
      fingerprint(record?.value) !== fingerprint(projected)
    )
      throw new Error("INVALID_SAVED_FORMAT");
  } else {
    delete projected.format;
    const old = obj(record?.value).comparison;
    if (old && !projected.comparison) {
      const counts = obj(obj(old).counts);
      projected.historicalComparisonCounts = Object.fromEntries(
        ["resolved", "new", "persistent", "improved", "worsened", "unevaluated"]
          .filter(
            (k) => Number.isSafeInteger(counts[k]) && Number(counts[k]) >= 0,
          )
          .map((k) => [k, counts[k]]),
      );
    }
  }
  return projected;
}
export async function readContentDrafts(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  draftId?: string,
  beforeRevision?: number,
) {
  return withEvidenceRead(db, actor, scope, "read", undefined, async (tx) => {
    const drafts = await tx.contentDraft.findMany({
      where: { ...siteScope(scope), ...(draftId ? { id: draftId } : {}) },
      select: {
        id: true,
        workspaceId: true,
        siteId: true,
        kind: true,
        revision: true,
        evidenceFormat: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    if (draftId && !drafts.length) throw new Error("NOT_FOUND");
    const now = new Date();
    return Promise.all(
      drafts.map(async (draft) => {
        const legacyWithheld =
          draft.evidenceFormat !== SAVED_FORMAT &&
          (await lockLegacyInlineRead(tx, scope));
        const snapshot =
          draftId && beforeRevision === undefined && !legacyWithheld
            ? await savedSnapshot(tx, scope, draft, "ContentDraft")
            : undefined;
        const history = await tx.contentRevision.findMany({
          where: {
            workspaceId: scope.workspaceId,
            draftId: draft.id,
            ...(beforeRevision !== undefined
              ? { revision: { lt: beforeRevision } }
              : {}),
            ...revisionEligibility(draft.revision, now),
          },
          include: { pin: { select: { pinnedAt: true, pinnedBy: true } } },
          orderBy: { revision: "desc" },
          take: draftId ? 101 : 1,
        });
        return {
          ...draft,
          evidenceStatus: legacyWithheld
            ? "legacy-lineage-withheld"
            : "available",
          ...(snapshot
            ? {
                snapshot,
                sourceAvailability: await sourceAvailability(
                  tx,
                  scope,
                  snapshot,
                  now,
                ),
              }
            : {}),
          history: history.slice(0, 100),
          nextHistoryBefore:
            history.length > 100 ? history[99]!.revision : null,
        };
      }),
    );
  });
}
async function verifyReportBranding(
  tx: Tx,
  scope: ContentScope,
  snapshot: EvidenceSnapshot,
) {
  if (!snapshot.reportBranding) return;
  const original = await captureWorkspaceBranding(
    tx,
    scope,
    snapshot.reportBranding.revision,
  );
  if (fingerprint(original) !== fingerprint(snapshot.reportBranding))
    throw new Error("SOURCE_CHANGED");
}
export async function storeEvidenceReport(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  input: {
    title: string;
    snapshot: EvidenceSnapshot;
    render: (
      title: string,
      snapshot: EvidenceSnapshot,
    ) => Promise<{ pdf: Uint8Array; csv: string }>;
  },
) {
  const snapshot = projectSnapshot(input.snapshot);
  if (
    input.snapshot.format !== SAVED_FORMAT ||
    fingerprint(input.snapshot) !== fingerprint(snapshot) ||
    !input.title.trim() ||
    input.title.length > 200 ||
    snapshot.scope.workspaceId !== scope.workspaceId ||
    snapshot.scope.siteId !== scope.siteId
  )
    throw new Error("INVALID_REPORT");
  await withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "export");
    await verifySources(tx, scope, snapshot, new Date(), actor.securityVersion);
    await verifyReportBranding(tx, scope, snapshot);
  });
  const output = await input.render(input.title, snapshot);
  if (
    output.pdf.length > 10 * 1024 * 1024 ||
    Buffer.byteLength(output.csv) > 10 * 1024 * 1024
  )
    throw new Error("INVALID_REPORT");
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "export");
    await lockSite(tx, scope);
    await verifySources(tx, scope, snapshot, new Date(), actor.securityVersion);
    const original = await capture(
      tx,
      scope,
      {
        auditIds: snapshot.sources
          .filter((s) => s.kind === "raw-http-audit")
          .map((s) => s.sourceId.slice(6)),
        searchSnapshotIds: snapshot.sources
          .filter((s) => s.kind === "google-search-console")
          .map((s) => s.sourceId.slice(4)),
      },
      actor.securityVersion,
      snapshot.comparison
        ? {
            beforeAuditId: snapshot.comparison.before.auditId,
            afterAuditId: snapshot.comparison.after.auditId,
          }
        : undefined,
    );
    if (
      fingerprint({
        ...original,
        ...(snapshot.reportBranding
          ? {
              reportBranding: await captureWorkspaceBranding(
                tx,
                scope,
                snapshot.reportBranding.revision,
              ),
            }
          : {}),
        ...(snapshot.reportTemplate
          ? { reportTemplate: snapshot.reportTemplate }
          : {}),
        capturedAt: snapshot.capturedAt,
      }) !== fingerprint(snapshot)
    )
      throw new Error("SOURCE_CHANGED");
    await verifySources(tx, scope, snapshot, new Date(), actor.securityVersion);
    const report = await tx.evidenceReport.create({
      data: {
        ...siteScope(scope),
        title: input.title,
        snapshot: json(snapshot),
        evidenceFormat: SAVED_FORMAT,
        pdf: new Uint8Array(output.pdf),
        csv: output.csv,
      },
      select: { id: true, title: true, createdAt: true },
    });
    await verifySources(tx, scope, snapshot, new Date(), actor.securityVersion);
    return { ...report, formatStatus: { pdf: "available", csv: "available" } };
  });
}
export async function readEvidenceReports(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  reportId?: string,
  format?: "pdf" | "csv",
) {
  return withEvidenceRead(
    db,
    actor,
    scope,
    reportId ? "export" : "read",
    undefined,
    async (tx) => {
      if (reportId) {
        const row = await tx.evidenceReport.findFirst({
          where: { ...siteScope(scope), id: reportId },
          select: { id: true, evidenceFormat: true },
        });
        if (!row) throw new Error("NOT_FOUND");
        const states = await reportFormatStatus(tx, scope, reportId);
        if (states[format ?? "pdf"] !== "available")
          throw new Error(
            states[format ?? "pdf"] === "withdrawn"
              ? "REPORT_WITHDRAWN"
              : "LEGACY_REVIEW",
          );
        await savedSnapshot(tx, scope, row, "EvidenceReport");
        const [payload] = await tx.$queryRaw<
          Array<{ id: string; pdf: Uint8Array | null; csv: string | null }>
        >`
          SELECT * FROM lyraseo_report.export(${scope.workspaceId},${scope.siteId},${reportId},${format ?? "pdf"})`;
        if (!payload) throw new Error("NOT_FOUND");
        if (!format) {
          if (states.csv !== "available") throw new Error("LEGACY_REVIEW");
          const [csv] = await tx.$queryRaw<Array<{ csv: string | null }>>`
            SELECT csv FROM lyraseo_report.export(${scope.workspaceId},${scope.siteId},${reportId},'csv')`;
          if (!csv) throw new Error("NOT_FOUND");
          payload.csv = csv.csv;
        }
        return payload;
      }
      const reports = await tx.evidenceReport.findMany({
        where: siteScope(scope),
        select: {
          id: true,
          title: true,
          createdAt: true,
          evidenceFormat: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return Promise.all(
        reports.map(async (report) => ({
          ...report,
          formatStatus: await reportFormatStatus(tx, scope, report.id),
        })),
      );
    },
  );
}
export async function reportFormatStatus(
  tx: Tx,
  scope: ContentScope,
  id: string,
) {
  const [row] = await tx.$queryRaw<
    Array<{ value: { pdf: string; csv: string } }>
  >`
    SELECT lyraseo_report.status(${scope.workspaceId},${scope.siteId},${id}) AS value`;
  if (!row) throw new Error("NOT_FOUND");
  return row.value;
}
export async function previewEvidenceReport(
  db: PrismaClient,
  actor: Actor,
  scope: ContentScope,
  id: string,
) {
  return withEvidenceRead(db, actor, scope, "read", undefined, async (tx) => {
    const row = await tx.evidenceReport.findFirst({
      where: { ...siteScope(scope), id },
      select: { id: true, title: true, evidenceFormat: true, createdAt: true },
    });
    if (!row) throw new Error("NOT_FOUND");
    const snapshot = await savedSnapshot(tx, scope, row, "EvidenceReport");
    const formatStatus = await reportFormatStatus(tx, scope, id);
    return {
      ...row,
      snapshot,
      sourceAvailability: await sourceAvailability(
        tx,
        scope,
        snapshot,
        new Date(),
      ),
      formatStatus,
      downloadStatus:
        formatStatus.pdf === "available" && formatStatus.csv === "available"
          ? "available"
          : formatStatus.pdf === "withdrawn" || formatStatus.csv === "withdrawn"
            ? "withdrawn"
            : "pending-review",
      derivativeStatus:
        row.evidenceFormat === SAVED_FORMAT
          ? undefined
          : "unavailable: exact retained fact contract required",
    };
  });
}
