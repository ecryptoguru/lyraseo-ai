import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { createDatabase } from "../../packages/db/src";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import { crawlerSite } from "../fixtures/crawler-site";
import type { EvidenceSnapshot } from "../../packages/db/src/content";
import { emptySiteContext } from "../../packages/db/src/sites";
const seams = vi.hoisted(() => ({
  db: null as unknown,
  actor: null as unknown,
  transport: null as
    null | import("../../packages/visibility/src/acquisition").PublicTransport,
}));
vi.mock("@/server/auth/server", () => ({
  database: () => seams.db,
  resolveActor: async () => seams.actor,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://localhost:3000" }),
}));
vi.mock("@/server/acquisition/transport", () => ({
  publicHttpsTransport: (url: string, signal: AbortSignal) =>
    seams.transport!(url, signal),
}));
import * as audits from "../../apps/lyraseo-web/src/app/api/audits/route";
import * as reports from "../../apps/lyraseo-web/src/app/api/reports/route";
import * as sites from "../../apps/lyraseo-web/src/app/api/sites/route";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" };
const post = (body: object) =>
  new Request("http://localhost:3000/api", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...scope, ...body }),
  });
const get = (query: string) =>
  new Request(`http://localhost:3000/api?workspaceId=a&siteId=a-site${query}`);
async function json(response: Response, status = 200) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  seams.db = db;
  seams.actor = actor;
  vi.stubEnv("LYRA_LOCAL_RAW_AUDITS", "true");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await admin.$disconnect();
});
it("freezes a real HTTP fix and unreadable D01 in authorized immutable comparison report handler downloads", async () => {
  const site = await crawlerSite();
  seams.transport = site.transport;
  const manifest = [
    "https://example.com/",
    "https://example.com/missing",
    "https://example.com/unreadable",
  ];
  const run = async (key: string) => {
    const created = await json(
      await audits.POST(
        post({ action: "create", idempotencyKey: key, manifest }),
      ),
      201,
    );
    for (const _ of manifest)
      await json(
        await audits.POST(post({ action: "step", auditId: created.id })),
      );
    return json(await audits.GET(get(`&auditId=${created.id}`)));
  };
  try {
    const before = await run("comparison-before");
    await json(
      await audits.POST(
        post({
          action: "review",
          auditId: before.id,
          ruleId: "D01",
          scopeKey: manifest[1],
          disposition: "REVIEWED",
          reason: "Observed defect; review is not a fix",
        }),
      ),
    );
    site.fix();
    const after = await run("comparison-after");
    const input = {
      title: "Controlled before and after",
      auditIds: [before.id, after.id],
      searchSnapshotIds: [],
      comparison: { beforeAuditId: before.id, afterAuditId: after.id },
    };
    const report = await json(await reports.POST(post(input)), 201);
    const stored = await admin.evidenceReport.findUniqueOrThrow({
      where: { id: report.id },
    });
    const snapshot = stored.snapshot as unknown as EvidenceSnapshot;
    expect(snapshot.comparison).toMatchObject({
      before: {
        auditId: before.id,
        manifest,
        methodologyVersion: "readiness-v2",
        profile: "LOCAL_RAW_V1",
        createdAt: before.createdAt,
      },
      after: { auditId: after.id, createdAt: after.createdAt },
      result: { scoreDelta: null },
    });
    const uiComparison = await json(
      await audits.GET(get(`&auditId=${after.id}&before=${before.id}`)),
    );
    const { profileComparable: _profileComparable, ...uiResult } = uiComparison;
    expect(snapshot.comparison!.result).toEqual(uiResult);
    for (const source of snapshot.sources)
      expect(
        (source.data as { evaluation: { score: unknown } }).evaluation.score,
      ).toBeNull();
    expect(snapshot.comparison!.result.resolved).toContainEqual(
      expect.objectContaining({
        ruleId: "D01",
        scopeKey: manifest[1],
        outcome: "FAIL",
        evidenceRefs: expect.any(Array),
      }),
    );
    expect(snapshot.comparison!.result.unevaluated).toContainEqual(
      expect.objectContaining({
        ruleId: "D01",
        scopeKey: manifest[2],
        outcome: "UNKNOWN",
      }),
    );
    const fetchBytes = async (format: string) => {
      const response = await reports.GET(
        get(`&reportId=${report.id}&format=${format}`),
      );
      expect(response.status).toBe(200);
      return Buffer.from(await response.arrayBuffer());
    };
    const pdf = await fetchBytes("pdf"),
      csv = await fetchBytes("csv");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(csv.toString()).toContain("Immutable audit comparison");
    expect(csv.toString()).toContain(before.createdAt);
    expect(csv.toString()).toContain("receipt");
    for (const comparison of [
      { beforeAuditId: before.id, afterAuditId: before.id },
      { beforeAuditId: after.id, afterAuditId: before.id },
      { beforeAuditId: "missing", afterAuditId: after.id },
    ])
      await json(await reports.POST(post({ ...input, comparison })), 409);
    await json(
      await reports.POST(post({ ...input, auditIds: [before.id] })),
      409,
    );
    await json(
      await reports.POST(
        post({ ...input, auditIds: [before.id, after.id, before.id] }),
      ),
      409,
    );
    // A valid audit on another site is indistinguishable from an unknown ID.
    const foreign = await json(
      await audits.POST(
        post({
          action: "create",
          workspaceId: "b",
          siteId: "b-site",
          manifest: ["https://other.com/"],
          idempotencyKey: "foreign",
        }),
      ),
      201,
    );
    await json(
      await audits.POST(
        post({
          action: "step",
          workspaceId: "b",
          siteId: "b-site",
          auditId: foreign.id,
        }),
      ),
    );
    const afterForeignCapture = site.requests.length;
    await json(
      await reports.POST(
        post({
          ...input,
          auditIds: [before.id, foreign.id],
          comparison: { beforeAuditId: before.id, afterAuditId: foreign.id },
        }),
      ),
      409,
    );
    expect(site.requests).toHaveLength(afterForeignCapture);
    await json(
      await sites.POST(
        post({
          action: "context",
          expectedRevision: 0,
          content: {
            ...emptySiteContext(),
            brandName: "New context after report",
          },
        }),
      ),
    );
    await run("later-audit");
    expect(await fetchBytes("pdf")).toEqual(pdf);
    expect(await fetchBytes("csv")).toEqual(csv);
    expect(
      (
        await admin.evidenceReport.findUniqueOrThrow({
          where: { id: report.id },
        })
      ).snapshot,
    ).toEqual(stored.snapshot);
    const oldRun = await admin.auditRun.findUniqueOrThrow({
      where: { id: before.id },
    });
    const { id: _oldId, resultExpiresAt: _generatedClock, ...oldData } = oldRun;
    const expired = await admin.auditRun.create({
      data: {
        ...oldData,
        evaluation: oldData.evaluation!,
        createdAt: new Date(0),
        idempotencyKey: "expired-report",
      },
    });
    await json(
      await reports.POST(
        post({
          ...input,
          auditIds: [expired.id, after.id],
          comparison: { beforeAuditId: expired.id, afterAuditId: after.id },
        }),
      ),
      410,
    );
    const legacyEvaluation = {
      ...(oldData.evaluation as object),
      methodologyVersion: "readiness-v1",
    };
    const legacy = await admin.auditRun.create({
      data: {
        ...oldData,
        evaluation: legacyEvaluation,
        methodologyVersion: "readiness-v1",
        idempotencyKey: "legacy-report",
        createdAt: oldRun.createdAt,
      },
    });
    const mixed = await json(
      await reports.POST(
        post({
          ...input,
          auditIds: [legacy.id, after.id],
          comparison: { beforeAuditId: legacy.id, afterAuditId: after.id },
        }),
      ),
      201,
    );
    const mixedSnapshot = (
      await admin.evidenceReport.findUniqueOrThrow({ where: { id: mixed.id } })
    ).snapshot as unknown as EvidenceSnapshot;
    expect(mixedSnapshot.comparison).toMatchObject({
      compatible: false,
      result: { resolved: [], scoreDelta: null },
    });
    expect(mixedSnapshot.comparison!.result.unevaluated.length).toBeGreaterThan(
      0,
    );
    // Current within-tenant client grant and export access are checked on every download.
    seams.actor = { ...actor, userId: "viewer" };
    await fetchBytes("csv");
    await admin.site.create({
      data: {
        id: "a-private",
        workspaceId: "a",
        origin: "https://private.example.com",
      },
    });
    await json(
      await reports.GET(
        new Request(
          `http://localhost:3000/api?workspaceId=a&siteId=a-private&reportId=${report.id}&format=pdf`,
        ),
      ),
      404,
    );
    await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
    await json(
      await reports.GET(get(`&reportId=${report.id}&format=csv`)),
      404,
    );
    await json(await reports.POST(post(input)), 404);
    seams.actor = actor;
    const artifacts = "output/build-2026-11-02";
    await mkdir(artifacts, { recursive: true });
    await writeFile(`${artifacts}/comparison-acceptance.pdf`, pdf);
    await writeFile(`${artifacts}/comparison-acceptance.csv`, csv);
    await writeFile(
      `${artifacts}/comparison-acceptance-snapshot.json`,
      JSON.stringify(snapshot, null, 2),
    );
  } finally {
    await site.close();
  }
});
