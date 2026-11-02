import { normalizeUrl } from "./url";
import { evaluateOriginRules, evaluatePageRules } from "./rules-v1";
import type {
  AuditEvidence,
  AuditEvaluation,
  Category,
  RuleResult,
} from "./types";

const weights: Record<Category, number> = {
  discovery: 30,
  extractability: 25,
  answer: 25,
  entity: 20,
};
const values = { PASS: 1, WARNING: 0.5, FAIL: 0 } as const;
const categories: Category[] = [
  "discovery",
  "extractability",
  "answer",
  "entity",
];
const halfUp = (value: number) => Math.floor(value + 0.5);

export function evaluateAuditV1(input: AuditEvidence): AuditEvaluation {
  if (input.methodologyVersion !== "readiness-v1")
    throw new Error("Unsupported methodology version.");
  if (input.manifest.length < 1 || input.manifest.length > 25)
    throw new Error("Select 1–25 pages.");
  const manifest = input.manifest.map(normalizeUrl);
  if (new Set(manifest).size !== manifest.length)
    throw new Error("The manifest contains duplicate pages.");
  const home = normalizeUrl(input.siteOrigin);
  if (!manifest.includes(home))
    throw new Error("The confirmed homepage must be selected.");
  if (manifest.some((url) => new URL(url).origin !== new URL(home).origin))
    throw new Error("All selected pages must use the verified origin.");
  const pagesByUrl = new Map(
    input.pages.map((page) => [normalizeUrl(page.requestedUrl), page]),
  );
  const pages = manifest.map(
    (url) =>
      pagesByUrl.get(url) ?? {
        requestedUrl: url,
        acquired: false,
        headComplete: false,
        bodyComplete: false,
        titleElements: [],
        headingLevels: [],
        h1Texts: [],
        canonicalUrls: [],
        linkNames: [],
        jsonLd: [],
      },
  );
  const rules: RuleResult[] = pages.flatMap((page) =>
    evaluatePageRules(page, input),
  );
  rules.push(...evaluateOriginRules({ ...input, pages }));
  const categoryScores = {} as Record<Category, number | null>;
  let totalWeight = 0;
  let coveredWeight = 0;
  let earned = 0;
  let everyActiveHasValue = true;
  for (const category of categories) {
    const instances = rules.filter((rule) => rule.category === category);
    const evaluated = instances.filter((rule) => rule.outcome in values);
    const unknown = instances.filter((rule) => rule.outcome === "UNKNOWN");
    const possible = evaluated.length + unknown.length;
    if (!possible) {
      categoryScores[category] = null;
      continue;
    }
    const score = evaluated.length
      ? evaluated.reduce(
          (sum, rule) => sum + values[rule.outcome as keyof typeof values],
          0,
        ) / evaluated.length
      : null;
    categoryScores[category] = score;
    totalWeight += weights[category];
    coveredWeight += (weights[category] * evaluated.length) / possible;
    if (score === null) everyActiveHasValue = false;
    else earned += weights[category] * score;
  }
  const coverage = totalWeight ? coveredWeight / totalWeight : 0;
  const usable = (page: (typeof pages)[number]) =>
    page.acquired &&
    page.bodyComplete &&
    page.status !== undefined &&
    page.status >= 200 &&
    page.status < 300;
  const acquired = pages.filter(usable).length;
  const eligible =
    pages.some(
      (page) => normalizeUrl(page.requestedUrl) === home && usable(page),
    ) &&
    acquired / manifest.length >= 0.8 &&
    coverage >= 0.8 &&
    everyActiveHasValue &&
    totalWeight > 0;
  const allNoindex =
    acquired === manifest.length &&
    pages.length === manifest.length &&
    pages.every(
      (page) =>
        page.acquired &&
        page.headComplete &&
        page.explicitNoindex === true &&
        !page.intentionallyExcluded,
    );
  return {
    score: eligible
      ? allNoindex
        ? 0
        : halfUp((100 * earned) / totalWeight)
      : null,
    coverage,
    categoryScores,
    rules,
    manifest,
    methodologyVersion: input.methodologyVersion,
    eligible,
  };
}
