import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  previewEditorialAssistance,
  createContentDraft,
  saveContentDraft,
  readContentDrafts,
  captureEvidenceReport,
  storeEvidenceReport,
  readEvidenceReports,
} from "../../packages/db/src/content";
import {
  emptySiteContext,
  reviewSiteContext,
} from "../../packages/db/src/sites";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" };
const selection = {
  kind: "brief" as const,
  auditIds: [],
  searchSnapshotIds: ["search"],
};
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  await admin.searchSnapshot.create({
    data: {
      id: "search",
      ...scope,
      property: "https://example.com/",
      shape: "page",
      status: "partial",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      rows: [{ keys: ["https://example.com/"], clicks: 3, impressions: 10 }],
    },
  });
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("requires reviewed same-site context, previews without writes and preserves the original context revision after edits", async () => {
  await expect(
    previewEditorialAssistance(db, actor, scope, selection),
  ).rejects.toThrow("REVIEWED_CONTEXT_REQUIRED");
  const context = await reviewSiteContext(db, actor, scope, 0, {
    ...emptySiteContext(),
    brandName: "Acme",
    audience: "Founders",
  });
  const preview = await previewEditorialAssistance(db, actor, scope, selection);
  expect(preview.context).toEqual({ id: context.id, revision: 1 });
  expect(preview.content.citations).toContainEqual({
    sourceId: `context:${context.id}:v1`,
    note: expect.stringContaining("Reviewed site context revision 1"),
  });
  expect(preview.content.body).toContain(
    "Available clicks: 3; impressions: 10",
  );
  expect(await admin.contentDraft.count()).toBe(0);
  expect(await admin.operation.count()).toBe(0);
  const saved = await createContentDraft(db, actor, scope, {
    ...selection,
    ...preview.content,
    body: preview.content.body + "\nReviewed by editor",
    expectedContextRevisionId: preview.context.id,
  });
  await reviewSiteContext(db, actor, scope, 1, {
    ...emptySiteContext(),
    brandName: "New name",
  });
  await saveContentDraft(db, actor, scope, {
    ...preview.content,
    draftId: saved.id,
    expectedRevision: 1,
    body: preview.content.body + "\nReviewed by editor; later revision",
  });
  const [reopened] = await readContentDrafts(db, actor, scope, saved.id);
  expect(reopened.snapshot.context).toEqual({ id: context.id, revision: 1 });
  expect(reopened.history).toHaveLength(2);
  expect(reopened.history[0].content).toMatchObject({
    citations: expect.arrayContaining([
      expect.objectContaining({ sourceId: `context:${context.id}:v1` }),
    ]),
  });
  expect(reopened.history[0].content).toMatchObject({
    body: expect.stringContaining("Reviewed by editor"),
  });
  await expect(
    createContentDraft(db, actor, scope, {
      ...selection,
      ...preview.content,
      expectedContextRevisionId: preview.context.id,
    }),
  ).rejects.toThrow("CONTEXT_REVISION_CONFLICT");
  expect(await admin.contentDraft.count()).toBe(1);
});
it("denies viewers, forged cross-site sources, expired sources and revoked editor access", async () => {
  await reviewSiteContext(db, actor, scope, 0, {
    ...emptySiteContext(),
    brandName: "Acme",
  });
  await expect(
    previewEditorialAssistance(
      db,
      { ...actor, userId: "viewer" },
      scope,
      selection,
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    previewEditorialAssistance(
      db,
      actor,
      { workspaceId: "b", siteId: "b-site" },
      selection,
    ),
  ).rejects.toThrow("INVALID_SOURCE");
  await admin.searchSnapshot.update({
    where: { id: "search" },
    data: { importedAt: new Date(0) },
  });
  await expect(
    previewEditorialAssistance(db, actor, scope, selection),
  ).rejects.toThrow("SOURCE_EXPIRED");
  await admin.membership.delete({
    where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
  });
  await expect(
    previewEditorialAssistance(db, actor, scope, selection),
  ).rejects.toThrow("FORBIDDEN");
  expect(await admin.contentDraft.count()).toBe(0);
});

it("freezes all three private report variants with their context/window and writes actual PDF/CSV acceptance artifacts", async () => {
  const { renderEvidenceReport } =
    await import("../../apps/lyraseo-web/src/server/editorial/reports");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const context = await reviewSiteContext(db, actor, scope, 0, {
    ...emptySiteContext(),
    brandName: "Acme",
  });
  for (const reportTemplate of ["founder", "editor", "agency"] as const) {
    const snapshot = await captureEvidenceReport(db, actor, scope, {
      ...selection,
      reportTemplate,
    });
    const saved = await storeEvidenceReport(db, actor, scope, {
      title: `${reportTemplate} acceptance`,
      snapshot,
      render: renderEvidenceReport,
    });
    const download = await readEvidenceReports(
      db,
      actor,
      scope,
      saved.id,
      "csv",
    );
    expect(download.csv).toContain(reportTemplate);
    expect(download.csv).toContain("2026-01-01");
    expect(download.csv).toContain("partial");
    expect(download.csv).toContain(context.id);
    if (process.env.LYRA_EDITORIAL_ARTIFACT_DIR) {
      const path = process.env.LYRA_EDITORIAL_ARTIFACT_DIR;
      await mkdir(path, { recursive: true });
      await writeFile(`${path}/${reportTemplate}-acceptance.csv`, download.csv);
      const pdf = await readEvidenceReports(db, actor, scope, saved.id, "pdf");
      await writeFile(`${path}/${reportTemplate}-acceptance.pdf`, pdf.pdf);
      await writeFile(
        `${path}/${reportTemplate}-snapshot.json`,
        JSON.stringify(snapshot, null, 2),
      );
    }
  }
  expect(await admin.evidenceReport.count()).toBe(3);
  await reviewSiteContext(db, actor, scope, 1, {
    ...emptySiteContext(),
    brandName: "Changed",
  });
  const snapshots = await admin.evidenceReport.findMany({
    select: { snapshot: true },
  });
  for (const row of snapshots)
    expect(row.snapshot).toMatchObject({
      context: { id: context.id, revision: 1 },
    });
});

it("rechecks current actor after a real site-lock wait before returning template evidence", async () => {
  await reviewSiteContext(db, actor, scope, 0, {
    ...emptySiteContext(),
    brandName: "Acme",
  });
  let preview!: Promise<unknown>;
  let result!: Promise<{ value?: unknown; error?: unknown }>;
  await admin.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${scope.siteId} FOR UPDATE`;
    preview = previewEditorialAssistance(db, actor, scope, selection);
    result = preview.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
      const [state] = await tx.$queryRaw<
        Array<{ blocked: boolean }>
      >`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%Site%') AS blocked`;
      if (state.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await tx.productUser.update({
      where: { id: actor.userId },
      data: { securityVersion: 1 },
    });
  });
  const outcome = await result;
  expect(outcome.error).toBeInstanceOf(Error);
  expect((outcome.error as Error).message).toBe("FORBIDDEN");
  expect(await admin.contentDraft.count()).toBe(0);
});

it("rejects changed same-ID source facts rather than relabelling a prepared template with new evidence", async () => {
  await reviewSiteContext(db, actor, scope, 0, {
    ...emptySiteContext(),
    brandName: "Acme",
  });
  const prepared = await previewEditorialAssistance(
    db,
    actor,
    scope,
    selection,
  );
  expect(prepared).toHaveProperty(
    "evidenceFingerprint",
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  await admin.searchSnapshot.update({
    where: { id: "search" },
    data: {
      rows: [{ keys: ["https://example.com/"], clicks: 9, impressions: 20 }],
    },
  });
  await expect(
    createContentDraft(db, actor, scope, {
      ...selection,
      ...prepared.content,
      expectedContextRevisionId: prepared.context.id,
      expectedEvidenceFingerprint: (
        prepared as unknown as { evidenceFingerprint: string }
      ).evidenceFingerprint,
    }),
  ).rejects.toThrow("SOURCE_CHANGED");
  expect(await admin.contentDraft.count()).toBe(0);
});
