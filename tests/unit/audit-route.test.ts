import { afterAll, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  readAuditRun: vi.fn(),
  readAuditSource: vi.fn(),
  listAuditRuns: vi.fn(),
  createAuditRun: vi.fn(),
  compareAuditRuns: vi.fn(),
  cancelAuditRun: vi.fn(),
  reviewAuditIssue: vi.fn(),
  runRawAuditStep: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("../../packages/db/src/audits", () => mocks);
vi.mock("@/server/acquisition/runner", () => ({
  runRawAuditStep: mocks.runRawAuditStep,
}));
vi.mock("@/server/acquisition/transport", () => ({
  publicHttpsTransport: vi.fn(),
}));
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/audits/route";
const scope = { workspaceId: "a", siteId: "site", auditId: "audit" };
const url =
  "http://127.0.0.1:3000/api/audits?workspaceId=a&siteId=site&auditId=audit";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LYRA_LOCAL_RAW_AUDITS", "true");
  vi.stubEnv("VERCEL", "");
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
  mocks.readAuditSource.mockResolvedValue(
    new TextEncoder().encode("<script>hostile</script>"),
  );
  mocks.readAuditRun.mockResolvedValue({
    id: "audit",
    profile: "LOCAL_RAW_V1",
    methodologyVersion: "readiness-v1",
    declarations: {},
    createdAt: new Date("2026-11-02T00:00:00Z"),
    pages: [
      {
        requestedUrl: "https://example.com/",
        provenance: {
          channel: "raw-http",
        },
      },
    ],
    evaluation: {
      coverage: 0.5,
      rules: [
        {
          ruleId: "E02",
          scopeKey: "\t=HOSTILE()",
          outcome: "FAIL",
          reasonCode: "MISSING_TITLE",
        },
      ],
    },
  });
});
afterAll(() => {
  vi.unstubAllEnvs();
});
it("hides raw HTML in status payloads while preserving separately authorized downloads", async () => {
  const response = await GET(new Request(url));
  expect(JSON.stringify(await response.json())).not.toContain("hostile");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const source = await GET(
    new Request(`${url}&format=source&url=https%3A%2F%2Fexample.com%2F`),
  );
  expect(source.headers.get("content-type")).toContain("text/plain");
  expect(source.headers.get("content-disposition")).toContain("attachment");
  expect(await source.text()).toBe("<script>hostile</script>");
});
it("exports scoped CSV with formula escaping and retained method/profile", async () => {
  const response = await GET(new Request(`${url}&format=csv`));
  const csv = await response.text();
  expect(csv).toContain("readiness-v1");
  expect(csv).toContain("LOCAL_RAW_V1");
  expect(csv).toContain("'\t=HOSTILE()");
  expect(mocks.readAuditRun).toHaveBeenCalledWith(
    {},
    { userId: "verified" },
    scope,
    "export",
  );
});
it("denies cross-origin mutations before dispatch", async () => {
  const response = await POST(
    new Request(url, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ action: "step", ...scope }),
    }),
  );
  expect(response.status).toBe(403);
  expect(mocks.runRawAuditStep).not.toHaveBeenCalled();
});
it("keeps hosted execution unavailable without runtime qualification", async () => {
  vi.stubEnv("VERCEL", "1");
  const response = await POST(
    new Request(url, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ action: "step", ...scope }),
    }),
  );
  expect(response.status).toBe(503);
  expect(mocks.runRawAuditStep).not.toHaveBeenCalled();
});
it("rejects oversized streaming request bodies without trusting content-length", async () => {
  const response = await POST(
    new Request(url, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000" },
      body: "x".repeat(65537),
    }),
  );
  expect(response.status).toBe(409);
  expect(mocks.runRawAuditStep).not.toHaveBeenCalled();
});
it("reauthorizes reads instead of accepting forged identity headers", async () => {
  mocks.resolveActor.mockRejectedValue(new Error("UNAUTHENTICATED"));
  const response = await GET(
    new Request(url, { headers: { "x-user-id": "owner" } }),
  );
  expect(response.status).toBe(401);
  expect(mocks.readAuditRun).not.toHaveBeenCalled();
});
