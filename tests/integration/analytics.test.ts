import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  beginGa4Connect,
  completeGa4Connect,
  ga4Properties,
  selectGa4Property,
  importGa4LandingPages,
  readGa4LandingPages,
  disconnectGa4,
  type Ga4Provider,
} from "../../packages/db/src/ga4";
import {
  beginGoogleConnect,
  completeGoogleConnect,
  type GoogleProvider,
} from "../../packages/db/src/gsc";
import { analyticsProvider } from "../../apps/lyraseo-web/src/server/google/analytics";
import { secretBox } from "../../apps/lyraseo-web/src/server/google/provider";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import { fixtureTransport, primaryReport } from "../fixtures/analytics";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" },
  box = secretBox(Buffer.alloc(32, 7).toString("base64")),
  window = { startDate: "2026-01-01", endDate: "2026-01-02" };
const config = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://app.example/api/integrations/analytics/callback",
};
const cleanReport = {
  ...primaryReport,
  metadata: { timeZone: "America/Los_Angeles" },
};
function provider() {
  const transport = fixtureTransport(cleanReport);
  const p = analyticsProvider(config, transport);
  return { p, transport };
}
const gsc: GoogleProvider = {
  authorize: (state) => state,
  exchange: async () => "gsc-secret",
  properties: async () => [],
  query: async () => [],
};
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
async function connect(p: Ga4Provider) {
  const { url } = await beginGa4Connect(db, actor, scope, p, box);
  const state = new URL(url).searchParams.get("state")!;
  await completeGa4Connect(db, actor, state, "code", p, box);
  await selectGa4Property(db, actor, scope, "properties/123", "456", p, box);
  return state;
}
it("binds OAuth purpose/session/replay and encrypts isolated GA4 credentials without replacing GSC", async () => {
  const { p } = provider();
  const { url: googleState } = await beginGoogleConnect(
    db,
    actor,
    scope,
    gsc,
    box,
  );
  const { url } = await beginGa4Connect(db, actor, scope, p, box),
    state = new URL(url).searchParams.get("state")!;
  await expect(
    completeGa4Connect(
      db,
      { ...actor, sessionId: "wrong" },
      state,
      "code",
      p,
      box,
    ),
  ).rejects.toThrow("INVALID_OAUTH_STATE");
  await expect(
    completeGa4Connect(db, actor, googleState, "code", p, box),
  ).rejects.toThrow("INVALID_OAUTH_STATE");
  await expect(
    completeGoogleConnect(db, actor, state, "code", gsc, box),
  ).rejects.toThrow("INVALID_OAUTH_STATE");
  await completeGoogleConnect(db, actor, googleState, "code", gsc, box);
  const races = await Promise.allSettled([
    completeGa4Connect(db, actor, state, "code", p, box),
    completeGa4Connect(db, actor, state, "code", p, box),
  ]);
  expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const row = await admin.analyticsConnection.findFirstOrThrow();
  expect(JSON.stringify(row)).not.toContain("analytics-refresh");
  expect(() => box.open(row.encryptedRefreshToken, "a:a-site")).toThrow();
  expect(await db.analyticsConnection.findMany()).toEqual([]);
  await disconnectGa4(db, actor, scope);
  expect(await admin.googleConnection.count()).toBe(1);
});
it("rejects tenant/site grant violations and exact property-stream origin mismatch", async () => {
  const { p } = provider();
  await connect(p);
  await expect(
    readGa4LandingPages(db, actor, { workspaceId: "a", siteId: "b-site" }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    selectGa4Property(db, actor, scope, "properties/123", "999", p, box),
  ).rejects.toThrow("EXACT_VERIFIED_ORIGIN_REQUIRED");
  await expect(
    selectGa4Property(db, actor, scope, "properties/999", "456", p, box),
  ).rejects.toThrow("EXACT_VERIFIED_ORIGIN_REQUIRED");
  await expect(
    selectGa4Property(
      db,
      actor,
      scope,
      "properties/123",
      "456",
      {
        ...p,
        properties: async () => [
          {
            property: "properties/123",
            displayName: "x",
            timeZone: "America/Los_Angeles",
            streams: [
              {
                streamId: "456",
                displayName: "x",
                defaultUri: "https://other.com",
              },
            ],
          },
        ],
      },
      box,
    ),
  ).rejects.toThrow("EXACT_VERIFIED_ORIGIN_REQUIRED");
  expect(
    (await readGa4LandingPages(db, { ...actor, userId: "viewer" }, scope))
      .connection?.property,
  ).toBe("properties/123");
  await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
  await expect(
    readGa4LandingPages(db, { ...actor, userId: "viewer" }, scope),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    ga4Properties(db, { ...actor, userId: "viewer" }, scope, p, box),
  ).rejects.toThrow("FORBIDDEN");
});
it("imports primary-shaped fixtures once, reads saved outcomes in GSC order, never calls provider on replay", async () => {
  const { p, transport } = provider();
  await connect(p);
  await admin.googleConnection.create({
    data: {
      ...scope,
      encryptedRefreshToken: box.seal("gsc", "a:a-site"),
      property: "https://example.com/",
    },
  });
  await admin.searchSnapshot.create({
    data: {
      ...scope,
      ...window,
      property: "https://example.com/",
      shape: "query,page",
      status: "complete",
      rows: [
        {
          keys: ["first", "https://example.com/products?plan=pro"],
          clicks: 1,
          impressions: 100,
          position: 10,
          ctr: 0.01,
        },
        {
          keys: ["second", "https://example.com/"],
          clicks: 1,
          impressions: 100,
          position: 11,
          ctr: 0.01,
        },
      ],
    },
  });
  const result = await importGa4LandingPages(db, actor, scope, window, p, box);
  expect(result.status).toBe("complete");
  expect(result.rows).toEqual([
    expect.objectContaining({
      normalizedUrl: "https://example.com/products?plan=pro",
      sessionKeyEventRate: 0.333333,
    }),
  ]);
  transport.mockClear();
  expect(
    (await importGa4LandingPages(db, actor, scope, window, p, box)).id,
  ).toBe(result.id);
  const saved = await readGa4LandingPages(db, actor, scope);
  expect(transport).not.toHaveBeenCalled();
  expect(saved.opportunityOutcomes.map((x) => x.query)).toEqual([
    "first",
    "first",
    "second",
    "second",
  ]);
  expect(
    saved.opportunityOutcomes.map((x) => x.conversionEvidence.status),
  ).toEqual(["available", "available", "unavailable", "unavailable"]);
  expect(saved.opportunityOutcomes[2]!.conversionEvidence).toMatchObject({
    reason: "no_matching_page",
  });
  expect(JSON.stringify(saved)).not.toContain("encryptedRefreshToken");
});
it("retains no-data separately from thresholded sampled restricted and missing landing rows", async () => {
  const { p } = provider();
  await connect(p);
  const limited = analyticsProvider(config, fixtureTransport(primaryReport));
  const partial = await importGa4LandingPages(
    db,
    actor,
    scope,
    window,
    limited,
    box,
  );
  expect(partial.status).toBe("partial");
  expect(partial.diagnostics).toMatchObject({
    restricted: true,
    thresholded: true,
    sampled: true,
    otherLoss: true,
  });
  await selectGa4Property(db, actor, scope, "properties/123", "456", p, box);
  const empty = analyticsProvider(
    config,
    fixtureTransport({ ...cleanReport, rows: [], rowCount: 0 }),
  );
  expect(
    (
      await importGa4LandingPages(
        db,
        actor,
        scope,
        { ...window, endDate: "2026-01-03" },
        empty,
        box,
      )
    ).status,
  ).toBe("no_data");
  await selectGa4Property(db, actor, scope, "properties/123", "456", p, box);
  const hidden = {
    ...p,
    report: async () => ({
      rows: [
        {
          date: "2026-01-01",
          rawLandingPage: "(not set)",
          hostName: "example.com",
          streamId: "456",
          channel: "Organic Search",
          sessions: 1,
          engagedSessions: 0,
          sessionKeyEventRate: null,
        },
      ],
      rowCount: 1,
      timeZone: "America/Los_Angeles",
      diagnostics: {},
    }),
  };
  const missing = await importGa4LandingPages(
    db,
    actor,
    scope,
    { ...window, endDate: "2026-01-04" },
    hidden,
    box,
  );
  expect(missing.status).toBe("partial");
  expect(missing.rows).toEqual([
    expect.objectContaining({
      normalizedUrl: null,
      unavailableReason: "missing_landing_page",
    }),
  ]);
});
it("durably records recoverable failure/revocation, retries only explicit failed operation", async () => {
  const { p } = provider();
  await connect(p);
  const fail = {
    ...p,
    report: vi.fn(async () => {
      throw new Error("ANALYTICS_RECONNECT_REQUIRED");
    }),
  };
  await expect(
    importGa4LandingPages(db, actor, scope, window, fail, box),
  ).rejects.toThrow("ANALYTICS_RECONNECT_REQUIRED");
  const state = await readGa4LandingPages(db, actor, scope);
  expect(state.connection?.status).toBe("revoked");
  expect(state.snapshots[0]).toMatchObject({
    status: "failed",
    failure: "ANALYTICS_RECONNECT_REQUIRED",
  });
  await connect(p);
  expect(
    (await importGa4LandingPages(db, actor, scope, window, p, box)).status,
  ).toBe("complete");
});
it("fences callback/import disconnect and import reselection during network", async () => {
  const { p } = provider();
  const disconnectExchange = {
    ...p,
    exchange: async () => {
      await disconnectGa4(db, actor, scope);
      return "r";
    },
  };
  const { url } = await beginGa4Connect(db, actor, scope, p, box);
  await expect(
    completeGa4Connect(
      db,
      actor,
      new URL(url).searchParams.get("state")!,
      "c",
      disconnectExchange,
      box,
    ),
  ).rejects.toThrow("INVALID_OAUTH_STATE");
  await connect(p);
  await expect(
    importGa4LandingPages(
      db,
      actor,
      scope,
      window,
      {
        ...p,
        report: async (...args) => {
          await disconnectGa4(db, actor, scope);
          return p.report(...args);
        },
      },
      box,
    ),
  ).rejects.toThrow("ANALYTICS_CONNECTION_CHANGED");
  expect(await admin.analyticsImport.count()).toBe(0);
  await connect(p);
  await expect(
    importGa4LandingPages(
      db,
      actor,
      scope,
      window,
      {
        ...p,
        report: async (...args) => {
          await selectGa4Property(
            db,
            actor,
            scope,
            "properties/123",
            "456",
            p,
            box,
          );
          return p.report(...args);
        },
      },
      box,
    ),
  ).rejects.toThrow("ANALYTICS_CONNECTION_CHANGED");
  expect((await admin.analyticsImport.findFirstOrThrow()).status).toBe(
    "failed",
  );
});
it("caps whole report at ten thousand and exposes bounded saved previews with explicit partial coverage", async () => {
  const { p } = provider();
  await connect(p);
  const report = {
    ...p,
    report: async () => ({
      rows: Array.from({ length: 10000 }, () => ({
        date: "2026-01-01",
        rawLandingPage: "/page",
        hostName: "example.com",
        streamId: "456",
        channel: "Organic Search",
        sessions: 1,
        engagedSessions: 0,
        sessionKeyEventRate: 0,
      })),
      rowCount: 10001,
      timeZone: "America/Los_Angeles",
      diagnostics: {},
    }),
  };
  const result = await importGa4LandingPages(
    db,
    actor,
    scope,
    window,
    report,
    box,
  );
  expect(result.status).toBe("partial");
  expect(result.diagnostics).toMatchObject({
    truncated: true,
    processedRows: 10000,
    rowCount: 10001,
  });
  const saved = await readGa4LandingPages(db, actor, scope);
  expect(saved.snapshots[0]).toMatchObject({
    rowCount: 10000,
    displayLimited: true,
  });
  expect(saved.snapshots[0]!.rows).toHaveLength(100);
});
it("does not dispatch duplicate inflight reports and allows expired lease recovery with attempt fencing", async () => {
  const { p } = provider();
  await connect(p);
  let release!: (value: Awaited<ReturnType<Ga4Provider["report"]>>) => void;
  const report = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<Ga4Provider["report"]>>>((resolve) => {
        release = resolve;
      }),
  );
  const pending = importGa4LandingPages(
    db,
    actor,
    scope,
    window,
    { ...p, report },
    box,
  );
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  await expect(
    importGa4LandingPages(db, actor, scope, window, p, box),
  ).rejects.toThrow("ANALYTICS_IMPORT_RUNNING");
  await admin.analyticsImport.updateMany({ data: { leaseUntil: new Date(0) } });
  const recovered = await importGa4LandingPages(
    db,
    actor,
    scope,
    window,
    p,
    box,
  );
  release({
    rows: [],
    rowCount: 0,
    timeZone: "America/Los_Angeles",
    diagnostics: {},
  });
  await expect(pending).rejects.toThrow("ANALYTICS_IMPORT_CHANGED");
  expect(
    (
      await admin.analyticsImport.findUniqueOrThrow({
        where: { id: recovered.id },
      })
    ).status,
  ).toBe("complete");
});
it("rejects immutable evidence updates and suppresses cross-host/stream/timezone publication", async () => {
  const { p } = provider();
  await connect(p);
  const saved = await importGa4LandingPages(db, actor, scope, window, p, box);
  await expect(
    admin.analyticsImport.update({
      where: { id: saved.id },
      data: { rows: [] },
    }),
  ).rejects.toThrow("Analytics evidence is immutable");
  await selectGa4Property(db, actor, scope, "properties/123", "456", p, box);
  const base = await p.report("r", "properties/123", {
    ...window,
    streamId: "456",
    hostName: "example.com",
  });
  await expect(
    importGa4LandingPages(
      db,
      actor,
      scope,
      { ...window, endDate: "2026-01-03" },
      {
        ...p,
        report: async () => ({
          ...base,
          rows: base.rows.map((x) => ({ ...x, hostName: "other.com" })),
        }),
      },
      box,
    ),
  ).rejects.toThrow("ANALYTICS_SCOPE_ERROR");
  expect(
    (
      await admin.analyticsImport.findFirstOrThrow({
        where: { status: "failed" },
      })
    ).rows,
  ).toEqual([]);
  await selectGa4Property(db, actor, scope, "properties/123", "456", p, box);
  await expect(
    importGa4LandingPages(
      db,
      actor,
      scope,
      { ...window, endDate: "2026-01-04" },
      { ...p, report: async () => ({ ...base, timeZone: "Asia/Kolkata" }) },
      box,
    ),
  ).rejects.toThrow("ANALYTICS_SCOPE_ERROR");
  expect(
    (
      await admin.analyticsImport.findFirstOrThrow({
        where: { endDate: "2026-01-04" },
      })
    ).status,
  ).toBe("failed");
});
it("preserves history and cached evidence across same/alternative selection and reconnect, attaching only active scope", async () => {
  const { p: base } = provider();
  const catalog = [
    {
      property: "properties/123",
      displayName: "First",
      timeZone: "America/Los_Angeles",
      streams: [
        {
          streamId: "456",
          displayName: "Web",
          defaultUri: "https://example.com",
        },
      ],
    },
    {
      property: "properties/789",
      displayName: "Second",
      timeZone: "America/Los_Angeles",
      streams: [
        {
          streamId: "987",
          displayName: "Other stream",
          defaultUri: "https://example.com",
        },
      ],
    },
  ];
  const report = vi.fn(
    async (
      _refresh: string,
      property: string,
      input: { streamId: string },
    ) => ({
      rows: [
        {
          date: "2026-01-01",
          rawLandingPage: "/products?plan=pro",
          hostName: "example.com",
          streamId: input.streamId,
          channel: "Organic Search",
          sessions: property === "properties/123" ? 12 : 3,
          engagedSessions: 1,
          sessionKeyEventRate: 0.25,
        },
      ],
      rowCount: 1,
      timeZone: "America/Los_Angeles",
      diagnostics: { fixtureProperty: property },
    }),
  );
  const p: Ga4Provider = { ...base, properties: async () => catalog, report };
  await connect(p);
  await admin.searchSnapshot.create({
    data: {
      ...scope,
      ...window,
      property: "https://example.com/",
      shape: "query,page",
      status: "complete",
      rows: [
        {
          keys: ["query", "https://example.com/products?plan=pro"],
          clicks: 1,
          impressions: 100,
          position: 10,
          ctr: 0.01,
        },
      ],
    },
  });
  const first = await importGa4LandingPages(db, actor, scope, window, p, box);
  report.mockClear();
  await selectGa4Property(db, actor, scope, "properties/123", "456", p, box);
  const same = await importGa4LandingPages(db, actor, scope, window, p, box);
  expect(same.id).toBe(first.id);
  expect(same.importedAt).toEqual(first.importedAt);
  expect(same.diagnostics).toEqual(first.diagnostics);
  expect(report).not.toHaveBeenCalled();
  await selectGa4Property(db, actor, scope, "properties/789", "987", p, box);
  const historical = await readGa4LandingPages(db, actor, scope);
  expect(historical.snapshots).toHaveLength(1);
  expect(historical.snapshots[0]!.id).toBe(first.id);
  expect(historical.opportunityOutcomes[0]!.conversionEvidence).toMatchObject({
    status: "unavailable",
    reason: "scope_mismatch",
  });
  const second = await importGa4LandingPages(db, actor, scope, window, p, box);
  expect(second.id).not.toBe(first.id);
  const active = await readGa4LandingPages(db, actor, scope);
  expect(active.snapshots).toHaveLength(2);
  const outcome = active.opportunityOutcomes[0]!.conversionEvidence;
  expect(outcome.status).toBe("available");
  if (outcome.status === "available")
    expect(outcome.rows.map((x) => x.sessions)).toEqual([3]);
  report.mockClear();
  await connect(p);
  expect(
    (await importGa4LandingPages(db, actor, scope, window, p, box)).id,
  ).toBe(first.id);
  expect(report).not.toHaveBeenCalled();
  expect(await admin.analyticsImport.count()).toBe(2);
  await disconnectGa4(db, actor, scope);
  expect(await admin.analyticsImport.count()).toBe(0);
});

it("keeps the agency-wide catalog manager-only for viewers and editors granted one client site", async () => {
  const { p } = provider();
  const agencyCatalog = [
    {
      property: "properties/123",
      displayName: "Client A",
      timeZone: "America/Los_Angeles",
      streams: [
        {
          streamId: "456",
          displayName: "A stream",
          defaultUri: "https://example.com",
        },
      ],
    },
    {
      property: "properties/999",
      displayName: "Private client B",
      timeZone: "Asia/Kolkata",
      streams: [
        {
          streamId: "999",
          displayName: "B stream",
          defaultUri: "https://private-client.example",
        },
      ],
    },
  ];
  const agency = { ...p, properties: async () => agencyCatalog };
  await connect(agency);
  await ga4Properties(db, actor, scope, agency, box);
  expect((await readGa4LandingPages(db, actor, scope)).properties).toEqual(
    agencyCatalog,
  );
  for (const role of ["VIEWER", "EDITOR"] as const) {
    await admin.membership.update({
      where: { workspaceId_userId: { workspaceId: "a", userId: "viewer" } },
      data: { role },
    });
    const result = await readGa4LandingPages(
      db,
      { ...actor, userId: "viewer" },
      scope,
    );
    expect(result.properties).toEqual([]);
    expect(result.connection).not.toHaveProperty("catalog");
    expect(JSON.stringify(result)).not.toContain("Private client B");
    expect(JSON.stringify(result)).not.toContain("private-client.example");
    expect(result.connection?.property).toBe("properties/123");
    await expect(
      ga4Properties(db, { ...actor, userId: "viewer" }, scope, agency, box),
    ).rejects.toThrow("FORBIDDEN");
  }
});
it("keeps a cached terminal measurement from its import time when its administrative start is older than 13 months", async () => {
  const { p } = provider();
  await connect(p);
  const result = await importGa4LandingPages(db, actor, scope, window, p, box);
  const row = await admin.analyticsImport.findUniqueOrThrow({
    where: { id: result.id },
  });
  const { resultExpiresAt: _generated, ...original } = row;
  await admin.analyticsImport.delete({ where: { id: result.id } });
  await admin.analyticsImport.create({
    data: {
      ...original,
      rows: original.rows!,
      diagnostics: original.diagnostics!,
      startedAt: new Date(0),
    },
  });
  const blocked = {
    ...p,
    properties: vi.fn(() => {
      throw Error("Unexpected provider call");
    }),
    report: vi.fn(() => {
      throw Error("Unexpected provider call");
    }),
  };
  const cached = await importGa4LandingPages(
    db,
    actor,
    scope,
    window,
    blocked,
    box,
  );
  expect(cached).toMatchObject({
    id: row.id,
    importedAt: row.importedAt,
    resultExpiresAt: row.resultExpiresAt,
  });
  expect(blocked.properties).not.toHaveBeenCalled();
  expect(blocked.report).not.toHaveBeenCalled();
  expect(
    (await readGa4LandingPages(db, actor, scope)).snapshots.some(
      (x) => x.id === row.id,
    ),
  ).toBe(true);
});
