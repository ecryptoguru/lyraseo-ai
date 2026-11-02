import { beforeAll, expect, it } from "vitest";
// @ts-expect-error Plain Node operator script, intentionally independent of the app bundle.
import { checkDatabase } from "../../scripts/auth-preflight.mjs";
import {
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
beforeAll(async () => {
  await resetDatabase();
  await seedTenants();
});
it("validates the real restricted runtime and hidden tenant rows with read-only queries", async () => {
  await expect(checkDatabase(runtimeUrl, false)).resolves.toBeUndefined();
});
it("rejects an owner/superuser credential as an application role", async () => {
  await expect(checkDatabase(adminUrl, false)).rejects.toThrow(
    "excessive administrative privileges",
  );
});
