import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import {
  crawlerContractSite,
  fixtureOrigin,
} from "../fixtures/crawler-contract-site";

const mocks = vi.hoisted(() => ({ resolveActor: vi.fn(), transport: vi.fn() }));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("@/server/auth/server", () => ({ resolveActor: mocks.resolveActor }));
vi.mock("@/server/acquisition/transport", () => ({
  publicHttpsTransport: mocks.transport,
}));
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("LYRA_LOCAL_RAW_AUDITS", "true");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "audits");
  mocks.resolveActor.mockResolvedValue(actor);
  await resetDatabase();
  await seedTenants();
  await admin.site.update({
    where: { id: scope.siteId },
    data: { origin: fixtureOrigin.slice(0, -1) },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("discovers the verified site's homepage links through controlled HTTP without creating an audit", async () => {
  const fixture = await crawlerContractSite();
  try {
    mocks.transport.mockImplementation(
      async (
        url: string,
        signal: AbortSignal,
        beforeSocket: () => Promise<void>,
      ) => {
        await beforeSocket();
        return fixture.transport(url, signal);
      },
    );
    const { discoverSiteCandidates } =
      await import("../../apps/lyraseo-web/src/server/acquisition/discovery");
    const result = await discoverSiteCandidates(db, actor, scope);
    expect(result).toMatchObject({
      state: "available",
      candidates: [fixtureOrigin, fixtureOrigin + "about"],
    });
    expect(fixture.requests).toEqual(["/robots.txt", "/"]);
    expect(await admin.auditRun.count()).toBe(0);
  } finally {
    await fixture.close();
  }
});
it("denies a same-tenant user without a site grant before any outbound request", async () => {
  const viewer = { ...actor, userId: "viewer" };
  mocks.resolveActor.mockResolvedValue(viewer);
  const { discoverSiteCandidates } =
    await import("../../apps/lyraseo-web/src/server/acquisition/discovery");
  await expect(
    discoverSiteCandidates(db, viewer, { workspaceId: "b", siteId: "b-site" }),
  ).rejects.toThrow();
  expect(mocks.transport).not.toHaveBeenCalled();
});
it("rejects a site grant revoked between the robots and page sockets", async () => {
  const viewer = { ...actor, userId: "viewer" };
  mocks.resolveActor.mockResolvedValue(viewer);
  // The standard viewer role cannot run audits. Use an editor with a scoped site grant.
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "viewer" } },
    data: { role: "EDITOR" },
  });
  const fixture = await crawlerContractSite();
  try {
    mocks.transport.mockImplementation(
      async (
        url: string,
        signal: AbortSignal,
        beforeSocket: () => Promise<void>,
      ) => {
        if (url.endsWith("/"))
          await admin.siteGrant.deleteMany({
            where: { workspaceId: "a", siteId: "a-site", userId: "viewer" },
          });
        await beforeSocket();
        return fixture.transport(url, signal);
      },
    );
    const { discoverSiteCandidates } =
      await import("../../apps/lyraseo-web/src/server/acquisition/discovery");
    await expect(discoverSiteCandidates(db, viewer, scope)).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(fixture.requests).toEqual(["/robots.txt"]);
    expect(await admin.auditRun.count()).toBe(0);
  } finally {
    await fixture.close();
  }
});
