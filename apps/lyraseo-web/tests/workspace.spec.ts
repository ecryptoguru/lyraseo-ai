import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("landing and audit work on desktop and mobile", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A clearer view. A better next move." }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `../../output/playwright/landing-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Explore the sample audit" }).click();
  await expect(
    page.getByRole("heading", { name: "Review your audit" }),
  ).toBeVisible();
  await expect(
    page.getByText("This workspace uses synthetic evidence"),
  ).toBeVisible();
  await page.getByRole("button", { name: /Page title is empty/ }).click();
  await expect(
    page.getByRole("heading", { name: "Page title is empty" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Mark reviewed", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mark unreviewed" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Guidance" }).click();
  await expect(
    page.getByRole("heading", { name: "What to check" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Evidence" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `../../output/playwright/audit-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("sample rerun changes only the explicitly selected fixture", async ({
  page,
}) => {
  await page.goto("/app/audits");
  await page.getByRole("button", { name: "Rerun sample audit" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("checkbox", {
      name: "Simulate publishing a descriptive product title",
    })
    .check();
  await page.getByRole("button", { name: "Run local evaluation" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: /Page title is empty/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Review the canonical destination/ }),
  ).toBeVisible();
});
test("search and export remain useful without any provider", async ({
  page,
}) => {
  await page.goto("/app/audits");
  await page
    .getByRole("textbox", { name: "Search findings" })
    .fill("no matching issue");
  await expect(
    page.getByRole("heading", { name: "No matching findings" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(
    page.getByRole("button", { name: /Page title is empty/ }),
  ).toBeVisible();
  await page.goto("/app/reports");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect((await download).suggestedFilename()).toBe("lyraseo-sample-audit.csv");
  await page.goto("/app/content");
  await page
    .getByRole("textbox", { name: "Product introduction" })
    .fill("My reviewed draft");
  await expect(
    page.getByRole("textbox", { name: "Product introduction" }),
  ).toHaveValue("My reviewed draft");
});
test("every retained navigation surface renders an honest local state", async ({
  page,
}) => {
  for (const route of [
    "overview",
    "sites",
    "issues",
    "content",
    "visibility",
    "search",
    "reports",
    "settings",
  ]) {
    await page.goto(`/app/${route}`);
    await expect(page.locator("main h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto("/sign-in");
  await expect(
    page.getByText("No sign-in details are collected here."),
  ).toBeVisible();
});
test("dialog focus is contained and restored; themes are accessible", async ({
  page,
}, testInfo) => {
  await page.goto("/app/audits");
  await page.getByRole("button", { name: "Rerun sample audit" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Rerun sample audit" }),
  ).toBeFocused();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByLabel("Color theme").selectOption("dark");
  if (testInfo.project.name === "mobile") {
    await page
      .getByRole("button", { name: "Close navigation", exact: true })
      .first()
      .click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // Measure settled theme colors, not an intermediate hover/theme transition.
  await page.locator(".workspace").evaluate(async (element) => {
    getComputedStyle(element).color;
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `../../output/playwright/dark-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("mobile drawer contains keyboard focus and closes on settings navigation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Drawer is mobile-only");
  await page.goto("/app/audits");
  await page.getByRole("button", { name: "Open navigation" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Close navigation", exact: true }).first(),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  await expect(page.locator(".sidebar")).not.toBeVisible();
});
test("narrow layouts keep content inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const route of ["audits", "settings", "search", "content"]) {
    await page.goto(`/app/${route}`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("private APIs reject a non-loopback hostname", async ({ request }) => {
  const response = await request.get("/api/health", {
    headers: { host: "untrusted.example" },
  });
  expect(response.status()).toBe(503);
});
