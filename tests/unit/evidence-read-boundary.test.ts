import { expect, it } from "vitest";
import type { PrismaClient } from "../../packages/db/generated/client";
import { withEvidenceRead } from "../../packages/db/src/context";
function fixture() {
  const tx = {
    productUser: {
      findUnique: async () => ({
        id: "u",
        suspended: false,
        securityVersion: 0,
      }),
    },
    membership: { findUnique: async () => ({ role: "OWNER" }) },
    workspace: { findUnique: async () => ({ deletedAt: null }) },
    site: { findUnique: async () => ({ deletedAt: null }) },
    $queryRaw: async () => [],
    $executeRaw: async (strings: TemplateStringsArray) => {
      if (strings.join("").startsWith("RELEASE SAVEPOINT"))
        throw Error("RELEASE_FAILED");
      return 0;
    },
  };
  const db = {
    $transaction: async (work: (value: unknown) => unknown) => work(tx),
  } as unknown as PrismaClient;
  const actor = {
    userId: "u",
    sessionId: "session",
    securityVersion: 0,
    authenticatedAt: new Date().toISOString(),
    mfaVerified: true,
    authProvider: "supabase" as const,
  };
  return { db, actor };
}
it("preserves the original failed-read error if releasing its rolled-back savepoint also fails", async () => {
  const { db, actor } = fixture(),
    original = Error("ORIGINAL_READ_FAILURE");
  await expect(
    withEvidenceRead(
      db,
      actor,
      { workspaceId: "w", siteId: "s" },
      "read",
      undefined,
      async () => {
        throw original;
      },
    ),
  ).rejects.toBe(original);
});
it("does not return buffered evidence when releasing a successful read boundary fails", async () => {
  const { db, actor } = fixture();
  await expect(
    withEvidenceRead(
      db,
      actor,
      { workspaceId: "w", siteId: "s" },
      "read",
      undefined,
      async () => ({ private: "WITHHELD" }),
    ),
  ).rejects.toThrow("RELEASE_FAILED");
});
