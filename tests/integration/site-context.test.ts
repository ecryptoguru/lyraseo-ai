import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  createSite,
  issueSiteChallenge,
  verifySiteChallenge as verifySiteChallengeWithFreshActor,
  emptySiteContext,
  reviewSiteContext,
  readSiteContextRevisions,
} from "../../packages/db/src/sites";
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
const verifySiteChallenge = (
  db: Parameters<typeof verifySiteChallengeWithFreshActor>[0],
  current: Parameters<typeof verifySiteChallengeWithFreshActor>[1],
  scope: Parameters<typeof verifySiteChallengeWithFreshActor>[2],
  challengeId: Parameters<typeof verifySiteChallengeWithFreshActor>[3],
  observe: Parameters<typeof verifySiteChallengeWithFreshActor>[4],
) =>
  verifySiteChallengeWithFreshActor(
    db,
    current,
    scope,
    challengeId,
    async (url, beforeSocket) => {
      await beforeSocket();
      return observe(url, beforeSocket);
    },
    async () => current,
  );
it("binds ownership proof to the issuing session before and after observation", async () => {
  const challenge = await issueSiteChallenge(db, actor, scope);
  let called = false;
  await expect(
    verifySiteChallenge(
      db,
      { ...actor, sessionId: "another-session" },
      scope,
      challenge.id,
      async (url) => {
        called = true;
        return { url, status: 200, body: challenge.token };
      },
    ),
  ).rejects.toThrow("INVALID_SITE_CHALLENGE");
  expect(called).toBe(false);
  await verifySiteChallenge(db, actor, scope, challenge.id, async (url) => ({
    url,
    status: 200,
    body: challenge.token,
  }));
});
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("creates only public HTTPS origins without inventing verification", async () => {
  const site = await createSite(db, actor, {
    workspaceId: "a",
    origin: "https://www.example.com/",
  });
  expect(site.origin).toBe("https://www.example.com");
  expect(site.verifiedAt).toBeNull();
  for (const origin of [
    "https://example.com/path",
    "https://example.com/?q=a",
    "http://example.com",
    "https://127.0.0.1",
    "https://localhost",
  ])
    await expect(
      createSite(db, actor, { workspaceId: "a", origin }),
    ).rejects.toThrow("INVALID_SITE_ORIGIN");
  await expect(
    createSite(
      db,
      { ...actor, userId: "viewer" },
      { workspaceId: "a", origin: "https://new.example.com" },
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("binds hashed one-use proofs to exact site challenge and rechecks pending results", async () => {
  const first = await issueSiteChallenge(db, actor, scope);
  expect(first.token.length).toBe(43);
  expect(
    (
      await admin.siteVerificationChallenge.findUniqueOrThrow({
        where: { id: first.id },
      })
    ).tokenHash,
  ).not.toContain(first.token);
  const second = await issueSiteChallenge(db, actor, scope);
  await expect(
    verifySiteChallenge(db, actor, scope, first.id, async (url) => ({
      url,
      status: 200,
      body: first.token,
    })),
  ).rejects.toThrow("INVALID_SITE_CHALLENGE");
  await expect(
    verifySiteChallenge(db, actor, scope, second.id, async (url) => ({
      url: url + "/redirect",
      status: 200,
      body: second.token,
    })),
  ).rejects.toThrow("INVALID_SITE_PROOF");
  await expect(
    verifySiteChallenge(
      db,
      actor,
      { workspaceId: "b", siteId: "b-site" },
      second.id,
      async (url) => ({ url, status: 200, body: second.token }),
    ),
  ).rejects.toThrow("INVALID_SITE_CHALLENGE");
  await verifySiteChallenge(db, actor, scope, second.id, async (url) => ({
    url,
    status: 200,
    body: second.token,
  }));
  await expect(
    verifySiteChallenge(db, actor, scope, second.id, async (url) => ({
      url,
      status: 200,
      body: second.token,
    })),
  ).rejects.toThrow("INVALID_SITE_CHALLENGE");
  const pending = await issueSiteChallenge(db, actor, scope);
  await expect(
    verifySiteChallenge(db, actor, scope, pending.id, async (url) => {
      await issueSiteChallenge(db, actor, scope);
      return { url, status: 200, body: pending.token };
    }),
  ).rejects.toThrow("INVALID_SITE_CHALLENGE");
});
it("blocks expired proofs and revoked actor security while fetching", async () => {
  const challenge = await issueSiteChallenge(db, actor, scope);
  await admin.siteVerificationChallenge.update({
    where: { id: challenge.id },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    verifySiteChallenge(db, actor, scope, challenge.id, async (url) => ({
      url,
      status: 200,
      body: challenge.token,
    })),
  ).rejects.toThrow("INVALID_SITE_CHALLENGE");
  const next = await issueSiteChallenge(db, actor, scope);
  await expect(
    verifySiteChallenge(db, actor, scope, next.id, async (url) => {
      await admin.productUser.update({
        where: { id: actor.userId },
        data: { securityVersion: 1 },
      });
      return { url, status: 200, body: next.token };
    }),
  ).rejects.toThrow("FORBIDDEN");
});
it("appends reviewed immutable versions with optimistic concurrency and viewer history", async () => {
  const content = {
    ...emptySiteContext(),
    brandName: "Example",
    supportedClaims: ["Customer supplied claim"],
  };
  const results = await Promise.allSettled([
    reviewSiteContext(db, actor, scope, 0, content),
    reviewSiteContext(db, actor, scope, 0, content),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    results.filter((r) => r.status === "rejected").map((r) => String(r.reason)),
  ).toEqual([expect.stringContaining("CONTEXT_REVISION_CONFLICT")]);
  await reviewSiteContext(db, actor, scope, 1, {
    ...content,
    brandName: "Reviewed Example",
  });
  const history = await readSiteContextRevisions(
    db,
    { ...actor, userId: "viewer" },
    scope,
  );
  expect(history.map((r) => r.revision)).toEqual([2, 1]);
  expect(history[0].reviewedBy).toBe("owner");
  await expect(
    reviewSiteContext(db, { ...actor, userId: "viewer" }, scope, 2, content),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    admin.siteContextRevision.updateMany({ data: { content: {} } }),
  ).rejects.toThrow("IMMUTABLE_SITE_CONTEXT");
  await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
  await expect(
    readSiteContextRevisions(db, { ...actor, userId: "viewer" }, scope),
  ).rejects.toThrow("FORBIDDEN");
});
it("limits context to explicit bounded plain declarations and the same origin", async () => {
  await expect(
    reviewSiteContext(db, actor, scope, 0, {
      ...emptySiteContext(),
      keyPages: ["https://other.com/"],
    }),
  ).rejects.toThrow("INVALID_SITE_CONTEXT");
  await expect(
    reviewSiteContext(db, actor, scope, 0, {
      ...emptySiteContext(),
      brandName: "x".repeat(513),
    }),
  ).rejects.toThrow("INVALID_SITE_CONTEXT");
  await expect(
    reviewSiteContext(
      db,
      actor,
      { workspaceId: "a", siteId: "b-site" },
      0,
      emptySiteContext(),
    ),
  ).rejects.toThrow("NOT_FOUND");
});
it("enforces forced RLS, browser denial and append-only runtime context grants", async () => {
  await reviewSiteContext(db, actor, scope, 0, emptySiteContext());
  expect(await db.siteContextRevision.findMany()).toEqual([]);
  const rows = await admin.$queryRaw<
    Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
  >`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('SiteVerificationChallenge','SiteContextRevision')`;
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(
    true,
  );
  const grants = await admin.$queryRaw<
    Array<{ update: boolean; delete: boolean }>
  >`SELECT has_table_privilege('lyraseo_runtime','"SiteContextRevision"','UPDATE') AS update,has_table_privilege('lyraseo_runtime','"SiteContextRevision"','DELETE') AS delete`;
  expect(grants[0]).toEqual({ update: false, delete: false });
  const browser = await admin.$queryRaw<
    Array<{ privilege_type: string }>
  >`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name IN ('SiteVerificationChallenge','SiteContextRevision') AND grantee IN ('anon','authenticated','PUBLIC')`;
  expect(browser).toEqual([]);
});
