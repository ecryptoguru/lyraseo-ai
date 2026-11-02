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
  expect(output.csv.split("\r\n")).toHaveLength(2);
  expect(output.csv).not.toContain("Immutable audit comparison");
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

it("exports the frozen comparison in full and visibly distinguishes resolved from unevaluated evidence", async () => {
  const { comparisonReportLines } =
    await import("../../apps/lyraseo-web/src/server/editorial/reports");
  const rule = {
    ruleId: "D01",
    ruleVersion: "2",
    scopeKey: "https://example.com/missing",
    category: "discovery" as const,
    outcome: "FAIL" as const,
    priority: "high" as const,
    reasonCode: "HTTP_ERROR",
    evidenceRefs: [
      {
        source: "receipt" as const,
        requestedUrl: "https://example.com/missing",
        fields: ["status"],
      },
    ],
  };
  const run = {
    auditId: "before",
    createdAt: "2026-11-01T00:00:00Z",
    methodologyVersion: "readiness-v2",
    profile: "LOCAL_RAW_V1",
    manifest: [rule.scopeKey],
    declarations: { contextRevision: 2 },
  };
  const comparison = {
    before: run,
    after: { ...run, auditId: "after", createdAt: "2026-11-02T00:00:00Z" },
    compatible: true,
    profileComparable: true,
    result: {
      resolved: [rule],
      new: [],
      persistent: [],
      improved: [],
      worsened: [],
      unevaluated: [
        {
          ...rule,
          scopeKey: "https://example.com/unreadable",
          outcome: "UNKNOWN" as const,
          reasonCode: "ACQUISITION_UNAVAILABLE",
        },
      ],
      scoreDelta: null,
    },
    counts: {
      resolved: 1,
      new: 0,
      persistent: 0,
      improved: 0,
      worsened: 0,
      unevaluated: 1,
    },
  };
  const snapshot = {
    capturedAt: run.createdAt,
    scope: { workspaceId: "a", siteId: "s" },
    methodology: "saved",
    context: null,
    internalLinks: [],
    sources: [],
    comparison,
  } as EvidenceSnapshot;
  const sources = [
    {
      sourceId: "audit:before",
      kind: "raw-http-audit",
      data: { evaluation: { rules: [rule] } },
    },
    {
      sourceId: "audit:after",
      kind: "raw-http-audit",
      data: {
        evaluation: {
          rules: [{ ...rule, outcome: "PASS", reasonCode: "HTML_ACQUIRED" }],
        },
      },
    },
  ];
  const lines = comparisonReportLines(comparison, sources).join("\n");
  expect(lines).toContain(
    "Before: FAIL (HTTP_ERROR) -> After: PASS (HTML_ACQUIRED)",
  );
  expect(lines).toContain("HTTP receipt (status)");
  expect(lines).toContain("Before: audit:before");
  expect(lines).toContain("After: audit:after");
  expect(lines).toContain("Resolved: 1");
  expect(lines).toContain("Unevaluated: 1");
  expect(lines).toContain("Resolved | D01 v2 | https://example.com/missing");
  expect(lines).toContain("HTTP_ERROR");
  expect(lines).toContain(
    "Unevaluated | D01 v2 | https://example.com/unreadable",
  );
  expect(lines).toContain("Before sources:");
  expect(lines).toContain("cannot prove a fix");
  expect(lines).toContain("not available");
  const report = await renderEvidenceReport("Private", snapshot);
  expect(report.csv).toContain(csvCell("Immutable audit comparison"));
  expect(report.csv).toContain(csvCell(JSON.stringify(comparison)));
  expect(comparisonReportLines(undefined)).toEqual([]);
  const large = {
    ...comparison,
    result: {
      ...comparison.result,
      resolved: Array.from({ length: 101 }, (_, index) => ({
        ...rule,
        scopeKey: `https://example.com/${index}`,
      })),
    },
    counts: { ...comparison.counts, resolved: 101 },
  };
  expect(comparisonReportLines(large).join("\n")).toContain("100 of 102");
  const full = await renderEvidenceReport("Large", {
    ...snapshot,
    comparison: large,
  });
  expect(full.csv).toContain("https://example.com/100");
});
