import { expect, it, vi } from "vitest";

// Exercise actual read assembly with a controlled transaction; authorization is covered separately.
vi.mock("../../packages/db/src/context", () => ({
  withEvidenceRead: async (
    _db: unknown,
    _actor: unknown,
    _scope: unknown,
    _action: unknown,
    _permission: unknown,
    work: (tx: unknown) => unknown,
  ) => work(transaction),
  isTokenActor: () => false,
}));
vi.mock("../../packages/db/src/legacy-inline", () => ({
  lockLegacyInlineRead: async () => false,
}));

const urls = Array.from(
  { length: 100 },
  (_, i) => `https://example.com/page-${i}`,
);
const current = {
  id: "page-snapshot",
  shape: "page",
  property: "https://example.com/",
  startDate: "2026-10-01",
  endDate: "2026-10-28",
  status: "complete",
  rows: urls.map((url) => ({
    keys: [url],
    impressions: 100,
    clicks: 5,
    position: 3,
  })),
};
const detail = {
  ...current,
  id: "query-snapshot",
  shape: "query,page",
  rows: [
    {
      keys: ["buy widgets", urls[0]],
      impressions: 100,
      clicks: 1,
      position: 3,
    },
  ],
};
const audits = Array.from({ length: 4 }, (_, i) => {
  const manifest = urls.slice(i * 25, (i + 1) * 25);
  return {
    id: `audit-${i}`,
    createdAt: new Date("2026-10-29"),
    manifest,
    storageFormat: "AUDIT_PRIVATE_V1",
    evaluation: {
      rules: manifest.map((url) => ({
        scopeKey: url,
        ruleId: "title",
        outcome: "FAIL",
      })),
    },
  };
});
const transaction = {
  googleConnection: { findFirst: vi.fn(async () => null) },
  searchImport: { findMany: vi.fn(async () => []) },
  $queryRaw: vi.fn(async () => []),
  searchSnapshot: { findMany: vi.fn(async () => [detail, current]) },
  auditRun: { findMany: vi.fn(async () => audits) },
};

it("keeps query opportunities visible after the search read combines many audit matches", async () => {
  const { readGoogleSearch } = await import("../../packages/db/src/gsc");
  const result = await readGoogleSearch({} as never, {} as never, {
    workspaceId: "ws",
    siteId: "site",
  });
  expect(result.opportunities).toHaveLength(100);
  expect(
    result.opportunities.some((item) => item.kind === "demand-and-audit"),
  ).toBe(true);
  expect(
    result.opportunities.some((item) => item.kind === "low-observed-query-ctr"),
  ).toBe(true);
});
