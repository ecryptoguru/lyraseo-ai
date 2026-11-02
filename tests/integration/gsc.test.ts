import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  beginGoogleConnect,
  completeGoogleConnect,
  selectGoogleProperty,
  importGoogleSearch,
  readGoogleSearch,
  disconnectGoogle,
  type GoogleProvider,
} from "../../packages/db/src/gsc";
import { secretBox } from "../../apps/lyraseo-web/src/server/google/provider";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" },
  box = secretBox(Buffer.alloc(32, 7).toString("base64"));
const provider: GoogleProvider = {
  authorize: (state) => state,
  exchange: async () => "refresh-secret",
  properties: async () => [
    { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
  ],
  query: async () => [
    {
      keys: ["https://example.com/"],
      clicks: 1,
      impressions: 10,
      position: 7,
      ctr: 0.1,
    },
  ],
};
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
async function connect(p = provider) {
  const { url: state } = await beginGoogleConnect(db, actor, scope, p, box);
  await completeGoogleConnect(db, actor, state, "code", p, box);
  await selectGoogleProperty(db, actor, scope, "https://example.com/", p, box);
  return state;
}
async function savedImport(id: string, extra: Record<string, unknown> = {}) {
  return admin.searchImport.create({
    data: {
      id,
      ...scope,
      property: "https://example.com/",
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      shape: "query,page",
      generation: 7,
      attempt: "private-attempt-secret",
      status: "running",
      leaseUntil: new Date(Date.now() + 300000),
      ...extra,
    },
  });
}
it("reads bounded retained import receipts with safe metadata and observes expired leases without mutation", async () => {
  await connect();
  await savedImport("failed", {
    status: "failed",
    failure: "GOOGLE_RECONNECT_REQUIRED",
    completedAt: new Date(),
  });
  await savedImport("expired", { leaseUntil: new Date(0) });
  await savedImport("active");
  await savedImport("unsafe", {
    status: "failed",
    failure: "GOOGLE_provider-body access_token=raw-secret",
  });
  await savedImport("old", { startedAt: new Date("2020-01-01") });
  const before = await admin.searchImport.findMany({ orderBy: { id: "asc" } });
  const read = await readGoogleSearch(db, actor, scope);
  expect(read.imports).toHaveLength(4);
  expect(read.imports.find((r) => r.id === "failed")).toMatchObject({
    status: "failed",
    failure: "GOOGLE_RECONNECT_REQUIRED",
    recoverable: true,
  });
  expect(read.imports.find((r) => r.id === "expired")).toMatchObject({
    status: "running",
    recoverable: true,
  });
  expect(read.imports.find((r) => r.id === "active")?.recoverable).toBe(false);
  expect(read.imports.find((r) => r.id === "unsafe")?.failure).toBe(
    "GOOGLE_TEMPORARILY_UNAVAILABLE",
  );
  expect(Object.keys(read.imports[0]).sort()).toEqual([
    "completedAt",
    "endDate",
    "failure",
    "id",
    "property",
    "recoverable",
    "shape",
    "snapshotStatus",
    "startDate",
    "startedAt",
    "status",
  ]);
  expect(JSON.stringify(read.imports)).not.toMatch(
    /raw-secret|private-attempt|generation|leaseUntil|sessionId|userId/,
  );
  expect(await admin.searchImport.findMany({ orderBy: { id: "asc" } })).toEqual(
    before,
  );
  await admin.searchImport.createMany({
    data: Array.from({ length: 24 }, (_, i) => ({
      ...before[0],
      resultExpiresAt: undefined,
      id: `bounded-${i}`,
      startedAt: new Date(Date.now() + i * 1000),
    })),
  });
  const bounded = await readGoogleSearch(db, actor, scope);
  expect(bounded.imports).toHaveLength(20);
  expect(bounded.imports[0].id).toBe("bounded-23");
  expect(bounded.imports.at(-1)?.id).toBe("bounded-4");
});
it("keeps import receipt reads site-authorized after same-tenant grant and token scope revocation", async () => {
  const { createApiToken, resolveApiToken, tokenAccessPolicyHash } =
    await import("../../packages/db/src/tokens");
  await savedImport("private-receipt", { status: "failed" });
  expect(
    (await readGoogleSearch(db, { ...actor, userId: "viewer" }, scope)).imports,
  ).toHaveLength(1);
  await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
  await expect(
    readGoogleSearch(db, { ...actor, userId: "viewer" }, scope),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    readGoogleSearch(db, actor, { workspaceId: "a", siteId: "b-site" }),
  ).rejects.toThrow("NOT_FOUND");
  expect(
    (await readGoogleSearch(db, actor, { workspaceId: "b", siteId: "b-site" }))
      .imports,
  ).toEqual([]);
  const policy = tokenAccessPolicyHash(["pilot@example.com"]);
  const issued = await createApiToken(
    db,
    actor,
    {
      workspaceId: "a",
      name: "Status read",
      siteIds: ["a-site"],
      scopes: ["search:read"],
      requestKey: crypto.randomUUID(),
    },
    policy,
  );
  const tokenActor = await resolveApiToken(db, issued.secret, policy);
  expect((await readGoogleSearch(db, tokenActor, scope)).imports[0].id).toBe(
    "private-receipt",
  );
  await admin.apiToken.update({
    where: { id: tokenActor.tokenId },
    data: { scopes: ["sites:read"] },
  });
  await expect(readGoogleSearch(db, tokenActor, scope)).rejects.toThrow(
    "FORBIDDEN",
  );
});
it("correlates completed partial imports without copying snapshot rows or dispatching a provider on reads", async () => {
  const p = {
    ...provider,
    properties: vi.fn(provider.properties),
    query: vi.fn(provider.query),
  };
  await connect(p);
  await savedImport("partial", { status: "complete", completedAt: new Date() });
  await admin.searchSnapshot.create({
    data: {
      ...scope,
      property: "https://example.com/",
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      shape: "query,page",
      status: "partial",
      rows: [],
    },
  });
  p.properties.mockClear();
  const read = await readGoogleSearch(db, actor, scope);
  expect(read.imports[0]).toMatchObject({
    snapshotStatus: "partial",
    recoverable: false,
  });
  expect(read.imports[0]).not.toHaveProperty("rows");
  expect(read.snapshots[0].rowCount).toBe(0);
  expect(read.coverage).toContain("not proven zero traffic");
  expect(p.properties).not.toHaveBeenCalled();
  expect(p.query).not.toHaveBeenCalled();
});
it("consumes session-bound state once and isolates credential rows under forced RLS", async () => {
  const { url: state } = await beginGoogleConnect(
    db,
    actor,
    scope,
    provider,
    box,
  );
  await expect(
    completeGoogleConnect(
      db,
      { ...actor, sessionId: "other" },
      state,
      "code",
      provider,
      box,
    ),
  ).rejects.toThrow("INVALID_OAUTH_STATE");
  await completeGoogleConnect(db, actor, state, "code", provider, box);
  await expect(
    completeGoogleConnect(db, actor, state, "code", provider, box),
  ).rejects.toThrow("INVALID_OAUTH_STATE");
  expect(await db.googleConnection.findMany()).toEqual([]);
  const stored = await admin.googleConnection.findFirstOrThrow();
  expect(JSON.stringify(stored)).not.toContain("refresh-secret");
  expect(stored.encryptedRefreshToken).toMatch(/^v1\./);
});
it("rejects expired state, other origins and unverified properties", async () => {
  const { url: state } = await beginGoogleConnect(
    db,
    actor,
    scope,
    provider,
    box,
  );
  await admin.googleOAuthState.updateMany({ data: { expiresAt: new Date(0) } });
  await expect(
    completeGoogleConnect(db, actor, state, "code", provider, box),
  ).rejects.toThrow("INVALID_OAUTH_STATE");
  await connect();
  await expect(
    selectGoogleProperty(
      db,
      actor,
      scope,
      "https://example.com/path",
      provider,
      box,
    ),
  ).rejects.toThrow("EXACT_VERIFIED_ORIGIN_REQUIRED");
  await expect(
    readGoogleSearch(db, actor, { workspaceId: "a", siteId: "b-site" }),
  ).rejects.toThrow("NOT_FOUND");
});
it("upserts bounded snapshots, rechecks grants, and immediately purges disconnect", async () => {
  await connect();
  const input = {
    startDate: "2026-01-01",
    endDate: "2026-01-28",
    shape: "page" as const,
  };
  const a = await importGoogleSearch(db, actor, scope, input, provider, box),
    b = await importGoogleSearch(db, actor, scope, input, provider, box);
  expect(a.id).toBe(b.id);
  const retryProvider = {
    ...provider,
    properties: vi.fn(provider.properties),
    query: vi.fn(provider.query),
  };
  const retry = await importGoogleSearch(
    db,
    actor,
    scope,
    input,
    retryProvider,
    box,
  );
  expect(retry.id).toBe(a.id);
  expect(retryProvider.properties).not.toHaveBeenCalled();
  expect(retryProvider.query).not.toHaveBeenCalled();
  expect(
    (await readGoogleSearch(db, { ...actor, userId: "viewer" }, scope))
      .snapshots,
  ).toHaveLength(1);
  await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
  await expect(
    readGoogleSearch(db, { ...actor, userId: "viewer" }, scope),
  ).rejects.toThrow("FORBIDDEN");
  await disconnectGoogle(db, actor, scope);
  expect((await readGoogleSearch(db, actor, scope)).snapshots).toEqual([]);
  expect(await admin.googleConnection.count()).toBe(0);
});
it("fences callback and imports when disconnect occurs during HTTP", async () => {
  const p = {
    ...provider,
    exchange: async () => {
      await disconnectGoogle(db, actor, scope);
      return "secret";
    },
  };
  const { url: state } = await beginGoogleConnect(db, actor, scope, p, box);
  await expect(
    completeGoogleConnect(db, actor, state, "code", p, box),
  ).rejects.toThrow("INVALID_OAUTH_STATE");
  await connect();
  await expect(
    importGoogleSearch(
      db,
      actor,
      scope,
      { startDate: "2026-01-01", endDate: "2026-01-02", shape: "page" },
      {
        ...provider,
        query: async () => {
          await disconnectGoogle(db, actor, scope);
          return [];
        },
      },
      box,
    ),
  ).rejects.toThrow("GOOGLE_CONNECTION_CHANGED");
  expect(await admin.searchSnapshot.count()).toBe(0);
});
it("paginates to processing ceiling and explicitly marks partial", async () => {
  await connect();
  const starts: number[] = [];
  const p = {
    ...provider,
    query: async (
      _token: string,
      _property: string,
      input: { startRow: number },
    ) => {
      starts.push(input.startRow);
      return Array.from({ length: 25000 }, (_, i) => ({
        keys: [`page-${input.startRow + i}`],
        clicks: 0,
        impressions: 1,
        ctr: 0,
        position: 10,
      }));
    },
  };
  const result = await importGoogleSearch(
    db,
    actor,
    scope,
    { startDate: "2026-01-01", endDate: "2026-01-02", shape: "page" },
    p,
    box,
  );
  expect(starts).toEqual([0, 25000, 50000, 75000]);
  expect(result.status).toBe("partial");
  expect((result.rows as unknown[]).length).toBe(100000);
}, 30000);
it("atomically accepts one callback and rechecks revocation after exchange", async () => {
  const { url: state } = await beginGoogleConnect(
    db,
    actor,
    scope,
    provider,
    box,
  );
  const races = await Promise.allSettled([
    completeGoogleConnect(db, actor, state, "code", provider, box),
    completeGoogleConnect(db, actor, state, "code", provider, box),
  ]);
  expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const { url: next } = await beginGoogleConnect(
    db,
    actor,
    scope,
    provider,
    box,
  );
  await expect(
    completeGoogleConnect(
      db,
      actor,
      next,
      "code",
      {
        ...provider,
        exchange: async () => {
          await admin.membership.delete({
            where: {
              workspaceId_userId: { workspaceId: "a", userId: actor.userId },
            },
          });
          return "refresh";
        },
      },
      box,
    ),
  ).rejects.toThrow("FORBIDDEN");
});

it("correlates exact-page demand with retained findings only when the credential can read audits", async () => {
  const { createApiToken, resolveApiToken, tokenAccessPolicyHash } =
    await import("../../packages/db/src/tokens");
  await admin.apiThrottle.deleteMany();
  await admin.searchSnapshot.create({
    data: {
      id: "demand",
      ...scope,
      property: "https://example.com/",
      startDate: "2026-10-01",
      endDate: "2026-10-28",
      shape: "page",
      status: "complete",
      rows: [
        {
          keys: ["https://example.com/"],
          clicks: 5,
          impressions: 200,
          position: 3,
          ctr: 0.025,
        },
      ],
    },
  });
  await admin.auditRun.create({
    data: {
      id: "finding-run",
      ...scope,
      userId: actor.userId,
      securityVersion: 0,
      idempotencyKey: "finding",
      inputHash: "fixture",
      manifest: ["https://example.com/"],
      profile: "LOCAL_RAW_V1",
      declarations: {},
      methodologyVersion: "readiness-v1",
      status: "COMPLETED",
      evaluation: {
        rules: [
          {
            scopeKey: "https://example.com/",
            ruleId: "title",
            outcome: "FAIL",
          },
        ],
      },
    },
  });
  expect((await readGoogleSearch(db, actor, scope)).opportunities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "demand-and-audit",
        evidence: expect.objectContaining({ auditId: "finding-run" }),
      }),
    ]),
  );
  const policy = tokenAccessPolicyHash(["pilot@example.com"]);
  const limited = await createApiToken(
    db,
    actor,
    {
      workspaceId: "a",
      name: "Search only",
      siteIds: ["a-site"],
      scopes: ["search:read"],
      requestKey: crypto.randomUUID(),
    },
    policy,
  );
  const limitedActor = await resolveApiToken(db, limited.secret, policy);
  const limitedRead = await readGoogleSearch(db, limitedActor, scope);
  expect(JSON.stringify(limitedRead)).not.toContain("finding-run");
  const combined = await createApiToken(
    db,
    actor,
    {
      workspaceId: "a",
      name: "Search and audits",
      siteIds: ["a-site"],
      scopes: ["search:read", "audits:read"],
      requestKey: crypto.randomUUID(),
    },
    policy,
  );
  const combinedActor = await resolveApiToken(db, combined.secret, policy);
  expect(
    (await readGoogleSearch(db, combinedActor, scope)).opportunities.some(
      (o) => o.kind === "demand-and-audit",
    ),
  ).toBe(true);
});
it("preserves saved snapshot identity and zero-report cache on selecting the same GSC property again", async () => {
  const p = { ...provider, query: vi.fn(provider.query) };
  await connect(p);
  const input = {
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    shape: "page" as const,
  };
  const first = await importGoogleSearch(db, actor, scope, input, p, box);
  p.query.mockClear();
  await selectGoogleProperty(db, actor, scope, "https://example.com/", p, box);
  const second = await importGoogleSearch(db, actor, scope, input, p, box);
  expect(second.id).toBe(first.id);
  expect(second.importedAt).toEqual(first.importedAt);
  expect(second.rows).toEqual(first.rows);
  expect(p.query).not.toHaveBeenCalled();
  expect((await readGoogleSearch(db, actor, scope)).snapshots).toHaveLength(1);
  const { url: state } = await beginGoogleConnect(db, actor, scope, p, box);
  await completeGoogleConnect(db, actor, state, "code", p, box);
  await selectGoogleProperty(db, actor, scope, "https://example.com/", p, box);
  expect((await importGoogleSearch(db, actor, scope, input, p, box)).id).toBe(
    first.id,
  );
  expect(p.query).not.toHaveBeenCalled();
});

it("admits one durable import before provider dispatch, bounds connection concurrency and caches retries", async () => {
  await connect();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const p = {
    ...provider,
    properties: vi.fn(provider.properties),
    query: vi.fn(async () => {
      entered();
      await gate;
      return provider.query("", "", {
        startDate: "",
        endDate: "",
        shape: "page",
        startRow: 0,
      });
    }),
  };
  const input = {
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    shape: "page" as const,
  };
  const first = importGoogleSearch(db, actor, scope, input, p, box);
  await started;
  try {
    expect((await admin.searchImport.findFirstOrThrow()).status).toBe(
      "running",
    );
    // Restricted raw reads cannot see any tenant's receipts without actor context.
    expect(await db.searchImport.count()).toBe(0);
    await expect(
      importGoogleSearch(db, actor, scope, input, p, box),
    ).rejects.toThrow("GOOGLE_IMPORT_RUNNING");
    await expect(
      importGoogleSearch(
        db,
        actor,
        scope,
        { ...input, shape: "query" },
        p,
        box,
      ),
    ).rejects.toThrow("GOOGLE_IMPORT_RUNNING");
    expect(p.properties).toHaveBeenCalledTimes(1);
    expect(p.query).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  const saved = await first;
  expect((await importGoogleSearch(db, actor, scope, input, p, box)).id).toBe(
    saved.id,
  );
  expect(p.query).toHaveBeenCalledTimes(1);
  expect((await admin.searchImport.findFirstOrThrow()).status).toBe("complete");
  await disconnectGoogle(db, actor, scope);
  expect(await admin.searchImport.count()).toBe(0);
});
it("recovers failures and expired leases while fencing the expired attempt from publication", async () => {
  await connect();
  const input = {
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    shape: "page" as const,
  };
  await expect(
    importGoogleSearch(
      db,
      actor,
      scope,
      input,
      {
        ...provider,
        query: async () => {
          throw new Error("GOOGLE_TEMPORARILY_UNAVAILABLE");
        },
      },
      box,
    ),
  ).rejects.toThrow("GOOGLE_TEMPORARILY_UNAVAILABLE");
  expect(await admin.searchImport.findFirstOrThrow()).toMatchObject({
    status: "failed",
    failure: "GOOGLE_TEMPORARILY_UNAVAILABLE",
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const old = importGoogleSearch(
    db,
    actor,
    scope,
    input,
    {
      ...provider,
      query: async () => {
        entered();
        await gate;
        return [];
      },
    },
    box,
  );
  // Observe rejection immediately so the runner never sees an unhandled rejection.
  const oldResult = old.then(
    () => "published",
    (e: Error) => e.message,
  );
  await started;
  await admin.searchImport.updateMany({ data: { leaseUntil: new Date(0) } });
  const recovered = await importGoogleSearch(
    db,
    actor,
    scope,
    input,
    provider,
    box,
  );
  release();
  expect(await oldResult).toBe("GOOGLE_CONNECTION_CHANGED");
  expect(await admin.searchSnapshot.count()).toBe(1);
  expect((await admin.searchSnapshot.findFirstOrThrow()).id).toBe(recovered.id);
  expect((await admin.searchImport.findFirstOrThrow()).status).toBe("complete");
});

it("fences an import when consent/selection generation changes during provider HTTP", async () => {
  await connect();
  const p = {
    ...provider,
    query: async () => {
      await selectGoogleProperty(
        db,
        actor,
        scope,
        "https://example.com/",
        provider,
        box,
      );
      return [];
    },
  };
  await expect(
    importGoogleSearch(
      db,
      actor,
      scope,
      { startDate: "2026-01-01", endDate: "2026-01-02", shape: "page" },
      p,
      box,
    ),
  ).rejects.toThrow("GOOGLE_CONNECTION_CHANGED");
  expect(await admin.searchSnapshot.count()).toBe(0);
  expect(await admin.searchImport.findFirstOrThrow()).toMatchObject({
    status: "failed",
    failure: "GOOGLE_CONNECTION_CHANGED",
  });
});
it("omits expired snapshot evidence and publishes a new stable ID when the same import key is explicitly acquired again", async () => {
  await connect();
  const input = {
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    shape: "page" as const,
  };
  const first = await importGoogleSearch(
    db,
    actor,
    scope,
    input,
    provider,
    box,
  );
  const clock = await admin.searchSnapshot.update({
    where: { id: first.id },
    data: { importedAt: new Date("2024-10-31T12:00:00.001Z") },
  });
  const boundary = clock.resultExpiresAt;
  for (const delta of [-1, 0, 1]) {
    const view = await readGoogleSearch(
      db,
      actor,
      scope,
      new Date(+boundary + delta),
    );
    expect(view.snapshots.map((x) => x.id)).toEqual(
      delta < 0 ? [first.id] : [],
    );
    if (delta >= 0) expect(view.opportunities).toEqual([]);
  }
  const next = await importGoogleSearch(db, actor, scope, input, provider, box);
  expect(next.id).not.toBe(first.id);
  const again = await importGoogleSearch(
    db,
    actor,
    scope,
    input,
    provider,
    box,
  );
  expect(again.id).toBe(next.id);
  expect(again.importedAt).toEqual(next.importedAt);
});
it("displays provider-admitted long keys without altering observed identities or forwarding opaque fields", async () => {
  const pageKey =
    "https://example.com/" + "x".repeat(8192 - "https://example.com/".length);
  await admin.searchSnapshot.create({
    data: {
      ...scope,
      property: "https://example.com/",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      shape: "page",
      status: "complete",
      rows: [
        {
          keys: [pageKey],
          clicks: 1,
          impressions: 200,
          position: 4,
          ctr: 0.005,
          opaque: "should-not-leave-postgres-api",
        },
      ],
    },
  });
  const view = await readGoogleSearch(db, actor, scope);
  expect(view.snapshots[0]).toMatchObject({
    rowCount: 1,
    rows: [{ keys: [pageKey], impressions: 200 }],
  });
  expect(view.opportunities.some((o) => o.page === pageKey)).toBe(true);
  expect(JSON.stringify(view)).not.toContain("should-not-leave-postgres-api");
});
