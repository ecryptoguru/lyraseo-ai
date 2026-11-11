import { expect, it } from "vitest";
import {
  buildSearchOpportunities,
  type SearchSnapshot,
} from "../../packages/visibility/src/search";

it("surfaces a low-CTR query and page from their own observed counts", () => {
  const snapshot: SearchSnapshot = {
    id: "query-page-window",
    property: "https://example.com/",
    shape: "query,page",
    startDate: "2026-10-01",
    endDate: "2026-10-28",
    status: "partial",
    rows: [
      {
        keys: ["buy widgets", "https://example.com/widgets"],
        impressions: 100,
        clicks: 1,
        position: 3,
        ctr: 0.9,
      },
      {
        keys: ["on threshold", "https://example.com/threshold"],
        impressions: 100,
        clicks: 2,
        position: 3,
      },
      {
        keys: ["too little", "https://example.com/small"],
        impressions: 99,
        clicks: 0,
        position: 3,
      },
      {
        keys: ["empty", "https://example.com/empty"],
        impressions: 0,
        clicks: 0,
        position: null,
      },
    ],
  };
  const result = buildSearchOpportunities([snapshot]).filter(
    (item) => item.kind === "low-observed-query-ctr",
  );
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    query: "buy widgets",
    page: "https://example.com/widgets",
    evidence: {
      snapshotId: "query-page-window",
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      status: "partial",
      clicks: 1,
      impressions: 100,
      ctr: 0.01,
      threshold: { minimumImpressions: 100, ctrBelow: 0.02 },
    },
  });
  expect(result[0]?.explanation).toContain("query and page");
  expect(result[0]?.evidence.limitations).toMatch(/omitted searches/i);
});

it("keeps existing declining-page opportunities visible with many eligible query-page rows", () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    keys: [`query ${i}`, `https://example.com/page-${i}`],
    impressions: 100,
    clicks: 0,
    position: 2,
  }));
  const common = { property: "https://example.com/", status: "complete" };
  const current: SearchSnapshot = {
    ...common,
    id: "current-page",
    shape: "page",
    startDate: "2026-10-01",
    endDate: "2026-10-28",
    rows: [
      {
        keys: ["https://example.com/declining"],
        impressions: 200,
        clicks: 5,
        position: 3,
      },
    ],
  };
  const prior: SearchSnapshot = {
    ...current,
    id: "previous-page",
    startDate: "2026-09-03",
    endDate: "2026-09-30",
    rows: [
      {
        keys: ["https://example.com/declining"],
        impressions: 200,
        clicks: 20,
        position: 3,
      },
    ],
  };
  const result = buildSearchOpportunities([
    { ...current, id: "pairs", shape: "query,page", rows },
    current,
    prior,
  ]);
  expect(result).toHaveLength(100);
  expect(result.some((item) => item.kind === "low-observed-query-ctr")).toBe(
    true,
  );
  expect(result.some((item) => item.kind === "declining-clicks")).toBe(true);
});
