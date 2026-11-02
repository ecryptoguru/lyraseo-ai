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
async function bundle(editable: boolean, pageId = "page") {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {PageWorkspace} from './src/components/page-workspace';createRoot(document.querySelector('#page-fixture')).render(<PageWorkspace workspaceId="a" siteId="site" origin="https://example.com" editable={${editable}} pageId="${pageId}"/>);`,
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
const detail = {
  page: {
    id: "page",
    originalUrl: "https://example.com/in/product?plan=team",
    normalizedUrl: "https://example.com/in/product?plan=team",
    revision: 1,
    assignedTo: null as string | null,
  },
  actor: { userId: "owner", canEdit: true },
  historyLimit: 100,
  history: [],
  context: { revision: 3 },
  audits: [
    {
      id: "audit",
      status: "COMPLETED",
      createdAt: "2026-11-02T00:00:00Z",
      methodologyVersion: "readiness-v1",
      pages: [
        {
          requestedUrl: "https://example.com/in/product?plan=team",
          evidence: { status: "unavailable" },
          provenance: { status: 403 },
        },
      ],
      findings: [
        { ruleId: "title", outcome: "UNKNOWN", reasonCode: "MISSING_EVIDENCE" },
      ],
    },
  ],
  search: { source: "Google Search Console", opportunities: [], snapshots: [] },
  drafts: [],
  reports: [],
  ai: {
    message:
      "AI observations remain site-level; no page-attributed presence is inferred.",
  },
};
async function mount(page: import("@playwright/test").Page, editable: boolean) {
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled page fixture</h1><div id="page-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(editable) });
}
test("page workspace preserves a stale note and reopens its evidence and assignment", async ({
  page,
}, testInfo) => {
  let saved = structuredClone(detail);
  let command: Record<string, unknown> = {};
  await page.route("**/api/pages**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: saved });
    command = route.request().postDataJSON();
    if (command.action === "change")
      return route.fulfill({
        status: 409,
        json: {
          error:
            "A newer revision exists. Reload the latest saved page after preserving your note.",
        },
      });
    saved = {
      ...saved,
      page: {
        ...saved.page,
        revision: 2,
        assignedTo: "owner",
      },
    };
    return route.fulfill({ json: { page: saved.page } });
  });
  await page.route("**/api/content**", (route) => route.fulfill({ json: [] }));
  await mount(page, true);
  await expect(
    page
      .getByText("https://example.com/in/product?plan=team", { exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Assign to me", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("assigned to you");
  await page
    .getByLabel("What changed on this page?", { exact: true })
    .fill("Added the missing product title.");
  await page
    .getByRole("button", { name: "Record change", exact: true })
    .click();
  expect(command.expectedRevision).toBe(2);
  await expect(page.getByRole("status")).toContainText("newer revision");
  await expect(
    page.getByLabel("What changed on this page?", { exact: true }),
  ).toHaveValue("Added the missing product title.");
  await expect(
    page.getByText("title · UNKNOWN", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("MISSING_EVIDENCE", { exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/page-workspace-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("viewer reads a stable page without mutation controls", async ({
  page,
}) => {
  await page.route("**/api/pages**", (route) =>
    route.fulfill({
      json: {
        ...detail,
        actor: { ...detail.actor, canEdit: false },
        history: [
          {
            id: "entry",
            revision: 2,
            action: "change",
            note: "Original journal note",
            userId: "owner",
            createdAt: "2025-01-01T12:00:00Z",
            contentDraftId: "draft",
            contentDraftRevision: 1,
          },
        ],
        drafts: [{ id: "draft", kind: "draft", revision: 2, history: [] }],
      },
    }),
  );
  await mount(page, false);
  await expect(
    page.getByText("Linked draft revision 1 · historical revision unavailable"),
  ).toBeVisible();
  await expect(page.getByText("Original journal note")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Audit evidence for this URL",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Assign to me", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("What changed on this page?", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("No retained opportunity evidence matches this URL.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("registration exposes the stable page link without starting acquisition", async ({
  page,
}) => {
  let registration: unknown;
  await page.route("**/api/pages**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { pages: [], limit: 100, siteLimit: 500 } });
    registration = route.request().postDataJSON();
    return route.fulfill({ json: detail.page });
  });
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Page registration fixture</h1><div id="page-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true, "") });
  await page
    .getByLabel("Exact page URL", { exact: true })
    .fill(detail.page.originalUrl);
  await page
    .getByRole("button", { name: "Register page", exact: true })
    .click();
  expect(registration).toEqual({
    workspaceId: "a",
    siteId: "site",
    action: "register",
    url: detail.page.originalUrl,
  });
  await expect(
    page.getByRole("link", { name: detail.page.normalizedUrl, exact: true }),
  ).toHaveAttribute("href", "/app/sites/site/pages/page?workspaceId=a");
  await expect(page.getByRole("status")).toContainText("Page registered");
});
