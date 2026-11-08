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
it("classifies current-schema relations: revoked handoff secrets, suppressed dispatch, disabled billing/staff authority, omitted bearers and scoped deletion", () => {
  const secret = "DO_NOT_ARCHIVE_HANDOFF_SECRET";
  const tables: BackupTables = {
    "public.Site": [
      row({
        id: "a",
        workspaceId: "w",
        origin: "https://site.example",
        deletedAt: "2026-11-01T00:00:00.000Z",
      }),
    ],
    "public.Workspace": [row({ id: "w", name: "Workspace", deletedAt: null })],
    "lyraseo_history.environment": [
      row({
        workspace_id: "w",
        site_id: "a",
        incarnation: "00000000-0000-0000-0000-000000000001",
        enabled: true,
      }),
    ],
    "lyraseo_handoff.destination": [
      row({
        id: "dest",
        workspace_id: "w",
        site_id: "a",
        secret_cipher: secret,
        previous_cipher: secret,
        previous_key_id: "k1",
        previous_until: "2026-11-04T00:00:00.000Z",
        key_id: "k2",
        status: "CONFIGURED",
      }),
      row({
        id: "dest-b",
        workspace_id: "w",
        site_id: "b",
        secret_cipher: secret,
        previous_cipher: null,
        previous_key_id: null,
        previous_until: null,
        key_id: "k2",
        status: "CONFIGURED",
      }),
    ],
    "lyraseo_handoff.intent": [
      row({
        id: "intent",
        workspace_id: "w",
        site_id: "b",
        state: "SENDING",
        lease_until: "2026-11-04T00:00:00.000Z",
        next_due_at: "2026-11-03T00:00:00.000Z",
      }),
    ],
    "lyraseo_handoff.dispatch": [
      row({
        id: "dispatch",
        intent_id: "intent",
        state: "PENDING",
        claim_token: "00000000-0000-0000-0000-000000000001",
        lease_until: "2026-11-04T00:00:00.000Z",
        next_due: "2026-11-03T00:00:00.000Z",
      }),
    ],
    "lyraseo_handoff.dispatch_policy": [
      row({
        id: true,
        enabled: true,
        revision: 3,
        changed_at: "2026-11-01T00:00:00.000Z",
      }),
    ],
    "lyraseo_handoff.dispatch_policy_history": [],
    "lyraseo_billing.merchant": [
      row({ provider: "POLAR", merchant_id: "m", enabled: true }),
    ],
    "lyraseo_billing.subscription": [
      row({
        resource_id: "r",
        sandbox_entitled: true,
        production_entitled: false,
      }),
    ],
    "lyraseo_billing.staff_capability": [
      row({
        user_id: "u",
        action: "billing:reconcile",
        enabled: true,
        revision: 2,
      }),
    ],
    "lyraseo_billing.staff_epoch": [row({ user_id: "u", revision: 4 })],
    "lyraseo_billing.step_up": [
      row({ token_hash: "DO_NOT_ARCHIVE_STEPUP", user_id: "u" }),
    ],
    "lyraseo_billing.action_request": [
      row({ id: "req", token_hash: "tok", args_text: "PRIVATE_ARGS" }),
    ],
    "lyraseo_ledger.managed_operation": [
      row({
        operation_id: "op",
        workspace_id: "w",
        site_id: "a",
        paused: false,
      }),
    ],
    "lyraseo_ledger.reconciliation": [
      row({
        operation_id: "op",
        lease_until: "2026-11-04T00:00:00.000Z",
        next_attempt_at: "2026-11-03T00:00:00.000Z",
      }),
    ],
    "lyraseo_ledger.qualification": [
      row({ id: "q", live_enabled: false, revoked_at: null }),
    ],
    "public.WorkspaceInvitation": [
      row({ id: "inv", tokenHash: "DO_NOT_ARCHIVE_INVITE" }),
    ],
    "public.AgencyBatchQuote": [
      row({
        id: "quote",
        workspaceId: "w",
        requestInput: { private: "PRIVATE_BATCH_INPUT" },
        expiresAt: "2027-01-01T00:00:00.000000Z",
        confirmedAt: "2026-11-02T00:00:00.000Z",
        confirmationKey: "DO_NOT_ARCHIVE_CONFIRM",
      }),
    ],
    "public.KeywordSelection": [
      row({
        id: "sel",
        workspaceId: "w",
        siteId: "b",
        request: { private: "PRIVATE_KEYWORD_REQUEST" },
        resultExpiresAt: "2027-01-01T00:00:00.000000Z",
      }),
    ],
    "lyraseo_report.decision": [
      row({
        id: "dec",
        workspace_id: "w",
        site_id: "a",
        receipt_expires_at: "2027-01-01T00:00:00.000Z",
      }),
      row({
        id: "dec-b",
        workspace_id: "w",
        site_id: "b",
        receipt_expires_at: "2027-01-01T00:00:00.000Z",
      }),
    ],
  };
  const result = projectBackupTables(tables, {
    at: "2026-11-03T00:00:00.000000Z",
    phase: "RESTORE",
  });
  const serialized = JSON.stringify(result.tables);
  for (const marker of [
    "DO_NOT_ARCHIVE_HANDOFF_SECRET",
    "DO_NOT_ARCHIVE_STEPUP",
    "DO_NOT_ARCHIVE_INVITE",
    "DO_NOT_ARCHIVE_CONFIRM",
    "PRIVATE_ARGS",
    "PRIVATE_BATCH_INPUT",
    "PRIVATE_KEYWORD_REQUEST",
  ])
    expect(serialized).not.toContain(marker);
  // Erased scope: destination and decision withdrawn, not merely revoked.
  expect(
    result.tables["lyraseo_handoff.destination"]!.map((p) => p.data.id),
  ).toEqual(["dest-b"]);
  expect(result.tables["lyraseo_handoff.destination"]![0]!.data).toMatchObject({
    status: "REVOKED",
    secret_cipher: null,
    previous_cipher: null,
    key_id: null,
  });
  expect(
    result.tables["lyraseo_report.decision"]!.map((p) => p.data.id),
  ).toEqual(["dec-b"]);
  // Surviving scope: handoff revoked/cancelled/suppressed, never sendable.
  expect(result.tables["lyraseo_handoff.intent"]![0]!.data).toMatchObject({
    state: "CANCELLED",
  });
  expect(result.tables["lyraseo_handoff.dispatch"]![0]!.data).toMatchObject({
    state: "SUPPRESSED",
    claim_token: null,
    next_due: null,
  });
  expect(
    result.tables["lyraseo_handoff.dispatch_policy"]![0]!.data,
  ).toMatchObject({ enabled: false, revision: 4 });
  expect(result.tables["lyraseo_handoff.dispatch_policy_history"]).toHaveLength(
    1,
  );
  // Financial/session authority fails closed; financial ledger facts remain.
  expect(result.tables["lyraseo_billing.merchant"]![0]!.data).toMatchObject({
    enabled: false,
  });
  expect(result.tables["lyraseo_billing.subscription"]![0]!.data).toMatchObject(
    { sandbox_entitled: false, production_entitled: false },
  );
  expect(
    result.tables["lyraseo_billing.staff_capability"]![0]!.data,
  ).toMatchObject({ enabled: false, revision: 3 });
  expect(result.tables["lyraseo_billing.staff_epoch"]![0]!.data).toMatchObject({
    revision: 5,
  });
  expect(result.tables["lyraseo_billing.step_up"]).toEqual([]);
  expect(result.tables["lyraseo_billing.action_request"]).toEqual([]);
  expect(result.tables["public.WorkspaceInvitation"]).toEqual([]);
  expect(
    result.tables["lyraseo_ledger.managed_operation"]![0]!.data,
  ).toMatchObject({ paused: true });
  expect(
    result.tables["lyraseo_ledger.reconciliation"]![0]!.data,
  ).toMatchObject({ lease_until: null, next_attempt_at: null });
  expect(result.tables["lyraseo_ledger.qualification"]![0]!.data).toMatchObject(
    { live_enabled: false },
  );
  // Agency/keyword inputs are hash-only projections of retained requests.
  expect(result.tables["public.AgencyBatchQuote"]![0]!.data).toMatchObject({
    confirmationKey: null,
    confirmedAt: null,
  });
  expect(result.tables["public.KeywordSelection"]).toHaveLength(1);
});
it("fails closed on unknown current relations and on replay of a pending deletion", () => {
  expect(() =>
    projectBackupTables(
      {
        "lyraseo_handoff.unknown_future_table": [row({ id: "x" })],
      } as unknown as BackupTables,
      { at: "2026-11-03T00:00:00.000000Z", phase: "BACKUP" },
    ),
  ).toThrow("MISSING_BACKUP_ADAPTER");
});
