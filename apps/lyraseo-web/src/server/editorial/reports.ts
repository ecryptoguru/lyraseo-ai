import { createElement as h } from "react";
import type { AuditEvaluation, RuleResult } from "@lyraseo/visibility";
import {
  Document,
  Page,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import type {
  FrozenAuditComparison,
  EvidenceSnapshot,
} from "@lyraseo/db/content";
export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
const comparisonLabels = {
  resolved: "Resolved",
  new: "New",
  persistent: "Persistent",
  improved: "Improved but unresolved",
  worsened: "Worsened",
  unevaluated: "Unevaluated",
} as const;
/** These exact text inputs are rendered as inert PDF text. CSV retains every classified row. */
export function comparisonReportLines(
  comparison?: FrozenAuditComparison,
  sources: EvidenceSnapshot["sources"] = [],
): string[] {
  if (!comparison) return [];
  const { before, after, result, counts } = comparison;
  const categories = Object.keys(comparisonLabels) as Array<
    keyof typeof comparisonLabels
  >;
  const order = [
    "resolved",
    "unevaluated",
    "new",
    "persistent",
    "improved",
    "worsened",
  ] as const;
  const rows = order.flatMap((classification) =>
    [...result[classification]]
      .sort((a, b) => Number(b.ruleId === "D01") - Number(a.ruleId === "D01"))
      .map((rule) => ({ classification, rule })),
  );
  const savedRules = (id: string) =>
    (
      sources.find((source) => source.sourceId === `audit:${id}`)?.data as
        { evaluation?: AuditEvaluation } | undefined
    )?.evaluation?.rules ?? [];
  const previous = savedRules(before.auditId),
    current = savedRules(after.auditId);
  const same = (a: RuleResult, b: RuleResult) =>
    a.ruleId === b.ruleId && a.scopeKey === b.scopeKey;
  const sourcesLabel = (rule: RuleResult | undefined) =>
    rule?.evidenceRefs
      ?.map(
        (ref) =>
          `${({ page: "page capture", receipt: "HTTP receipt", declarations: "declared context", manifest: "selected scope" } as const)[ref.source]} (${
            ref.fields
              .slice(0, 3)
              .map((field) =>
                (field.split(".").at(-1) ?? field)
                  .replace(/([a-z])([A-Z])/g, "$1 $2")
                  .toLowerCase(),
              )
              .join(", ") +
            (ref.fields.length > 3
              ? `; +${ref.fields.length - 3} fields in CSV`
              : "")
          })`,
      )
      .slice(0, 3)
      .join("; ") || "reference unavailable";
  const outcome = (rule: RuleResult | undefined) =>
    rule
      ? `${rule.outcome} (${rule.reasonCode})`
      : "not present in saved evidence";
  return [
    "Immutable audit comparison",
    `Before: audit:${before.auditId} | ${before.createdAt} | ${before.methodologyVersion} | ${before.profile}`,
    `After: audit:${after.auditId} | ${after.createdAt} | ${after.methodologyVersion} | ${after.profile}`,
    `Method/profile compatibility: ${comparison.compatible ? "compatible" : "incompatible"}. Scope manifests, context references and declarations are frozen in the CSV.`,
    categories
      .map((key) => `${comparisonLabels[key]}: ${counts[key]}`)
      .join(" | "),
    `Score delta: ${result.scoreDelta === null ? "not available" : result.scoreDelta}`,
    "Missing, incompatible or uncertain evidence cannot prove a fix. Unevaluated is not resolved. Reviewed dispositions do not prove fixes. Resolved rows retain the before defect; other rows retain the evaluator-selected evidence.",
    `Comparison finding rows included in PDF: ${Math.min(rows.length, 100)} of ${rows.length}. CSV contains the complete frozen comparison, including every classified finding and both source evaluations.`,
    ...rows.slice(0, 100).map(({ classification, rule }) => {
      const old = previous.find((r) => same(r, rule)),
        now = current.find((r) => same(r, rule));
      return [
        `${comparisonLabels[classification]} | ${rule.ruleId} v${rule.ruleVersion ?? "legacy/unversioned"} | ${rule.scopeKey}`,
        `Before: ${outcome(old)} -> After: ${outcome(now)}`,
        `Before sources: ${sourcesLabel(old)}. After sources: ${sourcesLabel(now)}.`,
        `Evidence excerpt (${classification === "resolved" ? "before" : "evaluator-selected"}): ${(rule.evidence ?? rule.reasonCode).slice(0, 300)}`,
      ].join("\n");
    }),
  ];
}
export async function renderEvidenceReport(
  title: string,
  snapshot: EvidenceSnapshot,
) {
  const rows = [
    [
      "Title",
      "Scope",
      "Captured UTC",
      "Methodology",
      "Context reference",
      "Source",
      "Kind",
      "Evidence",
    ],
    ...snapshot.sources.map((source) => [
      title,
      `${snapshot.scope.workspaceId}/${snapshot.scope.siteId}`,
      snapshot.capturedAt,
      snapshot.methodology,
      JSON.stringify(
        snapshot.context && typeof snapshot.context === "object"
          ? {
              id: (snapshot.context as Record<string, unknown>).id,
              revision: (snapshot.context as Record<string, unknown>).revision,
            }
          : null,
      ),
      source.sourceId,
      source.kind,
      JSON.stringify(source.data),
    ]),
  ];
  if (snapshot.comparison)
    rows.push(
      [
        "Immutable audit comparison",
        "Before source",
        "After source",
        "Captured UTC",
        "Comparison schema",
        "Scope",
        "Coverage",
        "Evidence",
      ],
      [
        title,
        `audit:${snapshot.comparison.before.auditId}`,
        `audit:${snapshot.comparison.after.auditId}`,
        snapshot.capturedAt,
        "audit-comparison-v1",
        `${snapshot.scope.workspaceId}/${snapshot.scope.siteId}`,
        "All normalized classification rows; selected saved audits only",
        JSON.stringify(snapshot.comparison),
      ],
    );
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const text = (value: string) =>
    h(Text, { style: { fontSize: 9, marginBottom: 8 } }, value);
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const describe = (value: unknown) => JSON.stringify(value ?? "unavailable");
  const context = object(snapshot.context);
  const sourceDetails = (source: EvidenceSnapshot["sources"][number]) => {
    const data = object(source.data),
      evaluation = object(data.evaluation);
    if (source.kind === "google-search-console") {
      const coverage = object(data.reportCoverage);
      return [
        `Property: ${String(data.property)} | Dates: ${String(data.startDate)} to ${String(data.endDate)}`,
        `Dimensions: ${String(data.shape)} | Import: ${String(data.status)} | Report rows: ${String(coverage.includedRows)} of ${String(coverage.importedRows)} imported`,
        "The PDF shows up to 10 saved rows. The CSV contains all rows included in this stored report snapshot.",
        ...(Array.isArray(data.rows)
          ? data.rows.slice(0, 10).map((row) => {
              const r = object(row);
              return `${Array.isArray(r.keys) ? r.keys.join(" / ") : "dimension unavailable"} | Clicks ${String(r.clicks ?? "unknown")} | Impressions ${String(r.impressions ?? "unknown")} | CTR ${String(r.ctr ?? "unknown")} | Position ${String(r.position ?? "unknown")}`;
            })
          : []),
      ];
    }
    return [
      `Acquired: ${String(data.createdAt ?? "unavailable")} | Method: ${String(data.methodologyVersion ?? source.kind)} | Profile: ${String(data.profile ?? "unavailable")}`,
      `Coverage: ${describe(evaluation.coverage)} | Readiness score: ${describe(evaluation.score)}`,
      ...(data.methodologyVersion === "readiness-v2"
        ? [
            "Audit business context revision " +
              String(object(data.declarations).contextRevision ?? "undeclared"),
            ...Object.entries(object(evaluation.categoryCoverage)).map(
              ([category, value]) =>
                category +
                " coverage: " +
                (typeof value === "number"
                  ? Math.round(value * 100) + "%"
                  : "not applicable"),
            ),
            "The CSV contains the frozen declarations, rule versions, evidence references and capture times.",
          ]
        : []),
      `Source rule rows included in PDF: ${Array.isArray(evaluation.rules) ? Math.min(evaluation.rules.length, 100) : 0} of ${Array.isArray(evaluation.rules) ? evaluation.rules.length : 0}. CSV retains the complete saved source evaluation.`,
      "Raw HTTP evidence only. Rendered DOM, actual bot retrieval and downstream citation outcomes are unobserved.",
      ...(Array.isArray(evaluation.rules)
        ? evaluation.rules.slice(0, 100).map((rule) => {
            const r = object(rule);
            return `${String(r.ruleId)}${r.ruleVersion ? " v" + String(r.ruleVersion) : ""} | ${String(r.scopeKey)} | ${String(r.outcome)} | ${String(r.reasonCode)}`;
          })
        : ["No rule summary is available; consult the stored CSV evidence."]),
    ];
  };
  const pdf = await renderToBuffer(
    h(
      Document,
      {},
      h(
        Page,
        {
          size: "A4",
          style: { padding: 36, paddingBottom: 52, fontFamily: "Helvetica" },
        },
        h(
          Text,
          { style: { fontSize: 20, marginBottom: 16 } },
          "Lyraseo | " + title,
        ),
        text(
          `Private report | Site reference: ${snapshot.scope.siteId} | ${snapshot.capturedAt}`,
        ),
        text(snapshot.methodology),
        text(
          "Assumptions: selected saved evidence represents only its acquisition window; user-declared context has not been independently verified; no causal, ranking, or citation guarantee is inferred. Initial PDF language support: English.",
        ),
        text(
          "Context revision: " +
            String(context.revision ?? "undeclared") +
            " | Reference: " +
            String(context.id ?? "none"),
        ),
        ...comparisonReportLines(snapshot.comparison, snapshot.sources).map(
          (line, index) =>
            h(
              Text,
              {
                key: `comparison-${index}`,
                wrap: false,
                style: { fontSize: 9, marginBottom: 10 },
              },
              line,
            ),
        ),
        ...snapshot.sources.map((source) =>
          h(
            View,
            { key: source.sourceId },
            text(`${source.sourceId} · ${source.kind}`),
            ...sourceDetails(source).map((line, index) =>
              h(
                Text,
                { key: index, style: { fontSize: 9, marginBottom: 8 } },
                line,
              ),
            ),
          ),
        ),
        h(Text, {
          fixed: true,
          style: { position: "absolute", bottom: 24, left: 36, fontSize: 8 },
          render: ({
            pageNumber,
            totalPages,
          }: {
            pageNumber: number;
            totalPages: number;
          }) => `Lyraseo private evidence | ${pageNumber} / ${totalPages}`,
        }),
        text(
          "Coverage: selected saved sources only. Missing pages, dates, dimensions and rendered DOM are not measured. This snapshot does not establish causal impact or ranking guarantees.",
        ),
      ),
    ),
  );
  return { pdf: new Uint8Array(pdf), csv };
}
