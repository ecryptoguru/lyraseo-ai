import { expect, it } from "vitest";
import {
  csvCell,
  renderEvidenceReport,
} from "../../apps/lyraseo-web/src/server/editorial/reports";
import type { EvidenceSnapshot } from "../../packages/db/src/content";
it("neutralizes spreadsheet formulas including whitespace and control prefixes", () => {
  for (const text of ["=1+1", " +SUM(1)", "\t@cmd", "\r-2"])
    expect(csvCell(text)).toBe("\"'" + text + '"');
  expect(csvCell('a"b')).toBe('"a""b"');
});
it("renders local structured private evidence to valid PDF and CSV without executing HTML", async () => {
  const snapshot: EvidenceSnapshot = {
    capturedAt: "2026-11-02T00:00:00.000Z",
    scope: { workspaceId: "a", siteId: "s" },
    methodology: "raw HTTP; rendered DOM unobserved",
    context: { revision: 1 },
    internalLinks: [],
    sources: [
      {
        sourceId: "audit:1",
        kind: "raw-http",
        data: {
          text: '<script>fetch("https://evil.invalid")</script>',
          coverage: "partial",
        },
      },
    ],
  };
  const output = await renderEvidenceReport("=Private evidence", snapshot);
  expect(Buffer.from(output.pdf).subarray(0, 5).toString()).toBe("%PDF-");
  expect(output.csv).toContain('"\'=Private evidence"');
  expect(output.csv).toContain("partial");
  expect(output.pdf.length).toBeGreaterThan(1000);
});

it("exports frozen v2 rule versions, category coverage and receipt provenance with the report", async () => {
  const source = {
    methodologyVersion: "readiness-v2",
    profile: "LOCAL_RAW_V1",
    declarations: { contextRevision: 3 },
    evaluation: {
      score: null,
      coverage: 0.25,
      categoryCoverage: { discovery: 0.25, entity: null },
      rules: [
        {
          ruleId: "D01",
          ruleVersion: "2",
          scopeKey: "https://example.com/",
          outcome: "FAIL",
          reasonCode: "HTTP_ERROR",
          evidence: "404",
          evidenceRefs: [
            {
              source: "receipt",
              requestedUrl: "https://example.com/",
              fields: ["acquiredAt"],
            },
          ],
        },
      ],
    },
    pages: [
      {
        url: "https://example.com/",
        receipt: { acquiredAt: "2026-11-01T00:00:00Z", status: 404 },
      },
    ],
  };
  const snapshot: EvidenceSnapshot = {
    capturedAt: "2026-11-02T00:00:00Z",
    scope: { workspaceId: "a", siteId: "s" },
    methodology: "Saved original HTTP",
    context: { revision: 4 },
    internalLinks: [],
    sources: [{ sourceId: "audit:1", kind: "raw-http-audit", data: source }],
  };
  const report = await renderEvidenceReport("Readiness", snapshot);
  expect(report.csv).toContain(csvCell(JSON.stringify(source)));
  expect(Buffer.from(report.pdf).subarray(0, 5).toString()).toBe("%PDF-");
});
