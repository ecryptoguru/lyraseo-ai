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
const content = {
  audience: "",
  positioning: "",
  conversionGoal: "",
  brandName: "Original",
  approvedAliases: [],
  competitors: [],
  keyPages: [],
  supportedClaims: [],
  editorialPreferences: "",
};
const revision = {
  id: "first",
  revision: 1,
  content,
  reviewedBy: "reviewer",
  reviewedAt: "2026-11-02T00:00:00Z",
};
async function bundle(editable: boolean) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import {SiteSettings} from './src/components/site-settings'; createRoot(document.querySelector('#site-fixture')).render(<SiteSettings workspaceId="a" siteId="site" editable={${editable}} manager={${editable}} enabled={true} initialRevisions={${JSON.stringify([revision])}} verifiedAt={null}/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    plugins: [
      {
        name: "fixture-navigation",
        setup(builder: {
          onResolve: (
            options: { filter: RegExp },
            callback: () => object,
          ) => void;
          onLoad: (
            options: { filter: RegExp; namespace: string },
            callback: () => object,
          ) => void;
        }) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "navigation",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const useRouter = () => ({push(){}, refresh(){}})",
            loader: "js",
          }));
        },
      },
    ],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}
test("site settings preserves a conflicting draft, reviews history and verifies only the issued challenge", async ({
  page,
}) => {
  let saved = false,
    verified = false;
  await page.route("**/api/sites**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: [{ ...revision, id: "second", revision: 2 }, revision],
      });
    const input = route.request().postDataJSON();
    if (input.action === "challenge")
      return route.fulfill({
        json: {
          id: "challenge",
          token: "t".repeat(43),
          url: "https://example.com/.well-known/lyraseo-verification.txt",
          expiresAt: "2026-11-03T00:00:00Z",
        },
      });
    if (input.action === "verify") {
      expect(input.challengeId).toBe("challenge");
      expect(input.token).toBeUndefined();
      verified = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (input.expectedRevision === 1)
      return route.fulfill({
        status: 409,
        json: { error: "A newer revision exists. Your draft was not saved." },
      });
    expect(input.content.brandName).toBe("Updated");
    expect(input.content.approvedAliases).toEqual(["Alias"]);
    saved = true;
    return route.fulfill({
      json: { ...revision, id: "third", revision: 3, content: input.content },
    });
  });
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Site settings fixture</h1><div id="site-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await page.getByLabel("Brand name", { exact: true }).fill("Unsaved");
  await page.getByRole("button", { name: "Save reviewed context" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "newer revision",
  );
  await expect(page.getByLabel("Brand name", { exact: true })).toHaveValue(
    "Unsaved",
  );
  await page
    .getByRole("button", { name: "Refresh history, keep draft" })
    .click();
  await expect(
    page.getByText("Current revision: 2.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Brand name", { exact: true })).toHaveValue(
    "Unsaved",
  );
  await page
    .getByRole("button", { name: "Replace draft with current revision" })
    .click();
  await page.getByLabel("Brand name", { exact: true }).fill("Updated");
  await page.getByLabel("Approved aliases", { exact: false }).fill("Alias\n");
  await page.getByRole("button", { name: "Save reviewed context" }).click();
  await expect.poll(() => saved).toBe(true);
  await page.getByRole("button", { name: "Issue new challenge" }).click();
  await expect(page.getByLabel("One-time token")).toHaveValue("t".repeat(43));
  await page.getByRole("button", { name: "Verify published file" }).click();
  await expect.poll(() => verified).toBe(true);
  await expect(page.getByLabel("One-time token")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
test("viewer reads history without mutation controls", async ({ page }) => {
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Site settings fixture</h1><div id="site-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(false) });
  await page.getByText("Revision 1 ·", { exact: false }).click();
  await expect(page.getByText("Original", { exact: true })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
});
