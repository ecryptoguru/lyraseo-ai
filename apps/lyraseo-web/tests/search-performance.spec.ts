import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const rootRequire = createRequire(resolve("../../package.json"));
const viteRequire = createRequire(
  createRequire(rootRequire.resolve("vitest/package.json")).resolve(
    "vite/package.json",
  ),
);
const { build } = viteRequire("esbuild");
async function renderBundle(editable: boolean, collectionEnabled = true) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {SearchPerformance} from './src/components/search-performance';createRoot(document.querySelector('#search-fixture')).render(<SearchPerformance workspaceId="a" siteId="site" editable={${editable}} collectionEnabled={${collectionEnabled}}/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}
const evidence = {
  connection: { property: "https://example.com/" },
  imports: [],
  coverage: "Available provider rows only. Some searches are omitted.",
  opportunities: [
    {
      kind: "best-observed-page",
      query: "example product",
      page: "https://example.com/",
      explanation: "Inspect a page ranking at position eight.",
      evidence: { snapshotId: "snapshot", position: 8 },
    },
  ],
  snapshots: [
    {
      id: "snapshot",
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      shape: "page",
      status: "partial",
      importedAt: "2026-11-02T00:00:00Z",
      rowCount: 120,
      rowsTruncated: true,
      rows: [
        {
          keys: ["https://example.com/"],
          clicks: 0,
          impressions: 0,
          ctr: null,
          position: null,
        },
      ],
    },
  ],
};
const history = [
  {
    id: "failed",
    property: "https://example.com/",
    startDate: "2026-10-02",
    endDate: "2026-10-22",
    shape: "query,page",
    status: "failed",
    startedAt: "2026-11-02T00:00:00Z",
    completedAt: "2026-11-02T00:01:00Z",
    failure: "GOOGLE_RECONNECT_REQUIRED",
    recoverable: true,
    snapshotStatus: null,
  },
  {
    id: "stalled",
    property: "https://example.com/",
    startDate: "2026-09-01",
    endDate: "2026-09-28",
    shape: "date",
    status: "running",
    startedAt: "2026-11-01T00:00:00Z",
    completedAt: null,
    failure: null,
    recoverable: true,
    snapshotStatus: null,
  },
  {
    id: "partial",
    property: "https://example.com/",
    startDate: "2026-10-01",
    endDate: "2026-10-28",
    shape: "page",
    status: "complete",
    startedAt: "2026-10-31T00:00:00Z",
    completedAt: "2026-10-31T00:01:00Z",
    failure: null,
    recoverable: false,
    snapshotStatus: "partial",
  },
  {
    id: "active",
    property: "https://example.com/",
    startDate: "2026-10-03",
    endDate: "2026-10-23",
    shape: "query",
    status: "running",
    startedAt: "2026-11-02T00:02:00Z",
    completedAt: null,
    failure: null,
    recoverable: false,
    snapshotStatus: null,
  },
];
async function reopenFixture(
  page: Page,
  editable = true,
  collectionEnabled = true,
) {
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Saved search status</h1><div id="search-fixture"></div>';
  });
  await page.addScriptTag({
    content: await renderBundle(editable, collectionEnabled),
  });
  await expect(
    page.getByRole("heading", { name: "Recent import status" }),
  ).toBeVisible();
}
test("reopens failed and stalled imports without dispatch and retries the exact saved window and shape", async ({
  page,
}, testInfo) => {
  const posts: unknown[] = [];
  await page.route("**/api/keywords**", (route) =>
    route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } }),
  );
  await page.route("**/api/search**", (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({
        status: 409,
        json: { error: "GOOGLE_IMPORT_RUNNING" },
      });
    }
    return route.fulfill({ json: { ...evidence, imports: history } });
  });
  await reopenFixture(page);
  await reopenFixture(page);
  await expect(
    page.getByText("Failed — this attempt", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Lease expired — import stalled", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Completed with partial coverage", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Running — this window", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Saved search evidence" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh import status" }).click();
  const searchStatus = page
    .getByRole("region", { name: "Search Console connection" })
    .getByRole("status");
  await expect(searchStatus).toContainText("No import was started");
  await expect(
    page
      .getByRole("region", { name: "Keyword enrichment" })
      .getByRole("status"),
  ).toHaveText("Saved keyword selections could not load. Refresh to retry.");
  expect(posts).toEqual([]);
  const failed = page.getByRole("listitem").filter({
    has: page.getByRole("heading", {
      name: "2026-10-02–2026-10-22 · query,page",
    }),
  });
  await failed.getByRole("button", { name: "Retry this window" }).click();
  await expect(searchStatus).toContainText("An import is already running");
  expect(posts).toEqual([
    {
      workspaceId: "a",
      siteId: "site",
      startDate: "2026-10-02",
      endDate: "2026-10-22",
      shape: "query,page",
    },
  ]);
  await expect(page.getByLabel("Start date")).toHaveValue("2026-10-02");
  await expect(page.getByLabel("End date")).toHaveValue("2026-10-22");
  await expect(
    page.getByRole("heading", { name: "Saved search evidence" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/search-import-status-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
for (const mode of ["viewer", "paused"] as const) {
  test(`${mode} reads saved failed and stalled status without retry; paused manager can disconnect`, async ({
    page,
  }) => {
    const posts: string[] = [];
    await page.route("**/api/search**", (route) => {
      if (route.request().method() === "POST") posts.push("import");
      return route.fulfill({ json: { ...evidence, imports: history } });
    });
    await page.route("**/api/integrations/google", (route) => {
      posts.push(route.request().postDataJSON().action);
      return route.fulfill({ json: {} });
    });
    await reopenFixture(page, mode !== "viewer", mode !== "paused");
    await expect(
      page.getByText("Lease expired — import stalled", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry this window" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh import status" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "No import was started" }),
    ).toBeVisible();
    expect(posts).toEqual([]);
    if (mode === "paused") {
      await page
        .getByRole("button", { name: "Disconnect and remove imported data" })
        .click();
      await expect(
        page.getByRole("status").filter({ hasText: "Google disconnected" }),
      ).toBeVisible();
      expect(posts).toEqual(["disconnect"]);
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  });
}
test("search evidence shows partial coverage and preserves dates after import failure", async ({
  page,
}, testInfo) => {
  await page.route("**/api/keywords**", (route) =>
    route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } }),
  );
  await page.route("**/api/search**", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          json: { error: "GOOGLE_RECONNECT_REQUIRED" },
        })
      : route.fulfill({ json: evidence }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled search fixture</h1><div id="search-fixture"></div>';
  });
  await page.addScriptTag({ content: await renderBundle(true) });
  await expect(
    page.getByText("Showing the first 100 rows", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Unavailable", exact: true }),
  ).toHaveCount(2);
  await page.getByLabel("Start date").fill("2026-10-01");
  await page.getByLabel("End date").fill("2026-10-28");
  await page.getByRole("button", { name: "Import selected window" }).click();
  await expect(
    page
      .getByRole("region", { name: "Search Console connection" })
      .getByRole("status"),
  ).toContainText("Reconnect Search Console");
  await expect(
    page
      .getByRole("region", { name: "Keyword enrichment" })
      .getByRole("status"),
  ).toHaveText("Saved keyword selections could not load. Refresh to retry.");
  await expect(page.getByLabel("Start date")).toHaveValue("2026-10-01");
  await expect(
    page.getByRole("heading", { name: "Opportunities to inspect" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/search-performance-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("viewer sees evidence without Google connection or import controls", async ({
  page,
}) => {
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: evidence }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled search viewer</h1><div id="search-fixture"></div>';
  });
  await page.addScriptTag({ content: await renderBundle(false) });
  await expect(
    page.getByRole("heading", { name: "Saved search evidence" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Search Console" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Import selected window" }),
  ).toHaveCount(0);
});

test("withheld legacy search correlation keeps independent observations and never implies clean audit findings", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let empty = false;
  await page.route("**/api/search**", (route) =>
    route.fulfill({
      json: {
        ...evidence,
        auditEvidenceStatus: "legacy-lineage-withheld",
        opportunities: empty ? [] : evidence.opportunities,
      },
    }),
  );
  await reopenFixture(page, false);
  await expect(
    page.getByText("Audit-derived search opportunities are withheld", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "best observed page" }),
  ).toBeVisible();
  empty = true;
  await reopenFixture(page, false);
  await expect(
    page.getByText("Audit-derived search opportunities are withheld", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No opportunities meet the current observed-data rules.", {
      exact: false,
    }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/legacy-search-withheld-r1-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("shows the measured query-page CTR with its source and limitations", async ({
  page,
}) => {
  const { buildSearchOpportunities } =
    await import("../../../packages/visibility/src/search");
  const opportunities = buildSearchOpportunities([
    {
      id: "pair-snapshot",
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
        },
        {
          keys: ["long-query-" + "x".repeat(500), "https://example.com/long"],
          impressions: 100,
          clicks: 1,
          position: 3,
        },
      ],
    },
  ]);
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { ...evidence, opportunities } }),
  );
  await reopenFixture(page, false);
  const item = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "low observed query ctr" }),
    hasText: "buy widgets",
  });
  await expect(item).toContainText("buy widgets");
  await expect(item).toContainText("https://example.com/widgets");
  await expect(item).toContainText(
    "do not represent the query's property-wide totals",
  );
  await expect(item).toContainText("Partial");
  await expect(item).toContainText("2026-10-01–2026-10-28");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await item.getByText("Source evidence and thresholds").click();
  await expect(item).toContainText('"ctr": 0.01');
  await expect(item).toContainText('"status": "partial"');
  await expect(item).toContainText("pair-snapshot");
});
