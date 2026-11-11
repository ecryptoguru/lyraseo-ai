import { normalizeUrl, sameOrigin } from "./url";
import type {
  AuditEvidence,
  Category,
  Outcome,
  PageEvidence,
  Priority,
  RuleResult,
} from "./types";

type Definition = { id: string; category: Category; priority: Priority };
const definitions: Definition[] = [
  { id: "D01", category: "discovery", priority: "high" },
  { id: "D02", category: "discovery", priority: "high" },
  { id: "D03", category: "discovery", priority: "medium" },
  { id: "D04", category: "discovery", priority: "high" },
  { id: "E01", category: "extractability", priority: "high" },
  { id: "E02", category: "extractability", priority: "medium" },
  { id: "E03", category: "extractability", priority: "medium" },
  { id: "E04", category: "extractability", priority: "medium" },
  { id: "E05", category: "extractability", priority: "medium" },
  { id: "A01", category: "answer", priority: "low" },
  { id: "A02", category: "answer", priority: "low" },
  { id: "A03", category: "answer", priority: "low" },
  { id: "A04", category: "answer", priority: "medium" },
  { id: "T01", category: "entity", priority: "medium" },
];
const genericLinks = new Set(["click here", "here", "read more", "learn more"]);
const genericHeadings = new Set([
  "untitled",
  "heading",
  "section",
  "text",
  "lorem ipsum",
]);
const normalized = (value: string) =>
  value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const result = (outcome: Outcome, reasonCode: string, evidence?: string) => ({
  outcome,
  reasonCode,
  evidence,
});
type Decision = ReturnType<typeof result>;

function decide(
  id: string,
  page: PageEvidence,
  audit: AuditEvidence,
): Decision {
  if (id === "D01") {
    if (page.status === undefined) return result("UNKNOWN", "HTTP_UNAVAILABLE");
    if (page.status >= 400)
      return result("FAIL", "HTTP_ERROR", String(page.status));
    if (page.status >= 300)
      return result("WARNING", "REDIRECT_UNRESOLVED", String(page.status));
    if (!page.contentType?.toLowerCase().includes("text/html"))
      return result("NOT_APPLICABLE", "NON_HTML");
    return page.acquired
      ? result("PASS", "HTML_ACQUIRED")
      : result("UNKNOWN", "BODY_UNAVAILABLE");
  }
  if (!page.acquired) return result("UNKNOWN", "PAGE_UNAVAILABLE");
  switch (id) {
    case "D02":
      if (page.intentionallyExcluded)
        return result("NOT_APPLICABLE", "EXPLICITLY_EXCLUDED");
      if (page.explicitNoindex)
        return result("FAIL", "NOINDEX_ON_INTENDED_PAGE");
      return page.headComplete
        ? result("PASS", "NO_NOINDEX")
        : result("UNKNOWN", "HEAD_UNAVAILABLE");
    case "D03": {
      if (!page.headComplete) return result("UNKNOWN", "HEAD_UNAVAILABLE");
      const canonicals = page.canonicalUrls.map((value) => {
        try {
          return normalizeUrl(value);
        } catch {
          return null;
        }
      });
      if (canonicals.some((value) => value === null))
        return result("FAIL", "INVALID_CANONICAL");
      const unique = new Set(canonicals);
      if (unique.size > 1) return result("FAIL", "CONFLICTING_CANONICALS");
      const actual = canonicals[0];
      if (!actual) return result("WARNING", "CANONICAL_MISSING");
      if (page.intendedCanonical)
        return normalizeUrl(page.intendedCanonical) === actual
          ? result("PASS", "DECLARED_CANONICAL_MATCH")
          : result("FAIL", "DECLARED_CANONICAL_MISMATCH", actual);
      return actual === normalizeUrl(page.finalUrl ?? page.requestedUrl)
        ? result("PASS", "SELF_CANONICAL")
        : result("WARNING", "CANONICAL_NEEDS_REVIEW", actual);
    }
    case "D04":
      if (page.intentionallyExcluded)
        return result("NOT_APPLICABLE", "EXPLICITLY_EXCLUDED");
      if (page.robotsGoogleAllowed === undefined)
        return result("UNKNOWN", "ROBOTS_UNAVAILABLE");
      return page.robotsGoogleAllowed
        ? result("PASS", "GOOGLEBOT_ALLOWED")
        : result("WARNING", "GOOGLEBOT_DISALLOWED");
    case "E01":
      if (!page.bodyComplete || page.mainText === undefined)
        return result("UNKNOWN", "MAIN_UNAVAILABLE");
      return /[\p{L}\p{N}]/u.test(page.mainText)
        ? result("PASS", "MAIN_TEXT_PRESENT")
        : result("FAIL", "MAIN_EMPTY");
    case "E02": {
      if (!page.headComplete) return result("UNKNOWN", "HEAD_UNAVAILABLE");
      const titles = page.titleElements.map(normalized);
      if (!titles.length) return result("FAIL", "MISSING_TITLE");
      if (titles.some((title) => !title)) return result("FAIL", "EMPTY_TITLE");
      if (new Set(titles).size > 1) return result("FAIL", "CONFLICTING_TITLES");
      return titles.length > 1
        ? result("WARNING", "DUPLICATE_TITLE")
        : result("PASS", "TITLE_PRESENT");
    }
    case "E03":
      if (!page.bodyComplete) return result("UNKNOWN", "BODY_UNAVAILABLE");
      return page.h1Texts.filter((text) => normalized(text)).length === 1
        ? result("PASS", "ONE_H1")
        : page.h1Texts.filter((text) => normalized(text)).length > 1
          ? result("WARNING", "MULTIPLE_H1")
          : result("FAIL", "MISSING_H1");
    case "E04": {
      if (!page.bodyComplete) return result("UNKNOWN", "BODY_UNAVAILABLE");
      const links = page.linkNames.filter((link) => link.href);
      if (!links.length) return result("NOT_APPLICABLE", "NO_LINKS");
      if (links.some((link) => !normalized(link.name)))
        return result("FAIL", "UNNAMED_LINK");
      return page.detectedLanguage === "en" &&
        links.some((link) =>
          genericLinks.has(normalized(link.name).toLowerCase()),
        )
        ? result("WARNING", "GENERIC_LINK")
        : result("PASS", "LINKS_NAMED");
    }
    case "E05":
      if (!page.headComplete) return result("UNKNOWN", "HEAD_UNAVAILABLE");
      if (!page.jsonLd.length) return result("NOT_APPLICABLE", "NO_JSON_LD");
      try {
        page.jsonLd.forEach((value) => JSON.parse(value));
        return result("PASS", "JSON_LD_PARSES");
      } catch {
        return result("FAIL", "INVALID_JSON_LD");
      }
    case "A01": {
      if (!page.bodyComplete) return result("UNKNOWN", "BODY_UNAVAILABLE");
      if (page.headingLevels.length < 2)
        return result("NOT_APPLICABLE", "FEW_HEADINGS");
      return page.headingLevels
        .slice(1)
        .some((level, i) => level > (page.headingLevels[i] ?? 0) + 1)
        ? result("WARNING", "HEADING_JUMP")
        : result("PASS", "HEADING_SEQUENCE");
    }
    case "A02":
      if (!page.bodyComplete || !page.populatedSections)
        return result("UNKNOWN", "SECTIONS_UNAVAILABLE");
      if (!page.headingLevels.length)
        return result("NOT_APPLICABLE", "NO_HEADINGS");
      return page.populatedSections.some((value) => !value)
        ? result("WARNING", "EMPTY_SECTION")
        : result("PASS", "SECTIONS_POPULATED");
    case "A03":
      if (!page.bodyComplete) return result("UNKNOWN", "BODY_UNAVAILABLE");
      if (page.detectedLanguage !== "en")
        return result("UNKNOWN", "LANGUAGE_UNCONFIRMED");
      if (!page.headingLevels.length)
        return result("NOT_APPLICABLE", "NO_HEADINGS");
      if (
        !page.headingTexts ||
        page.headingTexts.length !== page.headingLevels.length
      )
        return result("UNKNOWN", "HEADINGS_UNAVAILABLE");
      return page.headingTexts.some((text) =>
        genericHeadings.has(normalized(text).toLowerCase()),
      )
        ? result("WARNING", "GENERIC_HEADING")
        : result("PASS", "HEADING_NAMED");
    case "A04":
      if (!page.pageType) return result("UNKNOWN", "PAGE_TYPE_UNDECLARED");
      if (page.pageType !== "article")
        return result("NOT_APPLICABLE", "NOT_ARTICLE");
      if (!page.publishedDate || !page.byline)
        return result("WARNING", "ARTICLE_ATTRIBUTION_MISSING");
      if (
        Number.isNaN(Date.parse(page.publishedDate)) ||
        (page.modifiedDate !== undefined &&
          Number.isNaN(Date.parse(page.modifiedDate)))
      )
        return result("WARNING", "DATE_UNPARSEABLE");
      if (
        page.modifiedDate &&
        Date.parse(page.modifiedDate) < Date.parse(page.publishedDate)
      )
        return result("FAIL", "DATE_ORDER_CONFLICT");
      return result("PASS", "ARTICLE_ATTRIBUTION_PRESENT");
    case "T01": {
      const names = [audit.brandName, ...(audit.approvedAliases ?? [])].filter(
        (name): name is string => !!name,
      );
      if (!names.length) return result("UNKNOWN", "BRAND_UNDECLARED");
      if (!page.bodyComplete || page.visibleText === undefined)
        return result("UNKNOWN", "VISIBLE_TEXT_UNAVAILABLE");
      const text = normalized(page.visibleText).toLocaleLowerCase("en");
      return names.some((name) => {
        const escaped = normalized(name)
          .toLocaleLowerCase("en")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(
          `(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
          "u",
        ).test(text);
      })
        ? result("PASS", "BRAND_VISIBLE")
        : result("WARNING", "BRAND_NOT_OBSERVED");
    }
  }
  throw new Error(`Unknown rule ${id}`);
}

export function evaluatePageRules(
  page: PageEvidence,
  audit: AuditEvidence,
): RuleResult[] {
  const scopeKey = normalizeUrl(page.requestedUrl);
  return definitions.map((definition) => ({
    ruleId: definition.id,
    category: definition.category,
    priority: definition.priority,
    scopeKey,
    ...decide(definition.id, page, audit),
  }));
}

export function evaluateOriginRules(audit: AuditEvidence): RuleResult[] {
  const pages = audit.pages.filter((page) => page.acquired);
  const homepage = pages.find(
    (page) =>
      normalizeUrl(page.requestedUrl) === normalizeUrl(audit.siteOrigin),
  );
  const origin = new URL(normalizeUrl(audit.siteOrigin)).origin;
  const make = (
    ruleId: string,
    category: Category,
    priority: Priority,
    decision: Decision,
  ): RuleResult => ({
    ruleId,
    category,
    priority,
    scopeKey: origin,
    ...decision,
  });
  const selected = audit.manifest.filter(
    (url) => normalizeUrl(url) !== normalizeUrl(audit.siteOrigin),
  );
  let d05: Decision;
  if (audit.manifest.length === 1)
    d05 = result("NOT_APPLICABLE", "SINGLE_PAGE");
  else if (
    pages.length < audit.manifest.length ||
    pages.some((page) => !page.bodyComplete)
  )
    d05 = result("UNKNOWN", "INCOMPLETE_MANIFEST");
  else
    d05 = selected.every((url) =>
      pages.some(
        (page) =>
          normalizeUrl(page.requestedUrl) !== normalizeUrl(url) &&
          page.linkNames.some((link) => {
            try {
              return (
                sameOrigin(link.href, audit.siteOrigin) &&
                normalizeUrl(link.href) === normalizeUrl(url)
              );
            } catch {
              return false;
            }
          }),
      ),
    )
      ? result("PASS", "SAMPLED_LINKS_PRESENT")
      : result("WARNING", "SAMPLED_LINK_MISSING");
  let t02: Decision;
  if (!homepage?.bodyComplete) t02 = result("UNKNOWN", "HOMEPAGE_UNAVAILABLE");
  else
    t02 = homepage.linkNames.some(
      (link) =>
        /\b(about|contact)\b/i.test(link.name) &&
        (() => {
          try {
            return sameOrigin(link.href, origin);
          } catch {
            return false;
          }
        })(),
    )
      ? result("PASS", "CONTACT_LINK_OBSERVED")
      : result("WARNING", "CONTACT_LINK_NOT_OBSERVED");
  return [
    make("D05", "discovery", "medium", d05),
    make("T02", "entity", "low", t02),
    make(
      "T03",
      "entity",
      "medium",
      result("NOT_APPLICABLE", "NO_IDENTITY_FIELDS"),
    ),
    make(
      "T04",
      "entity",
      "low",
      result("NOT_APPLICABLE", "NO_DECLARED_POLICY_REQUIREMENT"),
    ),
  ];
}
