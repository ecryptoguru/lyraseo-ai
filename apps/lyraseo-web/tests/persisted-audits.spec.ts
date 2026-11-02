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
async function bundle(editable: boolean) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import {PersistedAudits} from './src/components/persisted-audits'; createRoot(document.querySelector('#audit-fixture')).render(<PersistedAudits workspaceId="a" siteId="site" origin="https://example.com" editable={${editable}} enabled={true}/>);`,
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
const run = {
  id: "audit",
  status: "COMPLETED",
  createdAt: "2026-11-02T00:00:00Z",
  manifest: ["https://example.com/"],
  pages: [
    {
      requestedUrl: "https://example.com/",
      sourceAvailability: "expired",
      provenance: {
        sha256: "a".repeat(64),
        acquiredAt: "2026-11-02T00:00:00Z",
      },
    },
  ],
  evaluation: {
    score: null,
    coverage: 0.4,
    methodologyVersion: "readiness-v1",
    rules: [
      {
        ruleId: "E02",
        outcome: "FAIL",
        scopeKey: "https://example.com/",
        reasonCode: "EMPTY_TITLE",
      },
    ],
  },
};
test("saved audit component captures, inspects and reviews evidence accessibly", async ({
  page,
}, testInfo) => {
  let submitted: Record<string, unknown> = {};
  const v2 = () => ({
    ...run,
    declarations: submitted,
    methodologyVersion: "readiness-v2",
    evaluation: {
      ...run.evaluation,
      methodologyVersion: "readiness-v2",
      categoryCoverage: { discovery: 0.25, entity: null },
      rules: [
        {
          ruleId: "D01",
          scopeKey: run.manifest[0],
          outcome: "FAIL",
          reasonCode: "HTTP_ERROR",
          ruleVersion: "2",
          evidence: "404",
          evidenceRefs: [
            {
              source: "receipt",
              requestedUrl: run.manifest[0],
              fields: ["status"],
            },
          ],
        },
      ],
    },
  });
  let created = false,
    reviewed = false;
  await page.route("**/api/audits**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: new URL(route.request().url()).searchParams.has("auditId")
          ? v2()
          : created
            ? [v2()]
            : [],
      });
    const input = route.request().postDataJSON();
    if (input.action === "create") {
      created = true;
      submitted = input.declarations;
      return route.fulfill({ json: { id: "audit", status: "QUEUED" } });
    }
    if (input.action === "review") {
      reviewed = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: v2() });
  });
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled audit fixture</h1><div id="audit-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await expect(
    page.getByText("Your first saved audit will appear here."),
  ).toBeVisible();
  await page.getByText("Review optional audit declarations").click();
  await page.getByLabel("Contact page URL").fill("https://example.com/contact");
  await page.getByLabel("Intended indexing").selectOption("indexable");
  await page.getByLabel("Page type", { exact: true }).selectOption("article");
  await page
    .getByLabel("Expected canonical URL")
    .fill("https://example.com/en/?q=UK");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/audit-declarations-expanded-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Confirm pages and start audit" })
    .click();
  await expect(
    page.getByText("Insufficient evidence for an overall score", {
      exact: false,
    }),
  ).toBeVisible();
  expect(submitted).toEqual({
    contactUrl: "https://example.com/contact",
    pageDeclarations: [
      {
        requestedUrl: "https://example.com/",
        indexingIntent: "indexable",
        pageType: "article",
        intendedCanonical: "https://example.com/en/?q=UK",
      },
    ],
  });
  await expect(page.getByText("readiness-v2", { exact: false })).toBeVisible();
  await expect(page.getByText("discovery: 25% coverage")).toBeVisible();
  await page.getByRole("button", { name: "Rerun the same pages" }).click();
  await expect(
    page.getByLabel("Confirm up to 25 pages", { exact: false }),
  ).toBeFocused();
  await expect(page.getByRole("link", { name: "Export CSV" })).toBeVisible();
  await page
    .getByLabel("Reason for your next review action")
    .fill("Title fix assigned to editor.");
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await expect.poll(() => reviewed).toBe(true);
  await expect(
    page.getByText("Review recorded.", { exact: false }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/persisted-audits-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("viewer can inspect saved audits without mutation controls", async ({
  page,
}) => {
  await page.route("**/api/audits**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).searchParams.has("auditId")
        ? run
        : [run],
    }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled viewer fixture</h1><div id="audit-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(false) });
  await expect(
    page.getByText(
      "Your site access allows viewing and exporting saved audits.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: /completed/i }).click();
  await page
    .locator("summary")
    .filter({ hasText: "https://example.com/" })
    .click();
  await expect(page.getByText("Original source expired.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download retained UTF-8 source" }),
  ).toHaveCount(0);
  await expect(page.getByText("readiness-v1", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm pages and start audit" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark reviewed" })).toHaveCount(
    0,
  );
});

test("retained original bytes, decoded legacy source and unavailable capture are distinguished", async ({
  page,
}, info) => {
  const retained = {
    ...run.pages[0],
    requestedUrl: "https://example.com/",
    sourceAvailability: "current",
    sourceRepresentation: "original-body",
  };
  const missing = {
    ...run.pages[0],
    requestedUrl: "https://example.com/missing",
    sourceAvailability: "unavailable",
  };
  const current = {
    ...run,
    id: "private-audit",
    methodologyVersion: "readiness-v2",
    manifest: [retained.requestedUrl, missing.requestedUrl],
    pages: [retained, missing],
    evaluation: {
      ...run.evaluation,
      methodologyVersion: "readiness-v2",
      rules: [],
    },
  };
  const decoded = {
    ...run,
    id: "legacy-audit",
    createdAt: "2026-10-12T00:00:00Z",
    pages: [{ ...retained, sourceRepresentation: "stored-utf8" }],
  };
  await page.route("**/api/audits**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("auditId");
    return route.fulfill({
      json:
        id === null
          ? [current, decoded]
          : id === current.id
            ? current
            : decoded,
    });
  });
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled source receipt fixture</h1><div id="audit-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(false) });
  const history = page.getByRole("button", { name: /completed/i });
  await history.nth(1).click();
  await page
    .locator("summary")
    .filter({ hasText: retained.requestedUrl })
    .click();
  await expect(
    page.getByRole("link", { name: "Download retained UTF-8 source" }),
  ).toBeVisible();
  await history.first().click();
  for (const item of current.pages) {
    const details = page
      .locator("details")
      .filter({ has: page.getByText(item.requestedUrl, { exact: true }) });
    if ((await details.getAttribute("open")) === null)
      await details.locator("summary").click();
  }
  await expect(
    page.getByRole("link", { name: "Download original response body" }),
  ).toHaveAttribute("href", /format=source.*url=/);
  await expect(page.getByText("Original source unavailable.")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByText("Original source unavailable.").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../output/build-2026-11-02/private-artifact-${info.project.name}.png`,
  });
});
