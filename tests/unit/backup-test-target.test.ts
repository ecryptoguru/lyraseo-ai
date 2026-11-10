import { expect, it } from "vitest";
import { backupTestTarget } from "../../scripts/lib/backup-test-target.mjs";

it("selects an explicitly named disposable loopback cluster without falling back to the shared instance", () => {
  expect(
    backupTestTarget({
      LYRA_BACKUP_TEST_CONTAINER: "lyraseo-disposable-20261107-123bf4ff",
      LYRA_BACKUP_TEST_PORT: "54335",
      LYRA_BACKUP_TEST_ADMIN_PASSWORD: "owned-test-only",
    }),
  ).toEqual({
    container: "lyraseo-disposable-20261107-123bf4ff",
    port: 54335,
    password: "owned-test-only",
  });
});

it.each([
  { LYRA_BACKUP_TEST_PORT: "54335" },
  {
    LYRA_BACKUP_TEST_CONTAINER: "customer-postgres",
    LYRA_BACKUP_TEST_PORT: "54335",
    LYRA_BACKUP_TEST_ADMIN_PASSWORD: "test",
  },
  { LYRA_BACKUP_TEST_CONTAINER: "lyraseo-disposable-20261107-123bf4ff" },
  {
    LYRA_BACKUP_TEST_CONTAINER: "lyraseo-disposable-20261107-123bf4ff",
    LYRA_BACKUP_TEST_PORT: "https://remote",
    LYRA_BACKUP_TEST_ADMIN_PASSWORD: "test",
  },
  {
    LYRA_BACKUP_TEST_CONTAINER: "lyraseo-disposable-20261107-123bf4ff",
    LYRA_BACKUP_TEST_PORT: "70000",
    LYRA_BACKUP_TEST_ADMIN_PASSWORD: "test",
  },
])(
  "rejects unsafe or incomplete disposable configuration instead of changing targets",
  (env) => {
    expect(() => backupTestTarget(env)).toThrow("UNSAFE_BACKUP_TEST_TARGET");
  },
);

it("retains the fixed CI target only when no override was requested", () => {
  expect(backupTestTarget({})).toEqual({
    container: "lyraseo-phase1-postgres",
    port: 54329,
    password: "lyraseo_local_only",
  });
});
