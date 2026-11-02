import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  createContentDraft: vi.fn(),
  saveContentDraft: vi.fn(),
  readContentDrafts: vi.fn(),
  captureEditorialEvidence: vi.fn(),
  storeEvidenceReport: vi.fn(),
  readEvidenceReports: vi.fn(),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.resolveActor,
  database: () => ({}),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("../../packages/db/src/content", () => mocks);
import { POST as contentPost } from "../../apps/lyraseo-web/src/app/api/content/route";
import {
  GET as reportGet,
  POST as reportPost,
} from "../../apps/lyraseo-web/src/app/api/reports/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActor.mockResolvedValue({ userId: "verified" });
});
const scope = { workspaceId: "a", siteId: "site" };
function request(body: unknown, origin = "http://127.0.0.1:3000") {
  return new Request(origin + "/api/content", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
it("rejects cross-origin and oversized editorial mutations before DB dispatch", async () => {
  expect(
    (
      await contentPost(
        request({ ...scope, action: "generate" }, "https://evil.invalid"),
      )
    ).status,
  ).toBe(403);
  expect(
    (await contentPost(request({ body: "x".repeat(200001) }))).status,
  ).toBe(409);
  expect(mocks.createContentDraft).not.toHaveBeenCalled();
  expect(mocks.readContentDrafts).not.toHaveBeenCalled();
});
it("never dispatches paid generation without qualified tariffs and authorizes access first", async () => {
  mocks.readContentDrafts.mockResolvedValue([]);
  const response = await contentPost(request({ ...scope, action: "generate" }));
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("verified editorial provider tariff");
  mocks.readContentDrafts.mockRejectedValue(new Error("FORBIDDEN"));
  expect(
    (await contentPost(request({ ...scope, action: "generate" }))).status,
  ).toBe(404);
});
it("rejects report capture before renderer when grants were revoked", async () => {
  mocks.captureEditorialEvidence.mockRejectedValue(new Error("FORBIDDEN"));
  const response = await reportPost(
    request({
      ...scope,
      title: "Private",
      auditIds: ["run"],
      searchSnapshotIds: [],
    }),
  );
  expect(response.status).toBe(404);
  expect(mocks.storeEvidenceReport).not.toHaveBeenCalled();
});
it("returns only persisted PDF bytes with attachment and private cache controls", async () => {
  mocks.readEvidenceReports.mockResolvedValue({
    id: "report",
    pdf: new Uint8Array([37, 80, 68, 70]),
    csv: "stored,csv",
  });
  const response = await reportGet(
    new Request(
      "http://127.0.0.1:3000/api/reports?workspaceId=a&siteId=site&reportId=report&format=pdf",
    ),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("%PDF");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="lyraseo-report.pdf"',
  );
  expect(mocks.readEvidenceReports).toHaveBeenCalledWith(
    {},
    { userId: "verified" },
    scope,
    "report",
  );
});
