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
async function bundle() {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {ApiAccess} from './src/components/api-access';createRoot(document.querySelector('#access-fixture')).render(<ApiAccess workspaceId="a" sites={[{id:"site",origin:"https://example.com"}]}/>);`,
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
test("credential secret is shown once, dismissed and immediately revocable", async ({
  page,
}) => {
  const secret = "lyra_controlled_fixture_only";
  let command: Record<string, unknown> = {};
  const token = {
    id: "token",
    name: "Research assistant",
    siteIds: ["site"],
    scopes: ["sites:read"],
    createdAt: "2026-11-02T00:00:00Z",
    expiresAt: "2026-12-02T00:00:00Z",
    revokedAt: null,
  };
  await page.route("**/api/tokens**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { tokens: [] } });
    command = route.request().postDataJSON();
    return route.fulfill({
      json: command.action === "create" ? { token, secret } : { revoked: true },
    });
  });
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled API access fixture</h1><div id="access-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle() });
  await page
    .getByLabel("Credential name", { exact: true })
    .fill("Research assistant");
  await page.getByLabel("https://example.com", { exact: true }).check();
  await page
    .getByRole("button", { name: "Create read-only credential", exact: true })
    .click();
  await expect(
    page.getByLabel("One-time credential secret", { exact: true }),
  ).toHaveValue(secret);
  expect(command.siteIds).toEqual(["site"]);
  expect(command.scopes).toEqual(["sites:read"]);
  expect(command.expiresInDays).toBe(30);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page
    .getByRole("button", { name: "Dismiss secret", exact: true })
    .click();
  await expect(
    page.getByLabel("One-time credential secret", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Revoke Research assistant", exact: true })
    .click();
  expect(command).toEqual({
    workspaceId: "a",
    action: "revoke",
    tokenId: "token",
  });
  await expect(page.getByRole("status")).toContainText("revoked");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
test("fresh-auth failure preserves credential selections and provides sign-in recovery", async ({
  page,
}) => {
  await page.route("**/api/tokens**", (route) =>
    route.fulfill(
      route.request().method() === "GET"
        ? { json: { tokens: [] } }
        : {
            status: 401,
            json: {
              code: "FRESH_AUTH_REQUIRED",
              error: "Sign in again with fresh authentication.",
            },
          },
    ),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Credential recovery fixture</h1><div id="access-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle() });
  await page
    .getByLabel("Credential name", { exact: true })
    .fill("Saved selection");
  await page.getByLabel("https://example.com", { exact: true }).check();
  await page
    .getByRole("button", { name: "Create read-only credential", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Sign in again", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Credential name", { exact: true })).toHaveValue(
    "Saved selection",
  );
  await expect(
    page.getByLabel("https://example.com", { exact: true }),
  ).toBeChecked();
});
