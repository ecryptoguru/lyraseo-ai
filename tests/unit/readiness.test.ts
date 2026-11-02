import { describe, expect, it } from "vitest";
import {
  evaluateAudit,
  compareAudits,
  normalizeUrl,
  type AuditEvidence,
  type PageEvidence,
} from "../../packages/visibility/src";
const page = (url = "https://example.com/"): PageEvidence => ({
  requestedUrl: url,
  finalUrl: url,
  status: 200,
  contentType: "text/html",
  acquired: true,
  headComplete: true,
  bodyComplete: true,
  titleElements: ["Example"],
  headingLevels: [1, 2],
  h1Texts: ["Example"],
  headingTexts: ["Example", "Useful features"],
  mainText: "Example makes useful software.",
  canonicalUrls: [url],
  robotsGoogleAllowed: true,
  linkNames: [{ name: "About", href: "https://example.com/about" }],
  jsonLd: [],
  pageType: "marketing",
  visibleText: "Example software",
  populatedSections: [true, true],
  detectedLanguage: "en",
});
const audit = (pages = [page()]): AuditEvidence => ({
  siteOrigin: "https://example.com/",
  brandName: "Example",
  pages,
  manifest: pages.map((p) => p.requestedUrl),
  methodologyVersion: "readiness-v1",
});
describe("public URL identity", () => {
  it.each([
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.0.0.1",
    "https://localhost",
    "https://metadata.google.internal",
    "https://169.254.169.254",
    "https://2130706433",
    "https://192.168.2.1",
  ])("rejects private destination %s", (url) =>
    expect(() => normalizeUrl(url)).toThrow(),
  );
  it("preserves path case, query order and trailing slash", () => {
    expect(normalizeUrl("https://EXAMPLE.com:443/A?b=2&a=1#x")).toBe(
      "https://example.com/A?b=2&a=1",
    );
    expect(normalizeUrl("https://example.com/a/")).not.toBe(
      normalizeUrl("https://example.com/a"),
    );
  });
  it("normalizes unreserved percent encodings", () =>
    expect(normalizeUrl("https://example.com/%7ehello")).toBe(
      "https://example.com/~hello",
    ));
});
describe("evidence and comparisons", () => {
  it("distinguishes an empty title from absence", () => {
    const p = page();
    p.titleElements = [""];
    expect(
      evaluateAudit(audit([p])).rules.find((r) => r.ruleId === "E02")
        ?.reasonCode,
    ).toBe("EMPTY_TITLE");
  });
  it("does not penalize absent JSON-LD", () =>
    expect(
      evaluateAudit(audit()).rules.find((r) => r.ruleId === "E05")?.outcome,
    ).toBe("NOT_APPLICABLE"));
  it("emits unknown rules for missing manifest pages", () => {
    const a = audit();
    a.manifest.push("https://example.com/docs");
    const result = evaluateAudit(a);
    expect(
      result.rules.some(
        (r) =>
          r.scopeKey === "https://example.com/docs" && r.outcome === "UNKNOWN",
      ),
    ).toBe(true);
    expect(result.score).toBeNull();
  });
  it("does not resolve an issue by dropping its page", () => {
    const p = page("https://example.com/docs");
    p.titleElements = [""];
    const before = evaluateAudit(audit([page(), p]));
    const after = evaluateAudit(audit());
    const delta = compareAudits(before, after);
    expect(delta.resolved).toHaveLength(0);
    expect(delta.unevaluated.some((r) => r.ruleId === "E02")).toBe(true);
    expect(delta.scoreDelta).toBeNull();
  });
  it("is deterministic without mutating inputs", () => {
    const a = audit();
    const saved = JSON.stringify(a);
    expect(evaluateAudit(a)).toEqual(evaluateAudit(a));
    expect(JSON.stringify(a)).toBe(saved);
  });
});

it("checks generic section headings beyond the H1", () => {
  const p = { ...page(), headingTexts: ["Example", "Section"] };
  expect(
    evaluateAudit(audit([p])).rules.find((r) => r.ruleId === "A03")?.outcome,
  ).toBe("WARNING");
});
it("does not pass heading/link rules on incomplete body evidence", () => {
  const a = audit([page(), page("https://example.com/docs")]);
  a.pages[1]!.bodyComplete = false;
  const result = evaluateAudit(a);
  expect(result.rules.find((r) => r.ruleId === "D05")?.outcome).toBe("UNKNOWN");
  expect(
    result.rules.find((r) => r.ruleId === "A03" && r.scopeKey.endsWith("/docs"))
      ?.outcome,
  ).toBe("UNKNOWN");
});
it("does not accept an invalid article modification date", () => {
  const p = page();
  p.pageType = "article";
  p.publishedDate = "2026-10-01";
  p.modifiedDate = "not-a-date";
  p.byline = "Example team";
  expect(
    evaluateAudit(audit([p])).rules.find((r) => r.ruleId === "A04")?.outcome,
  ).toBe("WARNING");
});

it("withholds the score when the homepage is unusable even if other pages meet coverage", () => {
  const pages = [
    page(),
    ...Array.from({ length: 9 }, (_, i) => page(`https://example.com/p${i}`)),
  ];
  pages[0]!.status = 500;
  expect(evaluateAudit(audit(pages)).score).toBeNull();
});
it("does not label incompatible methodology results as new issues", () => {
  const before = evaluateAudit(audit());
  const changed = page();
  changed.titleElements = [""];
  const after = {
    ...evaluateAudit(audit([changed])),
    methodologyVersion: "readiness-v2",
  };
  expect(compareAudits(before, after).new).toHaveLength(0);
});
