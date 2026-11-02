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
      provenance: {
        sha256: "a".repeat(64),
        acquiredAt: "2026-11-02T00:00:00Z",
      },
    },
  ],
  evaluation: {
    score: null,
    coverage: 0.4,
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
  let created = false,
    reviewed = false;
  await page.route("**/api/audits**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: new URL(route.request().url()).searchParams.has("auditId")
          ? run
          : created
            ? [run]
            : [],
      });
    const input = route.request().postDataJSON();
    if (input.action === "create") {
      created = true;
      return route.fulfill({ json: { id: "audit", status: "QUEUED" } });
    }
    if (input.action === "review") {
      reviewed = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: run });
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
  await page
    .getByRole("button", { name: "Confirm pages and start audit" })
    .click();
  await expect(
    page.getByText("Insufficient evidence for an overall score", {
      exact: false,
    }),
  ).toBeVisible();
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
    route.fulfill({ json: [run] }),
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
  await expect(
    page.getByRole("button", { name: "Confirm pages and start audit" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark reviewed" })).toHaveCount(
    0,
  );
});
