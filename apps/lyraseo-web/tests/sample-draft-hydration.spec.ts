import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("sample draft preserves edits after delayed Next hydration", async ({
  page,
}, testInfo) => {
  const initialDraft =
    "Example brings project plans, team updates and shared decisions into one clear workspace.";
  const reviewedDraft = "My reviewed draft";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Hold the real Next scripts, leaving the server-rendered workspace visible.
  // No component fixture or replacement hydration code participates in this test.
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  let heldScripts = 0;
  await page.route(/\/_next\/.*\.js(?:\?.*)?$/, async (route) => {
    heldScripts += 1;
    await scriptsReady;
    await route.continue();
  });

  try {
    await page.goto("/app/content", { waitUntil: "commit" });
    const editor = page.getByRole("textbox", { name: "Product introduction" });
    const exportDraft = page.getByRole("button", { name: "Export draft" });
    await expect(editor).toBeVisible();
    expect(heldScripts).toBeGreaterThan(0);
    await expect(editor).toHaveValue(initialDraft);
    // The scripts are gated, so these snapshots cannot become ready by waiting.
    expect.soft(await editor.isDisabled()).toBe(true);
    expect.soft(await exportDraft.isDisabled()).toBe(true);
    expect.soft(await editor.getAttribute("aria-busy")).toBe("true");
    expect
      .soft(await page.getByRole("status").allTextContents())
      .toEqual(["Preparing sample editor…"]);

    // A real pointer/keyboard attempt against the SSR editor must not accept
    // changes that React initialization would later overwrite.
    await editor.scrollIntoViewIfNeeded();
    const bounds = await editor.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + 15);
    await page.keyboard.insertText("Premature edit");
    expect.soft(await editor.inputValue()).toBe(initialDraft);
    await page.screenshot({
      path: testInfo.outputPath("sample-editor-before-hydration.png"),
      fullPage: true,
    });

    releaseScripts();
    await expect(editor).toBeEnabled();
    expect.soft(await editor.getAttribute("aria-busy")).toBe("false");
    await expect(page.getByText("Preparing sample editor…")).toHaveCount(0);
    await expect(exportDraft).toBeEnabled();
    await expect(editor).toHaveValue(initialDraft);
    await editor.fill(reviewedDraft);
    await expect(editor).toHaveValue(reviewedDraft);
    await expect(page.locator(".editor-footer")).toContainText(
      "17 characters · Browser session only",
    );

    const downloadPromise = page.waitForEvent("download");
    await exportDraft.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("sample-product-draft.md");
    expect(await readFile((await download.path())!, "utf8")).toBe(
      reviewedDraft,
    );
    expect(errors).toEqual([]);
  } finally {
    releaseScripts();
  }
});
