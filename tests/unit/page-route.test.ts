import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  registerPage: vi.fn(),
  changePage: vi.fn(),
  listPages: vi.fn(),
  readPage: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("../../packages/db/src/pages", () => mocks);
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/pages/route";
const origin = "http://127.0.0.1:3000";
const body = {
  workspaceId: "a",
  siteId: "site",
  action: "claim",
  pageId: "page",
  expectedRevision: 1,
  idempotencyKey: "once",
};
function post(value: unknown = body, requestOrigin = origin) {
  return new Request(origin + "/api/pages", {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
  mocks.listPages.mockResolvedValue({ pages: [], limit: 100, siteLimit: 500 });
  mocks.changePage.mockResolvedValue({ page: {}, entry: {} });
});
it("uses only authenticated browser actor, rejects forged actor fields and foreign mutation origin", async () => {
  expect((await POST(post({ ...body, userId: "forged" }))).status).toBe(409);
  expect(mocks.changePage).not.toHaveBeenCalled();
  expect((await POST(post(body, "https://evil.invalid"))).status).toBe(403);
  expect((await POST(post())).status).toBe(200);
  expect(mocks.changePage.mock.calls[0][1]).toEqual({ userId: "verified" });
});
it("returns bounded private reads, rejects unexpected query parameters, cross-site GET and absent authentication", async () => {
  const request = () =>
    new Request(origin + "/api/pages?workspaceId=a&siteId=site");
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await GET(new Request(request().url + "&actor=forged"))).status).toBe(
    409,
  );
  const cross = request();
  cross.headers.set("sec-fetch-site", "cross-site");
  expect((await GET(cross)).status).toBe(403);
  mocks.resolveActor.mockRejectedValue(new Error("UNAUTHENTICATED"));
  expect((await GET(request())).status).toBe(401);
});
it("returns a conflict without losing client text and rejects oversized writes", async () => {
  mocks.changePage.mockRejectedValue(new Error("REVISION_CONFLICT"));
  expect(
    (await POST(post({ ...body, action: "change", note: "Keep unsaved text" })))
      .status,
  ).toBe(409);
  expect(
    (await POST(post({ ...body, action: "change", note: "a".repeat(4001) })))
      .status,
  ).toBe(409);
  expect(
    (await POST(post({ ...body, action: "change", note: "a".repeat(200001) })))
      .status,
  ).toBe(409);
});

it("returns a private retryable conflict when composed evidence changes before final validation", async () => {
  mocks.readPage.mockRejectedValue(new Error("SOURCE_CHANGED"));
  const response = await GET(
    new Request(origin + "/api/pages?workspaceId=a&siteId=site&pageId=page"),
  );
  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toContain("reload the latest revision");
});
