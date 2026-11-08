import { expect, test, type Page } from "@playwright/test";
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
async function mount(
  page: Page,
  component: string,
  file: string,
  props: string,
) {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import {${component}} from './src/components/${file}'; createRoot(document.querySelector('#paused-fixture')).render(<${component} ${props}/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    plugins: [
      {
        name: "fixture-navigation",
        setup(builder: {
          onResolve(options: { filter: RegExp }, callback: () => object): void;
          onLoad(
            options: { filter: RegExp; namespace: string },
            callback: () => object,
          ): void;
        }) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "navigation",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const useRouter = () => ({push(){}, refresh(){}})",
            loader: "js",
          }));
        },
      },
    ],
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
      '<h1>Paused capability fixture</h1><div id="paused-fixture"></div>';
  });
  await page.addScriptTag({ content: result.outputFiles[0].text });
}
async function accessible(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}
test("paused credentials disable creation and keep revoke usable", async ({
  page,
}) => {
  let commands: unknown[] = [];
  const token = {
    id: "token",
    name: "Saved reader",
    siteIds: ["site"],
    scopes: ["sites:read"],
    createdAt: "2026-11-02T00:00:00Z",
    expiresAt: "2026-12-02T00:00:00Z",
    revokedAt: null,
  };
  await page.route("**/api/tokens**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { tokens: [token] } });
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { revoked: true } });
  });
  await mount(
    page,
    "ApiAccess",
    "api-access",
    'workspaceId="a" collectionEnabled={false} sites={[{id:"site",origin:"https://example.com"}]}',
  );
  await expect(
    page.getByRole("button", {
      name: "Create read-only credential",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Revoke Saved reader", exact: true })
    .click();
  expect(commands).toEqual([
    { workspaceId: "a", action: "revoke", tokenId: "token" },
  ]);
  await accessible(page);
});
test("paused audits preserve saved evidence and allow stop with execution disabled", async ({
  page,
}) => {
  let status = "QUEUED";
  const commands: unknown[] = [];
  const run = () => ({
    id: "run",
    status,
    createdAt: "2026-11-02T00:00:00Z",
    manifest: ["https://example.com/"],
    pages: [],
    evaluation: null,
  });
  await page.route("**/api/audits**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: new URL(route.request().url()).searchParams.has("auditId")
          ? run()
          : [run()],
      });
    commands.push(route.request().postDataJSON());
    status = "FAILED";
    return route.fulfill({ json: { ok: true } });
  });
  await mount(
    page,
    "PersistedAudits",
    "persisted-audits",
    'workspaceId="a" siteId="site" origin="https://example.com" editable={true} enabled={false} collectionEnabled={false}',
  );
  await page.getByRole("button", { name: /queued$/ }).click();
  await expect(
    page.getByRole("button", { name: "Resume audit", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Confirm pages and start audit",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Stop audit", exact: true }).click();
  expect(commands).toEqual([
    { workspaceId: "a", siteId: "site", action: "cancel", auditId: "run" },
  ]);
  await expect(
    page.getByRole("heading", { name: "Audit evidence", exact: true }),
  ).toBeVisible();
  await accessible(page);
});
for (const integration of ["search", "analytics"] as const)
  test(`paused ${integration} disables collection while manager can disconnect`, async ({
    page,
  }) => {
    const commands: unknown[] = [];
    const saved =
      integration === "search"
        ? {
            connection: { property: "https://example.com/" },
            coverage: "Retained search evidence.",
            opportunities: [],
            snapshots: [],
          }
        : {
            configured: true,
            connection: {
              property: "properties/123",
              streamId: "456",
              timeZone: "UTC",
              status: "connected",
            },
            properties: [],
            snapshots: [],
            opportunityOutcomes: [],
            coverage: "Retained analytics evidence.",
          };
    await page.route(`**/api/${integration}**`, (route) =>
      route.fulfill({ json: saved }),
    );
    await page.route(
      `**/api/integrations/${integration === "search" ? "google" : "analytics"}`,
      (route) => {
        commands.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      },
    );
    await mount(
      page,
      integration === "search" ? "SearchPerformance" : "AnalyticsWorkspace",
      integration === "search" ? "search-performance" : "analytics-workspace",
      `workspaceId="a" siteId="site" ${integration === "search" ? "editable" : "manageable"}={true} collectionEnabled={false}`,
    );
    await expect(
      page.getByRole("button", {
        name:
          integration === "search"
            ? "Connect Search Console"
            : "Connect Analytics",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", {
        name:
          integration === "search"
            ? "Load available properties"
            : "Load properties and streams",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("heading", {
        name:
          integration === "search"
            ? "Import a search window"
            : "Import a bounded window",
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name:
          integration === "search"
            ? "Disconnect and remove imported data"
            : "Disconnect and remove Analytics data",
        exact: true,
      })
      .click();
    expect(commands).toEqual([
      { workspaceId: "a", siteId: "site", action: "disconnect" },
    ]);
    await accessible(page);
  });
for (const editable of [true, false])
  test(`server edit and rollout permissions cannot be widened by page detail canEdit (${editable})`, async ({
    page,
  }) => {
    await page.route("**/api/pages**", (route) =>
      route.fulfill({
        json: {
          page: {
            id: "page",
            originalUrl: "https://example.com/",
            normalizedUrl: "https://example.com/",
            revision: 1,
            assignedTo: null,
          },
          actor: { userId: "owner", canEdit: true },
          historyLimit: 100,
          history: [],
          context: null,
          audits: [],
          search: { opportunities: [], snapshots: [] },
          drafts: [],
          reports: [],
          ai: { message: "Site-level only" },
        },
      }),
    );
    await page.route("**/api/content**", (route) =>
      route.fulfill({ json: [] }),
    );
    await mount(
      page,
      "PageWorkspace",
      "page-workspace",
      `workspaceId="a" siteId="site" pageId="page" origin="https://example.com" editable={${editable}} collectionEnabled={${!editable}}`,
    );
    await expect(
      page.getByRole("heading", {
        name: "Audit evidence for this URL",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Assign to me", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel("What changed on this page?", { exact: true }),
    ).toHaveCount(0);
    await accessible(page);
  });
for (const contextEnabled of [false, true])
  test(`context and ownership proof controls pause independently (${contextEnabled})`, async ({
    page,
  }) => {
    await mount(
      page,
      "SiteSettings",
      "site-settings",
      `workspaceId="a" siteId="site" editable={true} manager={true} enabled={true} contextEnabled={${contextEnabled}} proofEnabled={${!contextEnabled}} initialRevisions={[]} verifiedAt={null}`,
    );
    const challenge = page.getByRole("button", {
      name: "Issue new challenge",
      exact: true,
    });
    if (contextEnabled) {
      await expect(challenge).toBeDisabled();
      await expect(
        page.getByRole("button", {
          name: "Save reviewed context",
          exact: true,
        }),
      ).toBeEnabled();
    } else {
      await expect(challenge).toBeEnabled();
      await expect(
        page.getByRole("button", {
          name: "Save reviewed context",
          exact: true,
        }),
      ).toHaveCount(0);
    }
    await accessible(page);
  });
test("paused content preserves readable draft revisions and report downloads", async ({
  page,
}) => {
  const draft = {
    id: "draft",
    revision: 1,
    kind: "draft",
    history: [
      {
        revision: 1,
        content: {
          title: "Retained manual draft",
          body: "Saved body remains readable.",
          assumptions: [],
          citations: [],
        },
      },
    ],
    snapshot: { internalLinks: [] },
  };
  const mutations: string[] = [],
    readPaths = new Set<string>();
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET")
      mutations.push(route.request().url());
    const url = new URL(route.request().url());
    const path = url.pathname;
    readPaths.add(path);
    if (
      path === "/api/reports" &&
      url.searchParams.get("brandingOptions") === "1"
    )
      return route.fulfill({ json: { choices: [] } });
    return route.fulfill({
      json:
        path === "/api/content"
          ? [draft]
          : path === "/api/reports"
            ? [
                {
                  id: "report",
                  title: "Retained report",
                  createdAt: "2026-11-02T00:00:00Z",
                  evidenceFormat: "saved-evidence-v2",
                  formatStatus: { pdf: "available", csv: "available" },
                },
                {
                  id: "legacy",
                  title: "Historical report",
                  createdAt: "2025-11-02T00:00:00Z",
                  evidenceFormat: null,
                  formatStatus: {
                    pdf: "pending-review",
                    csv: "pending-review",
                  },
                },
                {
                  id: "withdrawn",
                  title: "Withdrawn report",
                  createdAt: "2025-10-02T00:00:00Z",
                  evidenceFormat: null,
                  formatStatus: { pdf: "withdrawn", csv: "withdrawn" },
                },
              ]
            : path === "/api/search"
              ? { snapshots: [] }
              : [],
    });
  });
  await mount(
    page,
    "ContentWorkspace",
    "content-workspace",
    'workspaceId="a" siteId="site" editable={true} collectionEnabled={false}',
  );
  await page
    .getByRole("button", {
      name: "Retained manual draft · revision 1",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Saved body remains readable.", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByLabel("Editable Markdown draft", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Create report from selected evidence",
      exact: true,
    }),
  ).toHaveCount(0);
  const retained = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Retained report", exact: true }),
  });
  const legacy = page.getByRole("listitem").filter({
    has: page.getByRole("heading", {
      name: "Historical report",
      exact: true,
    }),
  });
  const withdrawn = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Withdrawn report", exact: true }),
  });
  for (const format of ["PDF", "CSV"]) {
    const link = retained.getByRole("link", {
      name: "Download " + format,
      exact: true,
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      `/api/reports?workspaceId=a&siteId=site&reportId=report&format=${format.toLowerCase()}`,
    );
    await expect(
      legacy.getByRole("link", { name: "Download " + format, exact: true }),
    ).toHaveCount(0);
    await expect(
      legacy.getByText(`${format}: pending-review.`, { exact: true }),
    ).toBeVisible();
    await expect(
      withdrawn.getByRole("link", { name: "Download " + format, exact: true }),
    ).toHaveCount(0);
    await expect(
      withdrawn.getByText(`${format}: withdrawn.`, { exact: true }),
    ).toBeVisible();
  }
  await expect(
    legacy.getByRole("button", {
      name: "Preview Historical report",
      exact: true,
    }),
  ).toBeVisible();
  expect([...readPaths].sort()).toEqual([
    "/api/audits",
    "/api/content",
    "/api/reports",
    "/api/search",
  ]);
  expect(mutations).toEqual([]);
  await accessible(page);
});
test("paused visibility retains panels without create or review controls", async ({
  page,
}) => {
  const mutations: string[] = [];
  await page.route("**/api/visibility**", (route) => {
    if (route.request().method() !== "GET")
      mutations.push(route.request().url());
    return route.fulfill({
      json: {
        panels: [
          {
            id: "panel",
            version: 1,
            reviewedAt: null,
            prompts: [
              { id: "p", text: "Retained question?", label: "neutral" },
            ],
            brands: [{ id: "b", name: "Lyra", aliases: ["Lyra"], domains: [] }],
          },
        ],
        runs: [],
        availability: {
          available: false,
          reason: "Provider collection remains unavailable.",
          profiles: [],
        },
      },
    });
  });
  await mount(
    page,
    "VisibilityWorkspace",
    "visibility-workspace",
    'workspaceId="a" siteId="site" editable={true} collectionEnabled={false}',
  );
  await expect(
    page.getByText("Retained question?", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save panel version", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mark version 1 reviewed", exact: true }),
  ).toHaveCount(0);
  expect(mutations).toEqual([]);
  await accessible(page);
});
