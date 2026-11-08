import "server-only";
import { createDatabase } from "@lyraseo/db";
import { withActor, requireFreshAuthentication } from "@lyraseo/db/context";
import { database, resolveActor } from "@/server/auth/server";
let staff: ReturnType<typeof createDatabase> | undefined;
export function staffDatabase() {
  const url = process.env.LYRA_STAFF_DATABASE_URL;
  if (!url || process.env.LYRA_STAFF_ADMIN_ENABLED !== "true")
    throw new Error("STAFF_UNAVAILABLE");
  // Do not let an accidentally broad product/owner URL become a staff executor.
  if (new URL(url).username !== "lyraseo_staff_executor")
    throw new Error("STAFF_UNAVAILABLE");
  return (staff ??= createDatabase(url));
}
/** Every admin entry resolves a real browser actor; bearer/service identities cannot enter. */
export async function requireStaffFor(action: "read" | "change") {
  const actor = await resolveActor();
  if (!actor.mfaVerified || !actor.mfaAuthenticatedAt)
    throw new Error("STAFF_REQUIRED");
  if (action === "change") requireFreshAuthentication(actor);
  const grant = await withActor(database(), actor, "", (tx) =>
    tx.staffGrant.findUnique({ where: { userId: actor.userId } }),
  );
  if (!grant?.enabled) throw new Error("STAFF_REQUIRED");
  return actor;
}
