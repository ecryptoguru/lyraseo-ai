import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { readGoogleSearch } from "../../packages/db/src/gsc";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";

const db = createDatabase(runtimeUrl);
const admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };

beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});

it("returns both query CTR and audit opportunities from a site-scoped read and denies revoked access", async () => {
  const [role] = await db.$queryRaw<
    Array<{
      name: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
    }>
  >`SELECT current_user AS name, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = current_user`;
  expect(role).toEqual({
    name: "lyraseo_runtime",
    rolsuper: false,
    rolbypassrls: false,
    rolinherit: false,
  });
  const urls = Array.from(
    { length: 100 },
    (_, i) => `https://example.com/page-${i}`,
  );
  const window = {
    ...scope,
    property: "https://example.com/",
    startDate: "2026-10-01",
    endDate: "2026-10-28",
    status: "complete",
  };
  await admin.searchSnapshot.createMany({
    data: [
      {
        ...window,
        id: "page-snapshot",
        shape: "page",
        rows: urls.map((url) => ({
          keys: [url],
          impressions: 100,
          clicks: 5,
          ctr: 0.05,
          position: 3,
        })),
      },
      {
        ...window,
        id: "query-snapshot",
        shape: "query,page",
        rows: [
          {
            keys: ["buy widgets", urls[0]],
            impressions: 100,
            clicks: 1,
            ctr: 0.01,
            position: 3,
          },
        ],
      },
    ],
  });
  for (let i = 0; i < 4; i++) {
    const manifest = urls.slice(i * 25, (i + 1) * 25);
    await admin.auditRun.create({
      data: {
        ...scope,
        id: `audit-${i}`,
        userId: actor.userId,
        securityVersion: 0,
        idempotencyKey: `audit-${i}`,
        inputHash: "fixture",
        manifest,
        profile: "LOCAL_RAW_V1",
        declarations: {},
        methodologyVersion: "readiness-v1",
        status: "COMPLETED",
        evaluation: {
          rules: manifest.map((url) => ({
            scopeKey: url,
            ruleId: "title",
            outcome: "FAIL",
          })),
        },
      },
    });
  }
  const viewer = { ...actor, userId: "viewer" };
  const result = await readGoogleSearch(db, viewer, scope);
  expect(result.opportunities).toHaveLength(100);
  expect(
    result.opportunities.some((item) => item.kind === "demand-and-audit"),
  ).toBe(true);
  expect(result.opportunities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "low-observed-query-ctr",
        query: "buy widgets",
        page: urls[0],
      }),
    ]),
  );
  await expect(
    readGoogleSearch(db, viewer, { workspaceId: "b", siteId: "b-site" }),
  ).rejects.toThrow("FORBIDDEN");
  await admin.siteGrant.deleteMany({ where: { userId: "viewer", ...scope } });
  await expect(readGoogleSearch(db, viewer, scope)).rejects.toThrow(
    "FORBIDDEN",
  );
  expect((await readGoogleSearch(db, actor, scope)).opportunities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "low-observed-query-ctr",
        query: "buy widgets",
      }),
    ]),
  );
});
