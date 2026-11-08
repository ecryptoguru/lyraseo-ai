import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import * as tenants from "../../packages/db/src/tenants";
import { registerPage, changePage } from "../../packages/db/src/pages";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("lists team only for current managers and excludes global identity data", async () => {
  const result = await tenants.listWorkspaceMembers(db, actor, "a");
  expect(result.accessRevision).toBe(0);
  expect(result.members.map((m) => m.userId).sort()).toEqual([
    "other",
    "owner",
    "viewer",
  ]);
  expect(JSON.stringify(result)).not.toMatch(/email|provider|subject|session/i);
  await expect(
    tenants.listWorkspaceMembers(db, { ...actor, userId: "viewer" }, "a"),
  ).rejects.toThrow("FORBIDDEN");
});
it("serializes revisioned grants, returns conflicts and revokes immediately", async () => {
  const results = await Promise.allSettled([
    tenants.manageWorkspaceAccess(db, actor, {
      workspaceId: "a",
      action: "grant",
      siteId: "a-site",
      userId: "other",
      expectedAccessRevision: 0,
    }),
    tenants.manageWorkspaceAccess(db, actor, {
      workspaceId: "a",
      action: "revoke",
      siteId: "a-site",
      userId: "viewer",
      expectedAccessRevision: 0,
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const next = await tenants.listWorkspaceMembers(db, actor, "a");
  expect(next.accessRevision).toBe(1);
  await tenants.manageWorkspaceAccess(db, actor, {
    workspaceId: "a",
    action: "revoke",
    siteId: "a-site",
    userId: "viewer",
    expectedAccessRevision: 1,
  });
  expect(
    await tenants.listSites(db, { ...actor, userId: "viewer" }, "a"),
  ).toEqual([]);
  expect(await admin.workspaceAccessEvent.count()).toBe(2);
});
it("cannot grant foreign sites and stale or suspended managers cannot write", async () => {
  const input = {
    workspaceId: "a",
    action: "grant" as const,
    siteId: "b-site",
    userId: "viewer",
    expectedAccessRevision: 0,
  };
  await expect(tenants.manageWorkspaceAccess(db, actor, input)).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(
    tenants.manageWorkspaceAccess(db, { ...actor, securityVersion: 1 }, input),
  ).rejects.toThrow("FORBIDDEN");
  await admin.productUser.update({
    where: { id: "owner" },
    data: { suspended: true },
  });
  await expect(tenants.manageWorkspaceAccess(db, actor, input)).rejects.toThrow(
    "FORBIDDEN",
  );
});
it("assigns eligible teammates with immutable history and fences revoked assignments", async () => {
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "other" } },
    data: { role: "EDITOR" },
  });
  await tenants.grantSite(db, actor, "a", "a-site", "other");
  const page = await registerPage(db, actor, scope, "https://example.com/");
  const input = {
    pageId: page.id,
    expectedRevision: 1,
    idempotencyKey: "assignment",
    action: "assign" as const,
    assigneeUserId: "other",
  };
  const result = await changePage(db, actor, scope, input);
  expect(result.page.assignedTo).toBe("other");
  expect(result.entry.assigneeUserId).toBe("other");
  expect((await changePage(db, actor, scope, input)).entry.id).toBe(
    result.entry.id,
  );
  await expect(
    changePage(db, actor, scope, { ...input, assigneeUserId: "viewer" }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await tenants.manageWorkspaceAccess(db, actor, {
    workspaceId: "a",
    action: "revoke",
    siteId: "a-site",
    userId: "other",
    expectedAccessRevision: 1,
  });
  const stored = await admin.pageIdentity.findUniqueOrThrow({
    where: { id: page.id },
  });
  expect(stored.assignedTo).toBeNull();
  expect(stored.revision).toBe(3);
  await expect(
    changePage(db, actor, scope, {
      ...input,
      expectedRevision: 3,
      idempotencyKey: "again",
    }),
  ).rejects.toThrow("INVALID_ASSIGNEE");
  expect(await admin.pageJournal.count({ where: { pageId: page.id } })).toBe(2);
});
it("portfolio pagination exposes only currently granted sites and compact saved summaries", async () => {
  const { listAgencyPortfolio } = await import("../../packages/db/src/agency");
  await admin.site.create({
    data: { id: "hidden", workspaceId: "a", origin: "https://hidden.example" },
  });
  const viewer = { ...actor, userId: "viewer" };
  const result = await listAgencyPortfolio(db, viewer, "a", { limit: 1 });
  expect(result.sites.map((s) => s.id)).toEqual(["a-site"]);
  expect(result.nextCursor).toBeNull();
  expect(result.role).toBe("VIEWER");
  expect(JSON.stringify(result)).not.toMatch(
    /budget|securityVersion|rawAnswers|hidden.example/,
  );
  await tenants.manageWorkspaceAccess(db, actor, {
    workspaceId: "a",
    action: "revoke",
    siteId: "a-site",
    userId: "viewer",
    expectedAccessRevision: 0,
  });
  expect((await listAgencyPortfolio(db, viewer, "a")).sites).toEqual([]);
});
it("manually accepts only a matching server-verified recipient once without sending email", async () => {
  const { createWorkspaceInvitation, acceptWorkspaceInvitation } =
    await import("../../packages/db/src/invitations");
  const secret = "local-fixture-only-hmac-secret-32-bytes";
  await admin.productUser.create({ data: { id: "recipient" } });
  const invite = await createWorkspaceInvitation(
    db,
    actor,
    {
      workspaceId: "a",
      email: "Tester@example.com",
      role: "VIEWER",
      siteIds: ["a-site"],
      expectedAccessRevision: 0,
    },
    secret,
  );
  expect(
    JSON.stringify(await admin.workspaceInvitation.findMany()),
  ).not.toContain("Tester@example.com");
  const recipient = { ...actor, userId: "recipient" };
  await expect(
    acceptWorkspaceInvitation(
      db,
      { actor: recipient, email: "wrong@example.com" },
      { workspaceId: "a", invitationId: invite.id, token: invite.token },
      secret,
    ),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
  const accepted = await acceptWorkspaceInvitation(
    db,
    { actor: recipient, email: "tester@example.com" },
    { workspaceId: "a", invitationId: invite.id, token: invite.token },
    secret,
  );
  expect(accepted.role).toBe("VIEWER");
  expect(
    (await tenants.listSites(db, recipient, "a")).map((s) => s.id),
  ).toEqual(["a-site"]);
  await expect(
    acceptWorkspaceInvitation(
      db,
      { actor: recipient, email: "tester@example.com" },
      { workspaceId: "a", invitationId: invite.id, token: invite.token },
      secret,
    ),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
});
it("keeps issue assignments separate from findings and page tasks", async () => {
  const { assignAuditIssue, listAuditAssignments } =
    await import("../../packages/db/src/issue-assignments");
  const audit = await admin.auditRun.create({
    data: {
      id: "issue-run",
      ...scope,
      userId: "owner",
      securityVersion: 0,
      idempotencyKey: "issues",
      inputHash: "fixture",
      manifest: [],
      profile: "raw-http",
      declarations: {},
      methodologyVersion: "fixture",
      status: "COMPLETED",
      evaluation: {
        rules: [
          {
            ruleId: "missing-title",
            scopeKey: "https://example.com/",
            outcome: "FAIL",
          },
        ],
      },
    },
  });
  const command = {
    auditId: audit.id,
    ruleId: "missing-title",
    scopeKey: "https://example.com/",
    assigneeUserId: "other",
    expectedRevision: 0,
    idempotencyKey: "issue-once",
  };
  const assigned = await assignAuditIssue(db, actor, scope, command);
  expect(assigned.revision).toBe(1);
  expect((await assignAuditIssue(db, actor, scope, command)).id).toBe(
    assigned.id,
  );
  await expect(
    assignAuditIssue(db, actor, scope, {
      ...command,
      ruleId: "invented",
      idempotencyKey: "invalid",
    }),
  ).rejects.toThrow("INVALID_ISSUE");
  expect(
    (
      await listAuditAssignments(
        db,
        { ...actor, userId: "viewer" },
        scope,
        audit.id,
      )
    ).length,
  ).toBe(1);
  expect(
    (await admin.auditRun.findUniqueOrThrow({ where: { id: audit.id } }))
      .evaluation,
  ).toEqual(audit.evaluation);
  expect(await admin.issueAction.count()).toBe(0);
});
it("captures explicit private branding revisions and preserves them across replacement", async () => {
  const {
    saveWorkspaceBranding,
    readWorkspaceBranding,
    captureWorkspaceBranding,
  } = await import("../../packages/db/src/branding");
  const { withActor } = await import("../../packages/db/src/context");
  const first = await saveWorkspaceBranding(db, actor, {
    workspaceId: "a",
    displayName: "Agency One",
    expectedRevision: 0,
    logo: null,
  });
  const frozen = await withActor(db, actor, "a", (tx) =>
    captureWorkspaceBranding(tx, scope, first.revision),
  );
  expect(frozen?.displayName).toBe("Agency One");
  await saveWorkspaceBranding(db, actor, {
    workspaceId: "a",
    displayName: "Agency Two",
    expectedRevision: 1,
    logo: null,
  });
  expect(
    await withActor(db, actor, "a", (tx) =>
      captureWorkspaceBranding(tx, scope, first.revision),
    ),
  ).toEqual(frozen);
  expect(
    await withActor(db, actor, "a", (tx) =>
      captureWorkspaceBranding(tx, scope, undefined),
    ),
  ).toBeUndefined();
  await expect(
    saveWorkspaceBranding(
      db,
      { ...actor, userId: "viewer" },
      { workspaceId: "a", displayName: "Forged", expectedRevision: 2 },
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    saveWorkspaceBranding(db, actor, {
      workspaceId: "a",
      displayName: "Stale",
      expectedRevision: 1,
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  expect((await readWorkspaceBranding(db, actor, "a"))?.displayName).toBe(
    "Agency Two",
  );
});
it("quotes exact multi-site totals without reserving and resumes one admission per child", async () => {
  const { issueAgencyBatchQuote, confirmAgencyBatch } =
    await import("../../packages/db/src/agency-batches");
  const { issueOperationQuote } =
    await import("../../packages/db/src/accounting");
  await admin.site.create({
    data: {
      workspaceId: "a",
      id: "a-two",
      origin: "https://two.example",
      verifiedAt: new Date(),
    },
  });
  const input = {
    workspaceId: "a",
    items: [
      { siteId: "a-site", kind: "GENERATION" as const, input: { revision: 1 } },
      { siteId: "a-two", kind: "GENERATION" as const, input: { revision: 2 } },
    ],
  };
  const issuer = async (item: {
    siteId: string;
    kind: "GENERATION";
    input: unknown;
  }) =>
    issueOperationQuote(db, actor, {
      workspaceId: "a",
      ...item,
      provider: "AZURE",
      route: "content",
      maximumCost: "0.123456789",
      tariffVersion: "synthetic-test-only",
    });
  const quote = await issueAgencyBatchQuote(db, actor, input, issuer);
  expect(quote.combinedMaximum).toBe("0.246913578");
  expect(await admin.operation.count()).toBe(0);
  const result = await confirmAgencyBatch(db, actor, {
    batchQuoteId: quote.batchQuoteId,
    confirmationHash: quote.confirmationHash,
    idempotencyKey: "confirm-once",
  });
  expect(result.items.map((i) => i.status)).toEqual(["ADMITTED", "ADMITTED"]);
  expect(
    (
      await confirmAgencyBatch(db, actor, {
        batchQuoteId: quote.batchQuoteId,
        confirmationHash: quote.confirmationHash,
        idempotencyKey: "confirm-once",
      })
    ).items.map((i) => i.operationId),
  ).toEqual(result.items.map((i) => i.operationId));
  expect(await admin.operation.count()).toBe(2);
  expect(await admin.outboxEvent.count()).toBe(2);
  await expect(
    confirmAgencyBatch(db, actor, {
      batchQuoteId: quote.batchQuoteId,
      confirmationHash: quote.confirmationHash,
      idempotencyKey: "different",
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
});
it("unknown provider tariffs remain unavailable and cannot trigger batch reservations", async () => {
  const { issueAgencyBatchQuote, confirmAgencyBatch } =
    await import("../../packages/db/src/agency-batches");
  const quote = await issueAgencyBatchQuote(db, actor, {
    workspaceId: "a",
    items: [{ siteId: "a-site", kind: "GENERATION", input: {} }],
  });
  expect(quote.items[0].status).toBe("UNAVAILABLE");
  expect(quote.combinedMaximum).toBeNull();
  const result = await confirmAgencyBatch(db, actor, {
    batchQuoteId: quote.batchQuoteId,
    confirmationHash: quote.confirmationHash,
    idempotencyKey: "unavailable",
  });
  expect(result.items[0].status).toBe("UNAVAILABLE");
  expect(await admin.operation.count()).toBe(0);
});
it("expired, revoked and concurrently consumed invitations fail closed", async () => {
  const {
    createWorkspaceInvitation,
    acceptWorkspaceInvitation,
    revokeWorkspaceInvitation,
  } = await import("../../packages/db/src/invitations");
  const secret = "local-fixture-only-hmac-secret-32-bytes";
  await admin.productUser.create({ data: { id: "recipient" } });
  const identity = {
    actor: { ...actor, userId: "recipient" },
    email: "tester@example.com",
  };
  const make = (expectedAccessRevision: number) =>
    createWorkspaceInvitation(
      db,
      actor,
      {
        workspaceId: "a",
        email: identity.email,
        role: "EDITOR",
        siteIds: ["a-site"],
        expectedAccessRevision,
      },
      secret,
    );
  const first = await make(0);
  await revokeWorkspaceInvitation(db, actor, {
    workspaceId: "a",
    invitationId: first.id,
    expectedAccessRevision: 1,
  });
  await expect(
    acceptWorkspaceInvitation(
      db,
      identity,
      { workspaceId: "a", invitationId: first.id, token: first.token },
      secret,
    ),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
  const expired = await make(2);
  await admin.workspaceInvitation.update({
    where: { id: expired.id },
    data: {
      createdAt: new Date(Date.now() - 8 * 86400000),
      expiresAt: new Date(Date.now() - 86400000),
    },
  });
  await expect(
    acceptWorkspaceInvitation(
      db,
      identity,
      { workspaceId: "a", invitationId: expired.id, token: expired.token },
      secret,
    ),
  ).rejects.toThrow("INVITATION_UNAVAILABLE");
  const last = await make(3);
  const other = createDatabase(runtimeUrl);
  try {
    const input = {
      workspaceId: "a",
      invitationId: last.id,
      token: last.token,
    };
    const results = await Promise.allSettled([
      acceptWorkspaceInvitation(db, identity, input, secret),
      acceptWorkspaceInvitation(other, identity, input, secret),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  } finally {
    await other.$disconnect();
  }
  expect(
    await admin.membership.count({
      where: { workspaceId: "a", userId: "recipient" },
    }),
  ).toBe(1);
});
it("denies cross-tenant joins, immutable-event writes and direct browser table access", async () => {
  const { withActor } = await import("../../packages/db/src/context");
  await tenants.manageWorkspaceAccess(db, actor, {
    workspaceId: "a",
    action: "grant",
    siteId: "a-site",
    userId: "other",
    expectedAccessRevision: 0,
  });
  await expect(
    withActor(db, actor, "a", (tx) =>
      tx.workspaceAccessEvent.updateMany({
        where: { workspaceId: "a" },
        data: { action: "remove" },
      }),
    ),
  ).rejects.toThrow();
  await expect(
    withActor(db, actor, "a", (tx) =>
      tx.workspaceAccessEvent.deleteMany({ where: { workspaceId: "a" } }),
    ),
  ).rejects.toThrow();
  expect(
    await withActor(db, actor, "b", (tx) => tx.workspaceAccessEvent.count()),
  ).toBe(0);
  const rows = await admin.$queryRaw<
    { name: string; allowed: boolean }[]
  >`SELECT r.rolname AS name,has_table_privilege(r.rolname,'"WorkspaceInvitation"','SELECT') OR has_table_privilege(r.rolname,'"WorkspaceBrandingRevision"','SELECT') AS allowed FROM pg_roles r WHERE r.rolname IN ('anon','authenticated')`;
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => !r.allowed)).toBe(true);
});
it("batch partial budget rejection preserves accepted siblings without new charge on replay", async () => {
  const { issueAgencyBatchQuote, confirmAgencyBatch } =
    await import("../../packages/db/src/agency-batches");
  const { issueOperationQuote } =
    await import("../../packages/db/src/accounting");
  await admin.site.create({
    data: {
      id: "a-two",
      workspaceId: "a",
      origin: "https://two.example",
      verifiedAt: new Date(),
    },
  });
  const quote = await issueAgencyBatchQuote(
    db,
    actor,
    {
      workspaceId: "a",
      items: [
        { siteId: "a-site", kind: "GENERATION", input: {} },
        { siteId: "a-two", kind: "GENERATION", input: {} },
      ],
    },
    (item) =>
      issueOperationQuote(db, actor, {
        workspaceId: "a",
        ...item,
        provider: "AZURE",
        route: "content",
        maximumCost: "5",
        tariffVersion: "synthetic-only",
      }),
  );
  const command = {
    batchQuoteId: quote.batchQuoteId,
    confirmationHash: quote.confirmationHash,
    idempotencyKey: "partial",
  };
  const result = await confirmAgencyBatch(db, actor, command);
  expect(result.items.map((i) => i.status)).toEqual(["ADMITTED", "REJECTED"]);
  expect(result.admittedTotal).toBe("5.000000000");
  expect(
    (await confirmAgencyBatch(db, actor, command)).items.map((i) => i.status),
  ).toEqual(["ADMITTED", "REJECTED"]);
  expect(await admin.operation.count()).toBe(1);
});
it("report creators see only eligible branding metadata and current site grants", async () => {
  const { saveWorkspaceBranding, listReportBrandingChoices } =
    await import("../../packages/db/src/branding");
  await saveWorkspaceBranding(db, actor, {
    workspaceId: "a",
    displayName: "Agency One",
    expectedRevision: 0,
    logo: null,
  });
  expect(await listReportBrandingChoices(db, actor, scope)).toEqual([
    { revision: 1, displayName: "Agency One" },
  ]);
  await expect(
    listReportBrandingChoices(db, { ...actor, userId: "viewer" }, scope),
  ).rejects.toThrow("FORBIDDEN");
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "other" } },
    data: { role: "EDITOR" },
  });
  await expect(
    listReportBrandingChoices(db, { ...actor, userId: "other" }, scope),
  ).rejects.toThrow("FORBIDDEN");
  await tenants.grantSite(db, actor, "a", "a-site", "other");
  expect(
    await listReportBrandingChoices(db, { ...actor, userId: "other" }, scope),
  ).toEqual([{ revision: 1, displayName: "Agency One" }]);
});

it("reconciles a committed child after interruption and grant revoke/regrant without a second reservation", async () => {
  const { issueAgencyBatchQuote, confirmAgencyBatch, readAgencyBatch } =
    await import("../../packages/db/src/agency-batches");
  const { issueOperationQuote } =
    await import("../../packages/db/src/accounting");
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "other" } },
    data: { role: "EDITOR" },
  });
  await tenants.grantSite(db, actor, "a", "a-site", "other");
  const editor = { ...actor, userId: "other" };
  const quote = await issueAgencyBatchQuote(
    db,
    editor,
    {
      workspaceId: "a",
      items: [{ siteId: "a-site", kind: "GENERATION", input: {} }],
    },
    (item) =>
      issueOperationQuote(db, editor, {
        workspaceId: "a",
        ...item,
        provider: "AZURE",
        route: "content",
        maximumCost: "0.123456789",
        tariffVersion: "synthetic-recovery-only",
      }),
  );
  const input = {
    batchQuoteId: quote.batchQuoteId,
    confirmationHash: quote.confirmationHash,
    idempotencyKey: "interrupted",
  };
  let interrupted = false;
  const crashing = db.$extends({
    query: {
      $executeRaw: async ({ args, query }) => {
        const text = JSON.stringify(args);
        if (
          !interrupted &&
          text.includes("UPDATE") &&
          text.includes("AgencyBatchItem")
        ) {
          interrupted = true;
          throw Error("SIMULATED_PROCESS_INTERRUPTION");
        }
        return query(args);
      },
    },
  }) as unknown as typeof db;
  await expect(confirmAgencyBatch(crashing, editor, input)).rejects.toThrow(
    "SIMULATED_PROCESS_INTERRUPTION",
  );
  expect(interrupted).toBe(true);
  const operation = await admin.operation.findFirstOrThrow({
    where: { userId: "other" },
  });
  expect(
    (await admin.agencyBatchItem.findFirstOrThrow()).operationId,
  ).toBeNull();
  await tenants.manageWorkspaceAccess(db, actor, {
    workspaceId: "a",
    action: "revoke",
    siteId: "a-site",
    userId: "other",
    expectedAccessRevision: 1,
  });
  const beforeRead = await admin.agencyBatchItem.findFirstOrThrow();
  const readWhileRevoked = await readAgencyBatch(
    db,
    editor,
    quote.batchQuoteId,
  );
  expect(readWhileRevoked.admittedTotal).toBe("0.123456789");
  expect(readWhileRevoked.items).toEqual([
    {
      ordinal: 0,
      status: "ACCESS_UNAVAILABLE",
      operationId: null,
      errorCode: "FORBIDDEN",
    },
  ]);
  expect(await admin.agencyBatchItem.findFirstOrThrow()).toEqual(beforeRead);
  const hidden = await confirmAgencyBatch(db, editor, input);
  expect(hidden.admittedTotal).toBe("0.123456789");
  expect(hidden.items).toEqual([
    {
      ordinal: 0,
      status: "ACCESS_UNAVAILABLE",
      operationId: null,
      errorCode: "FORBIDDEN",
    },
  ]);
  expect((await admin.agencyBatchItem.findFirstOrThrow()).operationId).toBe(
    operation.id,
  );
  await tenants.grantSite(db, actor, "a", "a-site", "other");
  const restored = await confirmAgencyBatch(db, editor, input);
  expect(restored.items[0]).toMatchObject({
    status: "ADMITTED",
    operationId: operation.id,
  });
  expect(
    (await readAgencyBatch(db, editor, quote.batchQuoteId)).admittedTotal,
  ).toBe("0.123456789");
  expect(await admin.operation.count()).toBe(1);
  expect(await admin.outboxEvent.count()).toBe(1);
  expect(
    (
      await admin.budgetPeriod.findUniqueOrThrow({
        where: {
          userId_period_bucket: {
            userId: "other",
            period: operation.period,
            bucket: "AZURE",
          },
        },
      })
    ).reserved.toFixed(9),
  ).toBe("0.123456789");
});

it("reads and reassigns an exact issue identity older than the bounded latest100 list", async () => {
  const { assignAuditIssue, readAuditAssignment } =
    await import("../../packages/db/src/issue-assignments");
  const rules = Array.from({ length: 101 }, (_, i) => ({
    ruleId: `rule-${i}`,
    scopeKey: `https://example.com/?page=${i}`,
    outcome: "FAIL",
  }));
  await admin.auditRun.create({
    data: {
      id: "many-issues",
      ...scope,
      userId: "owner",
      securityVersion: 0,
      idempotencyKey: "many-issues",
      inputHash: "fixture",
      manifest: [],
      profile: "raw-http",
      declarations: {},
      methodologyVersion: "fixture",
      status: "COMPLETED",
      evaluation: { rules },
    },
  });
  await admin.issueAssignment.createMany({
    data: rules.map((rule, i) => ({
      id: `assignment-${i}`,
      ...scope,
      auditId: "many-issues",
      ruleId: rule.ruleId,
      scopeKey: rule.scopeKey,
      assigneeUserId: "other",
      revision: 1,
      updatedAt: new Date(Date.now() + i),
    })),
  });
  const identity = {
    auditId: "many-issues",
    ruleId: rules[0].ruleId,
    scopeKey: rules[0].scopeKey,
  };
  expect(await readAuditAssignment(db, actor, scope, identity)).toMatchObject({
    id: "assignment-0",
    revision: 1,
    assigneeUserId: "other",
  });
  const updated = await assignAuditIssue(db, actor, scope, {
    ...identity,
    assigneeUserId: "owner",
    expectedRevision: 1,
    idempotencyKey: "oldest-reassign",
  });
  expect(updated).toMatchObject({
    id: "assignment-0",
    revision: 2,
    assigneeUserId: "owner",
  });
});
