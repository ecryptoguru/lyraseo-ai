import {
  expect,
  test as base,
  type Page,
  type TestInfo,
} from "@playwright/test";

export { expect };
export const test = base.extend<{ consoleHealth: string[] }>({
  consoleHealth: [
    async ({ page }, use, testInfo) => {
      const diagnostics: string[] = [];
      page.on("pageerror", (error) => diagnostics.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()))
          diagnostics.push(`${message.type()}: ${message.text()}`);
      });
      await use(diagnostics);
      await testInfo.attach("browser-diagnostics", {
        body: JSON.stringify(diagnostics),
        contentType: "application/json",
      });
      expect(diagnostics).toEqual([]);
    },
    { auto: false },
  ],
});

// Compare with the configured viewport: mobile innerWidth can expand with overflow.
export async function expectHistoryWithinViewport(
  page: Page,
  testInfo: TestInfo,
  evidence: string,
  diagnostics: readonly string[],
) {
  expect(diagnostics).toEqual([]);
  const viewport = page.viewportSize()!;
  const buttons = page.locator(".audit-history .button");
  await expect(buttons.first()).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page).toHaveTitle(/Lyraseo/i);
  await expect(page.locator("main h1")).toBeVisible();
  const fontSize = await buttons
    .first()
    .evaluate((button) => parseFloat(getComputedStyle(button).fontSize));
  for (const scale of [1, 2]) {
    const style = await page.addStyleTag({
      content: `.audit-history .button { font-size: ${fontSize * scale}px; }`,
    });
    const metrics = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      dpr: devicePixelRatio,
      buttons: Array.from(
        document.querySelectorAll(".audit-history .button"),
      ).map((button) => {
        const rect = button.getBoundingClientRect();
        const card = button.closest(".pilot-card")!.getBoundingClientRect();
        return {
          label: button.textContent,
          left: rect.left,
          right: rect.right,
          cardLeft: card.left,
          cardRight: card.right,
          clientWidth: button.clientWidth,
          scrollWidth: button.scrollWidth,
        };
      }),
    }));
    await testInfo.attach(`${evidence}-${scale}x-metrics`, {
      body: JSON.stringify({ viewport, ...metrics }, null, 2),
      contentType: "application/json",
    });
    const png = await page.screenshot({
      path: `../../output/playwright/${evidence}-${testInfo.project.name}-${scale}x.png`,
      fullPage: true,
    });
    expect(metrics.clientWidth).toBe(viewport.width);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
    for (const button of metrics.buttons) {
      expect(
        button.left,
        button.label ?? "history label",
      ).toBeGreaterThanOrEqual(Math.max(0, button.cardLeft));
      expect(button.right, button.label ?? "history label").toBeLessThanOrEqual(
        Math.min(viewport.width, button.cardRight) + 1,
      );
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
    }
    expect(png.readUInt32BE(16)).toBe(Math.round(viewport.width * metrics.dpr));
    for (const button of await buttons.all()) {
      await expect(button).toHaveAccessibleName(
        (await button.innerText()).replace(/\s+/g, " ").trim(),
      );
      await button.focus();
      await expect(button).toBeFocused();
    }
    await style.evaluate((element) => element.remove());
  }
}
