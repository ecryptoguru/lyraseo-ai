import { listReportBrandingChoices } from "../../packages/db/src/branding";
/** Requires the real additive agency migration31. Never substitutes fixture DDL or skips absent tables. */
import { afterAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createDatabase } from "../../packages/db/src";
import {
  captureEvidenceReport,
  storeEvidenceReport,
  previewEvidenceReport,
  readEvidenceReports,
} from "../../packages/db/src/content";
import { renderEvidenceReport } from "../../apps/lyraseo-web/src/server/editorial/reports";
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
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgSPsPAAHPAWYvlgrbAAAAAElFTkSuQmCC",
  "base64",
);
const hash = createHash("sha256").update(bytes).digest("hex");
async function brand(workspaceId: string, revision: number, name: string) {
  await admin.$executeRaw`INSERT INTO "WorkspaceBrandingRevision"(id,"workspaceId",revision,"displayName","logoBytes","logoSha256",mime,width,height,"createdBy") VALUES (${workspaceId + "-branding-" + revision},${workspaceId},${revision},${name},${bytes},${hash},'image/png',1,1,${actor.userId})`;
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  await reviewSiteContext(db, actor, scope, 0, {
    ...emptySiteContext(),
    brandName: "Acme",
  });
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
  await brand("a", 1, "Original agency");
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
const selection = {
  auditIds: [],
  searchSnapshotIds: ["search"],
  reportTemplate: "agency" as const,
  brandingRevision: 1,
};
it("captures authorized canonical branding and retains the exact historical bytes after branding changes", async () => {
  expect(
    await db.$queryRaw`SELECT id FROM "WorkspaceBrandingRevision"`,
  ).toEqual([]);
  expect(await listReportBrandingChoices(db, actor, scope)).toEqual([
    { revision: 1, displayName: "Original agency" },
  ]);
  const snapshot = await captureEvidenceReport(db, actor, scope, selection);
  expect(snapshot.reportBranding).toMatchObject({
    brandingRevisionId: "a-branding-1",
    revision: 1,
    displayName: "Original agency",
    logo: { base64: bytes.toString("base64"), sha256: hash },
  });
  const saved = await storeEvidenceReport(db, actor, scope, {
    title: "Branded agency delivery",
    snapshot,
    render: renderEvidenceReport,
  });
  await brand("a", 2, "Changed agency");
  const reopened = await previewEvidenceReport(db, actor, scope, saved.id);
  expect(reopened.snapshot.reportBranding).toEqual(snapshot.reportBranding);
  const csv = await readEvidenceReports(db, actor, scope, saved.id, "csv");
  expect(csv.csv).toContain("Original agency");
  expect(csv.csv).not.toContain("Changed agency");
  expect(csv.csv).toContain(hash);
  const pdf = await readEvidenceReports(db, actor, scope, saved.id, "pdf");
  expect(Buffer.from(pdf.pdf).subarray(0, 5).toString()).toBe("%PDF-");
  if (process.env.LYRA_EDITORIAL_ARTIFACT_DIR) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = process.env.LYRA_EDITORIAL_ARTIFACT_DIR;
    await mkdir(path, { recursive: true });
    await writeFile(`${path}/branded-agency-acceptance.pdf`, pdf.pdf);
    await writeFile(`${path}/branded-agency-acceptance.csv`, csv.csv);
    await writeFile(
      `${path}/branded-agency-snapshot.json`,
      JSON.stringify(snapshot, null, 2),
    );
  }
  await expect(
    readEvidenceReports(
      db,
      actor,
      { workspaceId: "b", siteId: "b-site" },
      saved.id,
      "pdf",
    ),
  ).rejects.toThrow("NOT_FOUND");
});
it("rejects tampered branding before rendering and cannot use another workspace's revision", async () => {
  const snapshot = await captureEvidenceReport(db, actor, scope, selection);
  let renders = 0;
  await expect(
    storeEvidenceReport(db, actor, scope, {
      title: "Tamper",
      snapshot: {
        ...snapshot,
        reportBranding: {
          ...snapshot.reportBranding!,
          displayName: "Forged name",
        },
      },
      render: async () => {
        renders++;
        return { pdf: new Uint8Array(), csv: "" };
      },
    }),
  ).rejects.toThrow("SOURCE_CHANGED");
  expect(renders).toBe(0);
  await brand("b", 2, "Foreign agency");
  await expect(
    captureEvidenceReport(db, actor, scope, {
      ...selection,
      brandingRevision: 2,
    }),
  ).rejects.toThrow("INVALID_BRANDING");
  await expect(
    captureEvidenceReport(db, { ...actor, userId: "viewer" }, scope, selection),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    listReportBrandingChoices(db, { ...actor, userId: "viewer" }, scope),
  ).rejects.toThrow("FORBIDDEN");
  await admin.productUser.create({ data: { id: "editor" } });
  await admin.membership.create({
    data: { workspaceId: "a", userId: "editor", role: "EDITOR" },
  });
  await admin.siteGrant.create({
    data: { workspaceId: "a", siteId: "a-site", userId: "editor" },
  });
  expect(
    await listReportBrandingChoices(db, { ...actor, userId: "editor" }, scope),
  ).toEqual([{ revision: 1, displayName: "Original agency" }]);
  await admin.siteGrant.delete({
    where: {
      workspaceId_siteId_userId: {
        workspaceId: "a",
        siteId: "a-site",
        userId: "editor",
      },
    },
  });
  await expect(
    listReportBrandingChoices(db, { ...actor, userId: "editor" }, scope),
  ).rejects.toThrow("FORBIDDEN");
  expect(await admin.evidenceReport.count()).toBe(0);
});
