import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  database: vi.fn(() => ({})),
  read: vi.fn(),
  search: vi.fn(),
  prepareRequest: vi.fn(),
  executeRequest: vi.fn(),
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
vi.mock("../../packages/db/src/sandbox-billing", () => ({
  readStaffView: mocks.read,
  searchStaffSupport: mocks.search,
  prepareStaffStepUp: mocks.step,
  performStaffAction: mocks.action,
  recordStaffDenied: mocks.denied,
  prepareStaffRequest: mocks.prepareRequest,
  executeStaffRequest: mocks.executeRequest,
}));
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/admin/route";
const actor = {
  userId: "fixture-staff",
  sessionId: "fixture-session",
  securityVersion: 0,
  mfaVerified: true,
  authProvider: "supabase",
  authenticatedAt: new Date().toISOString(),
  mfaAuthenticatedAt: new Date().toISOString(),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.search.mockResolvedValue({
    mode: "SANDBOX",
    rows: [],
    nextKind: null,
    nextId: null,
  });
  mocks.read.mockResolvedValue({
    mode: "SANDBOX",
    rows: [],
    productionCommerceEnabled: false,
  });
  mocks.prepareRequest.mockResolvedValue({
    requestId: "00000000-0000-4000-8000-000000000001",
    state: "PREPARED",
  });
  mocks.executeRequest.mockResolvedValue({
    id: "saved-case",
    state: "VERIFYING",
  });
  mocks.step.mockResolvedValue("fixture-only-token-at-least-32-characters");
  mocks.action.mockResolvedValue({ state: "PENDING", effective: false });
  mocks.denied.mockResolvedValue(undefined);
});
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3013/api/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://127.0.0.1:3013",
      ...headers,
    },
    body: JSON.stringify(body),
  });
it("never returns staff payload when interactive current staff admission fails", async () => {
  mocks.authorize.mockRejectedValue(Error("STAFF_REQUIRED"));
  const response = await GET(
    new Request("http://127.0.0.1:3013/api/admin?view=controls"),
  );
  expect(response.status).toBe(403);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain("rows");
});
it("rejects bearer and cross-origin access before resolving a browser staff actor", async () => {
  for (const headers of [
    { authorization: "Bearer fixture" },
    { origin: "https://foreign.invalid" },
    { "sec-fetch-site": "cross-site" },
  ])
    expect(
      (
        await GET(
          new Request("http://127.0.0.1:3013/api/admin?view=controls", {
            headers,
          }),
        )
      ).status,
    ).toBe(403);
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it("strictly rejects forged actor and unknown fields before database mutation", async () => {
  const response = await POST(
    post({ kind: "step-up", action: "policy:pause", target: "audits", actor }),
  );
  expect(response.status).toBe(403);
  expect(mocks.step).not.toHaveBeenCalled();
});
it("requires the current fresh staff actor and binds action,target,revision and token", async () => {
  const response = await POST(
    post({
      kind: "action",
      action: "policy:pause",
      target: "audits",
      token: "fixture-only-token-at-least-32-characters",
      args: { expectedRevision: 4 },
      reason: "controlled fixture pause",
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.authorize).toHaveBeenCalledWith("change");
  expect(mocks.action).toHaveBeenCalledWith(
    {},
    actor,
    "policy:pause",
    "audits",
    "fixture-only-token-at-least-32-characters",
    { expectedRevision: 4 },
    "controlled fixture pause",
  );
  expect(await response.json()).toEqual({ state: "PENDING", effective: false });
});
it("records a bounded denied action separately without returning SQL or raw request details", async () => {
  mocks.action.mockRejectedValue(Error("SECRET_DATABASE_QUERY_DO_NOT_ECHO"));
  const response = await POST(
    post({
      kind: "action",
      action: "policy:pause",
      target: "audits",
      token: "fixture-only-token-at-least-32-characters",
      args: { expectedRevision: 4 },
      reason: "controlled fixture pause",
    }),
  );
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("SECRET_DATABASE");
  expect(mocks.denied).toHaveBeenCalledWith(
    {},
    actor,
    "policy:pause",
    "audits",
  );
});
it("keeps staff reads private and bounded with explicit sandbox mode", async () => {
  const response = await GET(
    new Request("http://127.0.0.1:3013/api/admin?view=controls"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.authorize).toHaveBeenCalledWith("read");
  expect(mocks.read).toHaveBeenCalledWith({}, actor, "controls", undefined);
});

it("requires fresh interactive staff admission for named support searches and passes literal prefix only", async () => {
  const response = await GET(
    new Request(
      "http://127.0.0.1:3013/api/admin?view=search&query=support_fixture_&match=PREFIX",
    ),
  );
  expect(response.status).toBe(200);
  expect(mocks.authorize).toHaveBeenCalledWith("change");
  expect(mocks.search).toHaveBeenCalledWith({}, actor, {
    view: "search",
    query: "support_fixture_",
    match: "PREFIX",
  });
});
it("rejects search patterns and unknown authority fields before the fixed search service", async () => {
  const response = await GET(
    new Request(
      "http://127.0.0.1:3013/api/admin?view=search&query=support_%25&match=PREFIX&actor=forged",
    ),
  );
  expect(response.status).toBe(403);
  expect(mocks.search).not.toHaveBeenCalled();
});
it("requires fresh interactive staff admission for the optional qualified privacy projection", async () => {
  expect(
    (await GET(new Request("http://127.0.0.1:3013/api/admin?view=privacy")))
      .status,
  ).toBe(200);
  expect(mocks.authorize).toHaveBeenCalledWith("change");
  expect(mocks.read).toHaveBeenCalledWith({}, actor, "privacy", undefined);
});

it("prepares a frozen server-bound action request without returning a browser step-up secret", async () => {
  const input = {
    kind: "prepare-request",
    requestId: "00000000-0000-4000-8000-000000000001",
    action: "recovery:open",
    target: "fixture-user",
    args: {},
    reason: "controlled recovery fixture",
  };
  const response = await POST(post(input));
  expect(response.status).toBe(200);
  expect(mocks.prepareRequest).toHaveBeenCalledWith({}, actor, input);
  expect(await response.json()).not.toHaveProperty("token");
});
it("executes or replays only the same nonsecret request ID under current verified fresh staff admission", async () => {
  const requestId = "00000000-0000-4000-8000-000000000001";
  const response = await POST(post({ kind: "execute-request", requestId }));
  expect(response.status).toBe(200);
  expect(mocks.authorize).toHaveBeenCalledWith("change");
  expect(mocks.executeRequest).toHaveBeenCalledWith({}, actor, requestId);
});
it("rejects attempts to change the frozen request payload at execution", async () => {
  const response = await POST(
    post({
      kind: "execute-request",
      requestId: "00000000-0000-4000-8000-000000000001",
      target: "different",
      token: "untrusted",
    }),
  );
  expect(response.status).toBe(403);
  expect(mocks.executeRequest).not.toHaveBeenCalled();
});
