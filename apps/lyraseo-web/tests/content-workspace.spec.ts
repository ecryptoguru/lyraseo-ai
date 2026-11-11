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
async function bundle(editable: boolean, collectionEnabled = true) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {ContentWorkspace} from './src/components/content-workspace';createRoot(document.querySelector('#content-fixture')).render(<ContentWorkspace workspaceId="a" siteId="site" editable={${editable}} collectionEnabled={${collectionEnabled}}/>);`,
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
const draft = {
  id: "draft",
  revision: 1,
  kind: "draft",
  history: [
    {
      revision: 1,
      content: {
        title: "Product page improvement",
        body: "Reviewed draft",
        assumptions: [],
        citations: [
          {
            sourceId: "audit:audit",
            note: "The title finding supports the proposed change.",
          },
        ],
      },
    },
  ],
  snapshot: { internalLinks: [] },
};
test("editor saves an evidence-backed draft and preserves changes after a revision conflict", async ({
  page,
}, testInfo) => {
  let created = false;
  await page.route("**/api/content**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: created ? [draft] : [] });
    if (route.request().postDataJSON().action === "save")
      return route.fulfill({
        status: 409,
        json: {
          error:
            "A newer revision exists. Reload the saved version after preserving your edits.",
        },
      });
    created = true;
    return route.fulfill({ json: draft });
  });
  await page.route("**/api/reports**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/audits**", (route) =>
    route.fulfill({
      json: [
        { id: "audit", status: "COMPLETED", createdAt: "2026-11-02T00:00:00Z" },
      ],
    }),
  );
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled editorial fixture</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await page
    .getByRole("group", {
      name: "Select up to five audits and five search imports",
      exact: true,
    })
    .getByRole("checkbox")
    .check();
  await page.getByLabel("Draft title").fill("Product page improvement");
  await page.getByLabel("Editable Markdown draft").fill("Reviewed draft");
  await page
    .getByLabel("Why audit:audit supports this draft")
    .fill("The title finding supports the proposed change.");
  await page.getByRole("button", { name: "Save draft with evidence" }).click();
  await expect(page.getByRole("status")).toContainText("Draft revision saved");
  await page.getByLabel("Editable Markdown draft").fill("My unsaved changes");
  await page.getByRole("button", { name: "Save next revision" }).click();
  await expect(page.getByRole("status")).toContainText("newer revision");
  await expect(page.getByLabel("Editable Markdown draft")).toHaveValue(
    "My unsaved changes",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/content-workspace-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("viewer can download a private report without draft or report creation controls", async ({
  page,
  consoleHealth,
}, testInfo) => {
  await page.route("**/api/content**", (route) =>
    route.fulfill({ json: [draft] }),
  );
  await page.route("**/api/reports**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).searchParams.get("format") === "preview"
          ? {
              id: "report",
              snapshot: { sources: [{ sourceId: "audit:audit", data: {} }] },
              sourceAvailability: [],
            }
          : [
              {
                id: "report",
                title:
                  "Private evidence report for the international product catalogue and accessibility review",
                evidenceFormat: "saved-evidence-v2",
                formatStatus: { pdf: "available", csv: "available" },
                createdAt: "2026-11-02T00:00:00Z",
              },
            ],
    }),
  );
  await page.route("**/api/audits**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled report viewer</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(false) });
  await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
  await expectHistoryWithinViewport(
    page,
    testInfo,
    "report-history",
    consoleHealth,
  );
  await page
    .getByRole("button", { name: /^Preview Private evidence report/ })
    .press("Enter");
  await expect(
    page.getByRole("region", { name: "Saved report preview" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Save draft with evidence" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create report from selected evidence" }),
  ).toHaveCount(0);
});

test("saved draft loads complete history and reports use their visible independent selection", async ({
  page,
}, testInfo) => {
  const latest = {
    ...draft,
    revision: 2,
    history: [
      {
        ...draft.history[0],
        revision: 2,
        content: {
          ...draft.history[0].content,
          title: "Saved draft B",
          body: "Second revision",
        },
      },
    ],
  };
  let requestedDetail = false;
  await page.route("**/api/content**", (route) => {
    const detailed = new URL(route.request().url()).searchParams.has("draftId");
    requestedDetail ||= detailed;
    return route.fulfill({
      json: [
        detailed
          ? { ...latest, history: [...latest.history, draft.history[0]] }
          : latest,
      ],
    });
  });
  let reportCommand: unknown;
  await page.route("**/api/reports**", (route) => {
    if (
      new URL(route.request().url()).searchParams.get("brandingOptions") === "1"
    )
      return route.fulfill({
        json: { choices: [{ revision: 3, displayName: "Acme agency" }] },
      });
    if (route.request().method() === "POST")
      reportCommand = route.request().postDataJSON();
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/audits**", (route) =>
    route.fulfill({
      json: [
        {
          id: "audit-a",
          status: "COMPLETED",
          createdAt: "2026-11-01T00:00:00Z",
        },
        {
          id: "audit-b",
          status: "COMPLETED",
          createdAt: "2026-11-02T00:00:00Z",
        },
      ],
    }),
  );
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Editorial history fixture</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await page
    .getByRole("group", {
      name: "Select up to five audits and five search imports",
      exact: true,
    })
    .getByRole("checkbox")
    .first()
    .check();
  await page
    .getByRole("button", { name: "Saved draft B · revision 2" })
    .click();
  expect(requestedDetail).toBe(true);
  await page.getByText("Saved revision history", { exact: true }).click();
  await expect(
    page.getByText("Revision 1 · Product page improvement", { exact: true }),
  ).toBeVisible();
  const create = page.getByRole("button", {
    name: "Create report from selected evidence",
  });
  await expect(create).toBeDisabled();
  await page
    .getByLabel("Report title", { exact: true })
    .fill("Evidence B report");
  await page
    .getByRole("group", {
      name: "Report evidence: select up to five audits and five search imports",
      exact: true,
    })
    .getByRole("checkbox")
    .nth(1)
    .check();
  await page
    .getByLabel("Report template", { exact: true })
    .selectOption("editor");
  await page
    .getByLabel("Report branding", { exact: true })
    .selectOption({ label: "Acme agency · version 3" });
  await page.screenshot({
    path: testInfo.outputPath("approved-branding-choice.png"),
    fullPage: true,
  });
  await create.click();
  expect(reportCommand).toEqual({
    workspaceId: "a",
    siteId: "site",
    title: "Evidence B report",
    reportTemplate: "editor",
    brandingRevision: 3,
    auditIds: ["audit-b"],
    searchSnapshotIds: [],
  });
});

test("explicit report comparison preserves independent selections on validation and server errors", async ({
  page,
}, testInfo) => {
  let reportCommand: unknown;
  let releaseReport!: () => void;
  const reportResponse = new Promise<void>((resolve) => {
    releaseReport = resolve;
  });
  await page.route("**/api/content**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/reports**", async (route) => {
    if (route.request().method() === "POST") {
      reportCommand = route.request().postDataJSON();
      await reportResponse;
      return route.fulfill({
        status: 409,
        json: {
          error:
            "Before audit must not be newer than after. Your selections are preserved.",
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/audits**", (route) =>
    route.fulfill({
      json: [
        {
          id: "before",
          status: "COMPLETED",
          createdAt: "2026-11-01T00:00:00Z",
        },
        { id: "after", status: "COMPLETED", createdAt: "2026-11-02T00:00:00Z" },
      ],
    }),
  );
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled comparison report</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await expect(page.getByRole("status")).toContainText("Choose saved evidence");
  await page
    .getByLabel("Report title", { exact: true })
    .fill("Immutable comparison acceptance");
  await page
    .getByLabel("Draft title", { exact: true })
    .fill("Unsaved manual draft remains independent");
  const evidence = page.getByRole("group", {
    name: "Report evidence: select up to five audits and five search imports",
    exact: true,
  });
  await evidence.getByRole("checkbox").nth(0).check();
  await evidence.getByRole("checkbox").nth(1).check();
  await page.getByLabel("Include a frozen before/after comparison").check();
  await page.getByLabel("Before audit", { exact: true }).selectOption("before");
  const create = page.getByRole("button", {
    name: "Create report from selected evidence",
  });
  await create.click();
  await expect(
    page
      .getByRole("region", { name: "Private evidence reports" })
      .getByRole("status"),
  ).toContainText("two distinct");
  expect(reportCommand).toBeUndefined();
  await page.getByLabel("After audit", { exact: true }).selectOption("after");
  await page.getByLabel("Before audit", { exact: true }).focus();
  await expect(page.getByLabel("Before audit", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("After audit", { exact: true })).toBeFocused();
  await create.click();
  await expect(create).toBeDisabled();
  await expect(page.getByLabel("Before audit", { exact: true })).toBeDisabled();
  releaseReport();
  await expect(
    page
      .getByRole("region", { name: "Private evidence reports" })
      .getByRole("status"),
  ).toContainText("must not be newer");
  expect(reportCommand).toEqual({
    workspaceId: "a",
    siteId: "site",
    title: "Immutable comparison acceptance",
    reportTemplate: "founder",
    auditIds: ["before", "after"],
    searchSnapshotIds: [],
    comparison: { beforeAuditId: "before", afterAuditId: "after" },
  });
  await expect(page.getByLabel("Before audit", { exact: true })).toHaveValue(
    "before",
  );
  await expect(page.getByLabel("After audit", { exact: true })).toHaveValue(
    "after",
  );
  await expect(page.getByLabel("Report title", { exact: true })).toHaveValue(
    "Immutable comparison acceptance",
  );
  await expect(page.getByLabel("Draft title", { exact: true })).toHaveValue(
    "Unsaved manual draft remains independent",
  );
  await expect(evidence.getByRole("checkbox").nth(0)).toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/build-2026-11-02/comparison-controls-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("report comparison respects loading, empty and paused states", async ({
  page,
}) => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/content**", async (route) => {
    await loaded;
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/reports**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/audits**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Paused report fixture</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true, false) });
  await expect(
    page.getByText("Loading saved work…", { exact: true }),
  ).toBeVisible();
  release();
  await expect(page.getByText("No saved reports yet.")).toBeVisible();
  await expect(
    page.getByLabel("Include a frozen before/after comparison"),
  ).toHaveCount(0);
  await expect(
    page.getByText("Paused", { exact: false }).first(),
  ).toBeVisible();
});
test("pins a historical revision, retains a citation from an expired source and previews a quarantined report", async ({
  page,
}, testInfo) => {
  let pinned = false,
    advanced = false,
    attempted: Record<string, unknown> | undefined;
  const saved = (older: boolean) => ({
    ...draft,
    revision: advanced ? 3 : 2,
    nextHistoryBefore: older ? null : 2,
    sourceAvailability: [{ sourceId: "audit:audit", status: "expired" }],
    history: older
      ? [
          {
            ...draft.history[0],
            revision: 1,
            pin: pinned ? { pinnedAt: "2026-11-02T00:00:00Z" } : null,
          },
        ]
      : [
          {
            ...draft.history[0],
            revision: advanced ? 3 : 2,
            pin: null,
            ...(advanced
              ? {
                  content: {
                    ...draft.history[0].content,
                    body: "Bob's revision",
                    citations: [
                      { sourceId: "audit:bob", note: "Bob's citation" },
                    ],
                  },
                }
              : {}),
          },
        ],
  });
  await page.route("**/api/content**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: [
          saved(
            new URL(route.request().url()).searchParams.has("beforeRevision"),
          ),
        ],
      });
    const input = route.request().postDataJSON();
    if (input.action === "save") {
      attempted = input;
      // Match the optimistic writer: only an actual stale baseline gets a conflict.
      if (input.expectedRevision === (advanced ? 3 : 2))
        return route.fulfill({
          json: { revision: input.expectedRevision + 1 },
        });
      return route.fulfill({
        status: 409,
        json: { error: "A newer revision exists. Preserve your edits." },
      });
    }
    expect(input.action).toBe("pin");
    expect(input.revision).toBe(1);
    advanced = true;
    pinned = input.pinned;
    return route.fulfill({
      json: {
        revision: 1,
        pinned,
        available: true,
        pin: pinned ? { pinnedAt: "2026-11-02T00:00:00Z" } : null,
      },
    });
  });
  const report = {
    id: "legacy",
    title: "Original report",
    createdAt: "2025-01-01T12:00:00Z",
    evidenceFormat: null,
  };
  await page.route("**/api/reports**", (route) =>
    route.fulfill({
      json: route.request().url().includes("format=preview")
        ? {
            ...report,
            sourceAvailability: [
              { sourceId: "gsc:old", status: "disconnected" },
            ],
            snapshot: {
              sources: [
                {
                  sourceId: "gsc:old",
                  data: { metrics: { clicks: 3, impressions: 10 } },
                },
              ],
            },
          }
        : [report],
    }),
  );
  await page.route("**/api/audits**", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/search**", (r) =>
    r.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled retention fixture</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await page
    .getByRole("button", { name: "Product page improvement · revision 2" })
    .click();
  await expect(page.getByText("audit:audit · source expired")).toBeVisible();
  await expect(
    page.getByText(
      "Saved citation · The title finding supports the proposed change.",
    ),
  ).toBeVisible();
  await page.getByText("Saved revision history", { exact: true }).click();
  await page.getByLabel("Editable Markdown draft").fill("Unsaved edits");
  await page.getByRole("button", { name: "Load older revisions" }).click();
  await page
    .getByRole("button", { name: "Pin revision 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unpin revision 1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Unpin revision 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pin revision 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Editable Markdown draft")).toHaveValue(
    "Unsaved edits",
  );
  await page.getByRole("button", { name: "Save next revision" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "newer revision",
  );
  expect(attempted).toMatchObject({
    expectedRevision: 2,
    body: "Unsaved edits",
    citations: draft.history[0].content.citations,
  });
  await expect(page.getByLabel("Editable Markdown draft")).toHaveValue(
    "Unsaved edits",
  );
  await expect(page.getByText("PDF: pending-review.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download PDF" })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview Original report" }).click();
  await expect(
    page.getByRole("region", { name: "Saved report preview" }),
  ).toContainText("source disconnected");
  await expect(
    page.getByRole("region", { name: "Saved report preview" }),
  ).toContainText("Saved clicks 3");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/retention-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("template assistance is reviewed, editable and rejectable before an explicit save", async ({
  page,
}, testInfo) => {
  const commands: Array<Record<string, unknown>> = [];
  await page.route("**/api/content**", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [] });
    const command = route.request().postDataJSON();
    commands.push(command);
    if (command.action === "assist")
      return route.fulfill({
        json: {
          method: "EVIDENCE_TEMPLATE_V1",
          evidenceFingerprint: "f".repeat(64),
          kind: "draft",
          context: { id: "context-1", revision: 1 },
          content: {
            title: "Template title",
            body: "Deterministic template, not AI generation.",
            assumptions: ["Review intent"],
            citations: [
              { sourceId: "audit:audit", note: "Saved audit" },
              {
                sourceId: "context:context-1:v1",
                note: "Reviewed site context revision 1",
              },
            ],
          },
          links: [
            {
              id: "link1",
              sourceId: "audit:audit",
              sourceUrl: "https://example.com/",
              url: "https://example.com/contact",
              anchorText: "Contact us",
              recommendation:
                "Review this existing raw link; rendered visibility needs review.",
            },
          ],
          limitations: ["No provider request or charge."],
        },
      });
    return route.fulfill({
      json: { ...draft, history: [{ revision: 1, content: command }] },
    });
  });
  await page.route("**/api/reports**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/audits**", (route) =>
    route.fulfill({
      json: [
        { id: "audit", status: "COMPLETED", createdAt: "2026-11-02T00:00:00Z" },
      ],
    }),
  );
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled writing template</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await page
    .getByRole("group", {
      name: "Select up to five audits and five search imports",
      exact: true,
    })
    .getByRole("checkbox")
    .check();
  await page
    .getByRole("button", { name: "Prepare evidence template", exact: true })
    .click();
  await expect(page.getByLabel("Draft title")).toHaveValue("Template title");
  await expect(
    page.getByText("Reviewed context revision 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Why context:context-1:v1 supports this draft", {
      exact: true,
    }),
  ).toHaveValue("Reviewed site context revision 1");
  expect(commands.map((command) => command.action)).toEqual(["assist"]);
  await page.screenshot({
    path: testInfo.outputPath("editorial-template-review.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Reject link suggestion", exact: true })
    .click();
  await expect(page.getByText("Contact us", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Discard prepared template", exact: true })
    .click();
  await expect(page.getByLabel("Draft title")).toHaveValue("");
  await page
    .getByRole("button", { name: "Prepare evidence template", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use link suggestion", exact: true })
    .click();
  await expect(page.getByLabel("Editable Markdown draft")).toHaveValue(
    /https:\/\/example\.com\/contact/,
  );
  await page
    .getByLabel("Editable Markdown draft")
    .fill("My reviewed template edits");
  await page
    .getByRole("button", { name: "Save draft with evidence", exact: true })
    .click();
  expect(commands.map((command) => command.action)).toEqual([
    "assist",
    "assist",
    "create",
  ]);
  expect(commands[2]).toMatchObject({
    action: "create",
    expectedContextRevisionId: "context-1",
    expectedEvidenceFingerprint: "f".repeat(64),
    body: "My reviewed template edits",
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("unavailable branding choices preserve typed work and recover independently", async ({
  page,
}) => {
  let choices = 0,
    posts = 0;
  await page.route("**/api/content**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/reports**", (route) => {
    if (route.request().method() === "POST") {
      posts++;
      return route.fulfill({ json: [] });
    }
    if (
      new URL(route.request().url()).searchParams.get("brandingOptions") === "1"
    ) {
      choices++;
      return choices === 1
        ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
        : route.fulfill({
            json: {
              choices: [{ revision: 2, displayName: "Approved agency" }],
            },
          });
    }
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/audits**", (route) =>
    route.fulfill({
      json: [
        { id: "audit", status: "COMPLETED", createdAt: "2026-11-02T00:00:00Z" },
      ],
    }),
  );
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Branding recovery fixture</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await expect(
    page.getByText(
      "Workspace branding could not load. Lyraseo reports remain available.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByLabel("Draft title", { exact: true })
    .fill("My unsaved draft");
  await page
    .getByLabel("Editable Markdown draft", { exact: true })
    .fill("My reviewed text");
  await page
    .getByLabel("Report title", { exact: true })
    .fill("My unsaved report");
  await page
    .getByRole("group", {
      name: "Report evidence: select up to five audits and five search imports",
      exact: true,
    })
    .getByRole("checkbox")
    .check();
  await expect(
    page.getByRole("button", {
      name: "Create report from selected evidence",
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Retry branding choices", exact: true })
    .click();
  await page
    .getByLabel("Report branding", { exact: true })
    .selectOption({ label: "Approved agency · version 2" });
  await expect(page.getByLabel("Draft title", { exact: true })).toHaveValue(
    "My unsaved draft",
  );
  await expect(
    page.getByLabel("Editable Markdown draft", { exact: true }),
  ).toHaveValue("My reviewed text");
  await expect(page.getByLabel("Report title", { exact: true })).toHaveValue(
    "My unsaved report",
  );
  expect(posts).toBe(0);
  expect(choices).toBe(2);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const supporting of ["assumptions", "citation notes"] as const) {
  test(`unsaved ${supporting} prevent template preparation without losing supporting text`, async ({
    page,
  }) => {
    const commands: unknown[] = [];
    await page.route("**/api/content**", (route) => {
      if (route.request().method() === "POST")
        commands.push(route.request().postDataJSON());
      return route.fulfill({ json: [] });
    });
    await page.route("**/api/reports**", (route) =>
      route.fulfill({
        json: new URL(route.request().url()).searchParams.has("brandingOptions")
          ? { choices: [] }
          : [],
      }),
    );
    await page.route("**/api/audits**", (route) =>
      route.fulfill({
        json: [
          {
            id: "audit",
            status: "COMPLETED",
            createdAt: "2026-11-02T00:00:00Z",
          },
        ],
      }),
    );
    await page.route("**/api/search**", (route) =>
      route.fulfill({ json: { snapshots: [] } }),
    );
    await page.goto("/sign-in");
    await page.locator("main").evaluate((main) => {
      main.className = "pilot-page";
      main.innerHTML =
        '<h1>Supporting text preservation</h1><div id="content-fixture"></div>';
    });
    await page.addScriptTag({ content: await bundle(true) });
    await page
      .getByRole("group", {
        name: "Select up to five audits and five search imports",
        exact: true,
      })
      .getByRole("checkbox")
      .check();
    const field =
      supporting === "assumptions"
        ? page.getByLabel("Assumptions to verify, one per line", {
            exact: true,
          })
        : page.getByLabel("Why audit:audit supports this draft", {
            exact: true,
          });
    await field.fill("My unsaved supporting text");
    await expect(page.getByLabel("Draft title", { exact: true })).toHaveValue(
      "",
    );
    await expect(
      page.getByLabel("Editable Markdown draft", { exact: true }),
    ).toHaveValue("");
    const prepare = page.getByRole("button", {
      name: "Prepare evidence template",
      exact: true,
    });
    await expect(prepare).toBeDisabled();
    await expect(prepare).toHaveAccessibleDescription(
      /empty title, draft, assumptions, and citation notes/i,
    );
    await prepare.click({ force: true });
    await expect(field).toHaveValue("My unsaved supporting text");
    expect(commands).toEqual([]);
    await field.fill("");
    await expect(prepare).toBeEnabled();
  });
}

test("withheld legacy draft snapshot keeps authored content readable without reporting empty evidence", async ({
  page,
  consoleHealth,
}, testInfo) => {
  const { snapshot: _snapshot, ...saved } = draft;
  const withheld = { ...saved, evidenceStatus: "legacy-lineage-withheld" };
  await page.route("**/api/content**", (route) =>
    route.fulfill({ json: [withheld] }),
  );
  await page.route("**/api/reports**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/audits**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Controlled legacy draft fixture</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(true) });
  await page
    .getByRole("button", { name: "Product page improvement · revision 1" })
    .click();
  await expect(page.getByLabel("Editable Markdown draft")).toHaveValue(
    "Reviewed draft",
  );
  await expect(
    page.getByText("Historical source evidence is withheld", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Saved citation · The title finding supports the proposed change.",
    ),
  ).toBeVisible();
  await page
    .getByText("Observed internal-link evidence", { exact: true })
    .click();
  await expect(
    page.getByText(
      "Historical internal-link evidence is withheld pending source-lineage verification.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("No qualifying anchor context was captured", {
      exact: false,
    }),
  ).toHaveCount(0);
  expect(consoleHealth).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../output/playwright/legacy-draft-withheld-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("report review states keep each format independent and show withdrawn originals", async ({
  page,
}, testInfo) => {
  await page.route("**/api/content**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/audits**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/search**", (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.route("**/api/reports**", (route) =>
    route.fulfill({
      json: [
        {
          id: "withdrawn",
          title: "Withdrawn historical report",
          createdAt: "2020-01-01T00:00:00Z",
          evidenceFormat: null,
          formatStatus: { pdf: "withdrawn", csv: "withdrawn" },
        },
        {
          id: "partial",
          title: "Separate format decisions",
          createdAt: "2020-01-01T00:00:00Z",
          evidenceFormat: null,
          formatStatus: { pdf: "pending-review", csv: "available" },
        },
        {
          id: "current",
          title: "Current saved report",
          createdAt: "2020-01-01T00:00:00Z",
          evidenceFormat: "saved-evidence-v2",
          formatStatus: { pdf: "available", csv: "available" },
        },
      ],
    }),
  );
  await page.goto("/sign-in");
  await page.locator("main").evaluate((main) => {
    main.className = "pilot-page";
    main.innerHTML =
      '<h1>Report review fixture</h1><div id="content-fixture"></div>';
  });
  await page.addScriptTag({ content: await bundle(false) });
  const withdrawn = page
    .getByRole("listitem")
    .filter({ hasText: "Withdrawn historical report" });
  await expect(withdrawn.getByText("PDF: withdrawn.")).toBeVisible();
  await expect(withdrawn.getByText("CSV: withdrawn.")).toBeVisible();
  await expect(withdrawn.getByRole("link")).toHaveCount(0);
  const partial = page
    .getByRole("listitem")
    .filter({ hasText: "Separate format decisions" });
  await expect(partial.getByRole("link", { name: "Download PDF" })).toHaveCount(
    0,
  );
  await expect(
    partial.getByRole("link", { name: "Download CSV" }),
  ).toBeVisible();
  const current = page
    .getByRole("listitem")
    .filter({ hasText: "Current saved report" });
  await expect(
    current.getByRole("link", { name: "Download PDF" }),
  ).toBeVisible();
  await expect(
    current.getByRole("link", { name: "Download CSV" }),
  ).toBeVisible();
  const metrics = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.width + 1);
  await page.screenshot({
    path: `../../output/playwright/report-review-${testInfo.project.name}.png`,
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    ),
  ).toEqual([]);
});
