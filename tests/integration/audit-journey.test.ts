import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  createAuditRun,
  readAuditRun,
  readAuditSource,
  compareAuditRuns,
} from "../../packages/db/src/audits";
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";
import {
  actor,
  runtimeUrl,
  adminUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import { crawlerSite } from "../fixtures/crawler-site";

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
it("persists real controlled HTTP evidence, resumes checkpoints and verifies an HTTP status fix", async () => {
  const site = await crawlerSite();
  const scope = { workspaceId: "a", siteId: "a-site" };
  const start = (key: string) =>
    createAuditRun(db, actor, {
      ...scope,
      manifest: [
        "https://example.com/",
        "https://example.com/missing",
        "https://example.com/unreadable",
      ],
      profile: "LOCAL_RAW_V1",
      idempotencyKey: key,
    });
  try {
    const before = await start("before");
    const resource = { ...scope, auditId: before.id };
    const checkpoint = await runRawAuditStep(
      db,
      actor,
      resource,
      site.transport,
    );
    expect(checkpoint.status).toBe("QUEUED");
    expect(checkpoint.pages).toHaveLength(1);
    // A new invocation loads the durable manifest and skips the completed page.
    await runRawAuditStep(db, actor, resource, site.transport);
    await runRawAuditStep(db, actor, resource, site.transport);
    expect((await readAuditRun(db, actor, resource)).status).toBe("COMPLETED");
    site.fix();
    const after = await start("after");
    await runRawAuditStep(
      db,
      actor,
      { ...scope, auditId: after.id },
      site.transport,
    );
    await runRawAuditStep(
      db,
      actor,
      { ...scope, auditId: after.id },
      site.transport,
    );
    await runRawAuditStep(
      db,
      actor,
      { ...scope, auditId: after.id },
      site.transport,
    );
    const delta = await compareAuditRuns(
      db,
      actor,
      { ...scope, auditId: after.id },
      before.id,
    );
    expect(delta.resolved.some((rule) => rule.ruleId === "D01")).toBe(true);
    const saved = await readAuditRun(db, actor, {
      ...scope,
      auditId: after.id,
    });
    expect(JSON.stringify(saved)).not.toContain("rawHtml");
    expect(
      (
        await readAuditSource(
          db,
          actor,
          { ...scope, auditId: after.id },
          "https://example.com/",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      saved.evaluation?.rules.find(
        (rule) =>
          rule.ruleId === "D01" && rule.scopeKey.endsWith("/unreadable"),
      )?.outcome,
    ).toBe("UNKNOWN");
    expect(
      saved.pages.find((page) => page.requestedUrl.endsWith("/unreadable"))
        ?.evidence.acquired,
    ).toBe(false);
  } finally {
    await site.close();
  }
});

it("checkpoints NUL as an unreadable receipt, resumes, and captures real raw anchors for editorial", async () => {
  const { createHash } = await import("node:crypto");
  const { captureEditorialEvidence } =
    await import("../../packages/db/src/content");
  const site = await crawlerSite();
  const scope = { workspaceId: "a", siteId: "a-site" };
  try {
    const run = await createAuditRun(db, actor, {
      ...scope,
      manifest: [
        "https://example.com/nul",
        "https://example.com/",
        "https://example.com/about",
      ],
      profile: "LOCAL_RAW_V1",
      idempotencyKey: "nul-anchor",
    });
    const resource = { ...scope, auditId: run.id };
    await runRawAuditStep(db, actor, resource, site.transport);
    await runRawAuditStep(db, actor, resource, site.transport);
    await runRawAuditStep(db, actor, resource, site.transport);
    const saved = await readAuditRun(db, actor, resource);
    expect(saved.status).toBe("COMPLETED");
    const nul = saved.pages.find((p) => p.requestedUrl.endsWith("/nul"))!;
    expect(nul.provenance.error).toBe("BODY_UNREPRESENTABLE");
    expect(nul.provenance).not.toHaveProperty("rawHtml");
    expect(nul.provenance.sha256).toBe(
      createHash("sha256")
        .update("<html><head><title>NUL</title></head><!--\u0000--></html>")
        .digest("hex"),
    );
    expect(nul.evidence.acquired).toBe(false);
    const checkpointCount = site.requests.length;
    await expect(
      runRawAuditStep(db, actor, resource, site.transport),
    ).rejects.toThrow("AUDIT_TERMINAL");
    expect(site.requests).toHaveLength(checkpointCount);
    const capture = await captureEditorialEvidence(db, actor, scope, {
      auditIds: [run.id],
      searchSnapshotIds: [],
    });
    const source = capture.sources[0]!.data as {
      methodologyVersion: string;
      pages: Array<{ url: string; receipt: Record<string, unknown> }>;
    };
    expect(source.methodologyVersion).toBe("readiness-v2");
    const reportReceipt = source.pages.find(
      (p) => p.url === nul.requestedUrl,
    )!.receipt;
    expect(reportReceipt).toMatchObject({
      acquiredAt: nul.provenance.acquiredAt,
      sha256: nul.provenance.sha256,
      error: "BODY_UNREPRESENTABLE",
    });
    expect(reportReceipt).not.toHaveProperty("rawHtml");
    expect(reportReceipt.robotsPolicy).toEqual(nul.provenance.robotsPolicy);
    const { replayGoogleRobots } =
      await import("../../packages/visibility/src/acquisition");
    expect(reportReceipt.robotsPolicy).toMatchObject({
      groupAgent: "*",
      ruleCount: 1,
    });
    const immutable = await admin.auditPage.findUniqueOrThrow({
      where: { id: nul.id },
    });
    const policy = (immutable.provenance as Record<string, unknown>)
      .robotsPolicy as import("../../packages/visibility/src/types").RobotsPolicyObservation;
    expect(policy.sha256).toBe(
      createHash("sha256")
        .update("User-agent: *\nDisallow: /blocked\n")
        .digest("hex"),
    );
    expect(replayGoogleRobots(policy, nul.requestedUrl)).toBe(true);
    expect(replayGoogleRobots(policy, "https://example.com/blocked")).toBe(
      false,
    );

    expect(capture.internalLinks).toContainEqual(
      expect.objectContaining({
        url: "https://example.com/about",
        sourceUrl: "https://example.com/",
        anchorText: "About",
        basis: expect.stringContaining("rendered DOM unobserved"),
      }),
    );
    expect(
      site.requests.some((p) => p.includes("tracker") || p.includes("secret")),
    ).toBe(false);
  } finally {
    await site.close();
  }
});

it("persists a valid UTF-8 anchor crossing the text cap and its editorial snapshot without splitting a surrogate", async () => {
  const { createContentDraft } = await import("../../packages/db/src/content");
  const site = await crawlerSite();
  const scope = { workspaceId: "a", siteId: "a-site" };
  try {
    const run = await createAuditRun(db, actor, {
      ...scope,
      manifest: [
        "https://example.com/",
        "https://example.com/unicode",
        "https://example.com/about",
      ],
      profile: "LOCAL_RAW_V1",
      idempotencyKey: "unicode-anchor",
    });
    const resource = { ...scope, auditId: run.id };
    await runRawAuditStep(db, actor, resource, site.transport);
    await runRawAuditStep(db, actor, resource, site.transport);
    await runRawAuditStep(db, actor, resource, site.transport);
    const saved = await readAuditRun(db, actor, resource);
    expect(saved.status).toBe("COMPLETED");
    const unicode = saved.pages.find((p) =>
      p.requestedUrl.endsWith("/unicode"),
    )!;
    expect(unicode.evidence.acquired).toBe(true);
    const immutable = await admin.auditPage.findUniqueOrThrow({
      where: { id: unicode.id },
    });
    expect((immutable.evidence as Record<string, unknown>).linkNames).toEqual([
      { href: "https://example.com/about", name: "a".repeat(499) },
    ]);
    expect(
      Buffer.from(
        await readAuditSource(db, actor, resource, unicode.requestedUrl),
      ).toString("utf8"),
    ).toContain(`${"a".repeat(499)}😀`);
    const draft = await createContentDraft(db, actor, scope, {
      kind: "draft",
      title: "Unicode evidence",
      body: "Manual",
      citations: [],
      assumptions: [],
      auditIds: [run.id],
      searchSnapshotIds: [],
    });
    expect(
      (
        draft.snapshot as unknown as import("../../packages/db/src/content").EvidenceSnapshot
      ).internalLinks,
    ).toContainEqual(
      expect.objectContaining({
        sourceUrl: "https://example.com/unicode",
        anchorText: "a".repeat(499),
      }),
    );
  } finally {
    await site.close();
  }
});
it("checkpoints empty HTML 200/204/205 as unavailable with observed status/digest and UNKNOWN D01", async () => {
  const { createHash } = await import("node:crypto");
  const site = await crawlerSite();
  const scope = { workspaceId: "a", siteId: "a-site" };
  try {
    const run = await createAuditRun(db, actor, {
      ...scope,
      manifest: [
        "https://example.com/",
        ...[200, 204, 205].map((s) => `https://example.com/empty-${s}`),
      ],
      profile: "LOCAL_RAW_V1",
      idempotencyKey: "empty-html",
    });
    const resource = { ...scope, auditId: run.id };
    for (let step = 0; step < 4; step++)
      await runRawAuditStep(db, actor, resource, site.transport);
    const saved = await readAuditRun(db, actor, resource);
    expect(saved.status).toBe("COMPLETED");
    for (const status of [200, 204, 205]) {
      const page = saved.pages.find((p) =>
        p.requestedUrl.endsWith(`/empty-${status}`),
      )!;
      expect(page.evidence).toMatchObject({
        acquired: false,
        status,
        headComplete: false,
        bodyComplete: false,
      });
      expect(page.provenance).toMatchObject({
        status,
        error: "EMPTY_HTML_BODY",
        sha256: createHash("sha256").update("").digest("hex"),
      });
      expect(page.provenance).not.toHaveProperty("rawHtml");
      expect(
        saved.evaluation?.rules.find(
          (r) => r.ruleId === "D01" && r.scopeKey === page.requestedUrl,
        )?.outcome,
      ).toBe("UNKNOWN");
    }
  } finally {
    await site.close();
  }
});
