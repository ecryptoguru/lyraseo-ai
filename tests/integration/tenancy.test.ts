import { resetDatabase } from "../helpers/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  withWorkspace,
  authorizeSite,
} from "../../packages/db/src";
const admin = createDatabase(
  "postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/lyraseo_test",
);
const runtime = createDatabase(
  "postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/lyraseo_test",
);
beforeAll(async () => {
  await resetDatabase();
  await admin.productUser.createMany({
    data: [{ id: "owner" }, { id: "viewer" }, { id: "stranger" }],
  });
  await admin.workspace.createMany({
    data: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ],
  });
  await admin.membership.createMany({
    data: [
      { workspaceId: "a", userId: "owner", role: "OWNER" },
      { workspaceId: "a", userId: "viewer", role: "VIEWER" },
      { workspaceId: "b", userId: "stranger", role: "OWNER" },
    ],
  });
  await admin.site.createMany({
    data: [
      { id: "a-site", workspaceId: "a", origin: "https://example.com" },
      { id: "b-site", workspaceId: "b", origin: "https://other.com" },
    ],
  });
  await admin.siteGrant.create({
    data: { workspaceId: "a", siteId: "a-site", userId: "viewer" },
  });
});
afterAll(async () => {
  await admin.$disconnect();
  await runtime.$disconnect();
});
describe("real PostgreSQL isolation", () => {
  it("fails closed with no tenant context", async () =>
    expect(await runtime.site.findMany()).toEqual([]));
  it("restricts rows even without an application WHERE clause", async () => {
    const rows = await withWorkspace(runtime, "a", (tx) => tx.site.findMany());
    expect(rows.map((r) => r.id)).toEqual(["a-site"]);
  });
  it("does not leak context when a pooled connection is reused", async () => {
    await withWorkspace(runtime, "a", (tx) => tx.site.findMany());
    expect(await runtime.site.findMany()).toEqual([]);
    const b = await withWorkspace(runtime, "b", (tx) => tx.site.findMany());
    expect(b.map((r) => r.id)).toEqual(["b-site"]);
  });
  it("enforces viewer grants and denies writes", async () => {
    await expect(
      authorizeSite(runtime, {
        userId: "viewer",
        workspaceId: "a",
        siteId: "a-site",
        action: "read",
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorizeSite(runtime, {
        userId: "viewer",
        workspaceId: "a",
        siteId: "a-site",
        action: "run",
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("denies a nested site from another workspace", async () => {
    await expect(
      authorizeSite(runtime, {
        userId: "owner",
        workspaceId: "a",
        siteId: "b-site",
        action: "read",
      }),
    ).rejects.toThrow("NOT_FOUND");
  });
  it("prevents attaching another workspace member to a site", async () => {
    await expect(
      admin.siteGrant.create({
        data: { workspaceId: "a", siteId: "b-site", userId: "viewer" },
      }),
    ).rejects.toThrow();
  });
  it("revokes read access immediately after removal", async () => {
    await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
    await expect(
      authorizeSite(runtime, {
        userId: "viewer",
        workspaceId: "a",
        siteId: "a-site",
        action: "read",
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
});

it("denies the legacy authorization helper access to deleted sites and workspaces", async () => {
  const input = {
    userId: "owner",
    workspaceId: "a",
    siteId: "a-site",
    action: "read" as const,
  };
  await admin.site.update({
    where: { id: "a-site" },
    data: { deletedAt: new Date() },
  });
  await expect(authorizeSite(runtime, input)).rejects.toThrow("NOT_FOUND");
  await admin.site.update({
    where: { id: "a-site" },
    data: { deletedAt: null },
  });
  await admin.workspace.update({
    where: { id: "a" },
    data: { deletedAt: new Date() },
  });
  await expect(authorizeSite(runtime, input)).rejects.toThrow("FORBIDDEN");
});
