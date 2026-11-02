import { expect, it } from "vitest";
import * as retention from "../../packages/db/src/retention";

it("clamps forward UTC months and expires exactly at the stored millisecond", () => {
  const anchor = new Date("2024-01-31T22:45:12.345Z");
  const expiry = retention.addMonthsClamped(anchor, 13);
  expect(expiry.toISOString()).toBe("2025-02-28T22:45:12.345Z");
  expect(anchor.toISOString()).toBe("2024-01-31T22:45:12.345Z");
  expect(retention.readable(new Date(+expiry - 1), expiry)).toBe(true);
  expect(retention.readable(expiry, expiry)).toBe(false);
  expect(retention.readable(new Date(+expiry + 1), expiry)).toBe(false);
  expect(retention.readable(anchor, null)).toBe(false);
  expect(retention.readable(anchor, "invalid")).toBe(false);
});

it("bounds normalized Unicode excerpts across every audit and report while retaining all measured outcomes", async () => {
  const { projectSnapshot } =
    await import("../../packages/db/src/saved-evidence");
  const audit = (id: number) => ({
    kind: "raw-http-audit",
    sourceId: "audit:" + id,
    data: {
      evaluation: {
        rules: Array.from({ length: 7 }, (_, i) => ({
          ruleId: "D0" + i,
          scopeKey: "https://example.com/",
          outcome: "UNKNOWN",
          reasonCode: "MISSING_EVIDENCE",
          evidence: "😀".repeat(700),
          evidenceRefs: [
            { source: "page", fields: ["status", "PRIVATE_RAW_MARKER"] },
          ],
        })),
      },
    },
  });
  const captured = projectSnapshot({
    sources: Array.from({ length: 5 }, (_, id) => audit(id)),
  });
  const lengths = captured.sources.map((s) => {
    const data = s.data as {
      evaluation: {
        rules: { evidence?: string }[];
        outcomeCounts: { UNKNOWN: number };
        ruleCount: number;
      };
      truncatedExcerpts: number;
    };
    expect(data.evaluation.outcomeCounts.UNKNOWN).toBe(7);
    expect(data.evaluation.ruleCount).toBe(7);
    expect(data.truncatedExcerpts).toBe(7);
    return data.evaluation.rules.reduce((total, row) => {
      const n = Array.from(row.evidence ?? "").length;
      expect(n).toBeLessThanOrEqual(512);
      return n + total;
    }, 0);
  });
  expect(lengths).toEqual([2048, 2048, 2048, 2048, 0]);
  expect(JSON.stringify(captured)).not.toContain("PRIVATE_RAW_MARKER");
  expect(projectSnapshot(captured)).toEqual(captured);
});
it("withholds incoherent historical comparison labels without re-evaluating old measurements", async () => {
  const { projectSnapshot, categories } =
    await import("../../packages/db/src/saved-evidence");
  const reference = {
    auditId: "id",
    createdAt: "2025-01-01T00:00:00Z",
    profile: "raw-v1",
    methodologyVersion: "readiness-v1",
  };
  const comparison = {
    before: reference,
    after: { ...reference, auditId: "id2", profile: "other" },
    compatible: true,
    profileComparable: true,
    counts: Object.fromEntries(categories.map((k) => [k, 0])),
    result: {
      ...Object.fromEntries(categories.map((k) => [k, []])),
      scoreDelta: 5,
    },
  };
  const projected = projectSnapshot({ comparison });
  expect(projected.comparison).toBeUndefined();
  expect(projected.comparisonUnavailable).toBe(true);
});
it.each(["rule", "anchor"])(
  "reprojects a %s clipped on normalized whitespace without changing the saved fingerprint",
  async (kind) => {
    const { projectSnapshot } =
      await import("../../packages/db/src/saved-evidence");
    const audit = (id: number) => {
      const from = "https://example.com/",
        to = from + "about";
      const rule = (text: string, i: number) => ({
        ruleId: "D01",
        scopeKey: from,
        outcome: "UNKNOWN",
        reasonCode: "MISSING_EVIDENCE",
        evidence: text,
        priority: "high",
        category: "discovery",
        index: i,
      });
      const rules = [
        ...Array.from({ length: 4 }, (_, i) => rule("😀".repeat(500), i)),
        ...(kind === "rule" ? [rule("x".repeat(47) + "\u00a0more", 4)] : []),
      ];
      return {
        sourceId: "audit:" + id,
        kind: "raw-http-audit",
        data: { pages: [{ url: from }, { url: to }], evaluation: { rules } },
      };
    };
    const captured = projectSnapshot({
      sources: Array.from({ length: 5 }, (_, i) => audit(i)),
      internalLinks: Array.from({ length: 5 }, (_, i) => ({
        sourceUrl: "https://example.com/",
        url: "https://example.com/about",
        anchorText: "x".repeat(47) + "\u00a0more",
        basis: "audit:" + i + "; reference",
      })),
    });
    expect(projectSnapshot(captured)).toEqual(captured);
  },
);
