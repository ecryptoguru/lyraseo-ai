import { expect, it } from "vitest";
import {
  aggregateReadiness,
  compareAudits,
  evaluateAudit,
  validateDeclarations,
  type AuditEvidence,
  type PageEvidence,
  type Outcome,
  type Category,
  type MetadataEvidence,
} from "../../packages/visibility/src";
const home = "https://example.com/",
  about = home + "about",
  policy = home + "policy";
const metadata = (): MetadataEvidence => ({
  directivesComplete: true,
  canonicalsComplete: true,
  directives: [],
  canonicalUrls: [],
});
function page(url = home): PageEvidence {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: "text/html",
    acquired: true,
    headComplete: true,
    bodyComplete: true,
    metadata: {
      headers: metadata(),
      original: metadata(),
      rendered: { ...metadata(), canonicalUrls: [url] },
    },
    robotsGoogleAllowed: true,
    mainText: "中文",
    mainMediaNames: [],
    titleElements: ["Example"],
    h1Texts: ["Example"],
    headingLevels: [2, 3],
    headingTexts: ["Overview", "Details"],
    populatedSections: [true, true],
    detectedLanguage: "en-US",
    linkNames: [
      { name: "About us", href: about },
      { name: "Policy", href: policy },
    ],
    jsonLd: [
      '{"@graph":[{"@type":"Organization","name":"Example","url":"https://example.com"}]}',
    ],
    jsonLdComplete: true,
    visibleText: "Our company Example.",
    logoNames: [],
    articleDates: {
      visible: { published: "2024-02-29" },
      structured: { published: "2024-02-29T23:55:00-05:00" },
    },
    byline: "Editor",
    canonicalUrls: [],
  };
}
function audit(): AuditEvidence {
  return {
    siteOrigin: home,
    brandName: "Example",
    approvedAliases: ["Ex"],
    aboutUrl: about,
    requiredPolicyUrls: [policy],
    pageDeclarations: [
      { requestedUrl: home, pageType: "article", indexingIntent: "indexable" },
    ],
    profile: "GOLDEN_GOOGLE_RENDERED",
    methodologyVersion: "readiness-v2",
    manifest: [home],
    pages: [page()],
  };
}
type Mutation = (p: PageEvidence, a: AuditEvidence) => void;
type Row = [string, string, Outcome, string, Mutation];
const rows: Row[] = [
  [
    "timeout-not-404",
    "D01",
    "UNKNOWN",
    "HTTP_UNAVAILABLE",
    (p) => {
      p.acquired = false;
      p.status = undefined;
    },
  ],
  [
    "unresolved-acquired-redirect",
    "D01",
    "WARNING",
    "REDIRECT_UNRESOLVED",
    (p) => {
      p.status = 302;
    },
  ],
  [
    "observed-404",
    "D01",
    "FAIL",
    "HTTP_ERROR",
    (p) => {
      p.acquired = false;
      p.status = 404;
    },
  ],
  [
    "first-http-error",
    "D01",
    "FAIL",
    "HTTP_ERROR",
    (p) => {
      p.status = 400;
    },
  ],
  [
    "last-http-error",
    "D01",
    "FAIL",
    "HTTP_ERROR",
    (p) => {
      p.status = 599;
    },
  ],
  [
    "unsupported-type",
    "D01",
    "NOT_APPLICABLE",
    "NON_HTML",
    (p) => {
      p.contentType = "application/pdf";
      p.acquired = false;
    },
  ],
  [
    "unusable-3xx",
    "D01",
    "UNKNOWN",
    "BODY_UNAVAILABLE",
    (p) => {
      p.status = 301;
      p.acquired = false;
    },
  ],
  [
    "scoped-noindex-partial",
    "D02",
    "FAIL",
    "NOINDEX_ON_INTENDED_PAGE",
    (p) => {
      p.metadata!.original!.directives = [
        { agent: "googlebot", value: "none" },
      ];
      delete p.metadata!.rendered;
    },
  ],
  [
    "training-block-only",
    "D02",
    "PASS",
    "NO_NOINDEX",
    (p) => {
      p.metadata!.headers!.directives = [{ agent: "GPTBot", value: "noindex" }];
    },
  ],
  [
    "conflicting-uncertain",
    "D02",
    "WARNING",
    "DIRECTIVE_CONFLICT",
    (p) => {
      p.metadata!.headers!.directives = [{ agent: "*", value: "index" }];
      p.metadata!.rendered!.directives = [
        { agent: "googlebot", value: "noindex", applicability: "uncertain" },
      ];
    },
  ],
  [
    "unknown-directive",
    "D02",
    "UNKNOWN",
    "UNSUPPORTED_DIRECTIVE",
    (p) => {
      p.metadata!.headers!.directives = [{ agent: "*", value: "unrecognized" }];
    },
  ],
  [
    "excluded-indexing",
    "D02",
    "NOT_APPLICABLE",
    "EXPLICITLY_EXCLUDED",
    (_, a) => {
      a.pageDeclarations![0]!.indexingIntent = "excluded";
    },
  ],
  [
    "indexing-undeclared",
    "D02",
    "UNKNOWN",
    "INDEXING_INTENT_UNDECLARED",
    (_, a) => {
      delete a.pageDeclarations![0]!.indexingIntent;
    },
  ],
  [
    "external-canonical-no-intent",
    "D03",
    "WARNING",
    "CANONICAL_NEEDS_REVIEW",
    (p) => {
      p.metadata!.rendered!.canonicalUrls = ["http://external.example/"];
    },
  ],
  [
    "canonical-declared-match",
    "D03",
    "PASS",
    "DECLARED_CANONICAL_MATCH",
    (p, a) => {
      a.pageDeclarations![0]!.intendedCanonical = about;
      p.metadata!.rendered!.canonicalUrls = ["/about"];
    },
  ],
  [
    "missing-canonical",
    "D03",
    "WARNING",
    "CANONICAL_MISSING",
    (p) => {
      p.metadata!.rendered!.canonicalUrls = [];
    },
  ],
  [
    "nonself",
    "D03",
    "WARNING",
    "CANONICAL_NEEDS_REVIEW",
    (p) => {
      p.metadata!.rendered!.canonicalUrls = ["/en"];
    },
  ],
  [
    "same-dom-after-render",
    "D03",
    "PASS",
    "SELF_CANONICAL",
    (p) => {
      p.metadata!.original!.canonicalUrls = [home];
    },
  ],
  [
    "duplicate-within-dom",
    "D03",
    "WARNING",
    "DUPLICATE_CANONICAL",
    (p) => {
      p.metadata!.rendered!.canonicalUrls = [home, home];
    },
  ],
  [
    "duplicate-http-dom",
    "D03",
    "WARNING",
    "DUPLICATE_CANONICAL",
    (p) => {
      p.metadata!.headers!.canonicalUrls = [home];
    },
  ],
  [
    "conflicting-http-dom",
    "D03",
    "FAIL",
    "CONFLICTING_CANONICALS",
    (p) => {
      p.metadata!.headers!.canonicalUrls = [about];
    },
  ],
  [
    "invalid-canonical",
    "D03",
    "FAIL",
    "INVALID_CANONICAL",
    (p) => {
      p.metadata!.rendered!.canonicalUrls = ["javascript:alert(1)"];
    },
  ],
  [
    "declared-mismatch",
    "D03",
    "FAIL",
    "DECLARED_CANONICAL_MISMATCH",
    (_, a) => {
      a.pageDeclarations![0]!.intendedCanonical = about;
    },
  ],
  [
    "robots-disallow-no-noindex",
    "D04",
    "WARNING",
    "GOOGLEBOT_DISALLOWED",
    (p) => {
      p.robotsGoogleAllowed = false;
    },
  ],
  [
    "robots-unavailable",
    "D04",
    "UNKNOWN",
    "ROBOTS_UNAVAILABLE",
    (p) => {
      delete p.robotsGoogleAllowed;
    },
  ],
  [
    "robots-excluded",
    "D04",
    "NOT_APPLICABLE",
    "EXPLICITLY_EXCLUDED",
    (_, a) => {
      a.pageDeclarations![0]!.indexingIntent = "excluded";
    },
  ],
  [
    "sampled-incoming",
    "D05",
    "PASS",
    "SAMPLED_LINKS_PRESENT",
    (_, a) => {
      a.manifest.push(about);
      a.pages.push(page(about));
    },
  ],
  [
    "no-visible-incoming",
    "D05",
    "WARNING",
    "SAMPLED_LINK_MISSING",
    (p, a) => {
      a.manifest.push(about);
      a.pages.push(page(about));
      p.linkNames = [
        { name: "hidden", href: about, visible: false },
        { name: "bad", href: "javascript:void(0)" },
        { name: "external", href: "https://external.example/about" },
      ];
    },
  ],
  [
    "incomplete-sample",
    "D05",
    "UNKNOWN",
    "INCOMPLETE_MANIFEST",
    (_, a) => {
      a.manifest.push(about);
    },
  ],
  [
    "media-only",
    "E01",
    "WARNING",
    "MAIN_MEDIA_ONLY",
    (p) => {
      p.mainText = ".";
      p.mainMediaNames = ["Logo"];
    },
  ],
  [
    "empty-main",
    "E01",
    "FAIL",
    "MAIN_EMPTY",
    (p) => {
      p.mainText = ".";
    },
  ],
  [
    "missing-media",
    "E01",
    "UNKNOWN",
    "MAIN_MEDIA_UNAVAILABLE",
    (p) => {
      p.mainText = "";
      delete p.mainMediaNames;
    },
  ],
  [
    "missing-extraction",
    "E01",
    "UNKNOWN",
    "MAIN_UNAVAILABLE",
    (p) => {
      delete p.mainText;
    },
  ],
  [
    "empty-title",
    "E02",
    "FAIL",
    "EMPTY_TITLE",
    (p) => {
      p.titleElements = ["　 "];
    },
  ],
  [
    "missing-title",
    "E02",
    "FAIL",
    "MISSING_TITLE",
    (p) => {
      p.titleElements = [];
    },
  ],
  [
    "normalized-duplicates",
    "E02",
    "WARNING",
    "DUPLICATE_TITLE",
    (p) => {
      p.titleElements = ["Ｆoo&nbsp;bar", "Foo　bar"];
    },
  ],
  [
    "conflicting-titles",
    "E02",
    "FAIL",
    "CONFLICTING_TITLES",
    (p) => {
      p.titleElements = ["One", "Two"];
    },
  ],
  [
    "head-unavailable",
    "E02",
    "UNKNOWN",
    "HEAD_UNAVAILABLE",
    (p) => {
      p.headComplete = false;
    },
  ],
  [
    "missing-visible-h1",
    "E03",
    "FAIL",
    "MISSING_H1",
    (p) => {
      p.h1Texts = [" "];
    },
  ],
  [
    "multiple-visible-h1",
    "E03",
    "WARNING",
    "MULTIPLE_H1",
    (p) => {
      p.h1Texts = ["One", "Two"];
    },
  ],
  [
    "unknown-h1-visibility",
    "E03",
    "UNKNOWN",
    "BODY_UNAVAILABLE",
    (p) => {
      p.bodyComplete = false;
    },
  ],
  [
    "generic-link",
    "E04",
    "WARNING",
    "GENERIC_LINK",
    (p) => {
      p.linkNames[0]!.name = "Read more";
    },
  ],
  [
    "unnamed-link",
    "E04",
    "FAIL",
    "UNNAMED_LINK",
    (p) => {
      p.linkNames[0]!.name = "";
    },
  ],
  [
    "no-valid-links",
    "E04",
    "NOT_APPLICABLE",
    "NO_LINKS",
    (p) => {
      p.linkNames = [{ href: "javascript:alert(1)", name: "Hint" }];
    },
  ],
  [
    "nonenglish-generic-link",
    "E04",
    "PASS",
    "LINKS_NAMED",
    (p) => {
      p.detectedLanguage = "fr";
      p.linkNames[0]!.name = "Here";
    },
  ],
  [
    "unknown-link-visibility",
    "E04",
    "UNKNOWN",
    "BODY_UNAVAILABLE",
    (p) => {
      p.bodyComplete = false;
    },
  ],
  [
    "no-jsonld",
    "E05",
    "NOT_APPLICABLE",
    "NO_JSON_LD",
    (p) => {
      p.jsonLd = [];
    },
  ],
  [
    "invalid-jsonld",
    "E05",
    "FAIL",
    "INVALID_JSON_LD",
    (p) => {
      p.jsonLd.push("{");
    },
  ],
  [
    "partial-jsonld",
    "E05",
    "UNKNOWN",
    "JSON_LD_SOURCE_UNAVAILABLE",
    (p) => {
      p.jsonLdComplete = false;
    },
  ],
  [
    "forward-jump",
    "A01",
    "WARNING",
    "HEADING_JUMP",
    (p) => {
      p.headingLevels = [1, 3];
    },
  ],
  [
    "initial-high-backward",
    "A01",
    "PASS",
    "HEADING_SEQUENCE",
    (p) => {
      p.headingLevels = [4, 2];
    },
  ],
  [
    "few-headings",
    "A01",
    "NOT_APPLICABLE",
    "FEW_HEADINGS",
    (p) => {
      p.headingLevels = [4];
    },
  ],
  [
    "heading-visibility",
    "A01",
    "UNKNOWN",
    "BODY_UNAVAILABLE",
    (p) => {
      p.bodyComplete = false;
    },
  ],
  [
    "subordinate-populates-parent",
    "A02",
    "PASS",
    "SECTIONS_POPULATED",
    (p) => {
      p.populatedSections = [false, true];
    },
  ],
  [
    "empty-section",
    "A02",
    "WARNING",
    "EMPTY_SECTION",
    (p) => {
      p.populatedSections = [true, false];
    },
  ],
  [
    "missing-alignment",
    "A02",
    "UNKNOWN",
    "SECTIONS_UNAVAILABLE",
    (p) => {
      p.populatedSections = [];
    },
  ],
  [
    "no-sections",
    "A02",
    "NOT_APPLICABLE",
    "NO_HEADINGS",
    (p) => {
      p.headingLevels = [];
      delete p.populatedSections;
    },
  ],
  [
    "generic-punctuation",
    "A03",
    "WARNING",
    "GENERIC_HEADING",
    (p) => {
      p.headingTexts = ["Section:", "Details"];
    },
  ],
  [
    "unknown-language",
    "A03",
    "UNKNOWN",
    "LANGUAGE_UNCONFIRMED",
    (p) => {
      delete p.detectedLanguage;
    },
  ],
  [
    "other-language",
    "A03",
    "NOT_APPLICABLE",
    "NON_ENGLISH",
    (p) => {
      p.detectedLanguage = "fr";
    },
  ],
  [
    "no-section-headings",
    "A03",
    "NOT_APPLICABLE",
    "NO_HEADINGS",
    (p) => {
      p.headingLevels = [];
    },
  ],
  [
    "missing-heading-text",
    "A03",
    "UNKNOWN",
    "HEADINGS_UNAVAILABLE",
    (p) => {
      p.headingTexts = [];
    },
  ],
  [
    "article-type-unknown",
    "A04",
    "UNKNOWN",
    "PAGE_TYPE_UNDECLARED",
    (_, a) => {
      delete a.pageDeclarations![0]!.pageType;
    },
  ],
  [
    "marketing-no-date",
    "A04",
    "NOT_APPLICABLE",
    "NOT_ARTICLE",
    (_, a) => {
      a.pageDeclarations![0]!.pageType = "marketing";
    },
  ],
  [
    "article-one-channel",
    "A04",
    "WARNING",
    "ARTICLE_SINGLE_DATE_CHANNEL",
    (p) => {
      p.articleDates!.visible = {};
    },
  ],
  [
    "invalid-calendar-day",
    "A04",
    "WARNING",
    "DATE_UNPARSEABLE",
    (p) => {
      p.articleDates!.visible!.published = "2026-02-29";
    },
  ],
  [
    "relative-date",
    "A04",
    "WARNING",
    "DATE_UNPARSEABLE",
    (p) => {
      p.articleDates!.visible!.published = "yesterday";
    },
  ],
  [
    "missing-byline",
    "A04",
    "WARNING",
    "ARTICLE_ATTRIBUTION_MISSING",
    (p) => {
      delete p.byline;
    },
  ],
  [
    "article-chronology-precedes-byline",
    "A04",
    "FAIL",
    "DATE_ORDER_CONFLICT",
    (p) => {
      delete p.byline;
      p.articleDates!.structured!.modified = "2023-01-01";
    },
  ],
  [
    "source-day-conflict",
    "A04",
    "FAIL",
    "DATE_CHANNEL_CONFLICT",
    (p) => {
      p.articleDates!.visible!.published = "2023-01-01";
    },
  ],
  [
    "article-unobserved",
    "A04",
    "UNKNOWN",
    "ARTICLE_SOURCES_UNAVAILABLE",
    (p) => {
      delete p.articleDates;
    },
  ],
  [
    "alias-in-logo",
    "T01",
    "PASS",
    "BRAND_VISIBLE",
    (p) => {
      p.visibleText = "";
      p.logoNames = ["Ex logo"];
    },
  ],
  [
    "substring-impostor",
    "T01",
    "WARNING",
    "BRAND_NOT_OBSERVED",
    (p) => {
      p.visibleText = "PreExampleX";
    },
  ],
  [
    "identity-normalized-empty",
    "T01",
    "UNKNOWN",
    "BRAND_UNDECLARED",
    (_, a) => {
      a.brandName = " ";
      a.approvedAliases = ["　"];
    },
  ],
  [
    "unknown-logo",
    "T01",
    "UNKNOWN",
    "LOGO_NAMES_UNAVAILABLE",
    (p) => {
      p.visibleText = "";
      delete p.logoNames;
    },
  ],
  [
    "localized-contact",
    "T02",
    "PASS",
    "CONTACT_LINK_OBSERVED",
    (p) => {
      p.detectedLanguage = "fr";
      p.linkNames[0]!.name = "À propos";
    },
  ],
  [
    "eligible-absent",
    "T02",
    "WARNING",
    "CONTACT_LINK_NOT_OBSERVED",
    (p) => {
      p.linkNames = [
        { name: "About", href: "https://other.example/" },
        { name: "Contact", href: about, visible: false },
      ];
    },
  ],
  [
    "contact-unknown-language",
    "T02",
    "UNKNOWN",
    "LANGUAGE_UNCONFIRMED",
    (p, a) => {
      delete a.aboutUrl;
      delete p.detectedLanguage;
    },
  ],
  [
    "contact-nonenglish",
    "T02",
    "NOT_APPLICABLE",
    "NON_ENGLISH",
    (p, a) => {
      delete a.aboutUrl;
      p.detectedLanguage = "fr";
    },
  ],
  [
    "unknown-home",
    "T02",
    "UNKNOWN",
    "HOMEPAGE_UNAVAILABLE",
    (p) => {
      p.bodyComplete = false;
    },
  ],
  [
    "identity-conflict",
    "T03",
    "WARNING",
    "ORGANIZATION_CONFLICT",
    (p) => {
      p.jsonLd = ['{"@type":"Organization","name":"Other"}'];
    },
  ],
  [
    "official-url",
    "T03",
    "PASS",
    "ORGANIZATION_MATCH",
    (p, a) => {
      a.officialUrls = ["https://official.example/"];
      p.jsonLd = ['{"@type":"Organization","url":"https://official.example"}'];
    },
  ],
  [
    "no-org",
    "T03",
    "NOT_APPLICABLE",
    "NO_IDENTITY_FIELDS",
    (p) => {
      p.jsonLd = ['{"@type":"Product","name":"Other"}'];
    },
  ],
  [
    "missing-identity",
    "T03",
    "UNKNOWN",
    "BRAND_UNDECLARED",
    (_, a) => {
      delete a.brandName;
      delete a.approvedAliases;
    },
  ],
  [
    "unknown-org-source",
    "T03",
    "UNKNOWN",
    "JSON_LD_SOURCE_UNAVAILABLE",
    (p) => {
      p.jsonLdComplete = false;
    },
  ],
  [
    "malformed-org-source",
    "T03",
    "UNKNOWN",
    "INVALID_JSON_LD",
    (p) => {
      p.jsonLd.push("{");
    },
  ],
  [
    "missing-policy-link",
    "T04",
    "WARNING",
    "POLICY_LINK_MISSING",
    (p) => {
      p.linkNames = [{ name: "Policy", href: policy, visible: false }];
    },
  ],
  [
    "no-required-policy",
    "T04",
    "NOT_APPLICABLE",
    "NO_DECLARED_POLICY_REQUIREMENT",
    (_, a) => {
      delete a.requiredPolicyUrls;
    },
  ],
  [
    "unknown-policy-visibility",
    "T04",
    "UNKNOWN",
    "HOMEPAGE_UNAVAILABLE",
    (p) => {
      p.bodyComplete = false;
    },
  ],
];
for (const source of ["original", "rendered", "headers"] as const) {
  rows.push([
    "missing-directives-" + source,
    "D02",
    "UNKNOWN",
    "DIRECTIVE_SOURCE_UNAVAILABLE",
    (p) => {
      p.metadata![source]!.directivesComplete = false;
    },
  ]);
  rows.push([
    "missing-canonicals-" + source,
    "D03",
    "UNKNOWN",
    "CANONICAL_SOURCE_UNAVAILABLE",
    (p) => {
      p.metadata![source]!.canonicalsComplete = false;
    },
  ]);
}
it.each(rows)("%s", (_name, id, outcome, reasonCode, change) => {
  const a = audit();
  change(a.pages[0]!, a);
  expect(evaluateAudit(a).rules.find((r) => r.ruleId === id)).toMatchObject({
    outcome,
    reasonCode,
    ruleVersion: "2",
  });
});
it("freezes every normalized healthy result and asserts there are no unexpected findings", () => {
  const a = audit(),
    saved = JSON.stringify(a),
    result = evaluateAudit(a);
  expect(result.rules).toHaveLength(18);
  expect(
    result.rules
      .filter((r) => r.outcome !== "PASS")
      .map((r) => [r.ruleId, r.outcome, r.reasonCode]),
  ).toEqual([["D05", "NOT_APPLICABLE", "SINGLE_PAGE"]]);
  expect(result.score).toBe(100);
  expect(result.coverage).toBe(1);
  expect(JSON.parse(JSON.stringify(result))).toMatchSnapshot();
  expect(JSON.stringify(a)).toBe(saved);
  const copy = evaluateAudit(a);
  copy.rules[0]!.evidenceRefs![0]!.fields.push("foreign");
  expect(evaluateAudit(JSON.parse(saved))).toEqual(result);
});
it("preserves timestamp-independent outcomes and bounded Unicode evidence", () => {
  const a = audit();
  a.pages[0]!.titleElements = ["🎓".repeat(1000)];
  const before = evaluateAudit(a),
    title = before.rules.find((r) => r.ruleId === "E02")!;
  expect(title.evidence).toBe("🎓".repeat(512));
  expect(title.evidenceRefs).toContainEqual({
    source: "receipt",
    requestedUrl: home,
    fields: ["acquiredAt", "sha256"],
  });
  Object.assign(a.pages[0]!, { acquiredAt: "2030-01-01T00:00:00Z" });
  expect(evaluateAudit(a)).toEqual(before);
});
it("complete-noindex requires full usable acquisition, declared intent and complete applicable directives", () => {
  const a = audit(),
    p = a.pages[0]!;
  p.metadata!.headers!.directives = [{ agent: "googlebot", value: "noindex" }];
  p.bodyComplete = false;
  expect(evaluateAudit(a).score).toBe(0);
  delete p.metadata!.rendered;
  expect(evaluateAudit(a).score).not.toBe(0);
  p.metadata!.rendered = metadata();
  p.metadata!.headers!.directives = [{ agent: "Otherbot", value: "noindex" }];
  expect(evaluateAudit(a).score).not.toBe(0);
  p.robotsGoogleAllowed = false;
  expect(evaluateAudit(a).score).not.toBe(0);
  p.metadata!.headers!.directives = [{ agent: "robots", value: "none" }];
  delete a.pageDeclarations![0]!.indexingIntent;
  expect(evaluateAudit(a).score).not.toBe(0);
  a.pageDeclarations![0]!.indexingIntent = "indexable";
  a.manifest.push(about);
  expect(evaluateAudit(a).score).not.toBe(0);
});
it("duplicate-final-url preserves both requested identities and denominator", () => {
  const a = audit();
  a.manifest.push(about);
  a.pages.push({ ...page(about), finalUrl: home });
  const result = evaluateAudit(a);
  expect(result.duplicateDestinations).toEqual([
    { finalUrl: home, requestedUrls: [home, about] },
  ]);
  expect(result.manifest).toEqual([home, about]);
  expect(result.rules).toHaveLength(32);
});
const distribution: { category: Category; outcome: Outcome }[] = [
  { category: "discovery", outcome: "PASS" },
  { category: "extractability", outcome: "WARNING" },
  { category: "answer", outcome: "FAIL" },
  { category: "entity", outcome: "PASS" },
];
it("rounds once: 62.5 → 63; all-na-category renormalizes 42.5/80 → 53", () => {
  expect(aggregateReadiness(distribution, 1, 1, true).score).toBe(63);
  expect(
    aggregateReadiness(
      [
        ...distribution.slice(0, 3),
        { category: "entity", outcome: "NOT_APPLICABLE" },
      ],
      1,
      1,
      true,
    ),
  ).toMatchObject({ score: 53, categoryCoverage: { entity: null } });
});
it("empty-category blocks the headline, all N/A has no active denominator", () => {
  expect(
    aggregateReadiness(
      [...distribution.slice(0, 3), { category: "entity", outcome: "UNKNOWN" }],
      1,
      1,
      true,
    ),
  ).toMatchObject({
    score: null,
    categoryCoverage: { entity: 0 },
    categoryScores: { entity: null },
  });
  expect(
    aggregateReadiness(
      [{ category: "entity", outcome: "NOT_APPLICABLE" }],
      1,
      1,
      true,
    ).score,
  ).toBeNull();
});
it("partial-79-percent independently gates page and applicable-weight coverage", () => {
  expect(aggregateReadiness(distribution, 15, 19, true).score).toBeNull(); // 78.95%, displayed as 79%
  expect(aggregateReadiness(distribution, 4, 5, true).score).toBe(63);
  expect(aggregateReadiness(distribution, 4, 5, false).score).toBeNull();
  for (const percent of [79, 80]) {
    const rules = Array.from({ length: 100 }, (_, i) => ({
      category: "answer" as const,
      outcome: i < percent ? ("PASS" as const) : ("UNKNOWN" as const),
    }));
    expect(aggregateReadiness(rules, 1, 1, true)).toMatchObject({
      coverage: percent / 100,
      score: percent === 80 ? 100 : null,
    });
  }
});
it("distinguishes every comparable outcome transition", () => {
  const base = evaluateAudit(audit());
  const outcomes: Outcome[] = [
    "PASS",
    "WARNING",
    "FAIL",
    "UNKNOWN",
    "NOT_APPLICABLE",
  ];
  for (const before of outcomes)
    for (const after of outcomes) {
      const run = (outcome: Outcome) => ({
        ...base,
        rules: [{ ...base.rules[0]!, outcome }],
      });
      const delta = compareAudits(run(before), run(after));
      const buckets = Object.entries(delta)
        .filter(([, v]) => Array.isArray(v) && v.length)
        .map(([k]) => k);
      const expected =
        before === "UNKNOWN" ||
        before === "NOT_APPLICABLE" ||
        after === "UNKNOWN" ||
        after === "NOT_APPLICABLE"
          ? ["unevaluated"]
          : before === "PASS"
            ? after === "PASS"
              ? []
              : ["new"]
            : after === "PASS"
              ? ["resolved"]
              : before === after
                ? ["persistent"]
                : before === "FAIL"
                  ? ["improved"]
                  : ["worsened"];
      expect(buckets, before + " → " + after).toEqual(expected);
    }
});
it("removed-page-not-fixed, new sampled pages and incompatible rules/profiles stay unevaluated", () => {
  const initial = audit();
  const before = evaluateAudit(initial);
  initial.manifest.push(about);
  initial.pages.push({ ...page(about), status: 404 });
  const after = evaluateAudit(initial);
  const added = compareAudits(before, after),
    removed = compareAudits(after, before);
  expect(added.new).toEqual([]);
  expect(added.unevaluated.some((r) => r.scopeKey === about)).toBe(true);
  expect(added.scoreDelta).toBeNull();
  expect(removed.resolved).toEqual([]);
  expect(removed.scoreDelta).toBeNull();
  for (const changed of [
    { ...after, profile: "other" },
    { ...after, methodologyVersion: "readiness-v1" as const },
  ]) {
    expect(compareAudits(after, changed).unevaluated).toHaveLength(
      after.rules.length,
    );
    expect(compareAudits(after, changed).scoreDelta).toBeNull();
  }
  const incompatible = {
    ...before,
    rules: before.rules.map((r) =>
      r.ruleId === "E02"
        ? { ...r, ruleVersion: "3", outcome: "FAIL" as const }
        : r,
    ),
  };
  expect(compareAudits(before, incompatible)).toMatchObject({
    new: [],
    scoreDelta: null,
  });
  expect(
    compareAudits(before, incompatible).unevaluated.some(
      (r) => r.ruleId === "E02",
    ),
  ).toBe(true);
});
it("changed expectations cannot masquerade as fixes; unrelated technical fixes remain comparable", () => {
  const a = audit();
  a.contextRevisionId = "one";
  a.pageDeclarations![0]!.intendedCanonical = about;
  a.pages[0]!.titleElements = [""];
  a.brandName = "Unknown";
  a.approvedAliases = [];
  const before = evaluateAudit(a);
  a.contextRevisionId = "two";
  delete a.pageDeclarations![0]!.intendedCanonical;
  a.brandName = "Example";
  a.pages[0]!.titleElements = ["Example"];
  const after = evaluateAudit(a);
  const delta = compareAudits(before, after);
  expect(delta.resolved.map((r) => r.ruleId)).toEqual(["E02"]);
  expect(delta.unevaluated.map((r) => r.ruleId)).toEqual(
    expect.arrayContaining(["D03", "T01", "T03"]),
  );
  expect(delta.scoreDelta).toBeNull();
  expect([before.contextRevisionId, after.contextRevisionId]).toEqual([
    "one",
    "two",
  ]);
  a.pageDeclarations![0]!.indexingIntent = "excluded";
  const next = compareAudits(after, evaluateAudit(a));
  expect(next.unevaluated.map((r) => r.ruleId)).toEqual(
    expect.arrayContaining(["D02", "D04"]),
  );
  expect(next.scoreDelta).toBeNull();
});
it("admits exact regional/query/slash scope, rejects extra fields, malformed targets and excessive declarations", () => {
  const urls = [home, home + "en/?q=US", home + "en?q=US"];
  expect(
    validateDeclarations(
      {
        pageDeclarations: urls.map((requestedUrl) => ({
          requestedUrl,
          intendedCanonical: "http://external.example/",
        })),
      },
      urls,
      new URL(home).origin,
    ).pageDeclarations?.map((d) => d.requestedUrl),
  ).toEqual(urls);
  for (const d of [
    {
      pageDeclarations: [{ requestedUrl: home, intendedCanonical: "garbage" }],
    },
    { pageDeclarations: [{ requestedUrl: about }] },
    { aboutUrl: "https://other.example/" },
    { pageDeclarations: [{ requestedUrl: home }, { requestedUrl: home }] },
    { bodyComplete: true },
    { pageDeclarations: [{ requestedUrl: home, metadata: {} }] },
    { approvedAliases: Array(21).fill("x") },
  ])
    expect(() => validateDeclarations(d, urls, new URL(home).origin)).toThrow(
      "INVALID_AUDIT_INPUT",
    );
});

it.each([
  ["mailto:team@example.com", "Email us", "PASS", "LINKS_NAMED"],
  ["mailto:team@example.com", "", "FAIL", "UNNAMED_LINK"],
  ["tel:+1-212-555-0184", "Call us", "PASS", "LINKS_NAMED"],
  ["tel:+1-212-555-0184", "", "FAIL", "UNNAMED_LINK"],
  ["#pricing", "", "FAIL", "UNNAMED_LINK"],
  ["javascript:alert(1)", "Contact", "NOT_APPLICABLE", "NO_LINKS"],
  ["mailto:not-an-address", "Contact", "NOT_APPLICABLE", "NO_LINKS"],
  ["mailto:?subject=Hello", "New email", "PASS", "LINKS_NAMED"],
  ["tel:garbage", "Contact", "NOT_APPLICABLE", "NO_LINKS"],
])("E04 navigation %s with name %j", (href, name, outcome, reasonCode) => {
  const a = audit();
  a.pages[0]!.linkNames = [{ href: href!, name: name! }];
  expect(evaluateAudit(a).rules.find((r) => r.ruleId === "E04")).toMatchObject({
    outcome,
    reasonCode,
  });
});
it("non-HTTP anchors never supply sampled incoming, contact or policy URLs", () => {
  const a = audit();
  a.manifest.push(about);
  a.pages.push(page(about));
  a.pages[0]!.linkNames = [
    { name: "Contact", href: "mailto:team@example.com" },
    { name: "Policy", href: "tel:+12125550184" },
  ];
  const rules = evaluateAudit(a).rules;
  for (const id of ["D05", "T02", "T04"])
    expect(rules.find((r) => r.ruleId === id)?.outcome).toBe("WARNING");
});
it.each([
  ["A02", "BODY_UNAVAILABLE"],
  ["A03", "BODY_UNAVAILABLE"],
  ["T01", "VISIBLE_TEXT_UNAVAILABLE"],
])("stale rendered arrays cannot pass %s", (id, reasonCode) => {
  const a = audit();
  a.pages[0]!.bodyComplete = false;
  expect(evaluateAudit(a).rules.find((r) => r.ruleId === id)).toMatchObject({
    outcome: "UNKNOWN",
    reasonCode,
  });
});
it.each(["A04", "T02", "T03", "T04"])(
  "changed %s declaration prevents a headline while independent E02 resolves",
  (id) => {
    const a = audit(),
      p = a.pages[0]!;
    p.titleElements = [];
    if (id === "A04") {
      p.byline = "";
      a.pageDeclarations![0]!.pageType = "marketing";
    }
    if (id === "T02") {
      p.detectedLanguage = "fr";
      a.aboutUrl = policy + "-other";
    }
    if (id === "T03") {
      p.jsonLd = ['{"@type":"Organization","url":"https://official.example/"}'];
    }
    if (id === "T04") {
      a.requiredPolicyUrls = [policy + "-other"];
    }
    const before = evaluateAudit(a);
    p.titleElements = ["Example"];
    if (id === "A04") a.pageDeclarations![0]!.pageType = "article";
    if (id === "T02") a.aboutUrl = about;
    if (id === "T03") a.officialUrls = ["https://official.example/"];
    if (id === "T04") a.requiredPolicyUrls = [policy];
    const after = evaluateAudit(a),
      delta = compareAudits(before, after);
    // Even an N/A-to-warning transition must suppress the headline on a type change.
    expect([before.score, after.score].every((v) => v !== null)).toBe(true);
    expect(delta.resolved.map((r) => r.ruleId)).toEqual(["E02"]);
    expect(delta.new).toEqual([]);
    expect(delta.unevaluated.some((r) => r.ruleId === id)).toBe(true);
    expect(delta.scoreDelta).toBeNull();
  },
);

it("a named HTTP link cannot mask an unnamed mailto anchor", () => {
  const a = audit();
  a.pages[0]!.linkNames.push({ name: "", href: "mailto:team@example.com" });
  expect(evaluateAudit(a).rules.find((r) => r.ruleId === "E04")).toMatchObject({
    outcome: "FAIL",
    reasonCode: "UNNAMED_LINK",
    evidence: "mailto:team@example.com",
  });
});
