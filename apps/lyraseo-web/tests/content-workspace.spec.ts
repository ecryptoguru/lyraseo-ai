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
async function bundle(editable: boolean) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {ContentWorkspace} from './src/components/content-workspace';createRoot(document.querySelector('#content-fixture')).render(<ContentWorkspace workspaceId="a" siteId="site" editable={${editable}}/>);`,
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
}) => {
  await page.route("**/api/content**", (route) =>
    route.fulfill({ json: [draft] }),
  );
  await page.route("**/api/reports**", (route) =>
    route.fulfill({
      json: [
        {
          id: "report",
          title: "Private evidence report",
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
  await expect(
    page.getByRole("button", { name: "Save draft with evidence" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create report from selected evidence" }),
  ).toHaveCount(0);
});

test("saved draft loads complete history and reports use their visible independent selection", async ({
  page,
}) => {
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
  await create.click();
  expect(reportCommand).toEqual({
    workspaceId: "a",
    siteId: "site",
    title: "Evidence B report",
    auditIds: ["audit-b"],
    searchSnapshotIds: [],
  });
});
