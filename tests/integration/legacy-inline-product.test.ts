import { afterAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  readAuditRun,
  readAuditSource,
  compareAuditRuns,
} from "../../packages/db/src/audits";
import {
  readContentDrafts,
  captureEditorialEvidence,
  setRevisionPin,
} from "../../packages/db/src/content";
import { withEvidenceRead } from "../../packages/db/src/context";

const name = process.env.LYRA_INLINE_TEST_DB;
if (name && !/^lyraseo_inline_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_INLINE_DATABASE_REQUIRED");
const url = `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${name ?? "lyraseo_inline_invalid"}`;
const runtime = createDatabase(url),
  admin = createDatabase(
    url.replace(
      "lyraseo_runtime:local_runtime_only",
      "postgres:lyraseo_local_only",
    ),
  );
const actor = {
  userId: "inline-owner",
  sessionId: "inline-session",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  authProvider: "supabase" as const,
};
const scope = { workspaceId: "inline-w", siteId: "inline-s" };
afterAll(async () => {
  await runtime.$disconnect();
  await admin.$disconnect();
});
describe.skipIf(!name)("local legacy inline product reads", () => {
  it("withholds ambiguous evaluation and preserves safe page receipt facts", async () => {
    const row = await readAuditRun(runtime, actor, {
      ...scope,
      auditId: "due",
    });
    expect(row.evaluation).toBeNull();
    expect(row.evidenceStatus).toBe("legacy-lineage-withheld");
    expect(JSON.stringify(row)).not.toMatch(
      /RAW_HTML|FROZEN_SOURCE_DIAGNOSTIC|EVIDENCE_RESIDUAL_MARKER|ANCHOR_RESIDUAL/,
    );
    expect(row.pages[0]?.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps authored history and pin actions available while withholding snapshot", async () => {
    const [draft] = await readContentDrafts(
      runtime,
      actor,
      scope,
      "legacy-draft",
    );
    expect(draft?.evidenceStatus).toBe("legacy-lineage-withheld");
    expect(draft?.snapshot).toBeUndefined();
    expect(draft?.history[0]?.content).toEqual({
      body: "AUTHORED_BODY",
      citations: ["INTENTIONAL_QUOTE"],
    });
    await setRevisionPin(runtime, actor, scope, "legacy-draft", 1, true);
    expect(JSON.stringify(draft)).not.toContain("SNAPSHOT_RAW_COPY");
  });
  it("does not let frozen comparison or capture bypass lineage withholding", async () => {
    await expect(
      compareAuditRuns(runtime, actor, { ...scope, auditId: "due" }, "fresh"),
    ).rejects.toThrow("LEGACY_EVIDENCE_WITHHELD");
    await expect(
      captureEditorialEvidence(runtime, actor, scope, {
        auditIds: ["due"],
        searchSnapshotIds: [],
      }),
    ).rejects.toThrow("LEGACY_EVIDENCE_WITHHELD");
  });
  it("preserves current legacy double-read source bytes and rejects due copies", async () => {
    const bytes = await readAuditSource(
      runtime,
      actor,
      { ...scope, auditId: "fresh" },
      "https://example.com/",
      async () => actor,
    );
    expect(Buffer.from(bytes).toString()).toBe("<html>RAW_HTML_fresh</html>");
    await expect(
      readAuditSource(
        runtime,
        actor,
        { ...scope, auditId: "due" },
        "https://example.com/",
        async () => actor,
      ),
    ).rejects.toThrow("SOURCE_EXPIRED");
  });
  it("rechecks application actor authority before returning a constructed payload", async () => {
    try {
      await expect(
        withEvidenceRead(runtime, actor, scope, "read", undefined, async () => {
          await admin.productUser.update({
            where: { id: actor.userId },
            data: { securityVersion: 1 },
          });
          return "SHOULD_NEVER_RETURN";
        }),
      ).rejects.toThrow("FORBIDDEN");
    } finally {
      await admin.productUser.update({
        where: { id: actor.userId },
        data: { securityVersion: 0 },
      });
    }
  });
});
