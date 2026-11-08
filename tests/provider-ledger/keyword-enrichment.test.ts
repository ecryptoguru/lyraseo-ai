import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { actor } from "../helpers/database";
import {
  prepareKeywordSelection,
  readKeywordSelections,
  requestKeywordQuote,
} from "../../packages/db/src/keywords";
const name = process.env.LYRA_LEDGER_DB;
if (!name || !/^lyraseo_ledger_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_LEDGER_DATABASE_REQUIRED");
const admin = createDatabase(
    `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
  ),
  runtime = createDatabase(
    `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${name}`,
  );
const user = { ...actor, userId: "fixture-ledger-keyword-owner" },
  scope = { workspaceId: "keyword-workspace", siteId: "keyword-site" };
const request = {
  snapshotId: "keyword-search",
  kind: "best-observed-page",
  query: "seo audit",
  page: "https://keywords.invalid/a?region=in",
  keywords: ["seo audit"],
  country: "IN" as const,
  language: "en" as const,
  idempotencyKey: "selected-one",
};
beforeAll(async () => {
  await admin.productUser.createMany({
    data: [{ id: user.userId }, { id: "keyword-client" }],
  });
  await admin.workspace.create({
    data: { id: scope.workspaceId, name: "Keyword fixture" },
  });
  await admin.membership.createMany({
    data: [
      { workspaceId: scope.workspaceId, userId: user.userId, role: "OWNER" },
      {
        workspaceId: scope.workspaceId,
        userId: "keyword-client",
        role: "VIEWER",
      },
    ],
  });
  await admin.site.create({
    data: {
      id: scope.siteId,
      workspaceId: scope.workspaceId,
      origin: "https://keywords.invalid",
      verifiedAt: new Date(),
    },
  });
  await admin.searchSnapshot.create({
    data: {
      id: request.snapshotId,
      ...scope,
      property: "sc-domain:keywords.invalid",
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      shape: "query,page",
      status: "complete",
      rows: [
        {
          keys: [request.query, request.page],
          impressions: 200,
          clicks: 5,
          ctr: 0.025,
          position: 8,
        },
      ],
    },
  });
});
afterAll(async () => {
  await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
});
it("freezes an explicit opportunity and selected keywords without creating a paid operation", async () => {
  const first = await prepareKeywordSelection(runtime, user, scope, request),
    again = await prepareKeywordSelection(runtime, user, scope, request);
  expect(first.id).toBe(again.id);
  expect(first.status).toBe("UNQUALIFIED");
  const quote = await requestKeywordQuote(runtime, user, scope, first.id);
  expect(quote.maximumCost).toBeNull();
  expect(quote.dispatchable).toBe(false);
  const a = await readKeywordSelections(runtime, user, scope),
    b = await readKeywordSelections(runtime, user, scope);
  expect(a).toEqual(b);
  expect(a[0]?.request.page).toBe(request.page);
  expect(await admin.operation.count({ where: { siteId: scope.siteId } })).toBe(
    0,
  );
});
it("rejects invented opportunities, changed retry bodies and ungranted clients", async () => {
  await expect(
    prepareKeywordSelection(runtime, user, scope, {
      ...request,
      idempotencyKey: "forged",
      query: "invented",
    }),
  ).rejects.toThrow("OPPORTUNITY_UNAVAILABLE");
  await expect(
    prepareKeywordSelection(runtime, user, scope, {
      ...request,
      keywords: ["different"],
    }),
  ).rejects.toThrow("CONFLICT");
  await expect(
    readKeywordSelections(
      runtime,
      { ...user, userId: "keyword-client" },
      scope,
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    prepareKeywordSelection(
      runtime,
      { ...user, userId: "keyword-client" },
      scope,
      request,
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("reopens saved synthetic keyword metrics with original source and no new operation", async () => {
  const { admitOperation, claimOperation } =
    await import("../../packages/db/src/accounting");
  const {
    prepareFixtureAttempt,
    recordAttemptEvidence,
    readProviderLedger,
    closeProviderAttemptPlan,
    settleManagedOperation,
  } = await import("../../packages/db/src/provider-ledger");
  const selection = await prepareKeywordSelection(runtime, user, scope, {
    ...request,
    idempotencyKey: "saved-fixture",
  });
  const op = await admitOperation(runtime, user, {
    ...scope,
    kind: "KEYWORD_ENRICHMENT",
    provider: "DATAFORSEO",
    route: "fixture-ledger",
    idempotencyKey: "keyword-fixture-operation",
    input: { requestHash: selection.requestHash },
    maximumCost: "0.10",
    tariffVersion: "synthetic-fixture-v1",
  });
  const lease = await claimOperation(runtime, user, op.id, "fixture-keywords");
  await admin.$queryRawUnsafe(
    "SELECT lyraseo_ledger.enroll_fixture($1,$2::jsonb)",
    op.id,
    JSON.stringify([{ step: "keywords", maximum: "0.10" }]),
  );
  const fixture = createDatabase(
    "postgresql://lyraseo_ledger_fixture:local_ledger_only@127.0.0.1:54329/" +
      name,
  );
  try {
    const attempt = await prepareFixtureAttempt(fixture, {
      operationId: op.id,
      fence: lease.fence,
      step: "keywords",
      requestHash: "e".repeat(64),
      expectedRevision: 0,
    });
    await recordAttemptEvidence(fixture, attempt.id, "keyword-saved-result", {
      kind: "RESOLVED",
      accepted: true,
      outputValid: true,
      cost: "0.012",
      costVersion: 1,
      observedAt: new Date().toISOString(),
    });
    await closeProviderAttemptPlan(fixture, op.id, 2);
    const snap = await readProviderLedger(fixture, op.id);
    await settleManagedOperation(fixture, {
      operationId: op.id,
      expectedRevision: snap.revision,
      evidenceHash: snap.evidenceHash,
    });
    const collectedAt = new Date();
    const metrics = JSON.stringify([
      {
        keyword: "seo audit",
        searchVolume: null,
        cpc: "0.50",
        competition: "MEDIUM",
      },
    ]);
    await fixture.$queryRawUnsafe(
      "SELECT lyraseo_ledger.save_keyword_fixture($1::uuid,$2,$3::jsonb,$4::timestamptz)",
      selection.id,
      op.id,
      metrics,
      collectedAt,
    );
    const first = await readKeywordSelections(runtime, user, scope),
      second = await readKeywordSelections(runtime, user, scope);
    expect(first).toEqual(second);
    expect(first.find((x) => x.id === selection.id)?.result).toMatchObject({
      source: "SYNTHETIC",
      method: "OFFLINE_FIXTURE",
      rows: [
        {
          keyword: "seo audit",
          searchVolume: null,
          cpc: "0.50",
          competition: "MEDIUM",
        },
      ],
    });
    expect(
      await admin.operation.count({ where: { siteId: scope.siteId } }),
    ).toBe(1);
  } finally {
    await fixture.$disconnect();
  }
});
it("freezes declining clicks against the same comparable prior window and earliest source expiry", async () => {
  const currentImportedAt = new Date(Date.now() - 86400000),
    priorImportedAt = new Date(Date.now() - 86400000 * 10);
  await admin.searchSnapshot.createMany({
    data: [
      {
        id: "keyword-current-page",
        ...scope,
        property: "sc-domain:keywords.invalid",
        startDate: "2026-10-01",
        endDate: "2026-10-28",
        shape: "page",
        status: "complete",
        rows: [
          {
            keys: [request.page],
            impressions: 200,
            clicks: 5,
            ctr: 0.025,
            position: 8,
          },
        ],
        importedAt: currentImportedAt,
      },
      {
        id: "keyword-prior-page",
        ...scope,
        property: "sc-domain:keywords.invalid",
        startDate: "2026-09-03",
        endDate: "2026-09-30",
        shape: "page",
        status: "complete",
        rows: [
          {
            keys: [request.page],
            impressions: 200,
            clicks: 20,
            ctr: 0.1,
            position: 8,
          },
        ],
        importedAt: priorImportedAt,
      },
      {
        id: "keyword-wrong-window",
        ...scope,
        property: "sc-domain:keywords.invalid",
        startDate: "2026-09-20",
        endDate: "2026-09-30",
        shape: "page",
        status: "complete",
        rows: [
          {
            keys: [request.page],
            impressions: 200,
            clicks: 99,
            ctr: 0.495,
            position: 8,
          },
        ],
      },
    ],
  });
  const selected = await prepareKeywordSelection(runtime, user, scope, {
    ...request,
    snapshotId: "keyword-current-page",
    kind: "declining-clicks",
    query: "",
    idempotencyKey: "declining",
  });
  const saved = (await readKeywordSelections(runtime, user, scope)).find(
    (x) => x.id === selected.id,
  );
  expect(saved?.request.opportunity).toMatchObject({
    kind: "declining-clicks",
    evidence: {
      snapshotId: "keyword-current-page",
      previousSnapshotId: "keyword-prior-page",
      previousStartDate: "2026-09-03",
      previousEndDate: "2026-09-30",
      previousClicks: 20,
    },
  });
  const priorSource = await admin.searchSnapshot.findUniqueOrThrow({
    where: { id: "keyword-prior-page" },
  });
  expect(saved?.resultExpiresAt.toISOString()).toBe(
    priorSource.resultExpiresAt.toISOString(),
  );
  const quote = await requestKeywordQuote(runtime, user, scope, selected.id);
  expect(quote.dispatchable).toBe(false);
  expect(await admin.operation.count({ where: { siteId: scope.siteId } })).toBe(
    1,
  );
});
