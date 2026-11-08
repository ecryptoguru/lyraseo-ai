import { expect, test } from "./fixtures/history-viewport";
import AxeBuilder from "@axe-core/playwright";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const rootRequire = createRequire(resolve("../../package.json")),
  viteRequire = createRequire(
    createRequire(rootRequire.resolve("vitest/package.json")).resolve(
      "vite/package.json",
    ),
  ),
  { build } = viteRequire("esbuild");
async function mount(
  page: import("@playwright/test").Page,
  manager: boolean,
  enabled = true,
) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {ExternalHandoffs} from './src/components/external-handoffs';createRoot(document.querySelector('#handoff-fixture')).render(<ExternalHandoffs workspaceId="a" siteId="s" origin="https://example.com" manager={${manager}} editable={${manager}} enabled={${enabled}}/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled handoff fixture</h1><div id="handoff-fixture"></div>';
  });
  await page.addStyleTag({
    content: readFileSync(
      resolve("src/components/external-handoffs.css"),
      "utf8",
    ),
  });
  await page.addScriptTag({ content: result.outputFiles[0].text });
}
const destination = {
  id: "8ca3c636-6c64-4970-9b24-c19753d0312f",
  kind: "WORDPRESS",
  url: "https://example.com/blog/",
  generation: 1,
  revision: 1,
  status: "CONFIGURED",
  key_id: null,
  previous_key_id: null,
  previous_until: null,
  event_types: [],
};
const summary = {
  destinations: [destination],
  intents: [],
  qualification: { liveEnabled: false, state: "UNQUALIFIED" },
};
test("manager reviews the exact literal draft and saves a quarantined intent without sending", async ({
  page,
  consoleHealth,
}, testInfo) => {
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/content**", (route) =>
    route.fulfill({
      json: [
        {
          kind: "draft",
          history: [
            {
              id: "revision-1",
              revision: 1,
              content: { title: "Literal draft" },
            },
          ],
        },
      ],
    }),
  );
  await page.route("**/api/integrations/handoffs**", (route) => {
    if (route.request().method() === "POST") {
      commands.push(route.request().postDataJSON());
      return route.fulfill({
        json: { id: "intent-1", mode: "QUARANTINED", state: "PREPARED" },
      });
    }
    if (
      new URL(route.request().url()).searchParams.get("action") ===
      "wordpress.preview"
    )
      return route.fulfill({
        json: {
          title: "Literal draft",
          sourceBody: "<script>unsafe text stays text</script>",
          hash: "a".repeat(64),
          draftRevisionId: "revision-1",
          draftRevision: 1,
          destination,
        },
      });
    return route.fulfill({ json: summary });
  });
  await mount(page, true);
  await page.getByLabel("Saved page draft").selectOption("revision-1");
  await page.getByRole("button", { name: "Review outgoing draft" }).click();
  await expect(page.getByLabel("Literal draft text")).toHaveValue(
    "<script>unsafe text stays text</script>",
  );
  await page
    .getByRole("button", { name: "Save reviewed draft handoff intent" })
    .click();
  await expect(
    page.getByText(
      "Draft handoff intent saved in quarantine. No WordPress request was sent.",
    ),
  ).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    action: "wordpress.prepare",
    destinationId: destination.id,
    draftRevisionId: "revision-1",
    expectedBodyHash: "a".repeat(64),
    expectedDestinationGeneration: destination.generation,
    expectedDestinationUrl: destination.url,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(consoleHealth).toEqual([]);
  await page.screenshot({
    path: `../../output/handoffs/ui-review-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("viewer sees unresolved guidance and no destination or draft mutation controls", async ({
  page,
  consoleHealth,
}, testInfo) => {
  await page.route("**/api/content**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/integrations/handoffs**", (route) =>
    route.fulfill({
      json: {
        ...summary,
        intents: [
          {
            id: "intent",
            kind: "WORDPRESS",
            state: "UNRESOLVED",
            mode: "FIXTURE",
            attempt: 1,
            destination_url: "https://example.com/blog/",
            created_at: "2026-11-03T00:00:00Z",
            editor_url: null,
            last_code: "LOST_ACKNOWLEDGEMENT",
          },
        ],
      },
    }),
  );
  await mount(page, false);
  await expect(
    page.getByText(
      "Inspect WordPress manually. Do not create a replacement automatically.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByLabel("Literal draft text")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(consoleHealth).toEqual([]);
  await page.screenshot({
    path: `../../output/handoffs/ui-viewer-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("operator pause retains disconnect and reports a changed destination", async ({
  page,
}) => {
  const diagnostics: string[] = [];
  page.on("pageerror", (error) => diagnostics.push(error.message));
  let posts = 0;
  await page.route("**/api/content**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/integrations/handoffs**", (route) => {
    if (route.request().method() === "POST") {
      posts++;
      return route.fulfill({
        status: 409,
        json: { error: "Destination changed. Reload and review again." },
      });
    }
    return route.fulfill({ json: summary });
  });
  await mount(page, true, false);
  await expect(
    page.getByRole("button", { name: "Save WordPress destination" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Disconnect WordPress" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Disconnect WordPress" }).click();
  await expect(
    page.locator(".handoff-workspace").getByRole("alert"),
  ).toHaveText("Destination changed. Reload and review again.");
  expect(posts).toBe(1);
  expect(diagnostics).toEqual([]);
});

for (const change of ["installation", "reconnect"] as const) {
  test(`stale WordPress ${change} review cannot be saved until the browser reviews the current destination`, async ({
    page,
  }) => {
    let currentDestination = { ...destination },
      saved = 0;
    const submitted: Record<string, unknown>[] = [];
    await page.route("**/api/content**", (route) =>
      route.fulfill({
        json: [
          {
            kind: "draft",
            history: [
              {
                id: "revision-1",
                revision: 1,
                content: { title: "Literal draft" },
              },
            ],
          },
        ],
      }),
    );
    await page.route("**/api/integrations/handoffs**", (route) => {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        submitted.push(input);
        if (
          input.expectedDestinationGeneration !==
            currentDestination.generation ||
          input.expectedDestinationUrl !== currentDestination.url
        )
          return route.fulfill({
            status: 409,
            json: {
              error:
                "This review is out of date. Review the outgoing draft and destination again before saving.",
            },
          });
        saved++;
        return route.fulfill({
          json: {
            id: "reviewed-intent",
            mode: "QUARANTINED",
            state: "PREPARED",
          },
        });
      }
      if (
        new URL(route.request().url()).searchParams.get("action") ===
        "wordpress.preview"
      )
        return route.fulfill({
          json: {
            title: "Literal draft",
            sourceBody: "Same authored body",
            hash: "a".repeat(64),
            draftRevisionId: "revision-1",
            draftRevision: 1,
            destination: { ...currentDestination },
          },
        });
      return route.fulfill({
        json: { ...summary, destinations: [currentDestination] },
      });
    });
    await mount(page, true);
    await page.getByLabel("Saved page draft").selectOption("revision-1");
    await page.getByRole("button", { name: "Review outgoing draft" }).click();
    await expect(page.getByLabel("Literal draft text")).toHaveValue(
      "Same authored body",
    );
    currentDestination = {
      ...destination,
      generation: 2,
      revision: 2,
      url:
        change === "installation"
          ? "https://example.com/second/"
          : destination.url,
    };
    await page
      .getByRole("button", { name: "Save reviewed draft handoff intent" })
      .click();
    await expect(
      page.locator(".handoff-workspace").getByRole("alert"),
    ).toContainText("review is out of date");
    expect(saved).toBe(0);
    await expect(page.getByLabel("Literal draft text")).toHaveCount(0);
    await page.getByRole("button", { name: "Review outgoing draft" }).click();
    await expect(page.getByLabel("Literal draft text")).toHaveValue(
      "Same authored body",
    );
    await page
      .getByRole("button", { name: "Save reviewed draft handoff intent" })
      .click();
    await expect(
      page.getByText(
        "Draft handoff intent saved in quarantine. No WordPress request was sent.",
      ),
    ).toBeVisible();
    expect(saved).toBe(1);
    expect(
      submitted.map((input) => ({
        generation: input.expectedDestinationGeneration,
        url: input.expectedDestinationUrl,
      })),
    ).toEqual([
      { generation: 1, url: destination.url },
      { generation: 2, url: currentDestination.url },
    ]);
  });
}
