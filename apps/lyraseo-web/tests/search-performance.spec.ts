import { expect, test } from "@playwright/test";
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
async function renderBundle(editable: boolean) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {SearchPerformance} from './src/components/search-performance';createRoot(document.querySelector('#search-fixture')).render(<SearchPerformance workspaceId="a" siteId="site" editable={${editable}}/>);`,
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
test("search evidence shows partial coverage and preserves dates after import failure", async ({
  page,
}, testInfo) => {
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
  await expect(page.getByRole("status")).toContainText(
    "Reconnect Search Console",
  );
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
