import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  createAuditRun,
  readAuditRun,
  compareAuditRuns,
} from "../../packages/db/src/audits";
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";
import {
  actor,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import { crawlerSite } from "../fixtures/crawler-site";

const db = createDatabase(runtimeUrl);
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
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
    expect(saved.pages.some((page) => page.provenance.rawHtml)).toBe(true);
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
    expect(nul.provenance.rawHtml).toBeUndefined();
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
    expect(unicode.evidence.linkNames).toEqual([
      { href: "https://example.com/about", name: "a".repeat(499) },
    ]);
    expect(unicode.provenance.rawHtml).toContain(`${"a".repeat(499)}😀`);
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
      expect(page.provenance.rawHtml).toBeUndefined();
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
