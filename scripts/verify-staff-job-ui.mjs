import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const viteRequire = createRequire(require.resolve("vitest/package.json"));
const { createServer } = await import(viteRequire.resolve("vite"));
const webRequire = createRequire(
  new URL("../apps/lyraseo-web/package.json", import.meta.url),
);
const { chromium } = webRequire("@playwright/test");
mkdirSync(root + "output/staff-job-ui", { recursive: true });
writeFileSync(
  root + "output/staff-job-ui/index.html",
  `<!doctype html><html lang="en"><head><title>Local staff job fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px sans-serif;margin:16px}button,textarea{max-width:100%;margin:4px}section{overflow-wrap:anywhere}</style></head><body><main id="root"></main><script type="module">import {createRoot} from 'react-dom/client';import {createElement} from 'react';import {StaffJobControls} from '/apps/lyraseo-web/src/components/staff-job-controls.tsx';createRoot(document.getElementById('root')).render(createElement(StaffJobControls,{rows:[{id:'fixture-job',status:'RUNNING',fence:3,provider_attempt_state:'NONE',lease_until:'2026-01-01'}],permissions:['jobs:manage'],onChanged:async()=>{}}));</script></body></html>`,
);
const server = await createServer({
  root,
  configFile: false,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      react: root + "apps/lyraseo-web/node_modules/react",
      "react-dom": root + "apps/lyraseo-web/node_modules/react-dom",
    },
  },
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw Error("SERVER_UNAVAILABLE");
const url = `http://127.0.0.1:${address.port}/output/staff-job-ui/index.html`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 375, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    let storedResult = null;
    let requestCount = 0;
    let received;
    await page.route("**/api/admin/jobs*", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        const requestId = new URL(request.url()).searchParams.get("requestId");
        await route.fulfill({
          json: requestId
            ? storedResult
              ? { state: "COMPLETE", result: storedResult }
              : { state: "PENDING" }
            : { available: true, profile: "LOCAL_REHEARSAL" },
        });
      } else {
        const body = request.postDataJSON();
        assert.equal("token" in body, false);
        if (body.kind === "allocate") {
          await route.fulfill({
            json: { requestId: "d9f64202-42a4-4f86-8644-dd3a2feb0fe1" },
          });
          return;
        }
        if (body.kind === "prepare") {
          await route.fulfill({ json: { prepared: true } });
          return;
        }
        requestCount++;
        received = body;
        storedResult = {
          id: body.target,
          status: "QUEUED",
          fence: 4,
          reconciliationRequired: false,
          delivery: "UNAVAILABLE",
        };
        await route.abort("failed");
      }
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(url);
    const retry = page.getByRole("button", { name: "Retry operation" });
    await retry.waitFor();
    await page
      .getByLabel("Reason for operation action")
      .fill("Investigate reported failure");
    await retry.click();
    await page.getByRole("button", { name: "Check request status" }).waitFor();
    for (let wait = 0; wait < 100 && requestCount === 0; wait++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requestCount, 1);
    const pending = await page.evaluate(() =>
      sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
    );
    assert.ok(pending);
    assert.equal(pending.includes("Investigate reported failure"), false);
    assert.equal(pending.includes("token"), false);
    assert.equal(JSON.parse(pending).requestId, received.requestId);
    await page.reload();
    await page.getByRole("button", { name: "Check request status" }).click();
    await page.getByText(/Job QUEUED/).waitFor();
    assert.equal(requestCount, 1);
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
      ),
      null,
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: root + `output/staff-job-ui/${width}.png`,
      fullPage: true,
    });
    await page.close();
  }
  const unavailablePage = await browser.newPage({
    viewport: { width: 375, height: 900 },
  });
  await unavailablePage.route("**/api/admin/jobs*", (route) =>
    route.fulfill({ json: { available: false, profile: "LOCAL_REHEARSAL" } }),
  );
  await unavailablePage.goto(url);
  await unavailablePage.getByText(/qualified provider-session proof/).waitFor();
  assert.equal(
    await unavailablePage
      .getByRole("button", { name: "Retry operation" })
      .isDisabled(),
    true,
  );
  assert.equal(
    await unavailablePage
      .getByRole("button", { name: "Cancel operation" })
      .isDisabled(),
    true,
  );
  await unavailablePage.keyboard.press("Tab");
  assert.equal(
    await unavailablePage.evaluate(() => document.activeElement?.id),
    "staff-job-reason",
  );
  await unavailablePage.close();
  console.log(
    "PASS unqualified issuer leaves job controls disabled and keyboard reaches the labelled reason field",
  );
  console.log(
    "PASS local component lost-response recovery, token-free storage and desktop/mobile layout (1440/375/320)",
  );
} finally {
  await browser.close();
  await server.close();
}
