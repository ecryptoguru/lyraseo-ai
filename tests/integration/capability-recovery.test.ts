import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const seams = vi.hoisted(() => ({
  db: null as unknown,
  actor: null as unknown,
  google: vi.fn(),
  analytics: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  database: () => seams.db,
  resolveActor: async () => seams.actor,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({
    origin: "http://localhost:3000",
    allowedEmails: ["pilot@example.com"],
  }),
}));
vi.mock("@/server/google/provider", async (original) => ({
  ...(await original<
    typeof import("../../apps/lyraseo-web/src/server/google/provider")
  >()),
  configuredGoogle: seams.google,
}));
vi.mock("@/server/google/analytics", async (original) => ({
  ...(await original<
    typeof import("../../apps/lyraseo-web/src/server/google/analytics")
  >()),
  configuredAnalytics: seams.analytics,
}));
import * as google from "../../apps/lyraseo-web/src/app/api/integrations/google/route";
import * as ga4 from "../../apps/lyraseo-web/src/app/api/integrations/analytics/route";
import * as search from "../../apps/lyraseo-web/src/app/api/search/route";
import * as analytics from "../../apps/lyraseo-web/src/app/api/analytics/route";
import * as audits from "../../apps/lyraseo-web/src/app/api/audits/route";
import * as tokens from "../../apps/lyraseo-web/src/app/api/tokens/route";
import * as content from "../../apps/lyraseo-web/src/app/api/content/route";
import * as reports from "../../apps/lyraseo-web/src/app/api/reports/route";
import * as googleCallback from "../../apps/lyraseo-web/src/app/api/integrations/google/callback/route";
import * as ga4Callback from "../../apps/lyraseo-web/src/app/api/integrations/analytics/callback/route";
import { beginGoogleConnect } from "../../packages/db/src/gsc";
import { beginGa4Connect } from "../../packages/db/src/ga4";
import { secretBox } from "../../apps/lyraseo-web/src/server/google/provider";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
const post = (body: object) =>
  new Request("http://localhost:3000/api", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "x-lyra-enabled-capabilities": "all",
    },
    body: JSON.stringify(body),
  });
const get = (suffix = "") =>
  new Request(`http://localhost:3000/api?workspaceId=a&siteId=a-site${suffix}`);
async function json(response: Response, status = 200) {
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return value;
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  seams.db = db;
  seams.actor = actor;
  vi.clearAllMocks();
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("keeps GSC and GA4 saved reads provider-free while paused, disconnects and purges only the selected integration", async () => {
  await admin.googleConnection.create({
    data: {
      ...scope,
      encryptedRefreshToken: "unread",
      property: "https://example.com/",
    },
  });
  await admin.analyticsConnection.create({
    data: {
      ...scope,
      encryptedRefreshToken: "unread",
      property: "properties/123",
      streamId: "456",
      timeZone: "UTC",
      catalog: [],
    },
  });
  await admin.searchSnapshot.create({
    data: {
      ...scope,
      property: "https://example.com/",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      shape: "page",
      status: "complete",
      rows: [],
    },
  });
  expect((await json(await search.GET(get()))).snapshots).toHaveLength(1);
  expect((await json(await analytics.GET(get()))).connection.property).toBe(
    "properties/123",
  );
  for (const [handler, body, capability] of [
    [google.POST, { action: "discover" }, "search"],
    [ga4.POST, { action: "discover" }, "analytics"],
    [
      search.POST,
      { startDate: "2026-01-01", endDate: "2026-01-02", shape: "page" },
      "search",
    ],
    [
      analytics.POST,
      { startDate: "2026-01-01", endDate: "2026-01-02" },
      "analytics",
    ],
  ] as const)
    expect(await json(await handler(post({ ...scope, ...body })), 503)).toEqual(
      { error: "CAPABILITY_PAUSED", capability },
    );
  expect(seams.google).not.toHaveBeenCalled();
  expect(seams.analytics).not.toHaveBeenCalled();
  await json(await google.POST(post({ ...scope, action: "disconnect" })));
  expect(await admin.googleConnection.count()).toBe(0);
  expect(await admin.searchSnapshot.count()).toBe(0);
  expect(await admin.analyticsConnection.count()).toBe(1);
  await json(await ga4.POST(post({ ...scope, action: "disconnect" })));
  expect(await admin.analyticsConnection.count()).toBe(0);
  expect(seams.google).not.toHaveBeenCalled();
  expect(seams.analytics).not.toHaveBeenCalled();
});
it("allows same-scope audit cancellation and retained reads with rollout and raw deployment gates off, but rejects other-scope recovery", async () => {
  await admin.auditRun.create({
    data: {
      id: "run",
      ...scope,
      userId: "owner",
      securityVersion: 0,
      idempotencyKey: "run",
      inputHash: "hash",
      manifest: ["https://example.com/"],
      profile: "LOCAL_RAW_V1",
      declarations: {},
      methodologyVersion: "readiness-v1",
    },
  });
  vi.stubEnv("LYRA_LOCAL_RAW_AUDITS", "false");
  vi.stubEnv("VERCEL", "1");
  expect(await json(await audits.GET(get()))).toHaveLength(1);
  await json(
    await audits.POST(post({ ...scope, action: "cancel", auditId: "run" })),
  );
  expect(
    (await admin.auditRun.findUniqueOrThrow({ where: { id: "run" } })).status,
  ).toBe("FAILED");
  expect(
    (
      await audits.POST(
        post({ ...scope, siteId: "b-site", action: "cancel", auditId: "run" }),
      )
    ).status,
  ).toBe(404);
});
it("issues credentials only when enabled, then lists and revokes during pause with real scope authorization", async () => {
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "mcp");
  const issued = await json(
    await tokens.POST(
      post({
        action: "create",
        workspaceId: "a",
        name: "Pilot",
        siteIds: ["a-site"],
        scopes: ["sites:read"],
        requestKey: randomUUID(),
      }),
    ),
    201,
  );
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "");
  expect(
    (
      await json(
        await tokens.GET(
          new Request("http://localhost:3000/api?workspaceId=a"),
        ),
      )
    ).tokens,
  ).toHaveLength(1);
  expect(
    (
      await tokens.POST(
        post({ action: "revoke", workspaceId: "b", tokenId: issued.token.id }),
      )
    ).status,
  ).toBe(404);
  await json(
    await tokens.POST(
      post({ action: "revoke", workspaceId: "a", tokenId: issued.token.id }),
    ),
  );
  expect(
    (await admin.apiToken.findUniqueOrThrow({ where: { id: issued.token.id } }))
      .revokedAt,
  ).not.toBeNull();
});
it("retains real drafts and downloadable reports during pause without changing evidence", async () => {
  await admin.searchSnapshot.create({
    data: {
      id: "source",
      ...scope,
      property: "https://example.com/",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      shape: "page",
      status: "complete",
      rows: [],
    },
  });
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "content");
  await json(
    await content.POST(
      post({
        ...scope,
        action: "create",
        kind: "draft",
        title: "Manual",
        body: "Saved",
        assumptions: [],
        citations: [],
        searchSnapshotIds: ["source"],
      }),
    ),
    201,
  );
  const report = await json(
    await reports.POST(
      post({ ...scope, title: "Evidence", searchSnapshotIds: ["source"] }),
    ),
    201,
  );
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "");
  expect(await json(await content.GET(get()))).toHaveLength(1);
  expect(await json(await reports.GET(get()))).toHaveLength(1);
  const csv = await reports.GET(get(`&reportId=${report.id}&format=csv`));
  expect(csv.status).toBe(200);
  expect(csv.headers.get("cache-control")).toBe("private, no-store");
  expect((await csv.text()).length).toBeGreaterThan(0);
  expect(await admin.searchSnapshot.count()).toBe(1);
  seams.actor = { ...actor, userId: "viewer" };
  expect(
    (await content.POST(post({ ...scope, action: "generate" }))).status,
  ).toBe(503);
  expect(
    (
      await reports.GET(
        new Request(
          `http://localhost:3000/api?workspaceId=b&siteId=b-site&reportId=${report.id}&format=csv`,
        ),
      )
    ).status,
  ).toBe(404);
});
it.each([
  [
    "search",
    googleCallback.GET,
    beginGoogleConnect,
    "http://localhost:3000/app/sites/callback%2Fsite%3Fx/search?workspaceId=callback%20workspace%26",
  ],
  [
    "analytics",
    ga4Callback.GET,
    beginGa4Connect,
    "http://localhost:3000/app/sites/callback%2Fsite%3Fx/analytics?workspaceId=callback%20workspace%26",
  ],
] as const)(
  "returns a private encoded 303 after %s consent, consumes state once, and exchanges nothing while paused",
  async (capability, handler, begin, location) => {
    const selected = {
      workspaceId: "callback workspace&",
      siteId: "callback/site?x",
    };
    await admin.workspace.create({
      data: { id: selected.workspaceId, name: "Callback workspace" },
    });
    await admin.membership.create({
      data: {
        workspaceId: selected.workspaceId,
        userId: "owner",
        role: "OWNER",
      },
    });
    await admin.site.create({
      data: {
        id: selected.siteId,
        workspaceId: selected.workspaceId,
        origin: "https://callback.example",
      },
    });
    const provider = {
      authorize: (state: string) => state,
      exchange: vi.fn(
        async (_code: string, _verifier: string) => "controlled-refresh",
      ),
      properties: vi.fn(async () => []),
      query: vi.fn(async () => []),
      report: vi.fn(async () => ({
        rows: [],
        rowCount: 0,
        diagnostics: {},
        timeZone: "UTC",
      })),
    };
    const box = secretBox(Buffer.alloc(32, 7).toString("base64"));
    seams.google.mockReturnValue({ provider, box });
    seams.analytics.mockReturnValue({ provider, box });
    const { url: state } = await begin(db, actor, selected, provider, box);
    const callback = () =>
      handler(
        new Request(
          `http://localhost:3000/api/integrations/callback?state=${encodeURIComponent(state)}&code=controlled-code`,
        ),
      );
    const states = () =>
      capability === "search"
        ? admin.googleOAuthState.findMany({ where: selected })
        : admin.analyticsOAuthState.findMany({ where: selected });
    const connections = () =>
      capability === "search"
        ? admin.googleConnection.count({ where: selected })
        : admin.analyticsConnection.count({ where: selected });
    // The other integration's opt-in cannot enable this callback or consume its state.
    vi.stubEnv(
      "LYRA_ENABLED_CAPABILITIES",
      capability === "search" ? "analytics" : "search",
    );
    expect(await json(await callback(), 503)).toEqual({
      error: "CAPABILITY_PAUSED",
      capability,
    });
    expect(await states()).toMatchObject([{ consumedAt: null }]);
    expect(await connections()).toBe(0);
    expect(provider.exchange).not.toHaveBeenCalled();
    expect(seams.google).not.toHaveBeenCalled();
    expect(seams.analytics).not.toHaveBeenCalled();
    vi.stubEnv("LYRA_ENABLED_CAPABILITIES", capability);
    const redirect = await callback();
    expect(provider.exchange).toHaveBeenCalledExactlyOnceWith(
      "controlled-code",
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    );
    expect(await connections()).toBe(1);
    expect(await states()).toHaveLength(0);
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe(location);
    expect(redirect.headers.get("cache-control")).toBe("private, no-store");
    expect(redirect.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await redirect.text()).toBe("");
    expect(await json(await callback(), 409)).toEqual({
      error: "INVALID_OAUTH_STATE",
    });
    expect(provider.exchange).toHaveBeenCalledTimes(1);
    expect(await connections()).toBe(1);
    vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "");
    expect(await json(await callback(), 503)).toEqual({
      error: "CAPABILITY_PAUSED",
      capability,
    });
    expect(provider.exchange).toHaveBeenCalledTimes(1);
    expect(provider.properties).not.toHaveBeenCalled();
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.report).not.toHaveBeenCalled();
  },
);
