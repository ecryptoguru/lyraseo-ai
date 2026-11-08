import { expect, it } from "vitest";
import {
  projectBackupTables,
  type BackupTables,
} from "../../packages/db/src/backup-projection";
const row = (data: Record<string, unknown>) => ({
  data,
  jsonNulls: [] as string[],
});
const source = (): BackupTables => ({
  "public.Workspace": [row({ id: "w", name: "Workspace", deletedAt: null })],
  "public.Site": [
    row({
      id: "a",
      workspaceId: "w",
      origin: "https://site.example",
      deletedAt: null,
    }),
  ],
  "lyraseo_history.environment": [
    row({
      workspace_id: "w",
      site_id: "a",
      incarnation: "00000000-0000-0000-0000-000000000001",
      enabled: true,
    }),
  ],
  "public.ProductSession": [row({ sessionId: "DO_NOT_ARCHIVE_SESSION" })],
  "public.GoogleConnection": [
    row({ encryptedRefreshToken: "DO_NOT_ARCHIVE_TOKEN" }),
  ],
  "lyraseo_audit.artifact_verifier": [row({ secret: "DO_NOT_ARCHIVE_HMAC" })],
  "public.AuditRun": [
    row({
      id: "audit",
      workspaceId: "w",
      siteId: "a",
      resultExpiresAt: "2027-01-01T00:00:00.000000Z",
      evaluation: { score: 42, rules: [], rawHtml: "RAW_SOURCE_ONLY" },
      manifest: ["https://site.example/"],
    }),
  ],
  "public.AuditPage": [
    row({
      id: "page",
      workspaceId: "w",
      auditId: "audit",
      evidence: {
        acquired: true,
        status: 200,
        headComplete: false,
        bodyComplete: false,
        jsonLd: { raw: "RAW_SOURCE_ONLY" },
      },
      provenance: {
        channel: "raw-http",
        acquiredAt: "2026-11-01T00:00:00.000Z",
        rawHtml: "RAW_SOURCE_ONLY",
      },
    }),
  ],
  "public.Operation": [
    row({
      id: "op",
      workspaceId: "w",
      siteId: "a",
      fence: 7,
      attemptState: "INTENT",
      reservedCost: "0.010000001",
      actualCost: null,
      requestInput: { body: "PRIVATE_EXECUTABLE_INPUT" },
      leaseOwner: "old",
      leaseUntil: "2026-11-04T00:00:00.000000Z",
    }),
  ],
  "public.BudgetPeriod": [
    row({
      id: "budget",
      reserved: "0.010000001",
      spent: "0.100000001",
      limit: "10.000000000",
    }),
  ],
  "public.ContentDraft": [
    row({
      id: "draft",
      workspaceId: "w",
      siteId: "a",
      revision: 2,
      snapshot: { rawHtml: "RAW_SOURCE_ONLY" },
    }),
  ],
  "public.ContentRevision": [
    row({
      id: "old",
      workspaceId: "w",
      draftId: "draft",
      revision: 1,
      historyExpiresAt: "2026-01-01T00:00:00.000000Z",
      content: { body: "EXPIRED_REVISION_BODY" },
    }),
    row({
      id: "head",
      workspaceId: "w",
      draftId: "draft",
      revision: 2,
      historyExpiresAt: "2026-01-01T00:00:00.000000Z",
      content: { body: "AUTHORED_HEAD" },
    }),
  ],
});
it("projects raw copies and executable secrets before a full database dump while retaining financial identities and heads", () => {
  const original = source(),
    result = projectBackupTables(original, {
      at: "2026-11-03T00:00:00.000000Z",
      phase: "BACKUP",
    });
  const serialized = JSON.stringify(result.tables);
  for (const marker of [
    "RAW_SOURCE_ONLY",
    "DO_NOT_ARCHIVE_SESSION",
    "DO_NOT_ARCHIVE_TOKEN",
    "DO_NOT_ARCHIVE_HMAC",
    "PRIVATE_EXECUTABLE_INPUT",
    "EXPIRED_REVISION_BODY",
  ])
    expect(serialized).not.toContain(marker);
  expect(serialized).toContain("AUTHORED_HEAD");
  expect(result.tables["public.BudgetPeriod"]).toEqual(
    original["public.BudgetPeriod"],
  );
  expect(result.tables["public.Operation"]![0]!.data).toMatchObject({
    fence: 7,
    attemptState: "INTENT",
    reservedCost: "0.010000001",
  });
  expect(original["public.AuditPage"]![0]!.data.provenance).toMatchObject({
    rawHtml: "RAW_SOURCE_ONLY",
  });
});
it("replays an applied exact-incarnation deletion into a financial skeleton and preserves another scope", () => {
  const original = source();
  original["public.Site"]!.push(
    row({
      id: "b",
      workspaceId: "w",
      origin: "https://other.example",
      deletedAt: null,
    }),
  );
  const result = projectBackupTables(original, {
    at: "2026-11-03T00:00:00.000000Z",
    phase: "RESTORE",
    events: [
      {
        phase: "APPLIED",
        receiptClock: {
          acceptedAt: "2026-11-02T00:00:00.000Z",
          deadline: "2026-11-09T00:00:00.000Z",
          recordExpiresAt: "2027-05-01T00:00:00.000Z",
        },
        intent: {
          action: "DELETE_SITE",
          workspaceId: "w",
          siteId: "a",
          incarnation: "00000000-0000-0000-0000-000000000001",
        },
      },
    ],
  });
  expect(result.tables["public.AuditRun"]).toEqual([]);
  expect(result.tables["public.ContentDraft"]).toEqual([]);
  expect(
    result.tables["public.Site"]!.find((r) => r.data.id === "a")!.data,
  ).toMatchObject({
    deletedAt: "2026-11-02T00:00:00.000Z",
    verifiedAt: null,
  });
  expect(
    result.tables["public.Site"]!.find((r) => r.data.id === "b")!.data.origin,
  ).toBe("https://other.example");
  expect(result.tables["public.Operation"]![0]!.data).toMatchObject({
    fence: 7,
    attemptState: "INTENT",
  });
});
