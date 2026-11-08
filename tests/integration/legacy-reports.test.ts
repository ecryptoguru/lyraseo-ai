import { afterAll, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  readEvidenceReports,
  previewEvidenceReport,
} from "../../packages/db/src/content";
import { projectSnapshot } from "../../packages/db/src/saved-evidence";
import type { Actor } from "../../packages/db/src/context";
const url = process.env.LYRA_REPORT_GATE_URL;
if (
  url &&
  !/^postgresql:\/\/lyraseo_runtime:local_runtime_only@127\.0\.0\.1:54329\/lyraseo_report_populated_[a-f0-9]{12}$/.test(
    url,
  )
)
  throw new Error("UNSAFE_REPORT_GATE_DATABASE");
const db = url ? createDatabase(url) : undefined;
const admin = url
  ? createDatabase(
      url.replace(
        "lyraseo_runtime:local_runtime_only",
        "postgres:lyraseo_local_only",
      ),
    )
  : undefined;
afterAll(async () => {
  await db?.$disconnect();
  await admin?.$disconnect();
});
const actor: Actor = {
  userId: "owner",
  sessionId: "fixture-session",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: false,
  authProvider: "supabase",
};
const scope = { workspaceId: "w", siteId: "s" };
it.skipIf(!db)(
  "keeps withdrawn actual originals blocked while returning bounded read-only preview and per-format state",
  async () => {
    const listed = await readEvidenceReports(db!, actor, scope);
    expect(Array.isArray(listed)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("FULL_SOURCE_MARKER");
    const legacy = Array.isArray(listed)
      ? listed.find((r) => r.id === "legacy")
      : undefined;
    expect(legacy?.formatStatus).toEqual({
      pdf: "withdrawn",
      csv: "withdrawn",
    });
    const preview = await previewEvidenceReport(db!, actor, scope, "legacy");
    expect(JSON.stringify(preview)).not.toContain("FULL_SOURCE_MARKER");
    expect(preview.formatStatus).toEqual({
      pdf: "withdrawn",
      csv: "withdrawn",
    });
    expect(preview.evidenceFormat).toBeNull();
    for (const format of ["pdf", "csv"] as const)
      await expect(
        readEvidenceReports(db!, actor, scope, "legacy", format),
      ).rejects.toThrow("REPORT_WITHDRAWN");
    await expect(
      previewEvidenceReport(
        db!,
        { ...actor, userId: "viewer" },
        scope,
        "legacy",
      ),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      previewEvidenceReport(
        db!,
        actor,
        { ...scope, siteId: "other" },
        "legacy",
      ),
    ).rejects.toThrow("NOT_FOUND");
  },
);

it.skipIf(!db)(
  "preserves saved-v2 preview and exact persisted PDF/CSV bytes through the narrow locked export",
  async () => {
    const snapshot = JSON.parse(
      JSON.stringify(
        projectSnapshot({
          format: "saved-evidence-v2",
          scope,
          capturedAt: "2020-01-01T00:00:00.000Z",
          sources: [],
        }),
      ),
    );
    await admin!.evidenceReport.create({
      data: {
        id: "service-v2",
        ...scope,
        title: "Deliberate minimal saved fixture",
        evidenceFormat: "saved-evidence-v2",
        snapshot,
        pdf: Buffer.from("%PDF fixture bytes"),
        csv: '"saved,cell","authored quote"',
      },
    });
    const runtimeStored = await db!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id','w',true)`;
      return tx.evidenceReport.create({
        data: {
          id: "runtime-service-v2",
          ...scope,
          title: "Runtime generated-key parity",
          evidenceFormat: "saved-evidence-v2",
          snapshot,
          pdf: Buffer.from("%PDF runtime"),
          csv: "runtime csv",
        },
        select: { id: true, title: true, createdAt: true },
      });
    });
    expect(runtimeStored.id).toBe("runtime-service-v2");
    const [generated] = await admin!.$queryRaw<
      Array<{ valid: boolean }>
    >`SELECT "identifierKey"=encode(sha256(convert_to(id,'UTF8')),'hex') AS valid FROM "EvidenceReport" WHERE id='runtime-service-v2'`;
    expect(generated?.valid).toBe(true);
    const preview = await previewEvidenceReport(
      db!,
      actor,
      scope,
      "service-v2",
    );
    expect(preview.downloadStatus).toBe("available");
    expect(preview.snapshot).toEqual(snapshot);
    const result = await readEvidenceReports(db!, actor, scope, "service-v2");
    if (Array.isArray(result)) throw new Error("UNEXPECTED_LIST");
    expect(Buffer.from(result.pdf!).toString()).toBe("%PDF fixture bytes");
    expect(result.csv).toBe('"saved,cell","authored quote"');
  },
);
