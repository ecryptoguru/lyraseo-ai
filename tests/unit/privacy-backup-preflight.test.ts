import { expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: calls.spawn }));
vi.mock("../../scripts/lib/privacy-bootstrap.mjs", () => ({
  preparePrivacyMigrationPlan: () => {
    throw Error("PRIVACY_MIGRATION_SET_UNQUALIFIED");
  },
  selectPrivacyBootstrap: () => {
    throw Error("PRIVACY_MIGRATION_SET_UNQUALIFIED");
  },
}));
import { createLocalBackupLab } from "../../scripts/lib/full-backup.mjs";

it("rejects an unqualified backup plan before inspecting or opening a database", async () => {
  await expect(createLocalBackupLab()).rejects.toThrow(
    "PRIVACY_MIGRATION_SET_UNQUALIFIED",
  );
  expect(calls.spawn).not.toHaveBeenCalled();
});
