import { expect, it } from "vitest";
import {
  buildSearchOpportunities,
  type SearchSnapshot,
} from "../../packages/visibility/src/search";
const snapshot = (
  rows: unknown,
  patch: Partial<SearchSnapshot> = {},
): SearchSnapshot => ({
  id: "current",
  shape: "query,page",
  rows,
  startDate: "2026-10-01",
  endDate: "2026-10-28",
  status: "complete",
  ...patch,
});
const row = (
  page: string,
  position: number,
  impressions = 200,
  clicks = 1,
) => ({ keys: ["query", page], position, impressions, clicks, ctr: 1 });
it("does not promote a secondary page when the best observed page already ranks highly", () => {
  const result = buildSearchOpportunities([
    snapshot([
      row("https://example.com/best", 2),
      row("https://example.com/secondary", 8),
    ]),
  ]);
  expect(result.map((item) => item.kind)).toEqual(["query-overlap"]);
});
it("considers the best low-impression page before the opportunity threshold", () => {
  expect(
    buildSearchOpportunities([
      snapshot([
        row("https://example.com/best", 2, 1),
        row("https://example.com/secondary", 8),
      ]),
    ]).some((item) => item.kind === "best-observed-page"),
  ).toBe(false);
});
it("retains source, window, position and coverage caveat with an eligible opportunity", () => {
  const result = buildSearchOpportunities([
    snapshot([row("https://example.com/a", 8)]),
  ]);
  expect(result[0]).toMatchObject({
    kind: "best-observed-page",
    evidence: { snapshotId: "current", position: 8, status: "complete" },
  });
});
it("recalculates CTR from counts and distinguishes zero impressions", () => {
  const result = buildSearchOpportunities([
    snapshot(
      [
        { ...row("unused", 5), keys: ["https://example.com/a"] },
        { ...row("unused", 0, 0), keys: ["https://example.com/empty"] },
      ],
      { shape: "page" },
    ),
  ]);
  expect(result).toHaveLength(1);
  expect(result[0]?.evidence.ctr).toBe(0.005);
});
it("compares compatible complete windows without treating missing pages as zero", () => {
  const now = snapshot(
    [{ ...row("unused", 5, 200, 5), keys: ["https://example.com/a"] }],
    { shape: "page" },
  );
  const before = snapshot(
    [
      { ...row("unused", 5, 200, 20), keys: ["https://example.com/a"] },
      {
        ...row("unused", 5, 200, 50),
        keys: ["https://example.com/disappeared"],
      },
    ],
    {
      id: "before",
      shape: "page",
      startDate: "2026-09-03",
      endDate: "2026-09-30",
    },
  );
  expect(
    buildSearchOpportunities([now, before]).filter(
      (item) => item.kind === "declining-clicks",
    ),
  ).toHaveLength(1);
  expect(
    buildSearchOpportunities([{ ...now, status: "partial" }, before]).filter(
      (item) => item.kind === "declining-clicks",
    ),
  ).toHaveLength(0);
});

it("correlates demand with exact latest-manifest failures without turning missing evidence into a defect", async () => {
  const { buildSearchAuditOpportunities } =
    await import("../../packages/visibility/src/search");
  const source = snapshot(
    [
      { ...row("unused", 8), keys: ["https://example.com/in?p=1"] },
      { ...row("unused", 8), keys: ["https://example.com/in?p=2"] },
      { ...row("unused", 8, 99), keys: ["https://example.com/low"] },
    ],
    { shape: "page" },
  );
  const old = {
    id: "old",
    createdAt: "2026-10-01",
    manifest: ["https://example.com/in?p=1"],
    evaluation: {
      rules: [
        {
          scopeKey: "https://example.com/in?p=1",
          ruleId: "title",
          outcome: "FAIL",
        },
      ],
    },
  };
  const current = {
    id: "latest",
    createdAt: "2026-10-02",
    manifest: ["https://example.com/in?p=1"],
    evaluation: {
      rules: [
        {
          scopeKey: "https://example.com/in?p=1",
          ruleId: "title",
          outcome: "UNKNOWN",
        },
      ],
    },
  };
  expect(buildSearchAuditOpportunities([source], [old, current])).toEqual([]);
  const result = buildSearchAuditOpportunities([source], [old]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    page: "https://example.com/in?p=1",
    kind: "demand-and-audit",
    evidence: { auditId: "old", ruleIds: ["title"], snapshotId: "current" },
  });
});
