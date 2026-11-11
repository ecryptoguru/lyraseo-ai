import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  compareAuditRuns,
  createAuditRun,
  readAuditRun,
} from "../../packages/db/src/audits";
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";
import {
  actor,
  runtimeUrl,
  adminUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import {
  crawlerContractSite,
  fixtureOrigin as origin,
} from "../fixtures/crawler-contract-site";

const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  await admin.site.update({
    where: { id: scope.siteId },
    data: { origin: origin.slice(0, -1) },
  });
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});

it("persists the real HTTP fault matrix through restricted checkpoints and resumes with a new database client", async () => {
  const site = await crawlerContractSite();
  const paths = [
    "",
    "healthy",
    "status/403",
    "status/404",
    "status/429",
    "status/503",
    "outside",
    "loop-a",
    "into-blocked",
    "chain/6",
    "unreadable",
    "empty",
    "encoded",
    "oversized",
    "header-conflict",
    "js-shell",
  ];
  try {
    const run = await createAuditRun(db, actor, {
      ...scope,
      manifest: paths.map((path) => origin + path),
      profile: "LOCAL_RAW_V1",
      idempotencyKey: "crawler-contract-matrix",
      declarations: {
        pageDeclarations: paths.map((path) => ({
          requestedUrl: origin + path,
          indexingIntent: "indexable" as const,
        })),
      },
    });
    const resource = { ...scope, auditId: run.id };
    for (let index = 0; index < paths.length; index++) {
      // The production step reloads persisted evidence on every invocation.
      // New pools model process restarts rather than relying on in-memory rows.
      const restarted = createDatabase(runtimeUrl);
      try {
        await runRawAuditStep(
          restarted,
          actor,
          resource,
          site.transport,
          async () => actor,
        );
      } finally {
        await restarted.$disconnect();
      }
      const partial = await readAuditRun(db, actor, resource);
      expect(partial.pages).toHaveLength(index + 1);
    }
    const saved = await readAuditRun(db, actor, resource);
    expect(saved.status).toBe("COMPLETED");
    expect(saved.evaluation?.score).toBeNull();
    expect(
      saved.evaluation?.rules
        .filter((r) => r.outcome === "FAIL" || r.outcome === "WARNING")
        .map((r) => `${r.ruleId}:${r.scopeKey}:${r.reasonCode}`)
        .sort(),
    ).toEqual(
      [
        `D01:${origin}status/403:HTTP_ERROR`,
        `D01:${origin}status/404:HTTP_ERROR`,
        `D01:${origin}status/429:HTTP_ERROR`,
        `D01:${origin}status/503:HTTP_ERROR`,
        `D02:${origin}header-conflict:NOINDEX_ON_INTENDED_PAGE`,
      ].sort(),
    );
    for (const [path, error] of [
      ["unreadable", "BODY_INVALID_UTF8"],
      ["encoded", "UNSUPPORTED_CONTENT_ENCODING"],
      ["oversized", "BODY_TOO_LARGE"],
      ["outside", "REDIRECT_OUTSIDE_ORIGIN"],
      ["chain/6", "REDIRECT_LIMIT"],
    ]) {
      const page = saved.pages.find((p) => p.requestedUrl === origin + path)!;
      expect(page.provenance.error).toBe(error);
      expect(page.evidence.acquired).toBe(false);
    }
    expect(
      saved.pages.find((p) => p.requestedUrl === `${origin}chain/6`)!.provenance
        .redirects,
    ).toHaveLength(5);
    expect(
      saved.pages.find((p) => p.requestedUrl === `${origin}outside`)!.provenance
        .redirects,
    ).toEqual([`${origin}outside`]);
    expect(JSON.stringify(saved)).not.toContain("rawHtml");
    expect(site.requests.filter((path) => path === "/healthy")).toHaveLength(1);
    expect(site.requests).not.toContain("/blocked");
    expect(site.requests.some((path) => /canary|meta-data/.test(path))).toBe(
      false,
    );
    const requests = site.requests.length;
    await expect(
      runRawAuditStep(db, actor, resource, site.transport, async () => actor),
    ).rejects.toThrow("AUDIT_TERMINAL");
    expect(site.requests).toHaveLength(requests);
  } finally {
    await site.close();
  }
});

it("compares persisted fixed, removed and unreadable pages without promoting missing evidence to a fix", async () => {
  const site = await crawlerContractSite();
  const manifest = [
    origin,
    `${origin}repair`,
    `${origin}removed`,
    `${origin}unreadable`,
  ];
  const capture = async (key: string) => {
    const run = await createAuditRun(db, actor, {
      ...scope,
      manifest,
      profile: "LOCAL_RAW_V1",
      idempotencyKey: key,
    });
    for (const _ of manifest)
      await runRawAuditStep(
        db,
        actor,
        { ...scope, auditId: run.id },
        site.transport,
        async () => actor,
      );
    return run.id;
  };
  try {
    const before = await capture("crawler-contract-before");
    site.fix();
    const after = await capture("crawler-contract-after");
    const comparison = await compareAuditRuns(
      db,
      actor,
      { ...scope, auditId: after },
      before,
    );
    expect(comparison.resolved.map((r) => `${r.ruleId}:${r.scopeKey}`)).toEqual(
      [`D01:${origin}repair`],
    );
    for (const path of ["removed", "unreadable"])
      expect(comparison.unevaluated).toContainEqual(
        expect.objectContaining({
          ruleId: "D01",
          scopeKey: origin + path,
          outcome: "UNKNOWN",
        }),
      );
    const saved = await readAuditRun(db, actor, { ...scope, auditId: after });
    for (const path of ["removed", "unreadable"])
      expect(
        saved.evaluation?.rules.find(
          (r) => r.ruleId === "D01" && r.scopeKey === origin + path,
        )?.outcome,
      ).toBe("UNKNOWN");
    expect(
      saved.evaluation?.rules.filter((r) =>
        ["FAIL", "WARNING"].includes(r.outcome),
      ),
    ).toEqual([]);
  } finally {
    await site.close();
  }
});
