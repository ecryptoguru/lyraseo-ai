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
