import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  createAuditRun,
  claimAuditRun,
  checkpointAuditPage,
  finishAuditRun,
  readAuditRun,
  reviewAuditIssue,
  compareAuditRuns,
  cancelAuditRun,
  yieldAuditRun,
} from "../../packages/db/src/audits";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import type { PageEvidence } from "../../packages/visibility/src";
import {
  emptySiteContext,
  reviewSiteContext,
} from "../../packages/db/src/sites";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
const request = (key: string, manifest = ["https://example.com/"]) => ({
  workspaceId: "a",
  siteId: "a-site",
  idempotencyKey: key,
  manifest,
  profile: "LOCAL_RAW_V1" as const,
});
const scope = (auditId: string) => ({
  workspaceId: "a",
  siteId: "a-site",
  auditId,
});
const page = (requestedUrl = "https://example.com/"): PageEvidence => ({
  requestedUrl,
  acquired: true,
  status: 200,
  contentType: "text/html",
  headComplete: false,
  bodyComplete: false,
  titleElements: [],
  headingLevels: [],
  h1Texts: [],
  canonicalUrls: [requestedUrl],
  linkNames: [],
  jsonLd: [],
});
const provenance = (requestedUrl = "https://example.com/") => ({
  channel: "raw-http",
  requestedUrl,
  acquiredAt: "2026-11-02T00:00:00Z",
  rawHtml: "<main>Example</main>",
  redirects: [],
});

it("freezes reviewed context without changing an existing idempotent audit", async () => {
  const selected = { workspaceId: "a", siteId: "a-site" };
  const context = await reviewSiteContext(db, actor, selected, 0, {
    ...emptySiteContext(),
    brandName: "Original brand",
  });
  const first = await createAuditRun(db, actor, request("context"));
  await reviewSiteContext(db, actor, selected, 1, {
    ...emptySiteContext(),
    brandName: "New brand",
  });
  const replay = await createAuditRun(db, actor, request("context"));
  expect(replay.id).toBe(first.id);
  expect(replay.declarations).toMatchObject({
    brandName: "Original brand",
    contextRevision: 1,
    contextRevisionId: context.id,
  });
});
async function complete(key: string, manifest = ["https://example.com/"]) {
  const run = await createAuditRun(db, actor, request(key, manifest));
  const s = scope(run.id),
    claim = await claimAuditRun(db, actor, s, "test");
  for (const url of manifest)
    await checkpointAuditPage(
      db,
      actor,
      s,
      claim.fence,
      { ...page(url), status: 404, acquired: false },
      provenance(url),
    );
  return finishAuditRun(db, actor, s, claim.fence);
}
it("serializes concurrent admission, replays identity and freezes canonical selection", async () => {
  const results = await Promise.allSettled([
    createAuditRun(db, actor, request("one")),
    createAuditRun(db, actor, request("one")),
  ]);
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  expect(await admin.auditRun.count()).toBe(1);
  await expect(createAuditRun(db, actor, request("two"))).rejects.toThrow(
    "AUDIT_ALREADY_ACTIVE",
  );
  await expect(
    createAuditRun(
      db,
      actor,
      request("one", ["https://example.com/", "https://example.com/a"]),
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
it("checkpoints immutable pages, fences stale workers and resumes before evaluation", async () => {
  const run = await createAuditRun(db, actor, request("resume"));
  const s = scope(run.id);
  const first = await claimAuditRun(db, actor, s, "first");
  await checkpointAuditPage(db, actor, s, first.fence, page(), provenance());
  await checkpointAuditPage(db, actor, s, first.fence, page(), provenance());
  await expect(
    checkpointAuditPage(
      db,
      actor,
      s,
      first.fence,
      { ...page(), status: 404 },
      provenance(),
    ),
  ).rejects.toThrow("IMMUTABLE_EVIDENCE");
  await admin.auditRun.update({
    where: { id: run.id },
    data: { leaseUntil: new Date(0) },
  });
  const second = await claimAuditRun(db, actor, s, "second");
  expect(second.fence).toBeGreaterThan(first.fence);
  await expect(finishAuditRun(db, actor, s, first.fence)).rejects.toThrow(
    "STALE_LEASE",
  );
  const finished = await finishAuditRun(db, actor, s, second.fence);
  expect(finished.status).toBe("COMPLETED");
  await expect(
    admin.auditRun.update({
      where: { id: run.id },
      data: { evaluation: { score: 100 } },
    }),
  ).rejects.toThrow("IMMUTABLE_AUDIT");
  await expect(
    admin.auditPage.updateMany({ data: { evidence: { acquired: false } } }),
  ).rejects.toThrow("IMMUTABLE_AUDIT");
});
it("reauthorizes reads, exports and worker writes after revocation and isolates sites", async () => {
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
    data: { role: "EDITOR" },
  });
  await admin.siteGrant.create({
    data: { workspaceId: "a", siteId: "a-site", userId: "owner" },
  });
  const run = await createAuditRun(db, actor, request("access"));
  const s = scope(run.id),
    claim = await claimAuditRun(db, actor, s, "test");
  await expect(
    readAuditRun(db, actor, { ...s, workspaceId: "b", siteId: "b-site" }),
  ).rejects.toThrow("NOT_FOUND");
  await admin.siteGrant.deleteMany({ where: { userId: "owner" } });
  for (const action of ["read", "export"] as const)
    await expect(readAuditRun(db, actor, s, action)).rejects.toThrow(
      "FORBIDDEN",
    );
  await expect(
    checkpointAuditPage(db, actor, s, claim.fence, page(), provenance()),
  ).rejects.toThrow("FORBIDDEN");
});
it("keeps review workflow separate from snapshots and removed pages unevaluated", async () => {
  const before = await complete("before", [
    "https://example.com/",
    "https://example.com/removed",
  ]);
  const original = before.evaluation;
  await reviewAuditIssue(db, actor, scope(before.id), {
    ruleId: "D01",
    scopeKey: "https://example.com/",
    disposition: "REVIEWED",
    reason: "Reviewed source",
  });
  expect((await readAuditRun(db, actor, scope(before.id))).evaluation).toEqual(
    original,
  );
  const after = await complete("after");
  const comparison = await compareAuditRuns(
    db,
    actor,
    scope(after.id),
    before.id,
  );
  expect(comparison.scoreDelta).toBeNull();
  expect(
    comparison.unevaluated.some(
      (r) => r.scopeKey === "https://example.com/removed",
    ),
  ).toBe(true);
});
it("requires each selected receipt and rejects URLs outside the manifest", async () => {
  const run = await createAuditRun(db, actor, request("incomplete"));
  const s = scope(run.id),
    claim = await claimAuditRun(db, actor, s, "test");
  await expect(finishAuditRun(db, actor, s, claim.fence)).rejects.toThrow(
    "AUDIT_INCOMPLETE",
  );
  await expect(
    checkpointAuditPage(
      db,
      actor,
      s,
      claim.fence,
      page("https://example.com/outside"),
      provenance("https://example.com/outside"),
    ),
  ).rejects.toThrow("INVALID_PAGE_EVIDENCE");
});
it("keeps restricted roles behind forced RLS with immutable append-only grants", async () => {
  const run = await createAuditRun(db, actor, request("rls"));
  expect(await db.auditRun.findMany()).toEqual([]);
  const tables = await admin.$queryRaw<
    Array<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>
  >`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('AuditRun','AuditPage','IssueAction')`;
  expect(tables.length).toBe(3);
  expect(tables.every((t) => t.relrowsecurity && t.relforcerowsecurity)).toBe(
    true,
  );
  const grants = await admin.$queryRaw<
    Array<{ pageupdate: boolean; actiondelete: boolean }>
  >`SELECT has_table_privilege('lyraseo_runtime','"AuditPage"','UPDATE') AS pageupdate,has_table_privilege('lyraseo_runtime','"IssueAction"','DELETE') AS actiondelete`;
  expect(grants[0]).toEqual({ pageupdate: false, actiondelete: false });
  expect(run.status).toBe("QUEUED");
});

it("cancels an abandoned revoked sponsor run through a current site editor and fences its worker", async () => {
  const run = await createAuditRun(db, actor, request("cancel"));
  const s = scope(run.id),
    claim = await claimAuditRun(db, actor, s, "old");
  await admin.membership.delete({
    where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
  });
  const current = { ...actor, userId: "other" };
  const cancelled = await cancelAuditRun(db, current, s);
  expect(cancelled.status).toBe("FAILED");
  expect(cancelled.fence).toBeGreaterThan(claim.fence);
  await expect(
    checkpointAuditPage(db, actor, s, claim.fence, page(), provenance()),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    createAuditRun(db, current, request("replacement")),
  ).resolves.toMatchObject({ status: "QUEUED" });
});

it("yields immediately between bounded page steps and blocks an old fence", async () => {
  const run = await createAuditRun(db, actor, request("yield"));
  const s = scope(run.id);
  const first = await claimAuditRun(db, actor, s, "first");
  expect(first.leaseUntil!.getTime() - Date.now()).toBeGreaterThan(85000);
  await checkpointAuditPage(db, actor, s, first.fence, page(), provenance());
  await yieldAuditRun(db, actor, s, first.fence);
  const second = await claimAuditRun(db, actor, s, "second");
  await expect(finishAuditRun(db, actor, s, first.fence)).rejects.toThrow(
    "STALE_LEASE",
  );
  await expect(
    finishAuditRun(db, actor, s, second.fence),
  ).resolves.toMatchObject({ status: "COMPLETED" });
});
it("rejects duplicate manifests and blocks a second site in the active workspace", async () => {
  await expect(
    createAuditRun(
      db,
      actor,
      request("duplicate", [
        "https://example.com/",
        "https://example.com/#duplicate",
      ]),
    ),
  ).rejects.toThrow("INVALID_MANIFEST");
  await createAuditRun(db, actor, request("workspace"));
  await admin.site.create({
    data: {
      id: "second-site",
      workspaceId: "a",
      origin: "https://second.com",
      verifiedAt: new Date(),
    },
  });
  await expect(
    createAuditRun(db, actor, {
      ...request("second"),
      siteId: "second-site",
      manifest: ["https://second.com/"],
    }),
  ).rejects.toThrow("AUDIT_ALREADY_ACTIVE");
});
it.each([new Date(0), new Date(Date.now() + 86400000)])(
  "requires fresh verification at admission and every acquisition checkpoint (%s)",
  async (verifiedAt) => {
    await admin.site.update({ where: { id: "a-site" }, data: { verifiedAt } });
    await expect(createAuditRun(db, actor, request("fresh"))).rejects.toThrow(
      "SITE_NOT_VERIFIED",
    );
    await admin.site.update({
      where: { id: "a-site" },
      data: { verifiedAt: new Date() },
    });
    const run = await createAuditRun(db, actor, request("fresh")),
      s = scope(run.id),
      claim = await claimAuditRun(db, actor, s, "first");
    await admin.site.update({ where: { id: "a-site" }, data: { verifiedAt } });
    await expect(
      checkpointAuditPage(db, actor, s, claim.fence, page(), provenance()),
    ).rejects.toThrow("SITE_NOT_VERIFIED");
  },
);
it("accepts bounded five MiB raw source and rejects cross-origin finals and future receipts", async () => {
  const run = await createAuditRun(db, actor, request("bounds")),
    s = scope(run.id),
    claim = await claimAuditRun(db, actor, s, "test");
  await expect(
    checkpointAuditPage(
      db,
      actor,
      s,
      claim.fence,
      { ...page(), finalUrl: "https://other.com/" },
      provenance(),
    ),
  ).rejects.toThrow("INVALID_PAGE_EVIDENCE");
  await expect(
    checkpointAuditPage(db, actor, s, claim.fence, page(), {
      ...provenance(),
      acquiredAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  ).rejects.toThrow("INVALID_PAGE_EVIDENCE");
  await expect(
    checkpointAuditPage(db, actor, s, claim.fence, page(), {
      ...provenance(),
      rawHtml: "x".repeat(5 * 1024 * 1024 + 1),
    }),
  ).rejects.toThrow("EVIDENCE_TOO_LARGE");
  await checkpointAuditPage(db, actor, s, claim.fence, page(), {
    ...provenance(),
    rawHtml: "\u0001".repeat(5 * 1024 * 1024),
  });
  await expect(
    admin.auditPage.deleteMany({ where: { auditId: run.id } }),
  ).resolves.toMatchObject({ count: 1 });
});

it("rejects fabricated rendered evidence at the raw checkpoint", async () => {
  const run = await createAuditRun(db, actor, request("raw-boundary")),
    s = scope(run.id),
    claim = await claimAuditRun(db, actor, s, "test");
  for (const change of [
    { robotsGoogleAllowed: true },
    { headComplete: true },
    { bodyComplete: true },
    {
      metadata: {
        rendered: {
          directivesComplete: true,
          canonicalsComplete: true,
          directives: [],
          canonicalUrls: [],
        },
      },
    },
    { visibleText: "Example" },
    { pageType: "article" as const },
  ])
    await expect(
      checkpointAuditPage(
        db,
        actor,
        s,
        claim.fence,
        { ...page(), ...change },
        provenance(),
      ),
    ).rejects.toThrow("INVALID_PAGE_EVIDENCE");
  expect(await admin.auditPage.count()).toBe(0);
});
it("finishes a legacy queued run under its stored methodology and keeps its historical evaluation intact", async () => {
  const input = request("legacy-pending");
  const old = await admin.auditRun.create({
    data: {
      ...input,
      userId: actor.userId,
      securityVersion: actor.securityVersion,
      methodologyVersion: "readiness-v1",
      inputHash: "legacy",
      declarations: {},
    },
  });
  const s = scope(old.id),
    claim = await claimAuditRun(db, actor, s, "legacy");
  await checkpointAuditPage(db, actor, s, claim.fence, page(), provenance());
  const completed = await finishAuditRun(db, actor, s, claim.fence);
  const saved = await readAuditRun(db, actor, s);
  expect(saved.evaluation).toEqual(completed.evaluation);
  expect(saved.evaluation).toMatchObject({
    methodologyVersion: "readiness-v1",
    score: null,
  });
  expect(saved.evaluation).not.toHaveProperty("categoryCoverage");
  expect(saved.evaluation?.rules[0]).not.toHaveProperty("ruleVersion");
});
