import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  prepareKeywordSelection: vi.fn(),
  readKeywordSelections: vi.fn(),
  requestKeywordQuote: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("../../packages/db/src/keywords", () => mocks);
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/keywords/route";
const origin = "http://127.0.0.1:3000",
  input = {
    workspaceId: "a",
    siteId: "site",
    action: "select",
    snapshotId: "snapshot",
    kind: "best-observed-page",
    query: "seo audit",
    page: "https://example.com/a",
    keywords: ["seo audit"],
    country: "IN",
    language: "en",
    idempotencyKey: "selected",
  };
function request(body: unknown, from = origin) {
  return new Request(origin + "/api/keywords", {
    method: "POST",
    headers: { origin: from, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
  mocks.readKeywordSelections.mockResolvedValue([]);
  mocks.prepareKeywordSelection.mockResolvedValue({
    id: "selection",
    status: "UNQUALIFIED",
  });
});
it("GET reads saved selections only and rejects cross-origin access", async () => {
  const response = await GET(
    new Request(origin + "/api/keywords?workspaceId=a&siteId=site"),
  );
  expect(await response.json()).toEqual({ selections: [] });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.prepareKeywordSelection).not.toHaveBeenCalled();
  expect(mocks.requestKeywordQuote).not.toHaveBeenCalled();
  expect(
    (
      await GET(
        new Request(origin + "/api/keywords?workspaceId=a&siteId=site", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      )
    ).status,
  ).toBe(403);
});
it("rejects customer pricing, actors, oversized bodies and foreign writes before selection", async () => {
  expect((await POST(request({ ...input, maximumCost: "0" }))).status).toBe(
    409,
  );
  expect((await POST(request({ ...input, userId: "forged" }))).status).toBe(
    409,
  );
  expect(
    (await POST(request({ ...input, extra: "x".repeat(10000) }))).status,
  ).toBe(409);
  expect((await POST(request(input, "https://foreign.invalid"))).status).toBe(
    403,
  );
  expect(mocks.prepareKeywordSelection).not.toHaveBeenCalled();
  expect(mocks.requestKeywordQuote).not.toHaveBeenCalled();
});
it("passes only verified scope and preserves an explicit unqualified quote without a charge", async () => {
  expect((await POST(request(input))).status).toBe(200);
  expect(mocks.prepareKeywordSelection.mock.calls[0]?.[1]).toEqual({
    userId: "verified",
  });
  expect(mocks.prepareKeywordSelection.mock.calls[0]?.[2]).toEqual({
    workspaceId: "a",
    siteId: "site",
  });
  const selectionId = "7c294e60-e546-423e-b620-c0b64c2e38c4";
  mocks.requestKeywordQuote.mockResolvedValue({
    selectionId,
    status: "UNQUALIFIED",
    maximumCost: null,
    dispatchable: false,
  });
  const response = await POST(
    request({ workspaceId: "a", siteId: "site", action: "quote", selectionId }),
  );
  expect(await response.json()).toMatchObject({
    maximumCost: null,
    dispatchable: false,
  });
});
