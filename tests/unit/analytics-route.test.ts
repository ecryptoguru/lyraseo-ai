import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  readGa4LandingPages: vi.fn(),
  importGa4LandingPages: vi.fn(),
  beginGa4Connect: vi.fn(),
  ga4Properties: vi.fn(),
  selectGa4Property: vi.fn(),
  disconnectGa4: vi.fn(),
  configuredAnalytics: vi.fn(),
  analyticsConfigured: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("@/server/google/analytics", () => mocks);
vi.mock("../../packages/db/src/ga4", () => mocks);
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/analytics/route";
import { POST as manage } from "../../apps/lyraseo-web/src/app/api/integrations/analytics/route";
const origin = "http://127.0.0.1:3000",
  scope = { workspaceId: "a", siteId: "site" };
function request(body: unknown, site = origin) {
  return new Request(origin + "/api/analytics", {
    method: "POST",
    headers: { origin: site, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
  mocks.readGa4LandingPages.mockResolvedValue({
    connection: null,
    snapshots: [],
    opportunityOutcomes: [],
  });
  mocks.configuredAnalytics.mockReturnValue({ provider: {}, box: {} });
  mocks.analyticsConfigured.mockReturnValue(false);
  mocks.importGa4LandingPages.mockResolvedValue({
    id: "import",
    rows: [],
    attempt: "internal",
  });
});
it("reads only saved data without credentials/provider creation and rejects cross-site reads", async () => {
  const r = await GET(
    new Request(origin + "/api/analytics?workspaceId=a&siteId=site"),
  );
  expect(await r.json()).toMatchObject({ configured: false, connection: null });
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.configuredAnalytics).not.toHaveBeenCalled();
  const cross = new Request(
    origin + "/api/analytics?workspaceId=a&siteId=site",
    { headers: { "sec-fetch-site": "cross-site" } },
  );
  expect((await GET(cross)).status).toBe(403);
});
it("rejects forged actor fields, oversized bodies and foreign-origin writes before dispatch", async () => {
  const input = { ...scope, startDate: "2026-01-01", endDate: "2026-01-02" };
  expect((await POST(request(input, "https://other.example"))).status).toBe(
    403,
  );
  expect((await POST(request({ ...input, userId: "forged" }))).status).toBe(
    409,
  );
  expect(
    (await POST(request({ ...input, extra: "a".repeat(10000) }))).status,
  ).toBe(409);
  expect(mocks.importGa4LandingPages).not.toHaveBeenCalled();
  const response = await POST(request(input));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "import", rowCount: 0 });
  expect(mocks.importGa4LandingPages.mock.calls[0]![2]).toEqual(scope);
});
it("requires explicit stream selection and sends only site scope to persistence", async () => {
  expect(
    (
      await manage(
        request({ ...scope, action: "select", property: "properties/123" }),
      )
    ).status,
  ).toBe(409);
  expect(mocks.selectGa4Property).not.toHaveBeenCalled();
  mocks.selectGa4Property.mockResolvedValue({
    property: "properties/123",
    streamId: "456",
  });
  expect(
    (
      await manage(
        request({
          ...scope,
          action: "select",
          property: "properties/123",
          streamId: "456",
        }),
      )
    ).status,
  ).toBe(200);
  expect(mocks.selectGa4Property.mock.calls[0]![2]).toEqual(scope);
  mocks.ga4Properties.mockResolvedValue([]);
  await manage(request({ ...scope, action: "discover" }));
  expect(mocks.ga4Properties.mock.calls[0]![2]).toEqual(scope);
});
it("disconnects even when Google configuration is absent", async () => {
  mocks.configuredAnalytics.mockImplementation(() => {
    throw new Error("ANALYTICS_UNAVAILABLE");
  });
  mocks.disconnectGa4.mockResolvedValue({ disconnected: true, purged: true });
  expect(
    (await manage(request({ ...scope, action: "disconnect" }))).status,
  ).toBe(200);
  expect(mocks.configuredAnalytics).not.toHaveBeenCalled();
});
