import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const viteRequire = createRequire(require.resolve("vitest/package.json"));
const { createServer } = await import(viteRequire.resolve("vite"));
const webRequire = createRequire(
  new URL("../apps/lyraseo-web/package.json", import.meta.url),
);
const { chromium } = webRequire("@playwright/test");
const directory = root + "output/staff-ui";
mkdirSync(directory, { recursive: true });
const controls = {
  mode: "SANDBOX",
  recoveryMode: "LOCAL_REHEARSAL",
  productionCommerceEnabled: false,
  limit: 25,
  nextCursor: null,
  permissions: [
    "policy:pause",
    "billing:reconcile",
    "billing:read",
    "recovery:manage",
    "support:search",
    "privacy:read",
  ],
  rows: [
    { key: "audits", enabled: true, revision: 4, requested_state: null },
    {
      key: "visibility",
      enabled: false,
      revision: 2,
      requested_state: "APPLIED",
    },
  ],
};
const css = readFileSync(
  root + "apps/lyraseo-web/src/app/globals.css",
  "utf8",
).replace(/^@import .*;$/gm, "");
writeFileSync(
  directory + "/index.html",
  `<!doctype html><html lang="en"><head><title>Isolated staff component fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>input,textarea{display:block;max-width:100%;margin-block:.5rem}fieldset{min-width:0;overflow-wrap:anywhere}body{padding:1rem;font-family:Arial,sans-serif}</style></head><body><main id="main" class="pilot-page"><h1>Staff console fixture</h1><p>Synthetic component verification, without a signed-in product session.</p><div id="root"></div></main><script type="module">import{createRoot}from"react-dom/client";import{createElement}from"react";import{StaffConsole}from"/apps/lyraseo-web/src/components/staff-console.tsx";createRoot(document.getElementById('root')).render(createElement(StaffConsole,{initial:${JSON.stringify(controls)}}));</script></body></html>`,
);
const server = await createServer({
  root,
  configFile: false,
  server: { host: "127.0.0.1", port: 3013, strictPort: true },
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      react: root + "apps/lyraseo-web/node_modules/react",
      "react-dom": root + "apps/lyraseo-web/node_modules/react-dom",
    },
  },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 375, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route("**/api/admin?*", (route) => {
      const view = new URL(route.request().url()).searchParams.get("view");
      return route.fulfill({
        json:
          view === "controls"
            ? controls
            : view === "deliveries"
              ? {
                  ...controls,
                  rows: [
                    {
                      id: "delivery_fixture_pending",
                      discovery_state: "PENDING",
                      last_error: "ACCOUNT_BOUND_REFERENCE_DISCOVERY_REQUIRED",
                    },
                  ],
                }
              : view === "search"
                ? {
                    ...controls,
                    rows: [
                      {
                        kind: "SITE",
                        id: "support_fixture_site",
                        workspace_id: "support_fixture_workspace",
                        verified: true,
                        tombstoned: false,
                      },
                    ],
                    nextKind: null,
                    nextId: null,
                  }
                : view === "privacy"
                  ? {
                      ...controls,
                      available: true,
                      profile: "LOCAL_TEST_ONLY",
                      allCopiesErased: false,
                      rows: [
                        {
                          id: "00000000-0000-4000-8000-000000000002",
                          accessBlocked: true,
                          taskCounts: {
                            complete: 3,
                            pending: 0,
                            needsAdapter: 5,
                          },
                          tasks: [
                            {
                              kind: "PROCESSORS",
                              state: "NEEDS_ADAPTER",
                              reason: "UNQUALIFIED_ERASURE_ADAPTER",
                            },
                          ],
                        },
                      ],
                    }
                  : {
                      ...controls,
                      rows:
                        view === "recovery"
                          ? [
                              {
                                id: "00000000-0000-4000-8000-000000000001",
                                subject_id: "fixture-user",
                                state: "HOLD",
                                revision: 1,
                                hold_until: "2099-01-01T00:00:00Z",
                                can_approve: false,
                                provider_state: "UNAVAILABLE",
                              },
                            ]
                          : [],
                    },
      });
    });
    await page.route("**/api/admin", (route) => {
      const data = route.request().postDataJSON();
      return route.fulfill({
        json:
          data.kind === "prepare-request"
            ? { requestId: data.requestId, state: "PREPARED" }
            : { id: "fixture-pause-id", state: "PENDING", effective: false },
      });
    });
    await page.goto("http://127.0.0.1:3013/output/staff-ui/index.html");
    await page
      .getByRole("button", {
        name: "Staff pause unavailable for audits",
        exact: true,
      })
      .waitFor();
    if (
      await page
        .getByRole("button", {
          name: "Staff pause unavailable for audits",
          exact: true,
        })
        .isEnabled()
    )
      throw Error("Unqualified staff pause must remain disabled");
    await page.screenshot({
      path: directory + `/controls-${width}.png`,
      fullPage: true,
    });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      )
    )
      throw Error(`Horizontal overflow at ${width}`);
    await page.getByRole("button", { name: "Recovery", exact: true }).click();
    await page
      .getByRole("heading", { name: "Staff console fixture" })
      .waitFor();
    await page
      .getByRole("button", { name: "Approve after hold", exact: true })
      .waitFor();
    if (
      await page
        .getByRole("button", { name: "Approve after hold", exact: true })
        .isEnabled()
    )
      throw Error("Recovery hold action incorrectly enabled");
    await page.screenshot({
      path: directory + `/recovery-${width}.png`,
      fullPage: true,
    });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      )
    )
      throw Error(`Recovery horizontal overflow at ${width}`);
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .getByLabel("Exact ID or selective literal prefix")
      .fill("support_fixture_site");
    await page
      .getByLabel("Exact ID or selective literal prefix")
      .press("Enter");
    await page.getByText("support_fixture_site", { exact: true }).waitFor();
    await page.screenshot({
      path: directory + `/search-${width}.png`,
      fullPage: true,
    });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw Error(`Support search overflow at ${width}`);
    await page.getByRole("button", { name: "Privacy", exact: true }).click();
    await page
      .getByText("Pending processor or backup adapters remain explicit", {
        exact: false,
      })
      .waitFor();
    await page.screenshot({
      path: directory + `/privacy-${width}.png`,
      fullPage: true,
    });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw Error(`Privacy overflow at ${width}`);
    await page.getByRole("button", { name: "Deliveries", exact: true }).click();
    await page.getByText("delivery_fixture_pending", { exact: true }).waitFor();
    await page.screenshot({
      path: directory + `/deliveries-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Billing", exact: true }).click();
    await page.getByText("No billing records are available.").waitFor();
    await page.close();
    console.log(
      `PASS staff component fixture ${width}px: pause fails closed, recovery hold disabled, support search, nested privacy exceptions, empty state, no horizontal overflow.`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
