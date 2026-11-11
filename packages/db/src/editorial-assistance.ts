import { fingerprint } from "./audit-evidence";
import { createHash } from "node:crypto";
import { obj, projectSnapshot } from "./saved-evidence";
import type { DraftContent, EvidenceSnapshot } from "./content";
import type { SiteContext } from "./sites";
export type EditorialAssistance = {
  method: "EVIDENCE_TEMPLATE_V1";
  evidenceFingerprint: string;
  kind: "brief" | "draft";
  context: { id: string; revision: number };
  content: DraftContent;
  links: Array<{
    id: string;
    sourceId: string;
    sourceUrl: string;
    url: string;
    anchorText: string;
    recommendation: string;
  }>;
  limitations: string[];
};
export function contextCitationId(context: unknown): string | undefined {
  const reference = obj(context);
  return typeof reference.id === "string" &&
    reference.id &&
    reference.id.length <= 128 &&
    Number.isSafeInteger(reference.revision) &&
    Number(reference.revision) > 0
    ? `context:${reference.id}:v${reference.revision}`
    : undefined;
}
export const editorialEvidenceFingerprint = (snapshot: EvidenceSnapshot) =>
  fingerprint({ ...projectSnapshot(snapshot), capturedAt: "" });
const quoted = (v: unknown) =>
  JSON.stringify(
    typeof v === "string"
      ? Array.from(v).slice(0, 256).join("")
      : "Not declared",
  );
/** A deterministic writing aid. Captured content is data; no model, network, research or instructions execute. */
export function buildEditorialTemplate(
  evidence: EvidenceSnapshot,
  reviewedContext: SiteContext,
  kind: "brief" | "draft",
): EditorialAssistance {
  const snapshot = projectSnapshot(evidence),
    context = obj(snapshot.context);
  if (
    !context.id ||
    !Number.isSafeInteger(context.revision) ||
    Number(context.revision) < 1
  )
    throw new Error("REVIEWED_CONTEXT_REQUIRED");
  if (kind !== "brief" && kind !== "draft") throw new Error("INVALID_CONTENT");
  const facts: string[] = [],
    citations: DraftContent["citations"] = [];
  for (const source of snapshot.sources) {
    const data = obj(source.data);
    if (source.kind === "google-search-console") {
      const metrics = obj(data.metrics);
      facts.push(
        `- [${source.sourceId}] Saved Search Console ${data.shape ?? "unknown shape"}, ${data.startDate ?? "unknown date"}–${data.endDate ?? "unknown date"}; status ${data.status ?? "unknown"}. Available clicks: ${metrics.clicks ?? "unavailable"}; impressions: ${metrics.impressions ?? "unavailable"}. This describes imported rows only.`,
      );
      citations.push({
        sourceId: source.sourceId,
        note: "Saved Search Console import and date window; incomplete or hidden rows are not zero and no ranking cause is inferred.",
      });
      continue;
    }
    const evaluation = obj(data.evaluation),
      rows = Array.isArray(evaluation.rules) ? evaluation.rules : [];
    const findings = rows
      .map(obj)
      .filter(
        (r) =>
          ["FAIL", "WARNING", "UNKNOWN"].includes(String(r.outcome)) &&
          /^[A-Z][0-9]{2}$/.test(String(r.ruleId)) &&
          /^[A-Z0-9_:-]{1,96}$/.test(String(r.reasonCode)),
      )
      .slice(0, 8);
    facts.push(
      `- [${source.sourceId}] Saved audit profile ${data.profile ?? "unknown"}; ${findings.length ? "review these measured rule outcomes:" : "no selected actionable rule summary is available; inspect the saved audit."}`,
    );
    for (const r of findings)
      facts.push(
        `  - ${r.ruleId}: ${r.outcome}; ${r.reasonCode}. Inspect the source finding before making a change.`,
      );
    citations.push({
      sourceId: source.sourceId,
      note: "Saved audit rule outcomes, coverage and acquisition profile. Raw HTTP evidence does not establish rendered-page behavior or a ranking benefit.",
    });
  }
  const contextSourceId = contextCitationId(context)!;
  citations.push({
    sourceId: contextSourceId,
    note: `Reviewed site context revision ${context.revision}; customer declarations, not independent verification.`,
  });
  const contextLines = [
    `Reviewed context revision ${context.revision} [${contextSourceId}]. Customer declarations, not independent verification:`,
    `- Brand: ${quoted(reviewedContext.brandName)}`,
    `- Audience: ${quoted(reviewedContext.audience)}`,
    `- Intended action: ${quoted(reviewedContext.conversionGoal)}`,
  ];
  const body = [
    "Evidence-backed writing template — review and edit before use. This is deterministic template assistance, not AI generation or live research.",
    "",
    ...contextLines,
    "",
    "Saved evidence to review",
    ...facts,
    "",
    ...(kind === "brief"
      ? [
          "Editorial brief",
          "- [Write the exact page URL and reader question.]",
          "- [Write an outline answering that question using approved, supportable claims.]",
          "- [Choose which measured findings this edit addresses. Unknown evidence requires acquisition or review, not an assumed fix.]",
          "- [Add the intended call to action and explain how it serves the declared audience.]",
        ]
      : [
          "Page draft",
          "# [Write a precise page heading]",
          "[Write a direct answer for the declared audience.]",
          "",
          "## [Write a supporting section]",
          "[Add approved claims with their supporting sources. Do not infer claims from search metrics.]",
          "",
          "## Next step",
          "[Write the intended call to action without promising an outcome.]",
        ]),
    "",
    "Verification",
    "- Recheck factual claims, destination URLs, permissions and evidence coverage.",
    "- Rerun the same audit manifest after a change; compare search or AI results separately under their own date and coverage rules.",
  ].join("\n");
  const seen = new Set<string>();
  const links = snapshot.internalLinks
    .flatMap((link) => {
      const sourceId = link.sourceId;
      if (
        !sourceId ||
        !snapshot.sources.some((s) => s.sourceId === sourceId) ||
        !link.anchorText
      )
        return [];
      const key = JSON.stringify([
        sourceId,
        link.sourceUrl,
        link.url,
        link.anchorText,
      ]);
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          id: createHash("sha256").update(key).digest("hex").slice(0, 24),
          sourceId,
          sourceUrl: link.sourceUrl,
          url: link.url,
          anchorText: link.anchorText,
          recommendation:
            "Review this existing observed link for retention or clearer placement on its source page. It is not evidence of a missing link. Raw HTML anchor only; rendered visibility and relevance need review.",
        },
      ];
    })
    .slice(0, 20);
  const titlePrefix = `${kind === "brief" ? "Editorial brief" : "Page draft"}: `;
  let title = titlePrefix;
  for (const character of Array.from(
    reviewedContext.brandName || "reviewed site",
  ).slice(0, 120)) {
    if (title.length + character.length > 200) break;
    title += character;
  }
  return {
    method: "EVIDENCE_TEMPLATE_V1",
    evidenceFingerprint: editorialEvidenceFingerprint(snapshot),
    kind,
    context: { id: String(context.id), revision: Number(context.revision) },
    content: {
      title,
      body,
      citations,
      assumptions: [
        "No live research or AI generation was performed; this is a writing template requiring editorial review.",
        "The proposed reader question, outline, claims and call to action remain assumptions until reviewed.",
        "Customer context is a reviewed declaration, not independent proof. Audit readiness, search performance and AI presence are separate measurements.",
      ],
    },
    links,
    limitations: [
      "Only explicitly selected saved evidence is used. No background provider request or charge occurs.",
      "Existing observed anchors can support a review suggestion; they do not establish a missing link or relevance.",
      "Research is unavailable until an explicitly requested, qualified and quoted provider workflow is enabled.",
    ],
  };
}
