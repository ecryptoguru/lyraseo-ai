import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const name = process.env.LYRA_STAFF_JOB_DB;
if (!name || !/^lyraseo_staff_jobs_[a-f0-9]{16}$/.test(name))
  throw Error("OWNED_STAFF_JOB_DATABASE_REQUIRED");
const require = createRequire(new URL("../package.json", import.meta.url));
const viteRequire = createRequire(require.resolve("vitest/package.json"));
const { createServer } = await import(viteRequire.resolve("vite"));
const webRequire = createRequire(
  new URL("../apps/lyraseo-web/package.json", import.meta.url),
);
const dbRequire = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { chromium } = webRequire("@playwright/test");
const { Pool } = dbRequire("pg");
const admin = new Pool({
  connectionString: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
});
const dir = root + "output/staff-job-integrated";
mkdirSync(dir, { recursive: true });
const initial = {
  mode: "SANDBOX",
  recoveryMode: "LOCAL_REHEARSAL",
  productionCommerceEnabled: false,
  permissions: [],
  rows: [],
  nextCursor: null,
  limit: 25,
};
writeFileSync(
  dir + "/index.html",
  `<!doctype html><html lang="en"><head><title>Integrated staff fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px sans-serif;margin:16px}input,textarea{display:block;max-width:100%}button{margin:4px}section{overflow-wrap:anywhere}</style></head><body><main id="root"></main><script type="module">import {createRoot} from 'react-dom/client';import {createElement} from 'react';import {StaffConsole} from '/apps/lyraseo-web/src/components/staff-console.tsx';createRoot(document.getElementById('root')).render(createElement(StaffConsole,{initial:${JSON.stringify(initial)}}));</script></body></html>`,
);
let focusId = "",
  loseExecute = false,
  loseAllocate = false,
  lostAllocationId = null,
  preparePause = null,
  fixtureStaff,
  routeModule;
const server = await createServer({
  root,
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  esbuild: { jsx: "automatic" },
  ssr: { noExternal: ["@lyraseo/db"] },
  resolve: {
    alias: [
      {
        find: "@/server/admin/staff",
        replacement: root + "tests/fixtures/staff-job/staff-server.ts",
      },
      {
        find: "@/server/auth/settings",
        replacement: root + "tests/fixtures/staff-job/auth-settings.ts",
      },
      { find: "@", replacement: root + "apps/lyraseo-web/src" },
      {
        find: "react-dom",
        replacement: root + "apps/lyraseo-web/node_modules/react-dom",
      },
      {
        find: "react",
        replacement: root + "apps/lyraseo-web/node_modules/react",
      },
    ],
  },
  plugins: [
    {
      name: "fixture-api",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          try {
            if (req.url?.startsWith("/api/admin/jobs")) {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = Buffer.concat(chunks);
              const parsed = body.length ? JSON.parse(body.toString()) : null;
              const actorSnapshot = fixtureStaff.snapshotFixtureActor();
              if (parsed?.kind === "prepare" && preparePause) {
                const pause = preparePause;
                preparePause = null;
                pause.arrived();
                await pause.released;
              }
              const request = new Request(
                process.env.LYRA_STAFF_JOB_ORIGIN + req.url,
                {
                  method: req.method,
                  headers: req.headers,
                  ...(body.length ? { body } : {}),
                },
              );
              const response = await fixtureStaff.withFixtureActor(
                actorSnapshot,
                () => routeModule[req.method](request),
              );
              const payload = await response.text();
              res.writeHead(
                response.status,
                Object.fromEntries(response.headers),
              );
              res.end(payload);
              return;
            }
            if (req.url?.startsWith("/api/admin?")) {
              const view = new URL(req.url, "http://fixture").searchParams.get(
                "view",
              );
              const rows =
                view === "operations"
                  ? (
                      await admin.query(
                        'SELECT id,kind,status,provider,"attemptState" AS provider_attempt_state,fence,"leaseUntil" AS lease_until FROM "Operation" WHERE id=$1',
                        [focusId],
                      )
                    ).rows
                  : [];
              res.writeHead(200, {
                "content-type": "application/json",
                "cache-control": "private, no-store",
              });
              res.end(
                JSON.stringify({
                  ...initial,
                  permissions: ["jobs:manage"],
                  rows,
                }),
              );
              return;
            }
            next();
          } catch (error) {
            res.writeHead(500);
            res.end(String(error));
          }
        });
      },
    },
  ],
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw Error("SERVER_UNAVAILABLE");
process.env.LYRA_STAFF_JOB_ORIGIN = `http://127.0.0.1:${address.port}`;
routeModule = await server.ssrLoadModule(
  "/apps/lyraseo-web/src/app/api/admin/jobs/route.ts",
);
fixtureStaff = await server.ssrLoadModule(
  "/tests/fixtures/staff-job/staff-server.ts",
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
page.setDefaultTimeout(8000);
page.on("dialog", (dialog) => dialog.accept());
await page.route("**/api/admin/jobs", async (route) => {
  if (
    loseAllocate &&
    route.request().method() === "POST" &&
    route.request().postDataJSON()?.kind === "allocate"
  ) {
    loseAllocate = false;
    const committed = await route.fetch();
    assert.equal(committed.status(), 200);
    lostAllocationId = (await committed.json()).requestId;
    await route.abort("failed");
    return;
  }
  if (
    loseExecute &&
    route.request().method() === "POST" &&
    route.request().postDataJSON()?.kind === "execute"
  ) {
    loseExecute = false;
    const committed = await route.fetch();
    assert.equal(committed.status(), 200);
    await route.abort("failed");
    return;
  }
  await route.continue();
});
const base =
  process.env.LYRA_STAFF_JOB_ORIGIN + "/output/staff-job-integrated/index.html";
async function job(id) {
  focusId = id;
  await admin.query(
    'UPDATE "BudgetPeriod" SET reserved=reserved+1,"limit"=100 WHERE "userId"=$1',
    ["sponsor"],
  );
  await admin.query(
    `INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost",status,"expiresAt","leaseUntil",fence) VALUES ($1,'ws','site','sponsor','sponsorsession',0,'GENERATION','AZURE',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),'ui',$1,'hash','v1',1,'RUNNING',(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour',(clock_timestamp() AT TIME ZONE 'UTC')-interval '2 minutes',2)`,
    [id],
  );
}
async function open() {
  await page.goto(base);
  await page.getByRole("button", { name: "Operations" }).click();
  await page.getByLabel("Reason for operation action").waitFor();
}
async function start() {
  await page
    .getByLabel("Reason for operation action")
    .fill("Review fixture reason");
  await page.getByRole("button", { name: "Retry operation" }).click();
  await page
    .getByRole("button", { name: "Safely resolve pending request" })
    .waitFor();
}
async function awaitWaiters(n) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock'",
    );
    if (rows[0].n >= n) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("LOCK_TEST_TIMEOUT");
}
try {
  await admin.query(`DELETE FROM lyraseo_billing.staff_rate WHERE user_id='staff';
    INSERT INTO "ProductUser"(id) VALUES('ui-other');
    INSERT INTO "ProductSession" VALUES('ui-other-session','ui-other',0,now(),now());
    INSERT INTO "StaffGrant"("userId",enabled) VALUES('ui-other',true);
    INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES('ui-other','jobs:manage');
    INSERT INTO lyraseo_billing.job_test_session SELECT oid,pg_postmaster_start_time(),'ui-other','ui-other-session',0,now()+interval '5 minutes',false FROM pg_database WHERE datname=current_database();`);
  await job("ui-denied");
  await open();
  await page
    .getByRole("button", { name: "Retry operation" })
    .waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) =>
        button.textContent?.trim() === "Retry operation" && !button.disabled,
    ),
  );
  let deniedArrived, deniedRelease;
  const deniedPaused = new Promise((resolve) => {
    deniedArrived = resolve;
  });
  const deniedReleased = new Promise((resolve) => {
    deniedRelease = resolve;
  });
  preparePause = { arrived: deniedArrived, released: deniedReleased };
  await start();
  await deniedPaused;
  await admin.query(
    "UPDATE lyraseo_billing.staff_capability SET enabled=false WHERE user_id='staff' AND action='jobs:manage'",
  );
  deniedRelease();
  await page.getByText(/pending request is retained/).waitFor();
  await open();
  const resolveButton = page.getByRole("button", {
    name: "Safely resolve pending request",
  });
  await resolveButton.waitFor();
  assert.equal(await resolveButton.isDisabled(), true);
  await admin.query(
    "UPDATE lyraseo_billing.staff_capability SET enabled=true WHERE user_id='staff' AND action='jobs:manage'",
  );
  await open();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) =>
        button.textContent?.trim() === "Safely resolve pending request" &&
        !button.disabled,
    ),
  );
  await page.getByLabel("Reason for operation action").focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    "Check request status",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    "Safely resolve pending request",
  );
  await page.keyboard.press("Enter");
  await page.getByText(/safely closed/).waitFor();
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
    ),
    null,
  );
  await job("ui-allocation-lost");
  await open();
  loseAllocate = true;
  await page
    .getByLabel("Reason for operation action")
    .fill("Review fixture reason");
  await page.getByRole("button", { name: "Retry operation" }).click();
  await page.getByText(/No job action was started/).waitFor();
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
    ),
    null,
  );
  assert.ok(lostAllocationId);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM lyraseo_billing.job_allocation WHERE id=$1 AND staff_id=$2",
        [lostAllocationId, "staff"],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM lyraseo_billing.job_request WHERE id=$1",
        [lostAllocationId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await admin.query('SELECT status FROM "Operation" WHERE id=$1', [focusId]))
      .rows[0].status,
    "RUNNING",
  );
  await job("ui-account-race");
  await open();
  let arrived, release;
  const paused = new Promise((resolve) => {
    arrived = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  preparePause = { arrived, released };
  await start();
  await paused;
  const foreignRef = await page.evaluate(() =>
    sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
  );
  assert.ok(foreignRef);
  const foreignId = JSON.parse(foreignRef).requestId;
  assert.equal(
    (
      await admin.query(
        "SELECT staff_id FROM lyraseo_billing.job_allocation WHERE id=$1",
        [foreignId],
      )
    ).rows[0].staff_id,
    "staff",
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM lyraseo_billing.job_request WHERE id=$1",
        [foreignId],
      )
    ).rows[0].n,
    0,
  );
  fixtureStaff.setFixtureActor("ui-other", "ui-other-session", 0);
  await open();
  await page
    .getByRole("button", { name: "Safely resolve pending request" })
    .click();
  await page.getByText(/pending request remains saved/).waitFor();
  assert.ok(
    await page.evaluate(() =>
      sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
    ),
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM lyraseo_billing.closed_job_request WHERE id=$1",
        [foreignId],
      )
    ).rows[0].n,
    0,
  );
  release();
  for (let i = 0; i < 100; i++) {
    if (
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM lyraseo_billing.job_request WHERE id=$1",
          [foreignId],
        )
      ).rows[0].n === 1
    )
      break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(
    (
      await admin.query(
        "SELECT staff_id FROM lyraseo_billing.job_request WHERE id=$1",
        [foreignId],
      )
    ).rows[0].staff_id,
    "staff",
  );
  fixtureStaff.setFixtureActor("staff", "staffsession", 0);
  await open();
  await page
    .getByRole("button", { name: "Safely resolve pending request" })
    .click();
  await page.getByText(/safely closed/).waitFor();
  assert.equal(
    (
      await admin.query(
        "SELECT staff_id FROM lyraseo_billing.closed_job_request WHERE id=$1",
        [foreignId],
      )
    ).rows[0].staff_id,
    "staff",
  );
  for (const kind of ["conflict", "terminal"]) {
    await job("ui-" + kind);
    await open();
    if (kind === "conflict")
      await admin.query('UPDATE "Operation" SET fence=3 WHERE id=$1', [
        focusId,
      ]);
    else
      await admin.query(
        "UPDATE \"Operation\" SET status='COMPLETED' WHERE id=$1",
        [focusId],
      );
    await start();
    await page.getByText(/pending request is retained/).waitFor();
    await open();
    await page
      .getByRole("button", { name: "Safely resolve pending request" })
      .click();
    await page.getByText(/safely closed/).waitFor();
  }
  await job("ui-lost");
  await open();
  loseExecute = true;
  await start();
  try {
    await page.getByText(/pending request is retained/).waitFor();
  } catch (error) {
    console.error("LOST_RESPONSE_UI", await page.locator("body").innerText());
    throw error;
  }
  const saved = await page.evaluate(() =>
    sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
  );
  assert.ok(
    saved &&
      !saved.includes("Review fixture reason") &&
      !saved.includes("token"),
  );
  await admin.query(
    "UPDATE lyraseo_billing.staff_capability SET enabled=false WHERE user_id='staff' AND action='jobs:manage'",
  );
  const deniedResult = await page.evaluate(async (requestId) => {
    const response = await fetch("/api/admin/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "resolve", requestId }),
    });
    return { status: response.status, body: await response.text() };
  }, JSON.parse(saved).requestId);
  assert.equal(deniedResult.status, 403);
  assert.equal(deniedResult.body.includes("ui-lost"), false);
  assert.ok(
    await page.evaluate(() =>
      sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
    ),
  );
  await admin.query(
    "UPDATE lyraseo_billing.staff_capability SET enabled=true WHERE user_id='staff' AND action='jobs:manage'",
  );
  await admin.query(`UPDATE "ProductUser" SET "securityVersion"=1 WHERE id='staff';
    UPDATE lyraseo_billing.job_test_session SET revoked=true WHERE user_id='staff' AND session_id='staffsession';
    INSERT INTO "ProductSession" VALUES('ui-rotated-session','staff',1,now(),now());
    INSERT INTO lyraseo_billing.job_test_session SELECT oid,pg_postmaster_start_time(),'staff','ui-rotated-session',1,now()+interval '5 minutes',false FROM pg_database WHERE datname=current_database();`);
  const oldResponse = await page.evaluate(async (p) => {
    const response = await fetch("/api/admin/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "execute",
        ...p,
        reason: "Review fixture reason",
      }),
    });
    return response.status;
  }, JSON.parse(saved));
  assert.equal(oldResponse, 403);
  fixtureStaff.setFixtureActor("ui-other", "ui-other-session", 0);
  await open();
  await page
    .getByRole("button", { name: "Safely resolve pending request" })
    .click();
  await page.getByText(/pending request remains saved/).waitFor();
  assert.ok(
    await page.evaluate(() =>
      sessionStorage.getItem("lyraseo-staff-job-pending-v1"),
    ),
  );
  fixtureStaff.setFixtureActor("staff", "ui-rotated-session", 1);
  await open();
  await page
    .getByRole("button", { name: "Safely resolve pending request" })
    .click();
  await page.getByText(/Job QUEUED/).waitFor();
  await job("ui-overlap");
  await open();
  const lock = await admin.connect();
  await lock.query("BEGIN");
  await lock.query('SELECT id FROM "Operation" WHERE id=$1 FOR UPDATE', [
    focusId,
  ]);
  try {
    await start();
    await awaitWaiters(1);
    await open();
    await page
      .getByRole("button", { name: "Safely resolve pending request" })
      .click({ noWaitAfter: true });
    await awaitWaiters(2);
    await lock.query("COMMIT");
    await page.getByText(/Job QUEUED/).waitFor();
  } finally {
    await lock.query("ROLLBACK").catch(() => {});
    lock.release();
  }
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: dir + `/${width}.png`, fullPage: true });
  }
  console.log(
    "PASS integrated staff console + actual route + restricted PostgreSQL: allocation lost-ack and delayed-prepare account switch, denied permission, stale fence, terminal, lost response, rotated security version, other-user denial, overlap, reload and responsive widths",
  );
} finally {
  await page.close();
  await browser.close();
  await fixtureStaff.closeFixtureStaffDatabase();
  await server.close();
  await admin.end();
}
