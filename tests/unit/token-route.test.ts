import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({
    origin: "http://127.0.0.1:3000",
    allowedEmails: ["pilot@example.com"],
  }),
}));
vi.mock("../../packages/db/src/tokens", async (original) => ({
  ...(await original<typeof import("../../packages/db/src/tokens")>()),
  ...mocks,
}));
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/tokens/route";
const origin = "http://127.0.0.1:3000";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
  mocks.listApiTokens.mockResolvedValue([]);
});
it("supports normal authenticated same-origin GET without Origin, rejects foreign origins and cross-site fetches", async () => {
  const request = () => new Request(origin + "/api/tokens?workspaceId=a");
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ tokens: [] });
  const badOrigin = request();
  badOrigin.headers.set("origin", "https://evil.invalid");
  expect((await GET(badOrigin)).status).toBe(403);
  const crossSite = request();
  crossSite.headers.set("sec-fetch-site", "cross-site");
  expect((await GET(crossSite)).status).toBe(403);
});
it("requires authenticated management and exact mutation origin without exposing errors or secrets", async () => {
  const body = {
    action: "create",
    workspaceId: "a",
    name: "Agent",
    siteIds: ["site"],
    scopes: ["sites:read"],
    requestKey: "ab342b34-2434-4234-9234-ab342b342b34",
  };
  const request = (withOrigin: boolean) =>
    new Request(origin + "/api/tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(withOrigin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    });
  expect((await POST(request(false))).status).toBe(403);
  expect(mocks.createApiToken).not.toHaveBeenCalled();
  mocks.resolveActor.mockRejectedValue(new Error("UNAUTHENTICATED"));
  expect(
    (await GET(new Request(origin + "/api/tokens?workspaceId=a"))).status,
  ).toBe(401);
  expect((await POST(request(true))).status).toBe(401);
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
  mocks.createApiToken.mockRejectedValue(new Error("TOKEN_ALREADY_CREATED"));
  const response = await POST(request(true));
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).not.toMatch(/lyra_|tokenHash/);
});

it("keeps infrastructure failures distinct from expired authentication", async () => {
  mocks.resolveActor.mockRejectedValue(new Error("AUTH_POLICY_UNVERIFIED"));
  expect(
    (await GET(new Request(origin + "/api/tokens?workspaceId=a"))).status,
  ).toBe(503);
});
