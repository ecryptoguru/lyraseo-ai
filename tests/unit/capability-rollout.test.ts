import { afterEach, beforeEach, expect, it, vi } from "vitest";
const seams = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  database: vi.fn(() => {
    throw new Error("TEST_DATABASE_UNAVAILABLE");
  }),
  google: vi.fn(() => {
    throw new Error("GOOGLE_UNAVAILABLE");
  }),
  analytics: vi.fn(() => {
    throw new Error("ANALYTICS_UNAVAILABLE");
  }),
  mcp: vi.fn(async () => Response.json({ enabled: true })),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: seams.resolveActor,
  database: seams.database,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://localhost:3000", allowedEmails: [] }),
}));
vi.mock("@/server/google/provider", () => ({ configuredGoogle: seams.google }));
vi.mock("@/server/google/analytics", () => ({
  configuredAnalytics: seams.analytics,
  analyticsConfigured: () => false,
}));
vi.mock("@/server/mcp/server", () => ({ handleMcpRequest: seams.mcp }));
import {
  capabilities,
  capabilityEnabled,
} from "../../apps/lyraseo-web/src/server/capabilities";
import * as sites from "../../apps/lyraseo-web/src/app/api/sites/route";
import * as audits from "../../apps/lyraseo-web/src/app/api/audits/route";
import * as pages from "../../apps/lyraseo-web/src/app/api/pages/route";
import * as content from "../../apps/lyraseo-web/src/app/api/content/route";
import * as reports from "../../apps/lyraseo-web/src/app/api/reports/route";
import * as visibility from "../../apps/lyraseo-web/src/app/api/visibility/route";
import * as tokens from "../../apps/lyraseo-web/src/app/api/tokens/route";
import * as search from "../../apps/lyraseo-web/src/app/api/search/route";
import * as analytics from "../../apps/lyraseo-web/src/app/api/analytics/route";
import * as google from "../../apps/lyraseo-web/src/app/api/integrations/google/route";
import * as ga4 from "../../apps/lyraseo-web/src/app/api/integrations/analytics/route";
import * as googleCallback from "../../apps/lyraseo-web/src/app/api/integrations/google/callback/route";
import * as ga4Callback from "../../apps/lyraseo-web/src/app/api/integrations/analytics/callback/route";
import * as mcp from "../../apps/lyraseo-web/src/app/api/mcp/route";
import { emptySiteContext } from "../../packages/db/src/sites";
const scope = { workspaceId: "a", siteId: "a-site" };
const request = (body: object, extraHeaders: Record<string, string> = {}) =>
  new Request(
    "http://localhost:3000/api?capability=all&LYRA_ENABLED_CAPABILITIES=audits,context,search,analytics,content,visibility,mcp",
    {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    },
  );
beforeEach(() => {
  vi.clearAllMocks();
  seams.resolveActor.mockResolvedValue({ userId: "owner" });
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "");
  vi.stubEnv("LYRA_LOCAL_RAW_AUDITS", "true");
  vi.stubEnv("VERCEL", "0");
});
afterEach(() => vi.unstubAllEnvs());
it.each([undefined, "", "all", "*", "AUDITS", "audits-extra", "true"])(
  "defaults off for absent/unknown configuration %s",
  (value) => {
    vi.stubEnv("LYRA_ENABLED_CAPABILITIES", value);
    expect(capabilities.filter(capabilityEnabled)).toEqual([]);
  },
);
it.each(capabilities)(
  "enables only exact independent capability %s",
  (capability) => {
    vi.stubEnv("LYRA_ENABLED_CAPABILITIES", ` ${capability} , unknown`);
    expect(capabilities.filter(capabilityEnabled)).toEqual([capability]);
  },
);
const fields = {
  title: "Draft",
  body: "Manual",
  assumptions: [],
  citations: [],
};
const mutations = [
  [
    "context",
    sites.POST,
    { action: "create", workspaceId: "a", origin: "https://example.com" },
  ],
  [
    "context",
    sites.POST,
    {
      ...scope,
      action: "context",
      expectedRevision: 0,
      content: emptySiteContext(),
    },
  ],
  ["audits", sites.POST, { ...scope, action: "challenge" }],
  [
    "audits",
    sites.POST,
    { ...scope, action: "verify", challengeId: "challenge" },
  ],
  [
    "context",
    pages.POST,
    { ...scope, action: "register", url: "https://example.com/" },
  ],
  ...["claim", "unassign"].map((action) => [
    "context",
    pages.POST,
    {
      ...scope,
      action,
      pageId: "page",
      expectedRevision: 1,
      idempotencyKey: "change",
    },
  ]),
  [
    "context",
    pages.POST,
    {
      ...scope,
      action: "change",
      pageId: "page",
      expectedRevision: 1,
      idempotencyKey: "change",
      note: "Updated",
    },
  ],
  [
    "audits",
    audits.POST,
    {
      ...scope,
      action: "create",
      idempotencyKey: "run",
      manifest: ["https://example.com/"],
    },
  ],
  ["audits", audits.POST, { ...scope, action: "step", auditId: "run" }],
  [
    "audits",
    audits.POST,
    {
      ...scope,
      action: "review",
      auditId: "run",
      ruleId: "D01",
      scopeKey: "https://example.com/",
      disposition: "REVIEWED",
      reason: "Reviewed",
    },
  ],
  [
    "content",
    content.POST,
    { ...scope, action: "create", kind: "draft", ...fields },
  ],
  [
    "content",
    content.POST,
    {
      ...scope,
      action: "save",
      draftId: "draft",
      expectedRevision: 1,
      ...fields,
    },
  ],
  ["content", content.POST, { ...scope, action: "generate" }],
  ["content", reports.POST, { ...scope, title: "Report" }],
  [
    "search",
    search.POST,
    { ...scope, startDate: "2026-01-01", endDate: "2026-01-02", shape: "page" },
  ],
  [
    "analytics",
    analytics.POST,
    { ...scope, startDate: "2026-01-01", endDate: "2026-01-02" },
  ],
  ...["connect", "discover"].flatMap((action) => [
    ["search", google.POST, { ...scope, action }],
    ["analytics", ga4.POST, { ...scope, action }],
  ]),
  [
    "search",
    google.POST,
    { ...scope, action: "select", property: "https://example.com/" },
  ],
  [
    "analytics",
    ga4.POST,
    { ...scope, action: "select", property: "properties/123", streamId: "456" },
  ],
  [
    "visibility",
    visibility.POST,
    {
      ...scope,
      action: "create-panel",
      prompts: [{ id: "p", text: "Question", label: "neutral" }],
      brands: [{ id: "b", name: "Brand", aliases: ["Brand"], domains: [] }],
    },
  ],
  [
    "visibility",
    visibility.POST,
    { ...scope, action: "review-panel", panelId: "panel" },
  ],
  [
    "visibility",
    visibility.POST,
    {
      ...scope,
      action: "request-run",
      panelId: "panel",
      profile: "azure-sol-api",
    },
  ],
  [
    "mcp",
    tokens.POST,
    {
      action: "create",
      workspaceId: "a",
      name: "Read",
      siteIds: ["a-site"],
      scopes: ["sites:read"],
      requestKey: "1a935ac3-94b6-400f-adb9-71300c3d916f",
    },
  ],
] as [string, (request: Request) => Promise<Response>, object][];
it.each(mutations)(
  "enforces %s off/on/off at mutation boundary %#",
  async (capability, handler, body) => {
    for (const enabled of [false, true, false]) {
      vi.stubEnv("LYRA_ENABLED_CAPABILITIES", enabled ? capability : "");
      vi.clearAllMocks();
      const response = await handler(
        request(body, { "x-lyra-enabled-capabilities": capability }),
      );
      const result = await response.json();
      if (!enabled) {
        expect(response.status, JSON.stringify(result)).toBe(503);
        expect(result).toEqual({ error: "CAPABILITY_PAUSED", capability });
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(seams.database).not.toHaveBeenCalled();
        expect(seams.google).not.toHaveBeenCalled();
        expect(seams.analytics).not.toHaveBeenCalled();
      } else {
        expect(result.error).not.toBe("CAPABILITY_PAUSED");
        expect(
          seams.database.mock.calls.length +
            seams.google.mock.calls.length +
            seams.analytics.mock.calls.length,
        ).toBeGreaterThan(0);
      }
    }
  },
);
it.each([
  ["search", googleCallback.GET],
  ["analytics", ga4Callback.GET],
] as const)(
  "pauses %s callback before exchange and independently of other integration",
  async (capability, handler) => {
    vi.stubEnv(
      "LYRA_ENABLED_CAPABILITIES",
      capability === "search" ? "analytics" : "search",
    );
    const response = await handler(
      new Request("http://localhost:3000/callback?state=state&code=secret"),
    );
    expect(await response.json()).toEqual({
      error: "CAPABILITY_PAUSED",
      capability,
    });
    expect(seams.google).not.toHaveBeenCalled();
    expect(seams.analytics).not.toHaveBeenCalled();
    expect(seams.database).not.toHaveBeenCalled();
  },
);
it.each([mcp.GET, mcp.POST, mcp.DELETE])(
  "pauses MCP before bearer resolution or data work",
  async (handler) => {
    const response = await handler(
      request(
        { method: "tools/list" },
        { authorization: "Bearer forged", LYRA_ENABLED_CAPABILITIES: "mcp" },
      ),
    );
    expect(await response.json()).toEqual({
      error: "CAPABILITY_PAUSED",
      capability: "mcp",
    });
    expect(seams.database).not.toHaveBeenCalled();
    expect(seams.mcp).not.toHaveBeenCalled();
  },
);
it("preserves authentication and origin failures while paused and rejects forged body flags", async () => {
  seams.resolveActor.mockRejectedValueOnce(new Error("UNAUTHENTICATED"));
  expect(
    (
      await search.POST(
        request({
          ...scope,
          startDate: "2026-01-01",
          endDate: "2026-01-02",
          shape: "page",
        }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await google.POST(
        request(
          { ...scope, action: "connect" },
          { origin: "https://foreign.example" },
        ),
      )
    ).status,
  ).toBe(403);
  const response = await google.POST(
    request({
      ...scope,
      action: "connect",
      LYRA_ENABLED_CAPABILITIES: "search",
    }),
  );
  expect(response.status).toBe(409);
  expect(seams.google).not.toHaveBeenCalled();
});
it("applies MCP off/on/off at its entry before data resolution while retaining the enabled handler", async () => {
  for (const enabled of [false, true, false]) {
    vi.stubEnv("LYRA_ENABLED_CAPABILITIES", enabled ? "mcp" : "");
    vi.clearAllMocks();
    if (enabled) seams.database.mockImplementationOnce(() => ({}) as never);
    const response = await mcp.POST(request({ method: "tools/list" }));
    expect(response.status).toBe(enabled ? 200 : 503);
    if (enabled) expect(seams.mcp).toHaveBeenCalledOnce();
    else {
      expect(seams.mcp).not.toHaveBeenCalled();
      expect(seams.database).not.toHaveBeenCalled();
    }
  }
});
