import { beforeEach, afterAll, it, expect } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  listSites,
  changeMemberRole,
  removeMember,
  issueStepUp,
} from "../../packages/db/src/tenants";
import {
  actor,
  resetDatabase,
  seedTenants,
  runtimeUrl,
  adminUrl,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("lists only granted sites for a viewer", async () => {
  expect(
    (await listSites(db, { ...actor, userId: "viewer" }, "a")).map((s) => s.id),
  ).toEqual(["a-site"]);
  await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
  expect(await listSites(db, { ...actor, userId: "viewer" }, "a")).toEqual([]);
});
it("serializes concurrent owner demotions so one owner always remains", async () => {
  const other = { ...actor, userId: "other" };
  const a = await issueStepUp(db, actor, "manage-owner", "a");
  const b = await issueStepUp(db, other, "manage-owner", "a");
  const results = await Promise.allSettled([
    changeMemberRole(db, actor, "a", "owner", "ADMIN", a),
    changeMemberRole(db, other, "a", "other", "ADMIN", b),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    await admin.membership.count({
      where: { workspaceId: "a", role: "OWNER" },
    }),
  ).toBe(1);
});
it("does not let an admin promote owners or remove one", async () => {
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "other" } },
    data: { role: "ADMIN" },
  });
  const a = { ...actor, userId: "other" };
  await expect(changeMemberRole(db, a, "a", "viewer", "OWNER")).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(removeMember(db, a, "a", "owner")).rejects.toThrow("FORBIDDEN");
});
it("consumes step-up once and binds it to actor, action and workspace", async () => {
  const token = await issueStepUp(db, actor, "manage-owner", "a");
  await expect(
    changeMemberRole(db, actor, "b", "owner", "ADMIN", token),
  ).rejects.toThrow("STEP_UP_REQUIRED");
  await changeMemberRole(db, actor, "a", "other", "ADMIN", token);
  await expect(
    changeMemberRole(db, actor, "a", "other", "OWNER", token),
  ).rejects.toThrow("STEP_UP_REQUIRED");
});
it("refuses old first-factor and old second-factor timestamps", async () => {
  const stale = new Date(Date.now() - 3600000).toISOString();
  await expect(
    issueStepUp(
      db,
      { ...actor, authenticatedAt: stale, mfaAuthenticatedAt: stale },
      "manage-owner",
      "a",
    ),
  ).rejects.toThrow("FRESH_AUTH_REQUIRED");
});
it("requires fresh verified MFA for MFA-enabled actors", async () => {
  await expect(
    issueStepUp(
      db,
      { ...actor, mfaAuthenticatedAt: undefined },
      "manage-owner",
      "a",
    ),
  ).rejects.toThrow("FRESH_AUTH_REQUIRED");
});
it("discovers only own workspaces before selecting tenant context", async () => {
  const { listWorkspaces } = await import("../../packages/db/src/tenants");
  expect((await listWorkspaces(db, actor)).map((w) => w.id)).toEqual([
    "a",
    "b",
  ]);
  expect(
    (await listWorkspaces(db, { ...actor, userId: "viewer" })).map((w) => w.id),
  ).toEqual(["a"]);
});
it("creates a workspace with exactly one owning membership", async () => {
  const { createWorkspace } = await import("../../packages/db/src/tenants");
  const created = await createWorkspace(db, actor, "My launch");
  expect(
    await admin.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: created.id, userId: actor.userId },
      },
    }),
  ).toMatchObject({ role: "OWNER" });
});
it("requires a member in the same workspace before granting site access", async () => {
  const { grantSite } = await import("../../packages/db/src/tenants");
  await expect(grantSite(db, actor, "b", "b-site", "viewer")).rejects.toThrow(
    "NOT_FOUND",
  );
  await grantSite(db, actor, "a", "a-site", "other");
  expect(
    await admin.siteGrant.count({
      where: { workspaceId: "a", userId: "other" },
    }),
  ).toBe(1);
  await expect(
    grantSite(db, { ...actor, userId: "viewer" }, "a", "a-site", "other"),
  ).rejects.toThrow("FORBIDDEN");
});
it("does not count a suspended owner as a surviving active owner", async () => {
  await admin.productUser.update({
    where: { id: "other" },
    data: { suspended: true },
  });
  const token = await issueStepUp(db, actor, "manage-owner", "a");
  await expect(
    changeMemberRole(db, actor, "a", "owner", "ADMIN", token),
  ).rejects.toThrow("LAST_OWNER");
});
it("allows removing a suspended co-owner while the active owner remains", async () => {
  await admin.productUser.update({
    where: { id: "other" },
    data: { suspended: true },
  });
  const token = await issueStepUp(db, actor, "manage-owner", "a");
  await removeMember(db, actor, "a", "other", token);
  expect(
    await admin.membership.count({
      where: { workspaceId: "a", role: "OWNER", user: { suspended: false } },
    }),
  ).toBe(1);
});
