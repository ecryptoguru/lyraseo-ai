import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const root = resolve(__dirname, "../../../..");
const rootRequire = createRequire(join(root, "package.json")),
  fromVitest = createRequire(rootRequire.resolve("vitest/package.json")),
  fromVite = createRequire(fromVitest.resolve("vite/package.json"));
const esbuild = fromVite("esbuild") as {
  build: (options: Record<string, unknown>) => Promise<unknown>;
};
type Command = {
  ruleId: string;
  scopeKey: string;
  expectedRevision: number;
  assigneeUserId: string | null;
  idempotencyKey: string;
};
type Saved = {
  id: string;
  ruleId: string;
  scopeKey: string;
  revision: number;
  assigneeUserId: string | null;
};
const target = { ruleId: "rule-old", scopeKey: "https://fixture.example/old" };
let directory: string, bundle: string, css: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "lyraseo-issue-controls-"));
  const component = join(
    root,
    "apps/lyraseo-web/src/components/issue-assignment.tsx",
  );
  await writeFile(
    join(directory, "entry.tsx"),
    `import{createRoot}from'react-dom/client';import{IssueAssignment}from${JSON.stringify(component)};createRoot(document.getElementById('root')).render(<main className="pilot-page"><h1>Synthetic assignment recovery fixture</h1><section className="pilot-card"><ul><li><IssueAssignment workspaceId="fixture" siteId="site" auditId="audit" ruleId="rule-old" scopeKey="https://fixture.example/old" assignees={[{userId:'owner',role:'OWNER'},{userId:'editor',role:'EDITOR'},{userId:'other',role:'EDITOR'}]}/></li></ul></section></main>);`,
  );
  await esbuild.build({
    entryPoints: [join(directory, "entry.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    nodePaths: [join(root, "apps/lyraseo-web/node_modules")],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    outfile: join(directory, "bundle.js"),
  });
  bundle = await readFile(join(directory, "bundle.js"), "utf8");
  css = (
    await readFile(join(root, "apps/lyraseo-web/src/app/globals.css"), "utf8")
  ).replace('@import "tailwindcss";', "");
});
test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(many = false) {
  const rows: Saved[] = [
    {
      id: "oldest",
      ...target,
      revision: many ? 7 : 1,
      assigneeUserId: many ? "other" : "owner",
    },
  ];
  if (many)
    for (let i = 0; i < 100; i++)
      rows.push({
        id: `newer-${i}`,
        ruleId: `newer-${i}`,
        scopeKey: `https://fixture.example/${i}`,
        revision: 1,
        assigneeUserId: "owner",
      });
  const requests: Command[] = [],
    receipts = new Map<string, { body: string; row: Saved }>();
  let dropNext = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end(
        '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic assignment fixture</title><link rel="stylesheet" href="/style.css"></head><body style="--font-inter:Arial;--font-manrope:Arial"><div id="root"></div><script src="/bundle.js"></script></body></html>',
      );
      return;
    }
    if (url.pathname === "/style.css") {
      response.setHeader("content-type", "text/css");
      response.end(css);
      return;
    }
    if (url.pathname === "/bundle.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(bundle);
      return;
    }
    if (url.pathname !== "/api/assignments") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      const ruleId = url.searchParams.get("ruleId"),
        scopeKey = url.searchParams.get("scopeKey");
      response.end(
        JSON.stringify(
          ruleId && scopeKey
            ? (rows.find(
                (row) => row.ruleId === ruleId && row.scopeKey === scopeKey,
              ) ?? null)
            : [...rows].reverse().slice(0, 100),
        ),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const command = JSON.parse(body) as Command;
    requests.push(command);
    const prior = receipts.get(command.idempotencyKey),
      row = rows.find(
        (row) =>
          row.ruleId === command.ruleId && row.scopeKey === command.scopeKey,
      )!;
    if (prior) {
      if (prior.body !== body) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: "Changed retry payload." }));
        return;
      }
      response.end(JSON.stringify(prior.row));
      return;
    }
    if (command.expectedRevision !== row.revision) {
      response.statusCode = 409;
      response.end(
        JSON.stringify({
          error:
            "Revision conflict. Refresh and review the current assignment.",
        }),
      );
      return;
    }
    row.revision++;
    row.assigneeUserId = command.assigneeUserId;
    receipts.set(command.idempotencyKey, { body, row: { ...row } });
    if (dropNext) {
      dropNext = false;
      response.end('{"acknowledgement":');
      return;
    }
    response.end(JSON.stringify(row));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture listener unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    rows,
    drop: () => {
      dropNext = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
test("exact identity displays and saves an assignment older than the newest100", async ({
  page,
}) => {
  const state = await fixture(true);
  try {
    await page.goto(state.url);
    await expect(
      page.getByRole("combobox", { name: "Issue assignee" }),
    ).toHaveValue("other");
    await page
      .getByRole("combobox", { name: "Issue assignee" })
      .selectOption("editor");
    await page.getByRole("button", { name: "Save issue assignment" }).click();
    await expect.poll(() => state.rows[0].revision).toBe(8);
    expect(state.requests[0].expectedRevision).toBe(7);
    expect(state.rows[0].assigneeUserId).toBe("editor");
  } finally {
    await state.close();
  }
});
test("two managers refresh a conflict without losing the proposed assignee or overwriting silently", async ({
  page,
  context,
}) => {
  const state = await fixture(),
    other = await context.newPage();
  try {
    await page.goto(state.url);
    await other.goto(state.url);
    await expect(
      page.getByRole("combobox", { name: "Issue assignee" }),
    ).toHaveValue("owner");
    await expect(
      other.getByRole("combobox", { name: "Issue assignee" }),
    ).toHaveValue("owner");
    await other
      .getByRole("combobox", { name: "Issue assignee" })
      .selectOption("other");
    await other.getByRole("button", { name: "Save issue assignment" }).click();
    await expect.poll(() => state.rows[0].revision).toBe(2);
    await page
      .getByRole("combobox", { name: "Issue assignee" })
      .selectOption("editor");
    await page.getByRole("button", { name: "Save issue assignment" }).click();
    const refresh = page.getByRole("button", {
      name: "Refresh assignment and review changes",
    });
    await expect(refresh).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await refresh.click();
    await expect(
      page.getByRole("combobox", { name: "Issue assignee" }),
    ).toHaveValue("editor");
    await expect(
      page.getByRole("button", { name: "Save issue assignment" }),
    ).toBeEnabled();
    expect(state.requests).toHaveLength(2);
    expect(state.rows[0].assigneeUserId).toBe("other");
    await page.getByRole("button", { name: "Save issue assignment" }).click();
    await expect.poll(() => state.rows[0].revision).toBe(3);
    expect(state.requests[2].expectedRevision).toBe(2);
    expect(state.requests[2].idempotencyKey).not.toBe(
      state.requests[1].idempotencyKey,
    );
    expect(state.rows[0].assigneeUserId).toBe("editor");
  } finally {
    await other.close();
    await state.close();
  }
});
test("a committed write with a lost acknowledgement retries the identical command and key", async ({
  page,
}) => {
  const state = await fixture();
  try {
    await page.goto(state.url);
    await expect(
      page.getByRole("combobox", { name: "Issue assignee" }),
    ).toHaveValue("owner");
    await page
      .getByRole("combobox", { name: "Issue assignee" })
      .selectOption("editor");
    state.drop();
    await page.getByRole("button", { name: "Save issue assignment" }).click();
    await expect.poll(() => state.requests.length).toBe(1);
    await expect.poll(() => state.rows[0].revision).toBe(2);
    const retry = page.getByRole("button", {
      name: /^(Save issue assignment|Retry saved assignment)$/,
    });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => state.requests.length).toBe(2);
    expect(state.requests[1]).toEqual(state.requests[0]);
    await expect(page.getByRole("status")).toContainText(
      "Issue assignment saved",
    );
    expect(state.rows[0].revision).toBe(2);
  } finally {
    await state.close();
  }
});
