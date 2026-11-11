import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import type { Actor } from "../../packages/db/src/context";
const seams = vi.hoisted(() => ({
  db: null as unknown,
  actor: null as unknown,
}));
vi.mock("@/server/auth/server", () => ({
  database: () => seams.db,
  resolveActor: async () => seams.actor,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
import { POST } from "../../apps/lyraseo-web/src/app/api/visibility/route";

const name = process.env.LYRA_OBSERVATION_DB;
if (!name || !/^lyraseo_ledger_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_OBSERVATION_DATABASE_REQUIRED");
const url = (u: string, p: string) =>
  `postgresql://${u}:${p}@127.0.0.1:54329/${name}`;
const admin = createDatabase(url("postgres", "lyraseo_local_only"));
const runtime = createDatabase(url("lyraseo_runtime", "local_runtime_only"));
const actor: Actor = {
  userId: "route-preview-user",
  sessionId: "route-preview-session",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: false,
  authProvider: "supabase",
};
const scope = { workspaceId: "route-preview-w", siteId: "route-preview-s" };
const input = {
  ...scope,
  action: "preview-run",
  panelId: "route-preview-panel",
  profile: "azure-sol-api",
};
const request = (body: unknown, origin = "http://127.0.0.1:3000") =>
  new Request(origin + "/api/visibility", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeAll(async () => {
  seams.db = runtime;
  seams.actor = actor;
  await admin.productUser.create({ data: { id: actor.userId } });
  await admin.workspace.create({
    data: { id: scope.workspaceId, name: "Route preview" },
  });
  await admin.membership.create({
    data: {
      workspaceId: scope.workspaceId,
      userId: actor.userId,
      role: "OWNER",
    },
  });
  await admin.site.create({
    data: {
      id: scope.siteId,
      workspaceId: scope.workspaceId,
      origin: "https://route-preview.invalid",
      verifiedAt: new Date(),
    },
  });
  await admin.visibilityPanel.create({
    data: {
      id: input.panelId,
      ...scope,
      version: 1,
      createdBy: actor.userId,
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
      prompts: [{ id: "p", text: "Which?", label: "neutral" }],
      brands: [{ id: "b", name: "Brand", aliases: ["Brand"], domains: [] }],
    },
  });
});
afterAll(async () => {
  await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
});
it("executes the actual private route against restricted PostgreSQL without a quote or provider dispatch", async () => {
  const counts = await Promise.all([
    admin.operation.count(),
    admin.operationQuote.count(),
    admin.outboxEvent.count(),
  ]);
  const response = await POST(request(input));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({
    available: false,
    quote: null,
    maximumCost: null,
    panel: { promptCount: 1 },
    allowance: {
      provider: { bucket: "AZURE" },
      observations: { bucket: "API_OBSERVATION" },
    },
  });
  const unavailable = await POST(request({ ...input, action: "request-run" }));
  expect(unavailable.status).toBe(503);
  expect(
    await Promise.all([
      admin.operation.count(),
      admin.operationQuote.count(),
      admin.outboxEvent.count(),
    ]),
  ).toEqual(counts);
  expect((await POST(request({ ...input, userId: "forged" }))).status).toBe(
    409,
  );
  expect((await POST(request(input, "https://foreign.invalid"))).status).toBe(
    403,
  );
});
