import { createHash } from "node:crypto";
import type { FrozenWorkspaceBranding } from "./branding";
import type {
  AuditComparison,
  RuleResult,
  EvidenceRef,
} from "@lyraseo/visibility";
import {
  declarationsSchema,
  measuredEvidenceFields,
} from "@lyraseo/visibility";
import type {
  EvidenceSnapshot,
  FrozenAuditComparison,
  FrozenAuditReference,
} from "./content";
export const SAVED_FORMAT = "saved-evidence-v2";
export const categories = [
  "resolved",
  "new",
  "persistent",
  "improved",
  "worsened",
  "unevaluated",
] as const;
export const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max ? v : undefined;
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const metric = (v: unknown) => (v === null ? null : num(v));
const strings = (v: unknown, count: number, length: number) =>
  array(v)
    .slice(0, count)
    .map((x) => str(x, length))
    .filter((x): x is string => x !== undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const timestamp = (v: unknown) =>
  v instanceof Date ? v.toISOString() : str(v, 40);
const scopeUrl = (v: unknown) => str(v, 2048);
const scores = (v: unknown) =>
  Object.fromEntries(
    ["discovery", "extractability", "answer", "entity"].flatMap((k) =>
      metric(obj(v)[k]) !== undefined ? [[k, metric(obj(v)[k])]] : [],
    ),
  );
export function declared(v: unknown) {
  const data = obj(v),
    input = Object.fromEntries(
      Object.keys(declarationsSchema.shape)
        .filter((k) => data[k] !== undefined)
        .map((k) => [k, data[k]]),
    );
  const parsed = declarationsSchema.safeParse(input);
  return {
    ...(parsed.success ? parsed.data : {}),
    contextRevision: num(data.contextRevision),
    contextRevisionId: str(data.contextRevisionId, 128),
  };
}
type Budget = { left: number; truncated: number };
function excerpt(v: unknown, budget: Budget) {
  if (typeof v !== "string" || !v) return undefined;
  const points = Array.from(
    v
      .normalize("NFKC")
      .replace(/[\u0000\uD800-\uDFFF]/gu, "�")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  const kept = points.slice(0, Math.min(budget.left, 512));
  if (kept.length < points.length) budget.truncated++;
  const canonical = kept.join("").trimEnd();
  budget.left -= Array.from(canonical).length;
  return canonical || undefined;
}
function rule(v: unknown, budget?: Budget): RuleResult | undefined {
  const r = obj(v);
  if (
    !str(r.ruleId, 32) ||
    !scopeUrl(r.scopeKey) ||
    !["PASS", "FAIL", "WARNING", "UNKNOWN", "NOT_APPLICABLE"].includes(
      String(r.outcome),
    ) ||
    !str(r.reasonCode, 128)
  )
    return;
  const refs = array(r.evidenceRefs)
    .slice(0, 64)
    .flatMap((v) => {
      const ref = obj(v);
      if (
        !["page", "receipt", "declarations", "manifest"].includes(
          String(ref.source),
        )
      )
        return [];
      return [
        {
          source: ref.source as EvidenceRef["source"],
          requestedUrl: scopeUrl(ref.requestedUrl),
          fields: strings(ref.fields, 64, 128).filter((f) =>
            measuredEvidenceFields.has(f),
          ),
        },
      ];
    });
  return {
    omittedEvidenceRefs:
      Math.max(
        num(r.omittedEvidenceRefs) ?? 0,
        array(r.evidenceRefs).length - refs.length,
      ) || undefined,
    ruleId: r.ruleId as string,
    ruleVersion: str(r.ruleVersion, 32),
    scopeKey: r.scopeKey as string,
    category: ["discovery", "extractability", "answer", "entity"].includes(
      String(r.category),
    )
      ? (r.category as RuleResult["category"])
      : undefined,
    priority: ["high", "medium", "low"].includes(String(r.priority))
      ? (r.priority as RuleResult["priority"])
      : undefined,
    reasonCode: r.reasonCode as string,
    outcome: r.outcome as RuleResult["outcome"],
    evidence: budget ? excerpt(r.evidence, budget) : undefined,
    evidenceRefs: Array.isArray(r.evidenceRefs) ? refs : undefined,
  } as RuleResult;
}
/** Whitelist the measured result, never accept an opaque evaluation or arbitrary evidence refs. */
export function compactEvaluation(
  v: unknown,
  budget: Budget = { left: 2048, truncated: 0 },
) {
  if (v == null) return null;
  const e = obj(v),
    rows = array(e.rules),
    rulesAvailable = Array.isArray(e.rules) && e.rulesAvailable !== false,
    rules = rows
      .map((r) => rule(r, budget))
      .filter((r): r is RuleResult => !!r);
  return {
    score: metric(e.score),
    coverage: num(e.coverage),
    categoryScores: scores(e.categoryScores),
    categoryCoverage: e.categoryCoverage
      ? scores(e.categoryCoverage)
      : undefined,
    eligible: bool(e.eligible),
    manifest: strings(e.manifest, 25, 2048),
    methodologyVersion: str(e.methodologyVersion, 32),
    profile: str(e.profile, 64),
    declarations: e.declarations ? declared(e.declarations) : undefined,
    contextRevision: num(e.contextRevision),
    contextRevisionId: str(e.contextRevisionId, 128),
    duplicateDestinations: Array.isArray(e.duplicateDestinations)
      ? e.duplicateDestinations.slice(0, 25).map((d) => ({
          finalUrl: scopeUrl(obj(d).finalUrl),
          requestedUrls: strings(obj(d).requestedUrls, 25, 2048),
        }))
      : undefined,
    rules,
    rulesAvailable,
    ruleCount: Math.max(num(e.ruleCount) ?? 0, rows.length),
    omittedRules: Math.max(
      num(e.omittedRules) ?? 0,
      Math.max(num(e.ruleCount) ?? 0, rows.length) - rules.length,
    ),
    truncatedExcerpts: Math.max(
      num(e.truncatedExcerpts) ?? 0,
      budget.truncated,
    ),
    outcomeCounts: rulesAvailable
      ? Object.fromEntries(
          ["PASS", "WARNING", "FAIL", "UNKNOWN", "NOT_APPLICABLE"].map((k) => [
            k,
            Math.max(
              rows.filter((r) => obj(r).outcome === k).length,
              Number.isSafeInteger(obj(e.outcomeCounts)[k]) &&
                Number(obj(e.outcomeCounts)[k]) <= Number(e.ruleCount)
                ? Number(obj(e.outcomeCounts)[k])
                : 0,
            ),
          ]),
        )
      : undefined,
  };
}
export function compactGroups(value: unknown) {
  const result = obj(value);
  return {
    ...Object.fromEntries(
      categories.map((k) => [
        k,
        array(result[k])
          .map((r) => rule(r))
          .filter(Boolean),
      ]),
    ),
    scoreDelta: metric(result.scoreDelta) ?? null,
  } as AuditComparison;
}
function reference(value: unknown): FrozenAuditReference | undefined {
  const r = obj(value);
  if (
    !str(r.auditId, 128) ||
    !timestamp(r.createdAt) ||
    !str(r.profile, 64) ||
    !str(r.methodologyVersion, 32)
  )
    return;
  return {
    auditId: r.auditId as string,
    createdAt: timestamp(r.createdAt)!,
    methodologyVersion: r.methodologyVersion as string,
    profile: r.profile as string,
    manifest: strings(r.manifest, 25, 2048),
    declarations: declared(r.declarations),
    contextRevision: num(r.contextRevision),
    contextRevisionId: str(r.contextRevisionId, 128),
  };
}
function comparison(value: unknown): FrozenAuditComparison | undefined {
  const c = obj(value),
    before = reference(c.before),
    after = reference(c.after),
    counts = obj(c.counts);
  if (
    !before ||
    !after ||
    typeof c.compatible !== "boolean" ||
    typeof c.profileComparable !== "boolean" ||
    (c.profileComparable && before.profile !== after.profile) ||
    (c.compatible &&
      (!c.profileComparable ||
        before.methodologyVersion !== after.methodologyVersion)) ||
    (!c.compatible && obj(c.result).scoreDelta != null) ||
    categories.some(
      (k) =>
        !Number.isSafeInteger(counts[k]) ||
        Number(counts[k]) < 0 ||
        !Array.isArray(obj(c.result)[k]) ||
        array(obj(c.result)[k]).length !== counts[k] ||
        array(obj(c.result)[k]).some((v) => !rule(v)),
    )
  )
    return;
  return {
    before,
    after,
    compatible: c.compatible,
    profileComparable: c.profileComparable,
    result: compactGroups(c.result),
    counts: Object.fromEntries(
      categories.map((k) => [k, counts[k]]),
    ) as FrozenAuditComparison["counts"],
  };
}
export function compactReceipt(value: unknown) {
  const p = obj(value),
    r = obj(p.robotsPolicy);
  const point = (v: unknown) =>
    v
      ? { url: scopeUrl(obj(v).url), allowed: bool(obj(v).allowed) }
      : undefined;
  const group = obj(r.googleGroup);
  return {
    acquiredAt: timestamp(p.acquiredAt),
    sha256: str(p.sha256, 64),
    finalUrl: scopeUrl(p.finalUrl),
    status: num(p.status),
    error: str(p.error, 128),
    channel: str(p.channel, 32),
    redirects: Array.isArray(p.redirects)
      ? strings(p.redirects, 8, 2048)
      : undefined,
    robotsPolicy: p.robotsPolicy
      ? {
          requestedUrl: scopeUrl(r.requestedUrl),
          finalUrl: scopeUrl(r.finalUrl),
          acquiredAt: timestamp(r.acquiredAt),
          state: str(r.state, 32),
          status: num(r.status),
          sha256: str(r.sha256, 64),
          requested: point(r.requested),
          final: point(r.final),
          groupAgent: str(group.agent, 16) ?? str(r.groupAgent, 16),
          ruleCount: Array.isArray(group.rules)
            ? group.rules.length
            : num(r.ruleCount),
        }
      : undefined,
  };
}
export interface SavedSearchFacts {
  id?: string;
  importedAt?: string;
  resultExpiresAt?: string;
  property?: string;
  startDate?: string;
  endDate?: string;
  shape?: string;
  status?: string;
  metrics: { clicks?: number | null; impressions?: number | null };
  reportCoverage: { importedRows?: number; includedRows: 0; selection: string };
}
export interface SavedAuditFacts {
  id?: string;
  createdAt?: string;
  resultExpiresAt?: string;
  methodologyVersion?: string;
  profile?: string;
  manifest: string[];
  declarations: ReturnType<typeof declared>;
  evaluation: ReturnType<typeof compactEvaluation>;
  pages: Array<{
    id?: string;
    url?: string;
    channel: string;
    receipt?: ReturnType<typeof compactReceipt>;
  }>;
  omittedLinks: number;
  truncatedExcerpts: number;
  excerptPolicy: string;
}
type SavedSource =
  | { sourceId: string; kind: "google-search-console"; data: SavedSearchFacts }
  | {
      sourceId: string;
      kind: "raw-http-audit" | "raw-http";
      data: SavedAuditFacts;
    };
export type ProjectedSnapshot = Omit<EvidenceSnapshot, "sources"> & {
  format: typeof SAVED_FORMAT;
  sources: SavedSource[];
};
/** Frozen branding accepts bounded embedded PNG bytes only; never an asset URL. */
function projectBranding(value: unknown): FrozenWorkspaceBranding | undefined {
  if (value === undefined) return undefined;
  const brand = obj(value);
  if (
    brand.schemaVersion !== 1 ||
    typeof brand.brandingRevisionId !== "string" ||
    !brand.brandingRevisionId ||
    brand.brandingRevisionId.length > 128 ||
    !Number.isSafeInteger(brand.revision) ||
    Number(brand.revision) < 1 ||
    typeof brand.displayName !== "string" ||
    brand.displayName.length > 100 ||
    Buffer.byteLength(brand.displayName) > 400
  )
    throw new Error("INVALID_BRANDING");
  let logo: FrozenWorkspaceBranding["logo"];
  if (brand.logo !== undefined) {
    const image = obj(brand.logo);
    if (
      typeof image.base64 !== "string" ||
      image.base64.length > 87384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        image.base64,
      ) ||
      image.mime !== "image/png" ||
      typeof image.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(image.sha256) ||
      !Number.isSafeInteger(image.width) ||
      Number(image.width) < 1 ||
      Number(image.width) > 512 ||
      !Number.isSafeInteger(image.height) ||
      Number(image.height) < 1 ||
      Number(image.height) > 256
    )
      throw new Error("INVALID_BRANDING");
    const bytes = Buffer.from(image.base64, "base64");
    if (
      bytes.length < 33 ||
      bytes.length > 65536 ||
      bytes.toString("base64") !== image.base64 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== image.width ||
      bytes.readUInt32BE(20) !== image.height ||
      createHash("sha256").update(bytes).digest("hex") !== image.sha256
    )
      throw new Error("INVALID_BRANDING");
    logo = {
      base64: image.base64,
      sha256: image.sha256,
      mime: "image/png",
      width: Number(image.width),
      height: Number(image.height),
    };
  }
  return {
    schemaVersion: 1,
    brandingRevisionId: brand.brandingRevisionId,
    revision: Number(brand.revision),
    displayName: brand.displayName,
    ...(logo ? { logo } : {}),
  };
}
export function projectSnapshot(
  v: unknown,
  source: "saved" | "legacy-sql" = "saved",
): ProjectedSnapshot {
  const s = obj(v),
    scope = obj(s.scope),
    ctx = obj(s.context),
    total = { left: 8192 },
    links: EvidenceSnapshot["internalLinks"] = [],
    sources: SavedSource[] = [];
  for (const item of array(s.sources).slice(0, 10)) {
    const src = obj(item),
      data = obj(src.data),
      id = str(src.sourceId, 160);
    if (!id) continue;
    if (src.kind === "google-search-console") {
      const counts = obj(data.reportCoverage),
        summary = obj(data.metrics);
      sources.push({
        sourceId: id,
        kind: src.kind,
        data: {
          id: str(data.id, 128),
          importedAt: timestamp(data.importedAt),
          resultExpiresAt: timestamp(data.resultExpiresAt),
          property: scopeUrl(data.property),
          startDate: str(data.startDate, 10),
          endDate: str(data.endDate, 10),
          shape: str(data.shape, 32),
          status: str(data.status, 32),
          metrics: {
            clicks: metric(summary.clicks),
            impressions: metric(summary.impressions),
          },
          reportCoverage: {
            importedRows: num(counts.importedRows),
            includedRows: 0,
            selection:
              "Aggregate of available rows in this import shape only. Individual rows are not saved.",
          },
        },
      });
      continue;
    }
    if (!["raw-http-audit", "raw-http"].includes(String(src.kind))) continue;
    const withheld =
      source === "legacy-sql"
        ? num(obj(data.evaluation).sqlWithheldExcerpts)
        : undefined;
    const budget = {
        left: Math.min(2048, total.left),
        truncated: withheld ?? 0,
      },
      initial = budget.left;
    const evaluation = compactEvaluation(data.evaluation, budget);
    const pages = array(data.pages)
      .slice(0, 25)
      .map((p) => ({
        id: str(obj(p).id, 128),
        url: scopeUrl(obj(p).url),
        channel: "raw-http",
        receipt: obj(p).receipt ? compactReceipt(obj(p).receipt) : undefined,
      }));
    const urls = new Set(pages.map((p) => p.url));
    let omittedLinks = 0;
    for (const item of array(s.internalLinks)) {
      const link = obj(item),
        from = scopeUrl(link.sourceUrl),
        to = scopeUrl(link.url);
      if (
        !from ||
        !to ||
        from === to ||
        !urls.has(from) ||
        !urls.has(to) ||
        !str(link.basis, 512)?.startsWith(id + ";")
      )
        continue;
      if (links.length >= 100) {
        omittedLinks++;
        continue;
      }
      const anchorText = excerpt(link.anchorText, budget);
      if (!anchorText) {
        omittedLinks++;
        continue;
      }
      links.push({
        sourceUrl: from,
        sourceId: str(link.sourceId, 160),
        sourcePageId: str(link.sourcePageId, 128),
        artifactRefId: str(link.artifactRefId, 36),
        artifactGeneration: str(link.artifactGeneration, 36),
        sourceFactHash: str(link.sourceFactHash, 64),
        rawExpiresAt: timestamp(link.rawExpiresAt),
        url: to,
        anchorText,
        basis:
          id +
          "; observed raw HTML anchor between acquired pages; rendered DOM unobserved",
      });
    }
    total.left -= initial - budget.left;
    sources.push({
      sourceId: id,
      kind: src.kind as "raw-http-audit" | "raw-http",
      data: {
        id: str(data.id, 128),
        createdAt: timestamp(data.createdAt),
        resultExpiresAt: timestamp(data.resultExpiresAt),
        methodologyVersion: str(data.methodologyVersion, 32),
        profile: str(data.profile, 64),
        manifest: strings(data.manifest, 25, 2048),
        declarations: declared(data.declarations),
        evaluation,
        pages,
        omittedLinks: (num(data.omittedLinks) ?? 0) + omittedLinks,
        truncatedExcerpts: Math.max(
          num(data.truncatedExcerpts) ?? 0,
          budget.truncated,
        ),
        excerptPolicy:
          "512 code points per excerpt, 2048 per source, 8192 per report",
      },
    });
  }
  const frozen = comparison(s.comparison);
  const reportBranding = projectBranding(s.reportBranding);
  const result: ProjectedSnapshot = {
    format: SAVED_FORMAT,
    ...(reportBranding ? { reportBranding } : {}),
    ...(["founder", "editor", "agency"].includes(String(s.reportTemplate))
      ? { reportTemplate: s.reportTemplate as "founder" | "editor" | "agency" }
      : {}),
    capturedAt: timestamp(s.capturedAt) ?? "",
    scope: {
      workspaceId: str(scope.workspaceId, 128) ?? "",
      siteId: str(scope.siteId, 128) ?? "",
    },
    methodology:
      str(s.methodology, 512) ?? "Historical methodology unavailable",
    context: s.context
      ? { id: str(ctx.id, 128), revision: num(ctx.revision) }
      : null,
    sources,
    internalLinks: links,
    ...(frozen
      ? { comparison: frozen }
      : s.comparison
        ? { comparisonUnavailable: true }
        : {}),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 1000000)
    throw new Error("INVALID_SOURCE_SIZE");
  return JSON.parse(JSON.stringify(result)) as ProjectedSnapshot;
}
