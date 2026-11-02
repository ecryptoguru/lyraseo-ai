import { normalizeUrl } from "./url";
import {
  completeDirectives,
  evaluateOriginRules,
  evaluatePageRules,
} from "./rules";
import { evaluateAuditV1 } from "./score-v1";
import type {
  AuditEvidence,
  AuditEvaluation,
  Category,
  PageEvidence,
  ReadinessDeclarations,
  RuleResult,
} from "./types";

const weights = {
  discovery: 30,
  extractability: 25,
  answer: 25,
  entity: 20,
} as const;
const categories = Object.keys(weights) as Category[];
/** Input is limited to a 25-page catalogue, including origin rules. This seam separates arithmetic from rule predicates. */
export function aggregateReadiness(
  rules: Pick<RuleResult, "category" | "outcome">[],
  acquired: number,
  selected: number,
  homepageUsable: boolean,
  allNoindex = false,
) {
  if (
    selected < 1 ||
    selected > 25 ||
    acquired < 0 ||
    acquired > selected ||
    rules.length > 354
  )
    throw new Error("Invalid readiness scope.");
  const categoryScores = {} as Record<Category, number | null>,
    categoryCoverage = {} as Record<Category, number | null>;
  let activeWeight = 0,
    coveredWeight = 0,
    earned = 0,
    everyActiveHasValue = true;
  for (const category of categories) {
    const active = rules.filter(
      (r) => r.category === category && r.outcome !== "NOT_APPLICABLE",
    );
    const evaluated = active.filter((r) => r.outcome !== "UNKNOWN");
    const score = evaluated.length
      ? evaluated.reduce(
          (sum, r) =>
            sum +
            (r.outcome === "PASS" ? 1 : r.outcome === "WARNING" ? 0.5 : 0),
          0,
        ) / evaluated.length
      : null;
    categoryScores[category] = score;
    categoryCoverage[category] = active.length
      ? evaluated.length / active.length
      : null;
    if (!active.length) continue;
    activeWeight += weights[category];
    coveredWeight += weights[category] * categoryCoverage[category]!;
    if (score === null) everyActiveHasValue = false;
    else earned += weights[category] * score;
  }
  const coverage = activeWeight ? coveredWeight / activeWeight : 0;
  const override = allNoindex && homepageUsable && acquired === selected;
  const eligible =
    override ||
    (homepageUsable &&
      acquired / selected >= 0.8 &&
      activeWeight > 0 &&
      everyActiveHasValue &&
      coverage >= 0.8);
  return {
    eligible,
    coverage,
    categoryScores,
    categoryCoverage,
    score: override
      ? 0
      : eligible
        ? Math.round((100 * earned) / activeWeight)
        : null,
  };
}
function missing(requestedUrl: string): PageEvidence {
  return {
    requestedUrl,
    acquired: false,
    headComplete: false,
    bodyComplete: false,
    titleElements: [],
    headingLevels: [],
    h1Texts: [],
    canonicalUrls: [],
    linkNames: [],
    jsonLd: [],
  };
}
function declarations(input: AuditEvidence): ReadinessDeclarations {
  const {
    brandName,
    approvedAliases,
    officialUrls,
    aboutUrl,
    contactUrl,
    requiredPolicyUrls,
    pageDeclarations,
  } = input;
  return structuredClone({
    brandName,
    approvedAliases,
    officialUrls,
    aboutUrl,
    contactUrl,
    requiredPolicyUrls,
    pageDeclarations,
  });
}
export function evaluateAudit(input: AuditEvidence): AuditEvaluation {
  if (input.methodologyVersion === "readiness-v1")
    return evaluateAuditV1(input);
  if (input.methodologyVersion !== "readiness-v2")
    throw new Error("Unsupported methodology version.");
  const home = normalizeUrl(input.siteOrigin);
  const manifest = input.manifest.map(normalizeUrl);
  if (
    !manifest.length ||
    manifest.length > 25 ||
    new Set(manifest).size !== manifest.length ||
    !manifest.includes(home) ||
    manifest.some((url) => new URL(url).origin !== new URL(home).origin)
  )
    throw new Error("Invalid manifest.");
  const receipts = new Map(
    input.pages.map((p) => [normalizeUrl(p.requestedUrl), p]),
  );
  if (
    receipts.size !== input.pages.length ||
    [...receipts.keys()].some((url) => !manifest.includes(url))
  )
    throw new Error("Invalid page receipts.");
  const pages = manifest.map((url) => {
    const observed = receipts.get(url) ?? missing(url);
    const declared = input.pageDeclarations?.find(
      (d) => d.requestedUrl === url,
    );
    return {
      ...observed,
      indexingIntent: declared?.indexingIntent,
      pageType: declared?.pageType,
      intendedCanonical: declared?.intendedCanonical,
    };
  });
  const audit = { ...input, manifest, pages };
  const rules = pages
    .flatMap((p) => evaluatePageRules(p, audit))
    .concat(evaluateOriginRules(audit));
  const usable = (p: PageEvidence) =>
    p.acquired &&
    p.status !== undefined &&
    p.status >= 200 &&
    p.status < 300 &&
    /^text\/html(?:\s*;|$)/i.test(p.contentType ?? "");
  const destinations = new Map<string, string[]>();
  for (const p of pages)
    if (p.finalUrl) {
      const final = normalizeUrl(p.finalUrl);
      destinations.set(final, [
        ...(destinations.get(final) ?? []),
        normalizeUrl(p.requestedUrl),
      ]);
    }
  const allNoindex =
    pages.every(
      (p) =>
        usable(p) && p.indexingIntent === "indexable" && completeDirectives(p),
    ) &&
    rules.filter((r) => r.ruleId === "D02").every((r) => r.outcome === "FAIL");
  return {
    ...aggregateReadiness(
      rules,
      pages.filter(usable).length,
      manifest.length,
      pages.some((p) => normalizeUrl(p.requestedUrl) === home && usable(p)),
      allNoindex,
    ),
    methodologyVersion: "readiness-v2",
    profile: input.profile ?? "LOCAL_RAW_V1",
    contextRevision: input.contextRevision,
    contextRevisionId: input.contextRevisionId,
    declarations: declarations(input),
    duplicateDestinations: [...destinations]
      .filter(([, urls]) => urls.length > 1)
      .map(([finalUrl, requestedUrls]) => ({ finalUrl, requestedUrls })),
    rules,
    manifest,
  };
}
