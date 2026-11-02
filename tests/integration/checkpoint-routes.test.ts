import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const seams = vi.hoisted(() => ({
  db: null as unknown,
  actor: null as unknown,
  proof: "",
  configured: null as unknown,
}));
vi.mock("@/server/auth/server", () => ({
  database: () => seams.db,
  resolveActor: async () => seams.actor,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://localhost:3000" }),
}));
vi.mock("@/server/acquisition/proof", () => ({
  observeSiteProof: async (url: string) => ({
    url,
    status: 200,
    body: seams.proof,
  }),
}));
vi.mock("@/server/google/provider", async (original) => ({
  ...(await original<
    typeof import("../../apps/lyraseo-web/src/server/google/provider")
  >()),
  configuredGoogle: () => seams.configured,
}));
import * as sites from "../../apps/lyraseo-web/src/app/api/sites/route";
import * as content from "../../apps/lyraseo-web/src/app/api/content/route";
import * as reports from "../../apps/lyraseo-web/src/app/api/reports/route";
import * as google from "../../apps/lyraseo-web/src/app/api/integrations/google/route";
import * as analytics from "../../apps/lyraseo-web/src/app/api/analytics/route";
import * as audits from "../../apps/lyraseo-web/src/app/api/audits/route";
import * as search from "../../apps/lyraseo-web/src/app/api/search/route";
import {
  emptySiteContext,
  issueSiteChallenge,
} from "../../packages/db/src/sites";
import { completeGoogleConnect } from "../../packages/db/src/gsc";
import { secretBox } from "../../apps/lyraseo-web/src/server/google/provider";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
const box = secretBox(Buffer.alloc(32, 7).toString("base64"));
const provider = {
  authorize: (state: string) => state,
  exchange: async () => "refresh",
  properties: vi.fn(async () => [
    { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
  ]),
  query: vi.fn(async () => []),
};
const post = (body: unknown) =>
  new Request("http://localhost:3000/api", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...scope, ...(body as object) }),
  });
const get = (query = "") =>
  new Request(`http://localhost:3000/api?workspaceId=a&siteId=a-site${query}`);
async function json(response: Response, status = 200) {
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return result;
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  seams.db = db;
  seams.actor = actor;
  seams.configured = { provider, box };
  provider.properties.mockClear();
  provider.query.mockClear();
  vi.stubEnv("LYRA_LOCAL_RAW_AUDITS", "true");
  vi.stubEnv("VERCEL", "0");
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
  vi.unstubAllEnvs();
});
it("executes real site challenge, proof verification and context handlers against restricted PostgreSQL", async () => {
  const challenge = await json(await sites.POST(post({ action: "challenge" })));
  seams.proof = challenge.token;
  await json(
    await sites.POST(post({ action: "verify", challengeId: challenge.id })),
  );
  const saved = await json(
    await sites.POST(
      post({
        action: "context",
        expectedRevision: 0,
        content: { ...emptySiteContext(), brandName: "Actual route" },
      }),
    ),
  );
  expect(saved.revision).toBe(1);
  expect(await json(await sites.GET(get()))).toHaveLength(1);
  // Service boundary also rejects accidental structural widening as Prisma input.
  await expect(
    issueSiteChallenge(db, actor, {
      ...scope,
      action: "challenge",
    } as typeof scope),
  ).resolves.toHaveProperty("token");
});
it("executes real create/save/report and report-download handlers without leaking query fields into Prisma", async () => {
  await admin.searchSnapshot.create({
    data: {
      id: "source",
      ...scope,
      property: "https://example.com/",
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      shape: "page",
      status: "complete",
      rows: [],
    },
  });
  const fields = {
    title: "Real draft",
    body: "Manual",
    assumptions: [],
    citations: [],
  };
  const draft = await json(
    await content.POST(
      post({
        action: "create",
        kind: "draft",
        ...fields,
        auditIds: [],
        searchSnapshotIds: ["source"],
      }),
    ),
    201,
  );
  expect(draft.history).toHaveLength(1);
  await json(
    await content.POST(
      post({
        action: "save",
        draftId: draft.id,
        expectedRevision: 1,
        ...fields,
        body: "Updated",
      }),
    ),
  );
  const read = await json(await content.GET(get(`&draftId=${draft.id}`)));
  expect(read[0].history[0].content.body).toBe("Updated");
  const report = await json(
    await reports.POST(
      post({
        title: "Real report",
        auditIds: [],
        searchSnapshotIds: ["source"],
      }),
    ),
    201,
  );
  const csv = await reports.GET(get(`&reportId=${report.id}&format=csv`));
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-type")).toContain("text/csv");
  expect((await csv.text()).length).toBeGreaterThan(0);
});
it("executes real GSC connect/discover/select/import/disconnect and leaves GET provider-free", async () => {
  const consent = await json(await google.POST(post({ action: "connect" })));
  await completeGoogleConnect(db, actor, consent.url, "code", provider, box);
  expect(
    (await json(await google.POST(post({ action: "discover" })))).properties,
  ).toHaveLength(1);
  await json(
    await google.POST(
      post({ action: "select", property: "https://example.com/" }),
    ),
  );
  const imported = await json(
    await search.POST(
      post({ startDate: "2026-01-01", endDate: "2026-01-02", shape: "page" }),
    ),
  );
  expect(imported.rowCount).toBe(0);
  expect(provider.query).toHaveBeenCalledTimes(1);
  provider.query.mockClear();
  provider.properties.mockClear();
  expect((await json(await search.GET(get()))).snapshots).toHaveLength(1);
  expect(provider.query).not.toHaveBeenCalled();
  expect(provider.properties).not.toHaveBeenCalled();
  await json(await google.POST(post({ action: "disconnect" })));
  expect(await admin.googleConnection.count()).toBe(0);
  expect(await admin.searchSnapshot.count()).toBe(0);
  expect(await admin.searchImport.count()).toBe(0);
});

it("projects audit review commands into clean scope and append-only issue fields", async () => {
  await admin.auditRun.create({
    data: {
      id: "review-route",
      ...scope,
      userId: actor.userId,
      securityVersion: 0,
      idempotencyKey: "review-route",
      inputHash: "fixture",
      manifest: ["https://example.com/"],
      profile: "LOCAL_RAW_V1",
      declarations: {},
      methodologyVersion: "readiness-v1",
      status: "COMPLETED",
      evaluation: {
        rules: [
          { ruleId: "D01", scopeKey: "https://example.com/", outcome: "FAIL" },
        ],
      },
    },
  });
  await json(
    await audits.POST(
      post({
        action: "review",
        auditId: "review-route",
        ruleId: "D01",
        scopeKey: "https://example.com/",
        disposition: "REVIEWED",
        reason: "Confirmed HTTP failure",
      }),
    ),
  );
  expect(await admin.issueAction.findFirstOrThrow()).toMatchObject({
    auditId: "review-route",
    ruleId: "D01",
    reason: "Confirmed HTTP failure",
  });
});

it("removes both management catalog forms from real analytics GET for a single-site reader", async () => {
  const catalog = [
    { property: "properties/123", displayName: "Client A", streams: [] },
    {
      property: "properties/999",
      displayName: "Private client B",
      streams: [{ streamId: "999", defaultUri: "https://private.example" }],
    },
  ];
  await admin.analyticsConnection.create({
    data: {
      ...scope,
      encryptedRefreshToken: "unread-by-GET",
      property: "properties/123",
      streamId: "456",
      timeZone: "UTC",
      catalog,
    },
  });
  expect((await json(await analytics.GET(get()))).properties).toHaveLength(2);
  seams.actor = { ...actor, userId: "viewer" };
  const response = await json(await analytics.GET(get()));
  expect(response.properties).toEqual([]);
  expect(response.connection).not.toHaveProperty("catalog");
  expect(JSON.stringify(response)).not.toContain("Private client B");
});
