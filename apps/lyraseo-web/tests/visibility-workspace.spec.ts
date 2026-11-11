import {
  expect,
  test,
  expectHistoryWithinViewport,
} from "./fixtures/history-viewport";
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
async function bundle(editable: boolean) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {VisibilityWorkspace} from './src/components/visibility-workspace';createRoot(document.querySelector('#visibility-fixture')).render(<VisibilityWorkspace workspaceId="a" siteId="site" editable={${editable}}/>);`,
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
const panel = {
  id: "panel",
  version: 1,
  reviewedAt: null,
  prompts: [
    { id: "p1", text: "Which product helps with audits?", label: "neutral" },
  ],
  brands: [
    { id: "brand", name: "Lyra", aliases: ["Lyra"], domains: ["example.com"] },
  ],
};
const availability = {
  available: false,
  reason: "Provider collection and cost qualification remain unavailable.",
  profiles: ["azure-sol-api", "consumer-chatgpt", "consumer-gemini"],
};
async function mount(page: import("@playwright/test").Page, editable: boolean) {
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled visibility fixture</h1><div id="visibility-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(editable) });
}
test("editor saves and reviews a panel without inventing observations", async ({
  page,
}, testInfo) => {
  let panels: (typeof panel)[] = [];
  let command: Record<string, unknown> = {};
  await page.route("**/api/visibility**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { panels, runs: [], availability } });
    command = route.request().postDataJSON();
    panels = [
      {
        ...panel,
        reviewedAt:
          command.action === "review-panel" ? "2026-11-02T00:00:00Z" : null,
      } as typeof panel,
    ];
    return route.fulfill({ json: panels[0] });
  });
  await mount(page, true);
  await expect(
    page.getByText(
      "No observations collected. Presence, citations and share of voice are unmeasured.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("Question 1", { exact: true })
    .fill("Which product helps with audits?");
  await page.getByLabel("Brand 1 name", { exact: true }).fill("Lyra");
  await page
    .getByLabel("Brand 1 domains, one per line", { exact: true })
    .fill("example.com\nexample.in");
  await page
    .getByRole("button", { name: "Save panel version", exact: true })
    .click();
  expect(command.brands).toEqual([
    {
      id: "brand-1",
      name: "Lyra",
      aliases: ["Lyra"],
      domains: ["example.com", "example.in"],
    },
  ]);
  await page
    .getByRole("button", { name: "Mark version 1 reviewed", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("reviewed");
  await expect(
    page.getByText(
      "No observations collected. Presence, citations and share of voice are unmeasured.",
    ),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({
    path: `../../output/playwright/visibility-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("reviews scope and allowance without issuing a quote or dispatching", async ({
  page,
}, testInfo) => {
  const actions: string[] = [];
  const reviewed = { ...panel, reviewedAt: "2026-11-02T00:00:00Z" };
  await page.route("**/api/visibility**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { panels: [reviewed], runs: [], availability },
      });
    const input = route.request().postDataJSON();
    actions.push(input.action);
    if (input.action !== "preview-run") return route.fulfill({ status: 500 });
    if (input.profile === "azure-sol-api")
      return route.fulfill({
        status: 503,
        json: { error: "Preview unavailable. Try again." },
      });
    return route.fulfill({
      json: {
        available: false,
        panel: { id: "panel", version: 1, promptCount: 1 },
        requested: { profile: input.profile, language: "en", market: "IN" },
        verification: "current",
        incompatiblePromptIds: ["x".repeat(80)],
        quote: null,
        maximumCost: null,
        cacheStatus: "not-checked",
        allowance: {
          asOf: "2026-11-03T12:00:00.000Z",
          period: "2026-11",
          combined: {
            bucket: "COMBINED",
            limit: "10",
            spent: "1",
            reserved: "2",
            remaining: "7",
          },
          provider: {
            bucket: "DATAFORSEO",
            limit: "1",
            spent: "0.2",
            reserved: "0.1",
            remaining: "0.7",
          },
          observations: {
            bucket: "CHATGPT_OBSERVATION",
            limit: "100",
            spent: "10",
            reserved: "3",
            remaining: "87",
          },
        },
        reasons: ["Provider account is not qualified."],
      },
    });
  });
  await mount(page, true);
  await page
    .getByLabel("Surface for panel version 1")
    .selectOption("consumer-chatgpt");
  await page
    .getByRole("button", { name: "Preview scope and allowance" })
    .click();
  const preview = page.getByRole("region", { name: "Observation run preview" });
  await expect(preview).toContainText("Consumer ChatGPT");
  await expect(preview).toContainText("1 question");
  await expect(preview).toContainText("0.7 USD");
  await expect(preview).toContainText("87 observations");
  await expect(preview).toContainText(
    "No quote or collection has been started",
  );
  await expect(preview).toContainText("Maximum cost is unavailable");
  expect(actions).toEqual(["preview-run"]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({
    path: `../../output/playwright/visibility-preview-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByLabel("Surface for panel version 1")
    .selectOption("azure-sol-api");
  await expect(preview).toHaveCount(0);
  await page
    .getByRole("button", { name: "Preview scope and allowance" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Preview unavailable. Try again.",
  );
  await expect(preview).toHaveCount(0);
  expect(actions).toEqual(["preview-run", "preview-run"]);
});
test("viewer traces synthetic evidence and failed slots without collection controls", async ({
  page,
  consoleHealth,
}, testInfo) => {
  const run = {
    id: "run",
    panelId: "panel",
    profile: "azure-sol-api",
    createdAt: "2026-11-02T00:00:00Z",
    provenance: {
      synthetic: true,
      provider: "azure-openai",
      model: "fixture-model",
    },
    rawExpired: false,
    slots: [
      {
        promptId: "p1",
        state: "successful",
        extraction: {
          brand: {
            mention: true,
            citation: false,
            recommendation: null,
            reason: "Recommendation requires review",
          },
        },
      },
      {
        promptId: "p2",
        state: "failed",
        failureReason: "Provider timeout",
        extraction: {},
      },
    ],
  };
  let detailReads = 0;
  let rawState: "retained" | "raw-expired" | "classification-blocked" =
    "retained";
  await page.route("**/api/visibility**", (route) => {
    const runId = new URL(route.request().url()).searchParams.get("runId");
    if (runId) detailReads++;
    return route.fulfill({
      json: {
        panels: [panel],
        runs: [
          runId
            ? {
                ...run,
                rawState,
                rawAnswers:
                  rawState === "retained"
                    ? [{ body: "Lyra is mentioned", annotations: [] }]
                    : null,
              }
            : run,
        ],
        availability,
      },
    });
  });
  await mount(page, false);
  expect(detailReads).toBe(0);
  await expect(
    page.getByRole("button", { name: "Save panel version", exact: true }),
  ).toHaveCount(0);
  await expectHistoryWithinViewport(
    page,
    testInfo,
    "legacy-history",
    consoleHealth,
  );
  await page
    .getByRole("button", { name: /Azure API.*Synthetic fixture/ })
    .press("Enter");
  await expect(
    page.getByText("Synthetic fixture — this is not a live measurement."),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Measured absent", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", {
      name: "Not measured · Provider timeout",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByText("Parsed answer evidence and provenance", { exact: true })
    .click();
  await expect(
    page.locator("pre").filter({ hasText: "Lyra is mentioned" }),
  ).toBeVisible();
  expect(detailReads).toBe(1);
  await expect(
    page.getByText(
      "Legacy answers are stored as parsed JSON, not original provider responses.",
    ),
  ).toBeVisible();
  for (const [state, message] of [
    [
      "raw-expired",
      "Raw answer retention has expired; clearing has not been confirmed.",
    ],
    [
      "classification-blocked",
      "The raw answer is unavailable pending classification.",
    ],
  ] as const) {
    rawState = state;
    await page
      .getByRole("button", { name: /Azure API.*Synthetic fixture/ })
      .click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(
      page.locator("pre").filter({ hasText: "Lyra is mentioned" }),
    ).toHaveCount(0);
  }
  expect(detailReads).toBe(3);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("private parsed fixtures show explicit per-answer availability without implicit raw reads", async ({
  page,
  consoleHealth,
}, testInfo) => {
  const run = {
    id: "private-run",
    panelId: "panel",
    profile: "azure-sol-api",
    createdAt: "2026-11-02T00:00:00Z",
    storageFormat: "OBSERVATION_PRIVATE_V1",
    provenance: { synthetic: true, provider: "azure", model: "fixture-model" },
    rawExpired: false,
    rawAnswers: null,
    slots: [
      {
        promptId: "p1",
        state: "successful",
        extraction: {
          brand: {
            mention: false,
            citation: false,
            recommendation: false,
            reason: null,
          },
        },
      },
    ],
    rawAvailability: [
      "retained-parsed",
      "expired",
      "rights-unavailable",
      "not-retained",
      "unavailable",
    ].map((state, index) => ({
      promptId: `p${index + 1}`,
      state,
      representation: "ANSWER_PARSED_JSON_V1",
      producerClass: "CONTROLLED_FIXTURE_V1",
      originalProviderWire: false,
    })),
  };
  let answerReads = 0;
  await page.route("**/api/visibility**", (route) => {
    if (new URL(route.request().url()).searchParams.has("action"))
      answerReads++;
    return route.fulfill({
      json: { panels: [panel], runs: [run], availability },
    });
  });
  await mount(page, false);
  await expectHistoryWithinViewport(
    page,
    testInfo,
    "private-history",
    consoleHealth,
  );
  await page
    .getByRole("button", { name: /Azure API.*Synthetic fixture/ })
    .press("Enter");
  await page
    .getByText("Parsed answer evidence and provenance", { exact: true })
    .click();
  await expect(
    page.getByText(
      /Retained answers are parsed JSON, not original provider responses/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText("p2: raw answer expired.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("p3: raw answer rights unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("p4: no answer body retained.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("p5: raw answer unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Read parsed answer for p1" }),
  ).toHaveAttribute("href", /action=read-answer/);
  expect(answerReads).toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expectHistoryWithinViewport(
    page,
    testInfo,
    "private-parsed-history",
    consoleHealth,
  );
  const table = page.getByRole("region", {
    name: "Per-prompt observation evidence table",
  });
  await table.focus();
  await expect(table).toBeFocused();
  if (
    await table.evaluate((element) => element.scrollWidth > element.clientWidth)
  ) {
    await table.press("ArrowRight");
    await expect
      .poll(() => table.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
  }
  await page.screenshot({
    path: `../../output/playwright/private-observation-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
