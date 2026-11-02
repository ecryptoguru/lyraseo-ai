import { Prisma } from "../generated/client";
import { categories } from "./saved-evidence";

/** Compile only this fixed field contract into SQL. Customer values stay in the scoped query's parameters.
 * PostgreSQL discards unknown keys, invalid scalar types and oversized children before Prisma receives a row. */
// V1 D03 measured the full canonical URL, accepted up to 2,048 UTF-16 units.
const diagnosticInputLimit = 2048;
type Shape =
  | number
  | "number"
  | "boolean"
  | { countOf: "rules" | "googleGroup.rules"; subtract: number }
  | { countWithheldDiagnostics: number }
  | { fields: Record<string, Shape> }
  | { items: Shape; limit: number };
const object = (fields: Record<string, Shape>): Shape => ({ fields });
const list = (items: Shape, limit: number): Shape => ({ items, limit });
function expression(shape: Shape, node: string, depth = 0): string {
  const type = `jsonb_typeof(${node})`;
  if (typeof shape === "number")
    return `CASE WHEN ${type}='string' AND length(${node} #>> '{}')<=${shape} AND octet_length(${node} #>> '{}')<=${4 * shape} THEN ${node} END`;
  if (shape === "number")
    return `CASE WHEN ${node}='null'::jsonb OR (${type}='number' AND octet_length((${node})::text)<=32) THEN ${node} END`;
  if (shape === "boolean")
    return `CASE WHEN ${type}='boolean' THEN ${node} END`;
  if ("countOf" in shape || "countWithheldDiagnostics" in shape)
    throw new Error("Legacy counts require a parent object");
  if ("items" in shape) {
    const alias = "item" + depth;
    return `CASE WHEN ${type}='array' THEN COALESCE((SELECT jsonb_agg(${expression(shape.items, alias + ".value", depth + 1)} ORDER BY ${alias}.ord) FROM jsonb_array_elements(jsonb_path_query_array(${node},'$[0 to ${shape.limit - 1}]')) WITH ORDINALITY AS ${alias}(value,ord)),'[]'::jsonb) END`;
  }
  const fields = Object.entries(shape.fields).map(([key, child]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key))
      throw new Error("INVALID_LEGACY_FIELD");
    if (typeof child === "object" && "countOf" in child) {
      const array =
        child.countOf === "rules"
          ? `(${node}->'rules')`
          : `(${node}#>'{googleGroup,rules}')`;
      return `('${key}',CASE WHEN jsonb_typeof(${array})='array' THEN to_jsonb(greatest(0,jsonb_array_length(${array})-${child.subtract})) ELSE ${expression("number", `(${node}->'${key}')`)} END)`;
    }
    if (typeof child === "object" && "countWithheldDiagnostics" in child) {
      const rules = `(${node}->'rules')`;
      // Count only inputs SQL does not send. The normalized projector counts clipping of admitted text.
      return `('${key}',CASE WHEN jsonb_typeof(${rules})='array' THEN
        (SELECT to_jsonb(count(*)) FROM jsonb_array_elements(${rules}) WITH ORDINALITY AS measured(r,ord)
         WHERE r->'evidence' IS NOT NULL AND r->'evidence' NOT IN ('null'::jsonb,'""'::jsonb)
           AND (ord>${child.countWithheldDiagnostics} OR jsonb_typeof(r->'evidence')<>'string'
             OR length(r->>'evidence')>${diagnosticInputLimit})) END)`;
    }
    return `('${key}',${expression(child, `(${node}->'${key}')`, depth + 1)})`;
  });
  // Drop missing SQL values, retaining explicit measured JSON nulls.
  return `CASE WHEN ${type}='object' THEN (SELECT coalesce(jsonb_object_agg(k,v),'{}'::jsonb) FROM (VALUES ${fields.join(",")}) fields(k,v) WHERE v IS NOT NULL) END`;
}
const scores = object(
  Object.fromEntries(
    ["discovery", "extractability", "answer", "entity"].map((k) => [
      k,
      "number",
    ]),
  ),
);
const declarations = object({
  brandName: 512,
  approvedAliases: list(512, 20),
  officialUrls: list(2048, 20),
  aboutUrl: 2048,
  contactUrl: 2048,
  requiredPolicyUrls: list(2048, 20),
  pageDeclarations: list(
    object({
      requestedUrl: 2048,
      indexingIntent: 32,
      pageType: 32,
      intendedCanonical: 2048,
    }),
    25,
  ),
  contextRevision: "number",
  contextRevisionId: 128,
});
const rule = object({
  ruleId: 32,
  ruleVersion: 32,
  scopeKey: 2048,
  category: 32,
  outcome: 32,
  priority: 16,
  reasonCode: 128,
  evidence: diagnosticInputLimit,
  evidenceRefs: list(
    object({ source: 32, requestedUrl: 2048, fields: list(128, 64) }),
    64,
  ),
});
const point = object({ url: 2048, allowed: "boolean" });
const receipt = object({
  acquiredAt: 40,
  sha256: 64,
  finalUrl: 2048,
  status: "number",
  error: 128,
  channel: 32,
  redirects: list(2048, 8),
  robotsPolicy: object({
    requestedUrl: 2048,
    finalUrl: 2048,
    acquiredAt: 40,
    state: 32,
    status: "number",
    sha256: 64,
    requested: point,
    final: point,
    groupAgent: 16,
    ruleCount: { countOf: "googleGroup.rules", subtract: 0 },
    googleGroup: object({ agent: 16 }),
  }),
});
const counts = object(Object.fromEntries(categories.map((k) => [k, "number"])));
const reference = object({
  auditId: 128,
  createdAt: 40,
  methodologyVersion: 32,
  profile: 64,
  manifest: list(2048, 25),
  declarations,
  contextRevision: "number",
  contextRevisionId: 128,
});
const link = object({
  sourceUrl: 2048,
  url: 2048,
  anchorText: 512,
  basis: 512,
});
const scalarEvaluation = {
  score: "number",
  coverage: "number",
  categoryCoverage: scores,
  categoryScores: scores,
  eligible: "boolean",
  methodologyVersion: 32,
  profile: 64,
  contextRevision: "number",
  contextRevisionId: 128,
} as const;
function snapshotShape(summary: boolean): Shape {
  const summaryFacts = {
    ...scalarEvaluation,
    sqlWithheldExcerpts: { countWithheldDiagnostics: summary ? 0 : 600 },
    ruleCount: { countOf: "rules", subtract: 0 },
    omittedRules: { countOf: "rules", subtract: summary ? 0 : 600 },
  } as const;
  const evaluation = object(
    summary
      ? summaryFacts
      : {
          ...summaryFacts,
          manifest: list(2048, 25),
          declarations,
          rules: list(rule, 600),
          duplicateDestinations: list(
            object({ finalUrl: 2048, requestedUrls: list(2048, 25) }),
            25,
          ),
        },
  );
  const comparison = object(
    summary
      ? { counts }
      : {
          counts,
          before: reference,
          after: reference,
          compatible: "boolean",
          profileComparable: "boolean",
          result: object({
            scoreDelta: "number",
            ...Object.fromEntries(categories.map((k) => [k, list(rule, 600)])),
          }),
        },
  );
  return object({
    scope: object({ workspaceId: 128, siteId: 128 }),
    capturedAt: 40,
    methodology: 512,
    context: object({ id: 128, revision: "number" }),
    comparison,
    ...(summary ? {} : { internalLinks: list(link, 100) }),
    sources: list(
      object({
        sourceId: 160,
        kind: 32,
        data: object({
          id: 128,
          createdAt: 40,
          importedAt: 40,
          methodologyVersion: 32,
          profile: 64,
          ...(summary
            ? {}
            : {
                manifest: list(2048, 25),
                declarations,
                pages: list(object({ id: 128, url: 2048, receipt }), 25),
              }),
          evaluation,
          shape: 32,
          property: 2048,
          status: 32,
          startDate: 10,
          endDate: 10,
          metrics: object({ clicks: "number", impressions: "number" }),
          reportCoverage: object({ importedRows: "number" }),
        }),
      }),
      10,
    ),
  });
}
const full = Prisma.raw(expression(snapshotShape(false), "snapshot")),
  summary = Prisma.raw(expression(snapshotShape(true), "snapshot"));
export const legacyProjection = Prisma.sql`(WITH bounded AS MATERIALIZED (SELECT ${full} AS doc)
  SELECT CASE WHEN octet_length(doc::text)>1000000 THEN ${summary} ELSE doc END FROM bounded)`;
