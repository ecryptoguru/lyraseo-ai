import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  readOperation: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("../../packages/db/src/execution", () => ({
  readOperation: mocks.readOperation,
}));
import { GET } from "../../apps/lyraseo-web/src/app/api/operations/[operationId]/route";
const request = new Request("http://localhost/api/operations/example", {
  headers: { "x-user-id": "forged" },
});
const context = { params: Promise.resolve({ operationId: "example" }) };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
  mocks.readOperation.mockResolvedValue({
    id: "example",
    status: "RECONCILING",
    actualCost: null,
  });
});
it("reads persisted state using verified identity with private cache policy", async () => {
  const response = await GET(request, context);
  expect(await response.json()).toEqual({
    id: "example",
    status: "RECONCILING",
    actualCost: null,
  });
  expect(mocks.readOperation).toHaveBeenCalledWith(
    {},
    { userId: "verified" },
    "example",
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("does not disclose operations after access revocation", async () => {
  mocks.readOperation.mockRejectedValue(new Error("FORBIDDEN"));
  const response = await GET(request, context);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "NOT_FOUND" });
});
it("requires real authentication even with forged headers", async () => {
  mocks.resolveActor.mockRejectedValue(new Error("UNAUTHENTICATED"));
  const response = await GET(request, context);
  expect(response.status).toBe(401);
  expect(mocks.readOperation).not.toHaveBeenCalled();
});
it("returns unavailable for unconfigured auth without exposing diagnostics", async () => {
  mocks.resolveActor.mockRejectedValue(new Error("AUTH_UNAVAILABLE"));
  const response = await GET(request, context);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "SERVICE_UNAVAILABLE" });
  expect(mocks.readOperation).not.toHaveBeenCalled();
});
