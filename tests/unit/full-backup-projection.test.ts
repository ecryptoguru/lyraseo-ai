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
        url: "https://other.example/hook",
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
        destination_url: "https://other.example/hook",
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
        confirmationKey: "confirmed-idempotency",
        preview: {
          batchQuoteId: "quote",
          expiresAt: "2027-01-01T00:00:00.000Z",
          inputHash: "a".repeat(64),
          items: [],
          totalsByProvider: {},
          combinedMaximum: null,
          currency: "USD",
          budgetOwnerId: "u",
          unavailable: true,
        },
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
    confirmationKey: "confirmed-idempotency",
    confirmedAt: "2026-11-02T00:00:00.000Z",
    confirmationHash: "RESTORE_DISABLED",
  });
  expect(result.tables["public.KeywordSelection"]).toHaveLength(1);
});
const projectionClock = "2026-11-03T00:00:00.000000Z";
const deletionGraph = (): BackupTables => ({
  "public.Workspace": [row({ id: "w", name: "Workspace", deletedAt: null })],
  "public.Site": [
    row({
      id: "a",
      workspaceId: "w",
      origin: "https://private.example",
      deletedAt: "2026-11-01T12:30:00.123Z",
    }),
  ],
  "lyraseo_deletion.scope_case": [
    row({
      id: "00000000-0000-0000-0000-000000000010",
      request_id: "00000000-0000-0000-0000-000000000011",
      workspace_id: "w",
      site_id: "a",
      incarnation: "00000000-0000-0000-0000-000000000001",
      actor_id: "u",
      actor_security_version: 3,
      policy_version: "SITE_DELETION_LOCAL_V1",
      journal_partition: "00000000-0000-0000-0000-000000000012",
      journal_sequence: "42",
      journal_hash: "a".repeat(64),
      accepted_at: "2026-11-01T12:30:00.123Z",
      deadline: "2026-11-08T12:30:00.123Z",
      record_expires_at: "2027-04-30T12:30:00.123Z",
      receipt_hash: "b".repeat(64),
    }),
  ],
  "lyraseo_deletion.task": [
    row({
      case_id: "00000000-0000-0000-0000-000000000010",
      kind: "AUTHORED_PAYLOAD",
      state: "NEEDS_ADAPTER",
      fence: 4,
      attempts: 3,
      next_retry_at: "2026-11-02T12:30:00.123Z",
      completed_at: null,
      result: { reason: "BOUNDED_ERASURE_NOT_QUALIFIED" },
    }),
  ],
  "lyraseo_deletion.event": [
    row({
      id: "00000000-0000-0000-0000-000000000013",
      case_id: "00000000-0000-0000-0000-000000000010",
      kind: "AUTHORED_PAYLOAD",
      fence: 4,
      result: { reason: "BOUNDED_ERASURE_NOT_QUALIFIED" },
      recorded_at: "2026-11-02T12:30:00.123Z",
    }),
  ],
  "public.ContentDraft": [
    row({
      id: "draft",
      workspaceId: "w",
      siteId: "a",
      snapshot: { body: "ERASED_AUTHORED_PAYLOAD" },
    }),
  ],
  "public.WorkspaceBrandingRevision": [
    row({
      id: "brand",
      workspaceId: "w",
      revision: 1,
      displayName: "Shared agency",
      logoBytes: "\\x89504e47",
      logoSha256: "c".repeat(64),
      mime: "image/png",
      width: 1,
      height: 1,
      createdBy: "u",
      createdAt: "2026-10-01T00:00:00.000Z",
    }),
  ],
});
it.each(["BACKUP", "RESTORE"] as const)(
  "keeps the tombstoned deletion receipt graph and its original clocks in %s, not erased authored payload",
  (phase) => {
    const tables = projectBackupTables(deletionGraph(), {
      at: projectionClock,
      phase,
    }).tables;
    expect(tables["lyraseo_deletion.scope_case"]).toHaveLength(1);
    expect(tables["lyraseo_deletion.scope_case"]![0]!.data).toMatchObject({
      id: "00000000-0000-0000-0000-000000000010",
      journal_sequence: "42",
      accepted_at: "2026-11-01T12:30:00.123Z",
      deadline: "2026-11-08T12:30:00.123Z",
      record_expires_at: "2027-04-30T12:30:00.123Z",
    });
    expect(tables["lyraseo_deletion.task"]![0]!.data).toMatchObject({
      case_id: "00000000-0000-0000-0000-000000000010",
      fence: 4,
      attempts: 3,
      next_retry_at: "2026-11-02T12:30:00.123Z",
    });
    expect(tables["lyraseo_deletion.event"]![0]!.data).toMatchObject({
      case_id: "00000000-0000-0000-0000-000000000010",
      recorded_at: "2026-11-02T12:30:00.123Z",
    });
    expect(tables["public.Site"]![0]!.data.deletedAt).toBe(
      "2026-11-01T12:30:00.123Z",
    );
    expect(tables["public.ContentDraft"]).toEqual([]);
    expect(JSON.stringify(tables)).not.toContain("ERASED_AUTHORED_PAYLOAD");
    expect(tables["public.WorkspaceBrandingRevision"]![0]!.data).toMatchObject({
      displayName: "Shared agency",
      logoBytes: "\\x89504e47",
    });
  },
);
it("expires completed deletion receipt parents and children together at the original receipt deadline", () => {
  const input = deletionGraph();
  input["lyraseo_deletion.task"] = [
    "IMPORTS",
    "CREDENTIALS",
    "AUTHORED_PAYLOAD",
    "AUDIT_PAYLOAD",
    "ARTIFACTS",
    "VISIBILITY_PAYLOAD",
    "KEYWORD_DATA",
    "HANDOFF_DATA",
    "TEAM_DATA",
    "PROCESSORS",
    "BACKUPS",
    "FINANCIAL_IDENTITY",
  ].map((kind) =>
    row({
      ...input["lyraseo_deletion.task"]![0]!.data,
      kind,
      state: "COMPLETE",
    }),
  );
  input["lyraseo_deletion.scope_case"]![0]!.data.record_expires_at =
    projectionClock;
  const tables = projectBackupTables(input, {
    at: projectionClock,
    phase: "RESTORE",
  }).tables;
  expect(tables["lyraseo_deletion.scope_case"]).toEqual([]);
  expect(tables["lyraseo_deletion.task"]).toEqual([]);
  expect(tables["lyraseo_deletion.event"]).toEqual([]);
  expect(tables["public.Site"]).toHaveLength(1);
});
it.each(["PENDING", "NEEDS_ADAPTER"])(
  "blocks an expired deletion receipt with unresolved %s work instead of dropping it",
  (state) => {
    const input = deletionGraph();
    input["lyraseo_deletion.scope_case"]![0]!.data.record_expires_at =
      projectionClock;
    input["lyraseo_deletion.task"]![0]!.data.state = state;
    expect(() =>
      projectBackupTables(input, { at: projectionClock, phase: "RESTORE" }),
    ).toThrow("BACKUP_DELETION_WORK_UNRESOLVED");
  },
);
it("does not equate missing deletion-task coverage with completed deletion", () => {
  const input = deletionGraph();
  input["lyraseo_deletion.scope_case"]![0]!.data.record_expires_at =
    projectionClock;
  input["lyraseo_deletion.task"] = [];
  expect(() =>
    projectBackupTables(input, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_DELETION_WORK_UNRESOLVED");
});
it("cascades expired audit assignments through assignmentId while preserving live audit event history", () => {
  const tables = projectBackupTables(
    {
      "public.AuditRun": [
        row({
          id: "expired",
          workspaceId: "w",
          siteId: "a",
          resultExpiresAt: projectionClock,
        }),
        row({
          id: "live",
          workspaceId: "w",
          siteId: "a",
          resultExpiresAt: "2026-12-01T00:00:00.000Z",
        }),
      ],
      "public.IssueAssignment": [
        row({
          id: "old-assignment",
          workspaceId: "w",
          siteId: "a",
          auditId: "expired",
          ruleId: "schema",
          scopeKey: "/",
          revision: 1,
        }),
        row({
          id: "live-assignment",
          workspaceId: "w",
          siteId: "a",
          auditId: "live",
          ruleId: "schema",
          scopeKey: "/",
          revision: 1,
        }),
      ],
      "public.IssueAssignmentEvent": [
        row({
          id: "old-event",
          workspaceId: "w",
          siteId: "a",
          assignmentId: "old-assignment",
          revision: 1,
          actorId: "u",
          assigneeUserId: "v",
          createdAt: "2026-11-01T00:00:00.000Z",
          idempotencyKey: "old-key",
          inputHash: "a".repeat(64),
        }),
        row({
          id: "live-event",
          workspaceId: "w",
          siteId: "a",
          assignmentId: "live-assignment",
          revision: 1,
          actorId: "u",
          assigneeUserId: "v",
          createdAt: "2026-11-01T00:00:00.000Z",
          idempotencyKey: "live-key",
          inputHash: "b".repeat(64),
        }),
      ],
    },
    { at: projectionClock, phase: "BACKUP" },
  ).tables;
  expect(tables["public.IssueAssignment"]!.map((p) => p.data.id)).toEqual([
    "live-assignment",
  ]);
  expect(tables["public.IssueAssignmentEvent"]!.map((p) => p.data.id)).toEqual([
    "live-event",
  ]);
});
const billingGraph = (): BackupTables => ({
  "public.Workspace": [row({ id: "w", deletedAt: null })],
  "lyraseo_billing.merchant": [
    row({
      provider: "POLAR",
      merchant_id: "merchant",
      mode: "SANDBOX",
      enabled: true,
    }),
  ],
  "lyraseo_billing.account": [
    row({
      id: "00000000-0000-0000-0000-000000000020",
      workspace_id: "w",
      tombstoned_at: null,
      revision: 1,
      created_at: "2026-11-01T00:00:00.000Z",
    }),
  ],
  "lyraseo_billing.binding": [
    row({
      provider: "POLAR",
      merchant_id: "merchant",
      resource_id: "subscription",
      customer_id: "customer",
      account_id: "00000000-0000-0000-0000-000000000020",
    }),
  ],
  "lyraseo_billing.event": [
    row({
      id: "00000000-0000-0000-0000-000000000021",
      provider: "POLAR",
      merchant_id: "merchant",
      external_id: "accepted-event",
      payload_hash: "a".repeat(64),
      key_version: "v1",
      event_type: "subscription.active",
      resource_id: "subscription",
      account_id: "00000000-0000-0000-0000-000000000020",
      references_json: {
        subscriptionId: "subscription",
        customerId: "customer",
        accountVerified: true,
      },
      occurred_at: "2026-11-01T00:00:00.000Z",
      received_at: "2026-11-01T01:00:00.000Z",
      contract: "SYNTHETIC_CANONICAL_V2",
      collision: false,
      mode: "SANDBOX",
    }),
    row({
      id: "00000000-0000-0000-0000-000000000022",
      provider: "POLAR",
      merchant_id: "merchant",
      external_id: "unresolved-event",
      payload_hash: "b".repeat(64),
      key_version: "v1",
      event_type: "payment.succeeded",
      resource_id: "payment",
      account_id: null,
      references_json: { paymentId: "payment" },
      occurred_at: "2026-11-01T00:00:00.000Z",
      received_at: "2026-11-01T01:00:00.000Z",
      contract: "SYNTHETIC_CANONICAL_V2",
      collision: false,
      mode: "SANDBOX",
    }),
  ],
  "lyraseo_billing.event_route": [
    row({
      event_id: "00000000-0000-0000-0000-000000000021",
      account_id: "00000000-0000-0000-0000-000000000020",
      provider: "POLAR",
      merchant_id: "merchant",
      resource_id: "subscription",
      basis: "SIGNED_SUBSCRIPTION_REFERENCE",
    }),
  ],
  "lyraseo_billing.inbox": [
    row({
      id: "00000000-0000-0000-0000-000000000023",
      provider: "POLAR",
      merchant_id: "merchant",
      resource_id: "subscription",
      generation: 4,
      fence: 3,
      token: "00000000-0000-0000-0000-000000000099",
      lease_until: "2026-11-03T00:01:00.000Z",
      state: "READING",
      attempts: 2,
      next_at: "2026-11-01T00:00:00.000Z",
      last_error: "RAW_READER_DETAIL",
      completed_at: null,
    }),
  ],
  "lyraseo_billing.discovery": [
    row({
      event_id: "00000000-0000-0000-0000-000000000022",
      state: "PENDING",
      attempts: 0,
      next_at: "2026-11-01T00:00:00.000Z",
      last_error: "RAW_READER_DETAIL",
    }),
  ],
});
it.each(["BACKUP", "RESTORE"] as const)(
  "retains accepted billing event queues in %s without executable claims or due dispatch",
  (phase) => {
    const tables = projectBackupTables(billingGraph(), {
      at: projectionClock,
      phase,
    }).tables;
    expect(
      tables["lyraseo_billing.event"]!.map((p) => p.data.external_id),
    ).toEqual(["accepted-event", "unresolved-event"]);
    expect(tables["lyraseo_billing.event_route"]![0]!.data.event_id).toBe(
      "00000000-0000-0000-0000-000000000021",
    );
    expect(tables["lyraseo_billing.inbox"]).toHaveLength(1);
    expect(tables["lyraseo_billing.inbox"]![0]!.data).toEqual({
      id: "00000000-0000-0000-0000-000000000023",
      provider: "POLAR",
      merchant_id: "merchant",
      resource_id: "subscription",
      generation: 4,
      fence: 3,
      token: null,
      lease_until: null,
      state: "READING",
      attempts: 2,
      next_at: "infinity",
      last_error: "RESTORE_REQUIRES_EXPLICIT_RECONCILIATION",
      completed_at: null,
    });
    expect(tables["lyraseo_billing.discovery"]![0]!.data).toEqual({
      event_id: "00000000-0000-0000-0000-000000000022",
      state: "PENDING",
      attempts: 0,
      next_at: "infinity",
      last_error: "RESTORE_REQUIRES_EXPLICIT_RECONCILIATION",
    });
    expect(JSON.stringify(tables)).not.toContain("RAW_READER_DETAIL");
  },
);
const committedBatchGraph = (): BackupTables => ({
  "public.Workspace": [row({ id: "w", deletedAt: null })],
  "public.Site": [
    row({
      id: "a",
      workspaceId: "w",
      origin: "https://private.example",
      deletedAt: "2026-11-01T00:00:00.000Z",
    }),
  ],
  "public.Operation": [
    row({
      id: "charged",
      workspaceId: "w",
      siteId: "a",
      userId: "u",
      idempotencyKey: "child-idempotency",
      reservedCost: "0.010000001",
      actualCost: "0.009000001",
      fence: 8,
      attemptState: "INTENT",
      requestInput: { body: "EXECUTABLE_BATCH_INPUT" },
    }),
  ],
  "public.OperationQuote": [
    row({
      id: "child-quote",
      workspaceId: "w",
      siteId: "a",
      userId: "u",
      consumedOperationId: "charged",
      maximumCost: "0.010000001",
      inputHash: "a".repeat(64),
      requestInput: { body: "EXECUTABLE_BATCH_INPUT" },
    }),
  ],
  "public.AgencyBatchQuote": [
    row({
      id: "batch",
      workspaceId: "w",
      userId: "u",
      securityVersion: 3,
      requestInput: {
        workspaceId: "w",
        items: [
          {
            siteId: "a",
            kind: "GENERATION",
            input: { body: "EXECUTABLE_BATCH_INPUT" },
          },
        ],
      },
      inputHash: "b".repeat(64),
      confirmationHash: "c".repeat(64),
      preview: {
        batchQuoteId: "batch",
        expiresAt: "2026-11-01T00:05:00.000Z",
        inputHash: "b".repeat(64),
        items: [
          {
            siteId: "a",
            ordinal: 0,
            quoteId: "child-quote",
            maximumCost: "0.010000001",
            provider: "OPENAI",
            tariffVersion: "v1",
            status: "QUOTED",
            errorCode: null,
          },
        ],
        totalsByProvider: { OPENAI: "0.010000001" },
        combinedMaximum: "0.010000001",
        currency: "USD",
        budgetOwnerId: "u",
        unavailable: false,
      },
      createdAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-11-01T00:05:00.000Z",
      confirmedAt: "2026-11-01T00:00:10.000Z",
      confirmationKey: "batch-idempotency",
    }),
  ],
  "public.AgencyBatchItem": [
    row({
      batchQuoteId: "batch",
      workspaceId: "w",
      userId: "u",
      siteId: "a",
      ordinal: 0,
      quoteId: "child-quote",
      operationId: "charged",
      status: "ADMITTED",
      errorCode: null,
    }),
  ],
  "public.BudgetPeriod": [
    row({
      id: "provider",
      limit: "10.000000000",
      reserved: "0.010000001",
      spent: "0.009000001",
    }),
    row({
      id: "product",
      limit: "8.000000000",
      reserved: "0.010000001",
      spent: "0.009000001",
    }),
    row({
      id: "api",
      limit: "1.000000000",
      reserved: "0.010000001",
      spent: "0.009000001",
    }),
    row({
      id: "visibility",
      limit: "1.000000000",
      reserved: "0.010000001",
      spent: "0.009000001",
    }),
  ],
});
it.each(["BACKUP", "RESTORE"] as const)(
  "preserves expired committed batch financial links, exact amounts and confirmation dates in %s",
  (phase) => {
    const tables = projectBackupTables(committedBatchGraph(), {
      at: projectionClock,
      phase,
    }).tables;
    expect(tables["public.AgencyBatchQuote"]).toHaveLength(1);
    expect(tables["public.AgencyBatchQuote"]![0]!.data).toMatchObject({
      id: "batch",
      confirmedAt: "2026-11-01T00:00:10.000Z",
      confirmationKey: "batch-idempotency",
      confirmationHash: "RESTORE_DISABLED",
      requestInput: null,
      expiresAt: "2026-11-01T00:05:00.000Z",
      preview: {
        combinedMaximum: "0.010000001",
        items: [{ ordinal: 0, maximumCost: "0.010000001" }],
      },
    });
    expect(tables["public.AgencyBatchItem"]![0]!.data).toEqual({
      batchQuoteId: "batch",
      workspaceId: "w",
      userId: "u",
      siteId: "a",
      ordinal: 0,
      quoteId: "child-quote",
      operationId: "charged",
      status: "ADMITTED",
      errorCode: null,
    });
    expect(tables["public.OperationQuote"]![0]!.data).toMatchObject({
      consumedOperationId: "charged",
      maximumCost: "0.010000001",
      requestInput: null,
    });
    expect(tables["public.Operation"]![0]!.data).toMatchObject({
      idempotencyKey: "child-idempotency",
      reservedCost: "0.010000001",
      actualCost: "0.009000001",
      fence: 8,
      attemptState: "INTENT",
    });
    expect(tables["public.BudgetPeriod"]!.map((p) => p.data.limit)).toEqual([
      "10.000000000",
      "8.000000000",
      "1.000000000",
      "1.000000000",
    ]);
    expect(JSON.stringify(tables)).not.toContain("EXECUTABLE_BATCH_INPUT");
  },
);
it("keeps a committed child whose item link was not yet reconciled when its consumed quote committed", () => {
  const input = committedBatchGraph();
  Object.assign(input["public.AgencyBatchItem"]![0]!.data, {
    operationId: null,
    status: "PENDING",
  });
  const tables = projectBackupTables(input, {
    at: projectionClock,
    phase: "RESTORE",
  }).tables;
  expect(tables["public.AgencyBatchQuote"]).toHaveLength(1);
  expect(tables["public.AgencyBatchItem"]![0]!.data).toMatchObject({
    quoteId: "child-quote",
    operationId: null,
    status: "PENDING",
  });
  expect(tables["public.OperationQuote"]![0]!.data.consumedOperationId).toBe(
    "charged",
  );
});
it("fails closed on unsupported workspace tombstones before returning authored site or branding data", () => {
  const input = deletionGraph();
  input["public.Workspace"]![0]!.data.deletedAt = "2026-11-01T00:00:00.000Z";
  input["public.Site"]![0]!.data.deletedAt = null;
  for (const phase of ["BACKUP", "RESTORE"] as const)
    expect(() =>
      projectBackupTables(input, { at: projectionClock, phase }),
    ).toThrow("BACKUP_WORKSPACE_DELETION_UNSUPPORTED");
});
it("keeps minimal opaque access receipts until exactly 180 days without refreshing createdAt", () => {
  const input = deletionGraph();
  input["public.WorkspaceAccessEvent"] = [
    row({
      id: "still-required",
      workspaceId: "w",
      actorId: "u",
      action: "revoke",
      targetUserId: "v",
      siteId: "a",
      previousRole: "EDITOR",
      nextRole: null,
      accessRevision: 2,
      createdAt: "2026-05-07T00:00:00.001Z",
      note: "PRIVATE_ACCESS_DETAIL",
    }),
    row({
      id: "deadline",
      workspaceId: "w",
      actorId: "u",
      action: "grant",
      targetUserId: "v",
      siteId: "a",
      previousRole: null,
      nextRole: "EDITOR",
      accessRevision: 1,
      createdAt: "2026-05-07T00:00:00.000Z",
    }),
  ];
  const tables = projectBackupTables(input, {
    at: projectionClock,
    phase: "RESTORE",
  }).tables;
  expect(tables["public.WorkspaceAccessEvent"]).toEqual([
    row({
      id: "still-required",
      workspaceId: "w",
      actorId: "u",
      action: "revoke",
      targetUserId: "v",
      siteId: "a",
      previousRole: "EDITOR",
      nextRole: null,
      accessRevision: 2,
      createdAt: "2026-05-07T00:00:00.001Z",
    }),
  ]);
  expect(JSON.stringify(tables)).not.toContain("PRIVATE_ACCESS_DETAIL");
});
it("retains a recent access promotion and expires workspace-wide and active-site receipts at 180 days", () => {
  const input = deletionGraph();
  input["public.Site"]![0]!.data.deletedAt = null;
  input["public.WorkspaceAccessEvent"] = [
    row({
      id: "promotion",
      workspaceId: "w",
      siteId: null,
      actorId: "u",
      targetUserId: "v",
      action: "role",
      previousRole: "VIEWER",
      nextRole: "ADMIN",
      accessRevision: 3,
      createdAt: "2026-11-02T00:00:00.000Z",
    }),
    row({
      id: "old-workspace",
      workspaceId: "w",
      siteId: null,
      action: "role",
      previousRole: "EDITOR",
      nextRole: "ADMIN",
      createdAt: "2026-05-07T00:00:00.000Z",
    }),
    row({
      id: "old-active-site",
      workspaceId: "w",
      siteId: "a",
      action: "grant",
      previousRole: null,
      nextRole: "VIEWER",
      createdAt: "2026-05-07T00:00:00.000Z",
    }),
  ];
  expect(
    projectBackupTables(input, { at: projectionClock, phase: "BACKUP" }).tables[
      "public.WorkspaceAccessEvent"
    ],
  ).toEqual([
    row({
      id: "promotion",
      workspaceId: "w",
      siteId: null,
      actorId: "u",
      targetUserId: "v",
      action: "role",
      previousRole: "VIEWER",
      nextRole: "ADMIN",
      accessRevision: 3,
      createdAt: "2026-11-02T00:00:00.000Z",
    }),
  ]);
});
it("fails closed rather than silently discarding receipts with unclassifiable clocks or missing parents", () => {
  const invalidClock = deletionGraph();
  invalidClock["public.WorkspaceAccessEvent"] = [
    row({
      id: "bad-clock",
      workspaceId: "w",
      siteId: "a",
      actorId: "u",
      action: "revoke",
      accessRevision: 1,
      createdAt: null,
    }),
  ];
  expect(() =>
    projectBackupTables(invalidClock, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_SECURITY_RECEIPT_CLOCK_INVALID");
  const missingParent = deletionGraph();
  missingParent["lyraseo_deletion.scope_case"] = [];
  expect(() =>
    projectBackupTables(missingParent, {
      at: projectionClock,
      phase: "BACKUP",
    }),
  ).toThrow("BACKUP_DELETION_RECEIPT_PARENT_MISSING");
});
it.each(["BACKUP", "RESTORE"] as const)(
  "removes path bearers from quarantined handoff routing and editor URLs in %s while preserving receipt hashes",
  (phase) => {
    const tables = projectBackupTables(
      {
        "lyraseo_handoff.destination": [
          row({
            id: "dest",
            workspace_id: "w",
            site_id: "a",
            kind: "WORDPRESS",
            generation: 1,
            url: "https://handoff.example/PATH_BEARER/blog/",
            status: "CONFIGURED",
            secret_cipher: "OLD_CIPHER",
            key_id: "k1",
            previous_cipher: null,
            previous_key_id: null,
            previous_until: null,
          }),
        ],
        "lyraseo_handoff.intent": [
          row({
            id: "intent",
            workspace_id: "w",
            site_id: "a",
            destination_id: "dest",
            destination_generation: 1,
            kind: "WORDPRESS",
            mode: "FIXTURE",
            state: "CONFIRMED_DRAFT",
            destination_url:
              "https://handoff.example/PATH_BEARER/wp-json/wp/v2/posts?_fields=id,status,link",
            remote_post_id: "42",
            editor_url:
              "https://handoff.example/PATH_BEARER/wp-admin/post.php?post=42&action=edit",
            lease_until: null,
            input_hash: "a".repeat(64),
            body_hash: "b".repeat(64),
            next_due_at: "2026-11-01T00:00:00.000Z",
          }),
        ],
        "lyraseo_handoff.receipt": [
          row({
            id: "receipt",
            intent_id: "intent",
            fence: 2,
            attempt: 1,
            outcome: "CONFIRMED_DRAFT",
            status: 201,
            code: "CONFIRMED",
            remote_post_id: "42",
            editor_url:
              "https://handoff.example/PATH_BEARER/wp-admin/post.php?post=42&action=edit",
            recorded_at: "2026-11-01T00:00:00.000Z",
          }),
        ],
        "lyraseo_handoff.dispatch": [
          row({
            intent_id: "intent",
            state: "PENDING",
            claim_token: "00000000-0000-0000-0000-000000000099",
            lease_until: "2026-11-03T00:01:00.000Z",
            next_due: projectionClock,
          }),
        ],
      },
      { at: projectionClock, phase },
    ).tables;
    expect(JSON.stringify(tables)).not.toContain("PATH_BEARER");
    expect(JSON.stringify(tables)).not.toContain("OLD_CIPHER");
    expect(tables["lyraseo_handoff.destination"]![0]!.data).toMatchObject({
      url: "https://handoff.example",
      status: "REVOKED",
      secret_cipher: null,
    });
    expect(tables["lyraseo_handoff.intent"]![0]!.data).toMatchObject({
      mode: "QUARANTINED",
      destination_url: "https://handoff.example",
      state: "CONFIRMED_DRAFT",
      editor_url: "https://handoff.example",
      input_hash: "a".repeat(64),
      body_hash: "b".repeat(64),
      remote_post_id: "42",
    });
    expect(tables["lyraseo_handoff.receipt"]![0]!.data).toMatchObject({
      editor_url: "https://handoff.example",
      recorded_at: "2026-11-01T00:00:00.000Z",
      fence: 2,
    });
    expect(tables["lyraseo_handoff.dispatch"]![0]!.data).toMatchObject({
      state: "SUPPRESSED",
      claim_token: null,
      lease_until: null,
      next_due: null,
    });
  },
);
it("fails closed on unknown retained batch previews instead of publishing executable input hidden outside requestInput", () => {
  const input = committedBatchGraph();
  (
    input["public.AgencyBatchQuote"]![0]!.data.preview as Record<
      string,
      unknown
    >
  ).privatePayload = { body: "UNCLASSIFIED_AUTHORED_PREVIEW" };
  expect(() =>
    projectBackupTables(input, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_BATCH_PREVIEW_CLASSIFICATION_BLOCKED");
});
it("fails closed on an unclassifiable nested batch item preview", () => {
  const input = committedBatchGraph();
  const preview = input["public.AgencyBatchQuote"]![0]!.data.preview as {
    items: Record<string, unknown>[];
  };
  preview.items[0]!.input = { body: "UNCLASSIFIED_AUTHORED_PREVIEW" };
  expect(() =>
    projectBackupTables(input, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_BATCH_PREVIEW_CLASSIFICATION_BLOCKED");
});
it("fails closed on committed financial links without their consumed quote or batch parent", () => {
  const missingQuote = committedBatchGraph();
  missingQuote["public.OperationQuote"] = [];
  expect(() =>
    projectBackupTables(missingQuote, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_BATCH_COMMITMENT_LINK_INVALID");
  const missingBatch = committedBatchGraph();
  missingBatch["public.AgencyBatchQuote"] = [];
  expect(() =>
    projectBackupTables(missingBatch, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_BATCH_COMMITMENT_LINK_INVALID");
});
it("fails closed on a confirmation pair that cannot satisfy the migration CHECK rather than inventing a date", () => {
  const input = committedBatchGraph();
  input["public.AgencyBatchQuote"]![0]!.data.confirmationKey = null;
  expect(() =>
    projectBackupTables(input, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_BATCH_CONFIRMATION_INVALID");
});
it("fails closed on unknown deletion receipt payloads rather than retaining ordinary authored data", () => {
  const input = deletionGraph();
  input["lyraseo_deletion.event"]![0]!.data.result = {
    body: "ERASED_AUTHORED_PAYLOAD",
  };
  expect(() =>
    projectBackupTables(input, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_DELETION_RESULT_CLASSIFICATION_BLOCKED");
});
it("fails closed on unclassifiable deletion admission clocks without refreshing them", () => {
  const input = deletionGraph();
  input["lyraseo_deletion.scope_case"]![0]!.data.accepted_at = null;
  expect(() =>
    projectBackupTables(input, { at: projectionClock, phase: "RESTORE" }),
  ).toThrow("BACKUP_DELETION_RECEIPT_CLOCK_INVALID");
});
it("fails closed on nonopaque billing event reference payloads while retaining accepted-event identity", () => {
  const input = billingGraph();
  input["lyraseo_billing.event"]![0]!.data.references_json = {
    subscriptionId: "subscription",
    body: "RAW_BILLING_PAYLOAD",
  };
  expect(() =>
    projectBackupTables(input, { at: projectionClock, phase: "BACKUP" }),
  ).toThrow("BACKUP_BILLING_REFERENCE_CLASSIFICATION_BLOCKED");
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
