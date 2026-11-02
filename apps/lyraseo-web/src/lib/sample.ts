import {
  evaluateAudit,
  type AuditEvidence,
  type PageEvidence,
} from "@lyraseo/visibility";
export function sampleEvidence(fixed = false): AuditEvidence {
  const urls = [
    "https://example.com/",
    "https://example.com/product",
    "https://example.com/pricing",
  ];
  const pages: PageEvidence[] = urls.map((url, i) => ({
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: "text/html",
    acquired: true,
    headComplete: true,
    bodyComplete: true,
    titleElements:
      i === 1 && !fixed ? [""] : ["Example — thoughtful project management"],
    headingLevels: [1, 2],
    h1Texts: ["Bring your best work together"],
    headingTexts: [
      "Bring your best work together",
      "Built for considered teams",
    ],
    mainText:
      "Example helps small teams plan work, share updates and deliver projects.",
    canonicalUrls: [i === 2 ? "https://example.com/plans" : url],
    robotsGoogleAllowed: true,
    linkNames: urls.map((href) => ({
      href,
      name: href.endsWith("/") ? "About Example" : "Product details",
    })),
    jsonLd: [],
    pageType: "marketing",
    visibleText: "Example helps small teams plan their work.",
    populatedSections: [true, true],
    detectedLanguage: "en",
  }));
  return {
    siteOrigin: urls[0]!,
    brandName: "Example",
    manifest: urls,
    pages,
    methodologyVersion: "readiness-v1",
  };
}
export const sampleAudit = (fixed = false) =>
  evaluateAudit(sampleEvidence(fixed));
export const findingCopy: Record<
  string,
  { title: string; description: string; source: string; guidance: string }
> = {
  EMPTY_TITLE: {
    title: "Page title is empty",
    description:
      "The title element is present but contains no text. A descriptive title helps people identify this page.",
    source: "<title></title>",
    guidance:
      "Write a descriptive page title that names the product and the purpose of this page. Publish the change, then rerun the same scope.",
  },
  CANONICAL_NEEDS_REVIEW: {
    title: "Review the canonical destination",
    description:
      "This page points to a different canonical URL. That can be intentional; confirm which URL should represent this content.",
    source: '<link rel="canonical" href="https://example.com/plans">',
    guidance:
      "Confirm the intended canonical destination. Keep the current value if it correctly identifies the preferred page; otherwise update it and rerun.",
  },
  CONTACT_LINK_NOT_OBSERVED: {
    title: "About or contact link not observed",
    description:
      "No matching link was found in the sampled homepage navigation.",
    source: "No matching visible link in this sample.",
    guidance:
      "Review the homepage navigation and ensure useful company information is easy to find.",
  },
};
export function csvCell(value: string): string {
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function auditCsv(fixed = false): string {
  const a = sampleAudit(fixed);
  return [
    "Rule,Outcome,Page,Reason",
    ...a.rules.map((r) =>
      [r.ruleId, r.outcome, r.scopeKey, r.reasonCode].map(csvCell).join(","),
    ),
  ].join("\r\n");
}
