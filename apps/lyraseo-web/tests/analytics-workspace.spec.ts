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
async function bundle(manageable: boolean) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {AnalyticsWorkspace} from './src/components/analytics-workspace';createRoot(document.querySelector('#analytics-fixture')).render(<AnalyticsWorkspace workspaceId="a" siteId="site" manageable={${manageable}}/>);`,
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
const saved = {
  configured: true,
  connection: {
    property: "properties/123",
    streamId: "456",
    timeZone: "Asia/Kolkata",
    status: "connected",
  },
  properties: [],
  coverage:
    "Available provider rows only; restricted data remains unavailable.",
  snapshots: [
    {
      id: "import",
      property: "properties/123",
      streamId: "456",
      timeZone: "Asia/Kolkata",
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      status: "partial",
      failure: null,
      rowCount: 1,
      rows: [
        {
          date: "2026-10-01",
          rawLandingPage: "(not set)",
          normalizedUrl: null,
          unavailableReason: "missing_landing_page",
          sessions: 4,
          engagedSessions: 1,
          sessionKeyEventRate: null,
        },
      ],
      diagnostics: { thresholded: true },
      stale: false,
    },
  ],
  opportunityOutcomes: [
    {
      query: "product",
      page: "https://example.com/product",
      explanation: "Observed query demand",
      conversionEvidence: {
        status: "unavailable",
        reason: "incompatible_window",
      },
    },
  ],
};
async function mount(
  page: import("@playwright/test").Page,
  manageable: boolean,
) {
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled Analytics fixture</h1><div id="analytics-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(manageable) });
}
test("Analytics preserves partial and unmatched evidence, dates after revoked access, and never invents homepage outcomes", async ({
  page,
}, testInfo) => {
  let command: unknown;
  await page.route("**/api/analytics**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: saved });
    command = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: { error: "ANALYTICS_RECONNECT_REQUIRED" },
    });
  });
  await mount(page, true);
  await expect(
    page.getByRole("cell", { name: "(not set)", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "missing_landing_page", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Outcome evidence unavailable: Date windows or timezones differ.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByLabel("Start date", { exact: true }).fill("2026-10-01");
  await page.getByLabel("End date", { exact: true }).fill("2026-10-28");
  await page
    .getByRole("button", { name: "Import organic landing pages", exact: true })
    .click();
  expect(command).toEqual({
    workspaceId: "a",
    siteId: "site",
    startDate: "2026-10-01",
    endDate: "2026-10-28",
  });
  await expect(page.getByRole("status")).toContainText("revoked or expired");
  await expect(page.getByLabel("Start date", { exact: true })).toHaveValue(
    "2026-10-01",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/analytics-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("viewer reads optional missing Analytics without connection or import controls", async ({
  page,
}) => {
  await page.route("**/api/analytics**", (route) =>
    route.fulfill({
      json: {
        ...saved,
        configured: false,
        connection: null,
        snapshots: [],
        opportunityOutcomes: [],
      },
    }),
  );
  await mount(page, false);
  await expect(
    page.getByText(
      "No Analytics imports yet. This is unmeasured, not zero sessions.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Analytics", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Import organic landing pages",
      exact: true,
    }),
  ).toHaveCount(0);
});
