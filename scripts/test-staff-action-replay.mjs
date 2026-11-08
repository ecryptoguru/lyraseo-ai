import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  req = createRequire(new URL("../package.json", import.meta.url)),
  vr = createRequire(req.resolve("vitest/package.json")),
  web = createRequire(
    new URL("../apps/lyraseo-web/package.json", import.meta.url),
  ),
  dbRequire = createRequire(
    new URL("../packages/db/package.json", import.meta.url),
  );
const { createServer } = await import(vr.resolve("vite")),
  { chromium } = web("@playwright/test"),
  { Pool } = dbRequire("pg");
const name =
  process.env.LYRA_SANDBOX_BILLING_TEST_DB ??
  readFileSync(root + "output/sandbox-billing-owned-db.txt", "utf8").trim();
if (!/^lyraseo_billing_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_BILLING_DATABASE_REQUIRED");
const admin = new Pool({
  connectionString: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
});
if (
  !(
    await admin.query(
      "SELECT EXISTS(SELECT FROM lyraseo_kernel.test_environment WHERE database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND postmaster_started_at=pg_postmaster_start_time()) yes",
    )
  ).rows[0].yes
)
  throw Error("CURRENT_OWNED_TEST_ENROLLMENT_REQUIRED");
const directory = root + "output/staff-action-replay";
mkdirSync(directory, { recursive: true });
writeFileSync(
  directory + "/auth.ts",
  `export async function requireStaffFor(){return globalThis[Symbol.for('lyraseo.staff.local.fixture')].actor;}export function staffDatabase(){return globalThis[Symbol.for('lyraseo.staff.local.fixture')].db;}`,
);
writeFileSync(
  directory + "/settings.ts",
  `export function authSettings(){return{origin:'http://127.0.0.1:3013'};}`,
);
let routes,
  lose = false;
const posted = [];
const attach = (server) => {
  server.middlewares.use("/api/admin", async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString();
      const input = text ? JSON.parse(text) : null;
      if (input) posted.push(input);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
      const url =
        "http://127.0.0.1:3013" + (req.originalUrl ?? "/api/admin" + req.url);
      const request = new Request(url, {
        method: req.method,
        headers,
        ...(text ? { body: text } : {}),
      });
      const response = await (req.method === "POST"
        ? routes.POST(request)
        : routes.GET(request));
      const body = await response.text();
      console.log(`FIXTURE_API ${req.method} ${url} ${response.status}`);
      if (
        false &&
        lose &&
        response.ok &&
        ["execute-request", "action"].includes(input?.kind)
      ) {
        writeInitial();
        lose = false;
        req.socket.destroy();
        return;
      }
      res.statusCode = response.status;
      for (const [k, v] of response.headers) res.setHeader(k, v);
      res.end(body);
    } catch (error) {
      res.statusCode = 500;
      res.end("Local fixture failed");
      console.error(error);
    }
  });
};

const server = await createServer({
  root,
  configFile: false,
  plugins: [
    { name: "fixture-staff-api", configureServer: attach },
    {
      name: "fixture-route-diagnostics",
      transform(code, id) {
        return id.endsWith("/api/admin/route.ts")
          ? code.replaceAll(
              "return failure(error);",
              'console.error("FIXTURE_ROUTE_ERROR",error instanceof Error?error.message:"unknown");return failure(error);',
            )
          : null;
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 3013,
    strictPort: true,
    watch: { ignored: ["**/output/staff-action-replay/index.html"] },
  },
  esbuild: { jsx: "automatic" },
  ssr: { noExternal: [/^@lyraseo\//] },
  resolve: {
    alias: [
      { find: "@/server/admin/staff", replacement: directory + "/auth.ts" },
      {
        find: "@/server/auth/settings",
        replacement: directory + "/settings.ts",
      },
      { find: "@", replacement: root + "apps/lyraseo-web/src" },
      {
        find: "react",
        replacement: root + "apps/lyraseo-web/node_modules/react",
      },
      {
        find: "react-dom",
        replacement: root + "apps/lyraseo-web/node_modules/react-dom",
      },
    ],
  },
});
let browser, db;
try {
  const { createDatabase } = await server.ssrLoadModule(
    "/packages/db/src/index.ts",
  );
  db = createDatabase(
    `postgresql://lyraseo_staff_executor:local_staff_executor_only@127.0.0.1:54329/${name}`,
  );
  routes = await server.ssrLoadModule(
    "/apps/lyraseo-web/src/app/api/admin/route.ts",
  );
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 375, 320]) {
    const nonce = randomUUID().replaceAll("-", ""),
      id = "replay_staff_" + nonce,
      subject = "replay_subject_" + nonce,
      now = new Date().toISOString();
    await admin.query('INSERT INTO "ProductUser"(id) VALUES($1),($2)', [
      id,
      subject,
    ]);
    await admin.query(
      'INSERT INTO "ProductSession"("sessionId","userId","securityVersion","createdAt","refreshedAt") VALUES($1,$2,0,now(),now())',
      ["session_" + nonce, id],
    );
    await admin.query(
      'INSERT INTO "StaffGrant"("userId",enabled) VALUES($1,true)',
      [id],
    );
    await admin.query(
      "INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES($1,'recovery:manage')",
      [id],
    );
    const actor = {
      userId: id,
      sessionId: "session_" + nonce,
      securityVersion: 0,
      authenticatedAt: now,
      mfaAuthenticatedAt: now,
      mfaVerified: true,
      authProvider: "supabase",
    };
    globalThis[Symbol.for("lyraseo.staff.local.fixture")] = { actor, db };
    let initial = (
      await db.$queryRaw`SELECT lyraseo_billing.staff_view(${JSON.stringify(actor)}::jsonb,'controls'::text,NULL::text,25::integer) value`
    )[0].value;
    const source =
      process.env.LYRA_REPLAY_UI_SOURCE ??
      "/apps/lyraseo-web/src/components/staff-console.tsx";
    const writeInitial = () =>
      writeFileSync(
        directory + "/index.html",
        `<!doctype html><html lang=en><meta name=viewport content="width=device-width,initial-scale=1"><title>Local staff replay fixture</title><body style="font-family:Arial;margin:16px"><main><h1>Local fixture: real API and restricted DB</h1><p>Controlled actor only; no real provider sign-in.</p><div id=root></div></main><script type=module>import{createRoot}from'react-dom/client';import{createElement}from'react';import{StaffConsole}from'${source}';createRoot(document.getElementById('root')).render(createElement(StaffConsole,{initial:${JSON.stringify(initial)}}));</script>`,
      );
    writeInitial();
    lose = false;
    posted.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    let dropAcknowledgement = true;
    await page.route("**/api/admin", async (route) => {
      const data = route.request().postDataJSON();
      if (
        dropAcknowledgement &&
        ["execute-request", "action"].includes(data?.kind)
      ) {
        const response = await route.fetch();
        if (!response.ok())
          throw Error("Fixture action was not committed successfully");
        dropAcknowledgement = false;
        await route.abort("failed");
      } else await route.continue();
    });
    const open = async () => {
      await page.getByRole("button", { name: "Recovery", exact: true }).click();
      await page
        .getByLabel("Reason for staff action")
        .fill("Controlled loss-after-commit recovery rehearsal");
      await page
        .getByLabel("Exact product user ID", { exact: true })
        .fill(subject);
      page.once("dialog", (d) => d.accept());
      await page
        .getByRole("button", { name: "Open rehearsal case", exact: true })
        .click();
    };
    await page.goto(
      "http://127.0.0.1:3013/output/staff-action-replay/index.html",
    );
    await page.waitForLoadState("networkidle");
    await open();
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("uncertain") ||
        document.body.innerText.includes("Failed to fetch"),
    );
    // A replacement, independently verified local fixture session must reveal the
    // original committed request without authorizing its old grant anew.
    actor.sessionId = "rotated_" + nonce;
    await admin.query(
      'INSERT INTO "ProductSession"("sessionId","userId","securityVersion","createdAt","refreshedAt") VALUES($1,$2,0,now(),now())',
      [actor.sessionId, id],
    );
    initial = (
      await db.$queryRaw`SELECT lyraseo_billing.staff_view(${JSON.stringify(actor)}::jsonb,'controls'::text,NULL::text,25::integer) value`
    )[0].value;
    writeInitial();
    await page.reload();
    await page.getByRole("button", { name: "Recovery", exact: true }).waitFor();
    if (
      await page
        .getByRole("button", { name: "Retry saved request", exact: true })
        .count()
    ) {
      await page
        .getByRole("button", { name: "Retry saved request", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Review request" })
        .waitFor();
    } else {
      await open();
      await page
        .getByRole("status")
        .filter({ hasText: "Saved VERIFYING" })
        .waitFor();
    }
    await page
      .getByRole("button", { name: "Acknowledge saved result", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "existing result is acknowledged" })
      .waitFor();
    const count = (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
        [id],
      )
    ).rows[0].n;
    if (count !== 1)
      throw Error(
        `LOST_RESPONSE_DUPLICATED_CASE count=${count} width=${width}`,
      );
    const replay = (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.staff_receipt WHERE staff_id=$1 AND outcome='REPLAY'",
        [id],
      )
    ).rows[0].n;
    if (replay !== 1) throw Error("SAFE_REPLAY_RECEIPT_REQUIRED");
    if (posted.some((body) => Object.hasOwn(body, "token")))
      throw Error("BROWSER_STEP_UP_SECRET_FORBIDDEN");
    const requests = posted
      .filter((body) => body.requestId)
      .map((body) => body.requestId);
    if (new Set(requests).size !== 1) throw Error("SAME_REQUEST_ID_REQUIRED");
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw Error("STAFF_REPLAY_HORIZONTAL_OVERFLOW");
    await page.screenshot({
      path: directory + `/resolved-${width}.png`,
      fullPage: true,
    });
    // A prepared request whose execute never reached the server is recoverable.
    const expiredId = randomUUID();
    await db.$queryRaw`SELECT lyraseo_billing.prepare_request(${JSON.stringify(actor)}::jsonb,${expiredId}::uuid,'recovery:open'::text,${subject}::text,'{}'::text,'Controlled expired prepared request'::text)`;
    await admin.query(
      "UPDATE lyraseo_billing.step_up SET expires_at=now()-interval '1 second' WHERE token_hash=(SELECT token_hash FROM lyraseo_billing.action_request WHERE id=$1)",
      [expiredId],
    );
    initial = (
      await db.$queryRaw`SELECT lyraseo_billing.staff_view(${JSON.stringify(actor)}::jsonb,'controls'::text,NULL::text,25::integer) value`
    )[0].value;
    writeInitial();
    await page.reload();
    await page
      .getByRole("button", { name: "Check saved request status", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "AUTHORIZATION_EXPIRED" })
      .waitFor();
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", {
        name: "Safely abandon unconsumed request",
        exact: true,
      })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "confirmed unconsumed and abandoned" })
      .waitFor();
    const remaining = (
      await db.$queryRaw`SELECT lyraseo_billing.staff_view(${JSON.stringify(actor)}::jsonb,'controls'::text,NULL::text,25::integer) value`
    )[0].value.pendingRequests;
    if (remaining.length) throw Error("EXPIRED_REQUEST_STILL_BLOCKS_STAFF");
    await page.screenshot({
      path: directory + `/abandoned-${width}.png`,
      fullPage: true,
    });
    await page.close();
    console.log(
      `PASS actual staff API+restrictedSQL ${width}px: response lost after commit, session replacement + refresh, same request replay, one case, safe retry receipt, expired prepare safely abandoned, no browser token.`,
    );
  }
} finally {
  if (browser) await browser.close();
  if (db) await db.$disconnect();
  await server.close();
  await admin.end();
  delete globalThis[Symbol.for("lyraseo.staff.local.fixture")];
}
