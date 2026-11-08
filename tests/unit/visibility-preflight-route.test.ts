import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  previewVisibilityRun: vi.fn(),
  requestVisibilityRun: vi.fn(),
  createVisibilityPanel: vi.fn(),
  reviewVisibilityPanel: vi.fn(),
  readVisibility: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("../../packages/db/src/visibility", () => mocks);
import { POST } from "../../apps/lyraseo-web/src/app/api/visibility/route";
const body = {
  workspaceId: "workspace",
  siteId: "site",
  action: "preview-run",
  panelId: "panel",
  profile: "consumer-chatgpt",
};
function request(input: unknown, origin = "http://127.0.0.1:3000") {
  return new Request("http://127.0.0.1:3000/api/visibility", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActor.mockResolvedValue({
    userId: "verified",
    sessionId: "session",
    securityVersion: 0,
  });
  mocks.previewVisibilityRun.mockResolvedValue({
    available: false,
    quote: null,
    maximumCost: null,
  });
  mocks.requestVisibilityRun.mockResolvedValue({ available: false });
});
it("returns a private no-dispatch preview for only the verified actor and submitted scope", async () => {
  const response = await POST(request(body));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    available: false,
    quote: null,
    maximumCost: null,
  });
  expect(mocks.previewVisibilityRun).toHaveBeenCalledWith(
    {},
    { userId: "verified", sessionId: "session", securityVersion: 0 },
    { workspaceId: "workspace", siteId: "site" },
    "panel",
    "consumer-chatgpt",
  );
  expect(mocks.requestVisibilityRun).not.toHaveBeenCalled();
});
it("withholds a preview if the authenticated session changes while it is read", async () => {
  mocks.resolveActor
    .mockResolvedValueOnce({
      userId: "verified",
      sessionId: "old",
      securityVersion: 0,
    })
    .mockResolvedValueOnce({
      userId: "verified",
      sessionId: "new",
      securityVersion: 0,
    });
  const response = await POST(request(body));
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("maximumCost");
  expect(mocks.previewVisibilityRun).toHaveBeenCalledTimes(1);
});
it("withholds a preview when the issuer or site permission is revoked before the second read", async () => {
  mocks.resolveActor
    .mockResolvedValueOnce({
      userId: "verified",
      sessionId: "session",
      securityVersion: 0,
    })
    .mockRejectedValueOnce(new Error("SESSION_EXPIRED"));
  expect((await POST(request(body))).status).toBe(401);
  mocks.resolveActor.mockReset().mockResolvedValue({
    userId: "verified",
    sessionId: "session",
    securityVersion: 0,
  });
  mocks.previewVisibilityRun
    .mockResolvedValueOnce({ available: false })
    .mockRejectedValueOnce(new Error("FORBIDDEN"));
  const response = await POST(request(body));
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("maximumCost");
});
it("rejects cross-origin, forged actor and unknown fields and leaves actual runs closed", async () => {
  expect((await POST(request(body, "https://elsewhere.invalid"))).status).toBe(
    403,
  );
  expect((await POST(request({ ...body, userId: "forged" }))).status).toBe(409);
  expect(mocks.previewVisibilityRun).not.toHaveBeenCalled();
  const actual = await POST(request({ ...body, action: "request-run" }));
  expect(actual.status).toBe(503);
  expect(mocks.requestVisibilityRun).toHaveBeenCalledOnce();
});
