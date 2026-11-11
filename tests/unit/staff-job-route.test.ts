import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  database: vi.fn(() => ({})),
  available: vi.fn(),
  allocate: vi.fn(),
  requestStatus: vi.fn(),
  resolve: vi.fn(),
  step: vi.fn(),
  action: vi.fn(),
  denied: vi.fn(),
}));
vi.mock("@/server/admin/staff", () => ({
  requireStaffFor: mocks.authorize,
  staffDatabase: mocks.database,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3013" }),
}));
vi.mock("../../packages/db/src/staff-job-control", () => ({
  staffJobAvailability: mocks.available,
  allocateStaffJobRequest: mocks.allocate,
  staffJobRequestStatus: mocks.requestStatus,
  resolveStaffJobRequest: mocks.resolve,
  prepareStaffJobRequest: mocks.step,
  executeStaffJobRequest: mocks.action,
  recordStaffJobDenied: mocks.denied,
}));
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/admin/jobs/route";
const actor = { userId: "staff", sessionId: "session", securityVersion: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.available.mockResolvedValue({
    available: false,
    profile: "LOCAL_REHEARSAL",
  });
  mocks.allocate.mockResolvedValue({
    requestId: "d9f64202-42a4-4f86-8644-dd3a2feb0fe1",
  });
  mocks.step.mockResolvedValue(undefined);
  mocks.requestStatus.mockResolvedValue({ state: "PENDING" });
  mocks.resolve.mockResolvedValue({ state: "CLOSED" });
  mocks.action.mockResolvedValue({
    id: "job",
    status: "QUEUED",
    fence: 4,
    delivery: "UNAVAILABLE",
  });
  mocks.denied.mockResolvedValue(undefined);
});
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3013/api/admin/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3013",
      ...headers,
    },
    body: JSON.stringify(body),
  });
it("fails closed when current staff session cannot be resolved", async () => {
  mocks.authorize.mockRejectedValue(Error("STAFF_REQUIRED"));
  const response = await GET(
    new Request("http://127.0.0.1:3013/api/admin/jobs"),
  );
  expect(response.status).toBe(403);
  expect(mocks.available).not.toHaveBeenCalled();
});
it("rejects cross-origin or bearer requests and forged actor fields", async () => {
  const response = await POST(
    post(
      { kind: "prepare", action: "jobs:retry", target: "job" },
      { origin: "https://bad.invalid" },
    ),
  );
  expect(response.status).toBe(403);
  expect(
    (
      await POST(
        post({
          kind: "prepare",
          action: "jobs:retry",
          target: "job",
          requestId: "d9f64202-42a4-4f86-8644-dd3a2feb0fe1",
          expectedFence: 3,
          reason: "Investigate fixture failure",
          actor,
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await GET(
        new Request("http://127.0.0.1:3013/api/admin/jobs", {
          headers: { authorization: "Bearer bad" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(mocks.step).not.toHaveBeenCalled();
});
it("reports only local proof availability and requires fresh staff", async () => {
  const response = await GET(
    new Request("http://127.0.0.1:3013/api/admin/jobs"),
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    available: false,
    profile: "LOCAL_REHEARSAL",
  });
  expect(mocks.authorize).toHaveBeenCalledWith("change");
});
it("passes only the verified actor and exact action target fence and request id", async () => {
  const response = await POST(
    post({
      kind: "execute",
      action: "jobs:retry",
      target: "job",
      requestId: "d9f64202-42a4-4f86-8644-dd3a2feb0fe1",
      expectedFence: 3,
      reason: "Investigate fixture failure",
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.authorize).toHaveBeenCalledWith("change");
  expect(mocks.action).toHaveBeenCalledWith(
    {},
    actor,
    "jobs:retry",
    "job",
    3,
    "Investigate fixture failure",
    "d9f64202-42a4-4f86-8644-dd3a2feb0fe1",
  );
});
it("writes a separate bounded denial without leaking database errors", async () => {
  mocks.action.mockRejectedValue(Error("SECRET_DATABASE_DETAIL"));
  const response = await POST(
    post({
      kind: "execute",
      action: "jobs:cancel",
      target: "job",
      requestId: "d9f64202-42a4-4f86-8644-dd3a2feb0fe1",
      expectedFence: 3,
      reason: "Investigate fixture failure",
    }),
  );
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("SECRET_DATABASE_DETAIL");
  expect(mocks.denied).toHaveBeenCalledWith({}, actor, "jobs:cancel", "job");
});

it("prepares a request without returning a step-up secret and retrieves only a valid request reference", async () => {
  const requestId = "d9f64202-42a4-4f86-8644-dd3a2feb0fe1";
  const response = await POST(
    post({
      kind: "prepare",
      action: "jobs:retry",
      target: "job",
      requestId,
      expectedFence: 3,
      reason: "Investigate fixture failure",
    }),
  );
  expect(await response.json()).toEqual({ prepared: true });
  const status = await GET(
    new Request(`http://127.0.0.1:3013/api/admin/jobs?requestId=${requestId}`),
  );
  expect(await status.json()).toEqual({ state: "PENDING" });
  expect(mocks.requestStatus).toHaveBeenCalledWith({}, actor, requestId);
  const malformed = await GET(
    new Request("http://127.0.0.1:3013/api/admin/jobs?requestId=bad"),
  );
  expect(malformed.status).toBe(403);
});

it("rejects POST without the configured same-origin header", async () => {
  const request = new Request("http://127.0.0.1:3013/api/admin/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "prepare",
      action: "jobs:retry",
      target: "job",
      requestId: "d9f64202-42a4-4f86-8644-dd3a2feb0fe1",
      expectedFence: 3,
      reason: "Investigate fixture failure",
    }),
  });
  expect((await POST(request)).status).toBe(403);
  expect(mocks.step).not.toHaveBeenCalled();
});

it("requires current staff and resolves only the exact request id without exposing a token", async () => {
  const requestId = "d9f64202-42a4-4f86-8644-dd3a2feb0fe1";
  const response = await POST(post({ kind: "resolve", requestId }));
  expect(await response.json()).toEqual({ state: "CLOSED" });
  expect(mocks.authorize).toHaveBeenCalledWith("change");
  expect(mocks.resolve).toHaveBeenCalledWith({}, actor, requestId);
  expect(
    (await POST(post({ kind: "resolve", requestId, target: "injected" })))
      .status,
  ).toBe(403);
});

it("allocates a server-bound id and rejects a caller-supplied identity or id", async () => {
  const response = await POST(post({ kind: "allocate" }));
  expect(await response.json()).toEqual({
    requestId: "d9f64202-42a4-4f86-8644-dd3a2feb0fe1",
  });
  expect(mocks.allocate).toHaveBeenCalledWith({}, actor);
  expect(
    (
      await POST(
        post({
          kind: "allocate",
          requestId: "d9f64202-42a4-4f86-8644-dd3a2feb0fe1",
        }),
      )
    ).status,
  ).toBe(403);
  expect((await POST(post({ kind: "allocate", userId: "other" }))).status).toBe(
    403,
  );
});
