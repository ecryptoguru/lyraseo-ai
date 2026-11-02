import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  googleProperties: vi.fn(),
  readGoogleSearch: vi.fn(),
  configuredGoogle: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("@/server/google/provider", () => ({
  configuredGoogle: mocks.configuredGoogle,
}));
vi.mock("../../packages/db/src/gsc", async (original) => ({
  ...(await original<typeof import("../../packages/db/src/gsc")>()),
  googleProperties: mocks.googleProperties,
  readGoogleSearch: mocks.readGoogleSearch,
}));
import * as route from "../../apps/lyraseo-web/src/app/api/integrations/google/route";
import * as searchRoute from "../../apps/lyraseo-web/src/app/api/search/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
  mocks.configuredGoogle.mockReturnValue({ provider: {}, box: {} });
  mocks.googleProperties.mockResolvedValue([
    { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
  ]);
});
it("reads authorized saved import status without configuring or dispatching Google", async () => {
  const saved = {
    imports: [{ id: "failed", status: "failed", recoverable: true }],
    snapshots: [],
  };
  mocks.readGoogleSearch.mockResolvedValue(saved);
  const response = await searchRoute.GET(
    new Request("http://127.0.0.1:3000/api/search?workspaceId=a&siteId=site"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(saved);
  expect(mocks.readGoogleSearch).toHaveBeenCalledWith(
    {},
    { userId: "verified" },
    { workspaceId: "a", siteId: "site" },
  );
  expect(mocks.configuredGoogle).not.toHaveBeenCalled();
  expect(mocks.googleProperties).not.toHaveBeenCalled();
});
it("uses explicit authenticated discovery POST and has no provider-dispatching GET", async () => {
  expect("GET" in route).toBe(false);
  const response = await route.POST(
    new Request("http://127.0.0.1:3000/api/integrations/google", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "discover",
        workspaceId: "a",
        siteId: "site",
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    properties: [{ siteUrl: "https://example.com/" }],
  });
  expect(mocks.googleProperties).toHaveBeenCalledOnce();
});
it("rejects cross-origin discovery before any provider call", async () => {
  const response = await route.POST(
    new Request("http://127.0.0.1:3000/api/integrations/google", {
      method: "POST",
      headers: {
        origin: "https://foreign.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "discover",
        workspaceId: "a",
        siteId: "site",
      }),
    }),
  );
  expect(response.status).toBe(403);
  expect(mocks.configuredGoogle).not.toHaveBeenCalled();
  expect(mocks.googleProperties).not.toHaveBeenCalled();
});
