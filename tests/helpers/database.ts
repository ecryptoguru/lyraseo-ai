import { createDatabase } from "../../packages/db/src";
// Focused migration work can reserve an independently created local fixture DB.
const ownedName = process.env.LYRA_TEST_DB_NAME;
if (
  ownedName &&
  !/^(?:lyraseo_p2a[12]|lyraseo_origin)_[a-f0-9]{12}$|^lyraseo_expiry_[a-f0-9]{8,12}$/.test(
    ownedName,
  )
)
  throw Error("INVALID_LOCAL_TEST_DATABASE");
const databaseName = ownedName ?? "lyraseo_test";
export const adminUrl = `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${databaseName}`;
export const runtimeUrl = `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${databaseName}`;
export async function resetDatabase() {
  const db = createDatabase(adminUrl);
  try {
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE lyraseo_origin.blob_store_binding,lyraseo_origin.store_namespace,lyraseo_origin.source_store_key,lyraseo_origin.store_registration,"ProductUser", "Workspace", "StaffGrant", "StepUpGrant", "BudgetPeriod", "ProductSession" CASCADE',
    );
  } finally {
    await db.$disconnect();
  }
}
export async function seedTenants() {
  const db = createDatabase(adminUrl);
  try {
    await db.productUser.createMany({
      data: [{ id: "owner" }, { id: "other" }, { id: "viewer" }],
    });
    await db.workspace.createMany({
      data: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
    });
    await db.membership.createMany({
      data: [
        { workspaceId: "a", userId: "owner", role: "OWNER" },
        { workspaceId: "a", userId: "other", role: "OWNER" },
        { workspaceId: "a", userId: "viewer", role: "VIEWER" },
        { workspaceId: "b", userId: "owner", role: "OWNER" },
      ],
    });
    await db.site.createMany({
      data: [
        {
          id: "a-site",
          workspaceId: "a",
          origin: "https://example.com",
          verifiedAt: new Date(),
        },
        {
          id: "b-site",
          workspaceId: "b",
          origin: "https://other.com",
          verifiedAt: new Date(),
        },
      ],
    });
    await db.siteGrant.create({
      data: { workspaceId: "a", siteId: "a-site", userId: "viewer" },
    });
  } finally {
    await db.$disconnect();
  }
}
export const actor = {
  userId: "owner",
  sessionId: "test-session",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  mfaAuthenticatedAt: new Date().toISOString(),
  authProvider: "supabase" as const,
};
