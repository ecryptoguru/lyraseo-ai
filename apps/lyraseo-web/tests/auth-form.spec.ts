import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const rootRequire = createRequire(resolve("../../package.json"));
const viteRequire = createRequire(
  createRequire(rootRequire.resolve("vitest/package.json")).resolve(
    "vite/package.json",
  ),
);
const { build } = viteRequire("esbuild");
async function bundle(mfa: boolean) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import {SignInForm} from './src/components/sign-in-form'; createRoot(document.querySelector('.auth-panel')).render(<SignInForm mfa={${mfa}} />);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: {
      "@/app/sign-in/actions": resolve("tests/fixtures/auth-actions.ts"),
    },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}
test("email code errors preserve the form and Google has recoverable pending state", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.addScriptTag({ content: await bundle(false) });
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(
    page.getByRole("button", { name: "Connecting to Google…" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Google sign-in is unavailable. Use an email code."),
  ).toBeVisible();
  await page.getByLabel("Invited email address").fill("invited@example.com");
  await page.getByRole("button", { name: "Send email code" }).click();
  await page.getByLabel("Email code", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Verify email code" }).click();
  await expect(page.getByText("Check your code and try again.")).toBeVisible();
  await expect(page.getByLabel("Invited email address")).toHaveValue(
    "invited@example.com",
  );
  await expect(page.getByLabel("Email code", { exact: true })).toBeVisible();
});
test("MFA loading failures recover through retry with a usable factor selector", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.addScriptTag({ content: await bundle(true) });
  await page
    .getByRole("button", { name: "Retry loading authenticators" })
    .click();
  await page
    .getByLabel("Authenticator", { exact: true })
    .selectOption("backup");
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(page.getByText("Try a current code.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Start sign-in again" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
