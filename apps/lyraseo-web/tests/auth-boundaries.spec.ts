import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("unconfigured sign-in is honest, accessible and collects no credentials", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await expect(
    page.getByRole("heading", { name: "Your workspace, by invitation." }),
  ).toBeVisible();
  await expect(
    page.getByText("Authentication and email delivery aren’t connected"),
  ).toBeVisible();
  await expect(page.locator("input")).toHaveCount(0);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
  await expect(
    page.getByRole("link", { name: "Explore the local sample" }),
  ).toBeVisible();
});
test("authenticated account endpoint never accepts forged identity headers", async ({
  request,
}) => {
  const result = await request.get("/api/account", {
    headers: {
      "x-user-id": "owner",
      "x-workspace-id": "a",
      authorization: "Bearer synthetic-test-token",
    },
  });
  expect(result.status()).toBe(503);
  expect(await result.json()).toEqual({ error: "AUTH_UNAVAILABLE" });
  expect(result.headers()["cache-control"]).toContain("no-store");
});
test("private data and security pages require sign-in even on loopback", async ({
  page,
}) => {
  await page.goto("/app/workspaces");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/app/security");
  await expect(page).toHaveURL(/\/sign-in$/);
});
test("sign-in keeps approved branding readable in dark theme", async ({
  page,
  context,
}, testInfo) => {
  await context.addCookies([
    { name: "lyraseo-theme", value: "dark", url: "http://127.0.0.1:3000" },
  ]);
  await page.goto("/sign-in");
  await expect(page.locator(".logo-on-dark")).toBeVisible();
  await expect(page.locator(".logo-on-light")).toBeHidden();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: `../../output/playwright/sign-in-dark-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
