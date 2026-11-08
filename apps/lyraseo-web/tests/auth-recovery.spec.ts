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
async function bundle(component: "enrollment" | "challenge") {
  const statement =
    component === "enrollment"
      ? "import {AuthenticatorEnrollment} from './src/components/authenticator-enrollment'; createRoot(document.querySelector('#recovery-fixture')).render(<AuthenticatorEnrollment hasAuthenticator={true} />);"
      : "import {SignInForm} from './src/components/sign-in-form'; createRoot(document.querySelector('#recovery-fixture')).render(<SignInForm mfa={true} />);";
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; ${statement}`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: {
      "@/app/app/security/actions": resolve(
        "tests/fixtures/recovery-actions.ts",
      ),
      "@/app/sign-in/actions": resolve("tests/fixtures/auth-actions.ts"),
    },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}
async function mount(
  page: import("@playwright/test").Page,
  component: "enrollment" | "challenge",
) {
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main, mode) => {
    main.className = mode === "enrollment" ? "pilot-page" : "auth-page";
    main.innerHTML =
      mode === "enrollment"
        ? '<div class="pilot-title"><h1>Authenticator recovery</h1></div><section class="pilot-card"><div id="recovery-fixture"></div></section>'
        : '<div class="auth-panel"><h1>Authenticator recovery</h1><div id="recovery-fixture"></div></div>';
  }, component);
  await page.addScriptTag({ content: await bundle(component) });
}
test("backup setup is explicit and confirmation errors remain usable", async ({
  page,
}, testInfo) => {
  await mount(page, "enrollment");
  await page.getByRole("button", { name: "Add backup authenticator" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "separate device or app",
  );
  await expect(
    page.getByRole("img", { name: /Authenticator setup QR code/ }),
  ).toBeVisible();
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Confirm authenticator" }).click();
  await expect(
    page.getByText("The authenticator could not be confirmed.", {
      exact: false,
    }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("backup.png"),
    fullPage: true,
  });
});
test("a lost primary leads to the existing backup challenge without suggesting a reset", async ({
  page,
}, testInfo) => {
  await mount(page, "challenge");
  await expect(page.getByRole("status")).toContainText(
    "No verified authenticator is available, or the list could not be loaded.",
  );
  await expect(page.getByRole("status")).toContainText(
    "Retry or sign in again.",
  );
  await expect(
    page.getByText(
      "New staff should enroll and verify an authenticator before a staff grant is assigned.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Self-service factor reset is not available.", {
      exact: false,
    }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("authenticator-unavailable.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Retry loading authenticators" })
    .click();
  await page.getByText("Lost access to your usual authenticator?").click();
  await expect(
    page.getByText("self-service factor recovery is not currently available.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Authenticator", { exact: true })
    .selectOption("backup");
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(page.getByText("Try a current code.")).toBeVisible();
  await expect(page.getByLabel("Authenticator", { exact: true })).toHaveValue(
    "backup",
  );
  await expect(page.getByLabel("Authenticator code")).toHaveValue("");
  await page.getByLabel("Authenticator code").fill("654321");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(page.getByLabel("Authenticator code")).toHaveValue("");
  await expect(page.getByLabel("Authenticator", { exact: true })).toHaveValue(
    "backup",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("challenge.png"),
    fullPage: true,
  });
});
