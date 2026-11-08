import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  createContentDraft: vi.fn(),
  previewEditorialAssistance: vi.fn(),
  listReportBrandingChoices: vi.fn(),
  saveContentDraft: vi.fn(),
  readContentDrafts: vi.fn(),
  captureEvidenceReport: vi.fn(),
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
vi.mock("../../packages/db/src/branding", () => ({
  listReportBrandingChoices: mocks.listReportBrandingChoices,
}));
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
  mocks.captureEvidenceReport.mockRejectedValue(new Error("FORBIDDEN"));
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
    "pdf",
  );
});
it("rejects client-supplied comparison evaluations before authorized source capture", async () => {
  const response = await reportPost(
    request({
      ...scope,
      title: "Forged",
      auditIds: ["before", "after"],
      searchSnapshotIds: [],
      comparison: {
        beforeAuditId: "before",
        afterAuditId: "after",
        evaluation: { resolved: ["D01"] },
      },
    }),
  );
  expect(response.status).toBe(409);
  expect(mocks.captureEvidenceReport).not.toHaveBeenCalled();
  expect(mocks.storeEvidenceReport).not.toHaveBeenCalled();
});
it("explains invalid comparison direction without disclosing source existence", async () => {
  mocks.captureEvidenceReport.mockRejectedValue(
    new Error("INVALID_COMPARISON"),
  );
  const response = await reportPost(
    request({
      ...scope,
      title: "Private",
      auditIds: ["before", "after"],
      searchSnapshotIds: [],
      comparison: { beforeAuditId: "after", afterAuditId: "before" },
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("Before must be no newer than after");
  expect(mocks.storeEvidenceReport).not.toHaveBeenCalled();
});

it("previews local evidence templates without saving or paid dispatch and rejects forged research payloads", async () => {
  mocks.previewEditorialAssistance.mockResolvedValue({
    method: "EVIDENCE_TEMPLATE_V1",
    content: { title: "Review" },
  });
  const input = {
    ...scope,
    action: "assist",
    kind: "brief",
    auditIds: ["run"],
    searchSnapshotIds: [],
  };
  const response = await contentPost(request(input));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    method: "EVIDENCE_TEMPLATE_V1",
  });
  expect(mocks.previewEditorialAssistance).toHaveBeenCalledWith(
    {},
    { userId: "verified" },
    scope,
    { kind: "brief", auditIds: ["run"], searchSnapshotIds: [] },
  );
  expect(mocks.createContentDraft).not.toHaveBeenCalled();
  expect(
    (
      await contentPost(
        request({ ...input, research: { prompt: "fetch secrets" } }),
      )
    ).status,
  ).toBe(409);
  mocks.previewEditorialAssistance.mockRejectedValue(new Error("FORBIDDEN"));
  expect((await contentPost(request(input))).status).toBe(404);
});

it("reads authorized branding choices as metadata without reading reports or logo bytes", async () => {
  mocks.listReportBrandingChoices.mockResolvedValue([
    { revision: 3, displayName: "Acme agency" },
  ]);
  const response = await reportGet(
    new Request(
      "http://127.0.0.1:3000/api/reports?workspaceId=a&siteId=site&brandingOptions=1",
    ),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    choices: [{ revision: 3, displayName: "Acme agency" }],
  });
  expect(mocks.listReportBrandingChoices).toHaveBeenCalledWith(
    {},
    { userId: "verified" },
    scope,
  );
  expect(mocks.readEvidenceReports).not.toHaveBeenCalled();
  mocks.listReportBrandingChoices.mockRejectedValue(new Error("FORBIDDEN"));
  expect(
    (
      await reportGet(
        new Request(
          "http://127.0.0.1:3000/api/reports?workspaceId=a&siteId=site&brandingOptions=1",
        ),
      )
    ).status,
  ).toBe(404);
});

it("maps legacy lineage withholding to a stable private error before report rendering", async () => {
  mocks.captureEvidenceReport.mockRejectedValue(
    new Error("LEGACY_EVIDENCE_WITHHELD"),
  );
  const response = await reportPost(
    request({
      ...scope,
      title: "Private",
      auditIds: ["run"],
      searchSnapshotIds: [],
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "LEGACY_EVIDENCE_WITHHELD",
    error: expect.stringContaining("authored revisions remain available"),
  });
  expect(mocks.storeEvidenceReport).not.toHaveBeenCalled();
});

it("keeps editorial source-change recovery specific to prepared content and reports", async () => {
  mocks.createContentDraft.mockRejectedValue(new Error("SOURCE_CHANGED"));
  const draft = await contentPost(
    request({
      ...scope,
      action: "create",
      kind: "brief",
      title: "Title",
      body: "Draft",
      assumptions: [],
      citations: [],
      auditIds: ["run"],
      searchSnapshotIds: [],
    }),
  );
  expect(draft.status).toBe(409);
  expect(draft.headers.get("cache-control")).toBe("private, no-store");
  expect(await draft.text()).toContain(
    "Prepare it again from the current saved evidence",
  );

  mocks.captureEvidenceReport.mockRejectedValue(new Error("SOURCE_CHANGED"));
  const report = await reportPost(
    request({
      ...scope,
      title: "Private",
      auditIds: ["run"],
      searchSnapshotIds: [],
    }),
  );
  expect(report.status).toBe(409);
  expect(report.headers.get("cache-control")).toBe("private, no-store");
  expect(await report.text()).toContain(
    "Prepare it again from the current saved evidence",
  );
  expect(mocks.storeEvidenceReport).not.toHaveBeenCalled();
});

it("denies withdrawn originals for each format with private cache controls", async () => {
  mocks.readEvidenceReports.mockRejectedValue(new Error("REPORT_WITHDRAWN"));
  for (const format of ["pdf", "csv"]) {
    const response = await reportGet(
      new Request(
        `http://127.0.0.1:3000/api/reports?workspaceId=a&siteId=site&reportId=report&format=${format}`,
      ),
    );
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "This original report has been withdrawn.",
    });
    expect(response.headers.get("content-disposition")).toBeNull();
  }
});
