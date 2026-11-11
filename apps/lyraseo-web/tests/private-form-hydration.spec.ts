import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const rootRequire = createRequire(resolve("../../package.json"));
const viteRequire = createRequire(
  createRequire(rootRequire.resolve("vitest/package.json")).resolve(
    "vite/package.json",
  ),
);
const { build } = viteRequire("esbuild");
const context = {
  audience: "Known audience",
  positioning: "",
  conversionGoal: "",
  brandName: "Example",
  approvedAliases: [],
  competitors: [],
  keyPages: [],
  supportedClaims: [],
  editorialPreferences: "",
};
const revision = {
  id: "r",
  revision: 1,
  content: context,
  reviewedBy: "u",
  reviewedAt: "2026-11-02T00:00:00Z",
};
const exactUrl = "https://example.com/in/product?plan=team&lang=en";
const savedAudits = ["before", "after"].map((id) => ({
  id,
  status: "COMPLETED",
  createdAt: "2026-11-02T00:00:00Z",
}));
const pageDetail = {
  page: {
    id: "page",
    originalUrl: exactUrl,
    normalizedUrl: exactUrl,
    revision: 1,
    assignedTo: null,
  },
  actor: { userId: "owner", canEdit: true },
  historyLimit: 100,
  history: [],
  context: null,
  audits: [],
  search: { source: "Google Search Console", opportunities: [], snapshots: [] },
  drafts: [],
  reports: [],
  ai: { message: "No page-attributed presence is inferred." },
};

type Surface = {
  module: string;
  symbol: string;
  props: Record<string, unknown>;
  fields: Record<string, string>;
  readyText: string;
  loadedText?: string;
  action: string;
  preparing: string;
};
const surfaces: Surface[] = [
  {
    module: "content-workspace",
    symbol: "ContentWorkspace",
    props: { workspaceId: "a", siteId: "site", editable: true },
    fields: {
      "#draft-body": "My reviewed Markdown body",
      "#draft-assumptions": "Verify the supported claim",
      "#draft-title": "Independent draft title",
      "#report-title": "Independent private report title",
    },
    readyText: "Evidence and editable draft",
    loadedText:
      "Choose saved evidence, draft your changes and save a reviewed revision.",
    action: "Save draft with evidence",
    preparing: "Preparing draft and report controls…",
  },
  {
    module: "page-workspace",
    symbol: "PageWorkspace",
    props: {
      workspaceId: "a",
      siteId: "site",
      origin: "https://example.com",
      editable: true,
    },
    fields: { "#registered-url": exactUrl },
    readyText: "Pages",
    loadedText:
      "Register an exact URL to keep its evidence and changes together.",
    action: "Register page",
    preparing: "Preparing page registration…",
  },
  {
    module: "site-settings",
    symbol: "SiteSettings",
    props: {
      workspaceId: "a",
      siteId: "site",
      editable: true,
      manager: false,
      enabled: false,
      verifiedAt: null,
      initialRevisions: [revision],
    },
    fields: {
      "#context-audience": "Reviewed audience edit",
      "#context-conversionGoal": "Request a product demo",
    },
    readyText: "Reviewed site context",
    action: "Save reviewed context",
    preparing: "Preparing reviewed context editor…",
  },
  {
    module: "persisted-audits",
    symbol: "PersistedAudits",
    props: {
      workspaceId: "a",
      siteId: "site",
      origin: "https://example.com",
      editable: true,
      enabled: true,
    },
    fields: { "#audit-pages": `https://example.com/\n${exactUrl}` },
    readyText: "Audit selected pages",
    loadedText: "Choose an audit to inspect its evidence.",
    action: "Confirm pages and start audit",
    preparing: "Preparing audit controls…",
  },
];

// The real production React server renderer and hydrateRoot render each actual
// component. Only saved reads are controlled; no customer route or auth seam exists.
async function mount(page: Page, surface: Surface, detail = false) {
  const imported = `import {${surface.symbol} as Component} from './src/components/${surface.module}';`;
  const element = `<Component {...${JSON.stringify({ ...surface.props, ...(detail ? { pageId: "page" } : {}) })}}/>`;
  const options = {
    bundle: true,
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  };
  const server = await build({
    ...options,
    stdin: {
      contents: `import {renderToString} from 'react-dom/server';${imported}console.log(renderToString(${element}));`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    platform: "node",
    format: "cjs",
  });
  const markup = execFileSync(process.execPath, ["-"], {
    input: server.outputFiles[0].text,
    encoding: "utf8",
    maxBuffer: 10e6,
  });
  const client = await build({
    ...options,
    stdin: {
      contents: `import {hydrateRoot} from 'react-dom/client';import {flushSync} from 'react-dom';${imported}window.hydratePrivateForm=()=>flushSync(()=>hydrateRoot(document.getElementById('fixture'),${element}));`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    format: "iife",
  });
  const html = await (await page.request.get("/sign-in")).text();
  const styles = (html.match(/<link[^>]+rel="stylesheet"[^>]*>/g) ?? []).join(
    "",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releaseSavedReads!: () => void, releaseBranding!: () => void;
  const readsReady = new Promise<void>((resolve) => {
    releaseSavedReads = resolve;
  });
  const brandingReady = new Promise<void>((resolve) => {
    releaseBranding = resolve;
  });
  const releaseReads = () => {
    releaseSavedReads();
    releaseBranding();
  };
  const brandingReads: string[] = [];
  const reads: string[] = [],
    commands: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") {
      commands.push(route.request().postDataJSON());
      return route.fulfill({
        status: 500,
        json: { error: "Unexpected mutation in hydration test" },
      });
    }
    const url = new URL(route.request().url());
    const path = url.pathname;
    const branding =
      path === "/api/reports" &&
      url.searchParams.get("brandingOptions") === "1";
    (branding ? brandingReads : reads).push(path);
    await (branding ? brandingReady : readsReady);
    const value = branding
      ? { choices: [{ revision: 1, displayName: "Approved brand" }] }
      : path === "/api/pages"
        ? detail
          ? pageDetail
          : { pages: [] }
        : path === "/api/search"
          ? { snapshots: [] }
          : path === "/api/audits"
            ? savedAudits
            : path === "/api/sites"
              ? [revision]
              : [];
    await route.fulfill({ json: value });
  });
  await page.route("**/__private-form-hydration", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Controlled private form hydration</title>${styles}</head><body><main class="pilot-page"><h1>Private workspace hydration</h1><div id="fixture">${markup}</div></main></body></html>`,
    }),
  );
  await page.goto("/__private-form-hydration");
  await page.addScriptTag({
    content: `window.process={env:{}};${client.outputFiles[0].text}`,
  });
  expect(errors, "actual-component browser bundle boot").toEqual([]);
  return {
    releaseReads,
    releaseSavedReads,
    releaseBranding,
    reads,
    brandingReads,
    commands,
    errors,
  };
}
async function hydrate(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { hydratePrivateForm: () => void }
    ).hydratePrivateForm(),
  );
}
async function checkLayout(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}

for (const surface of surfaces) {
  test(`${surface.symbol} rejects prehydration edits and preserves hydrated edits across saved reads`, async ({
    page,
  }, testInfo: TestInfo) => {
    const fixture = await mount(page, surface);
    try {
      await expect(
        page.getByRole("heading", { name: surface.readyText, exact: true }),
      ).toBeVisible();
      const action = page.getByRole("button", {
        name: surface.action,
        exact: true,
      });
      expect.soft(await action.isDisabled()).toBe(true);
      expect
        .soft(await page.getByRole("status").allTextContents())
        .toContain(surface.preparing);
      const earlyValues: Record<string, string> = {};
      for (const [selector, value] of Object.entries(surface.fields)) {
        const field = page.locator(selector);
        const initial = await field.inputValue();
        expect
          .soft(
            await field.isDisabled(),
            `${selector} must be natively disabled in SSR`,
          )
          .toBe(true);
        await field.scrollIntoViewIfNeeded();
        const bounds = (await field.boundingBox())!;
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + 12);
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.insertText(value);
        earlyValues[selector] = await field.inputValue();
        expect
          .soft(
            earlyValues[selector],
            `${selector} rejects real early keyboard input`,
          )
          .toBe(initial);
      }
      // Declarations and comparison controls emitted by SSR share the same gate.
      if (surface.symbol === "PersistedAudits") {
        await page
          .getByText("Review optional audit declarations", { exact: true })
          .click();
        expect
          .soft(
            await page
              .getByLabel("Display brand", { exact: true })
              .isDisabled(),
          )
          .toBe(true);
      }
      if (surface.symbol === "ContentWorkspace")
        expect
          .soft(
            await page
              .getByRole("checkbox", {
                name: "Include a frozen before/after comparison",
              })
              .isDisabled(),
          )
          .toBe(true);
      await checkLayout(page);
      await page.screenshot({
        path: testInfo.outputPath("private-form-preparing.png"),
        fullPage: true,
      });
      await hydrate(page);
      for (const selector of Object.keys(surface.fields)) {
        await expect(page.locator(selector)).toBeEnabled();
        expect
          .soft(
            await page.locator(selector).inputValue(),
            `${selector} must not silently lose an accepted edit during hydration`,
          )
          .toBe(earlyValues[selector]);
      }
      await expect(
        page.getByText(surface.preparing, { exact: true }),
      ).toHaveCount(0);
      fixture.releaseReads();
      if (surface.symbol === "SiteSettings")
        await page
          .locator("#context-positioning")
          .fill("Secondary field render");
      if (surface.loadedText)
        await expect(
          page.getByText(surface.loadedText, { exact: true }),
        ).toBeVisible();
      for (const selector of Object.keys(surface.fields))
        expect
          .soft(
            await page.locator(selector).inputValue(),
            `${selector} must not lose an accepted edit on saved-read rerender`,
          )
          .toBe(earlyValues[selector]);
      expect(fixture.commands).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally {
      fixture.releaseReads();
    }
  });

  test(`${surface.symbol} owns edits before optional saved reads finish`, async ({
    page,
  }, testInfo) => {
    const fixture = await mount(page, surface);
    try {
      await hydrate(page);
      for (const [selector, value] of Object.entries(surface.fields)) {
        await expect(page.locator(selector)).toBeEnabled();
        await page.locator(selector).fill(value);
        await expect(page.locator(selector)).toBeFocused();
      }
      if (surface.symbol === "SiteSettings") {
        await page
          .getByRole("button", { name: "Refresh history, keep draft" })
          .click();
        await expect.poll(() => fixture.reads.length).toBe(1);
      } else
        await expect
          .poll(() => fixture.reads.length)
          .toBe(surface.symbol === "ContentWorkspace" ? 4 : 1);
      if (surface.symbol === "ContentWorkspace") {
        await expect
          .poll(() => fixture.brandingReads)
          .toEqual(["/api/reports"]);
        expect([...fixture.reads].sort()).toEqual([
          "/api/audits",
          "/api/content",
          "/api/reports",
          "/api/search",
        ]);
      }
      // The readiness gate ends before these held network reads complete.
      for (const [selector, value] of Object.entries(surface.fields))
        await expect(page.locator(selector)).toHaveValue(value);
      fixture.releaseSavedReads();
      if (surface.loadedText)
        await expect(
          page.getByText(surface.loadedText, { exact: true }),
        ).toBeVisible();
      else
        await expect(
          page.getByText(/History refreshed\. Your unsaved draft is preserved/),
        ).toBeVisible();
      if (surface.symbol === "ContentWorkspace") {
        await expect(
          page.getByText(
            "Loading approved workspace branding. Lyraseo reports remain available.",
          ),
        ).toBeVisible();
        for (const [selector, value] of Object.entries(surface.fields))
          await expect(page.locator(selector)).toHaveValue(value);
        fixture.releaseBranding();
        await expect(
          page
            .locator("#report-branding")
            .getByRole("option", { name: "Approved brand · version 1" }),
        ).toHaveCount(1);
        for (const [selector, value] of Object.entries(surface.fields))
          await expect(page.locator(selector)).toHaveValue(value);
        await page.locator("#draft-title").fill("Second-field draft update");
        await expect(page.locator("#draft-body")).toHaveValue(
          surface.fields["#draft-body"],
        );
        await expect(page.locator("#draft-assumptions")).toHaveValue(
          surface.fields["#draft-assumptions"],
        );
        await expect(page.locator("#report-title")).toHaveValue(
          surface.fields["#report-title"],
        );
        await page
          .getByRole("checkbox", {
            name: "Include a frozen before/after comparison",
          })
          .check();
        await page.locator("#report-before").focus();
        await expect(page.locator("#report-before")).toBeFocused();
      } else if (surface.symbol === "SiteSettings") {
        await page
          .locator("#context-positioning")
          .fill("Second-field positioning update");
        for (const [selector, value] of Object.entries(surface.fields))
          await expect(page.locator(selector)).toHaveValue(value);
      } else if (surface.symbol === "PersistedAudits") {
        await page
          .getByText("Review optional audit declarations", { exact: true })
          .click();
        await page
          .getByLabel("Display brand", { exact: true })
          .fill("Reviewed brand");
        await expect(page.locator("#audit-pages")).toHaveValue(
          surface.fields["#audit-pages"],
        );
      }
      await checkLayout(page);
      await page.screenshot({
        path: testInfo.outputPath("private-form-ready.png"),
        fullPage: true,
      });
      expect(fixture.errors).toEqual([]);
      expect(fixture.commands).toEqual([]);
    } finally {
      fixture.releaseReads();
    }
  });
}

test("page journal is absent from SSR and appears only after hydrated saved detail loads", async ({
  page,
}) => {
  const fixture = await mount(page, surfaces[1], true);
  try {
    await expect(page.locator("#page-change-note")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Assign to me", exact: true }),
    ).toHaveCount(0);
    await hydrate(page);
    await expect.poll(() => fixture.reads.length).toBe(2);
    await expect(page.locator("#page-change-note")).toHaveCount(0);
    fixture.releaseReads();
    const note = page.locator("#page-change-note");
    await expect(note).toBeEnabled();
    await note.fill("Reviewed client-created change note");
    await expect(note).toHaveValue("Reviewed client-created change note");
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.releaseReads();
  }
});
