import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createDatabase } from "../../packages/db/src";
import {
  readAuditRun,
  readAuditSource,
  createAuditRun,
  reviewAuditIssue,
} from "../../packages/db/src/audits";
import { readGoogleSearch } from "../../packages/db/src/gsc";
import { readPage, registerPage } from "../../packages/db/src/pages";
import {
  createApiToken,
  tokenAccessPolicyHash,
} from "../../packages/db/src/tokens";
import { handleMcpRequest } from "../../apps/lyraseo-web/src/server/mcp/server";
import { localAuditArtifactStore } from "../../packages/db/src/artifact-store";
import { bindLocalArtifactStore } from "../../packages/db/src/artifact-checkpoint";
import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";

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
  mfaAuthenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  authProvider: "supabase" as const,
};
const scope = { workspaceId: "inline-w", siteId: "inline-s" },
  pageUrl = "https://example.com/";
afterAll(async () => {
  await runtime.$disconnect();
  await admin.$disconnect();
});
describe.skipIf(!name)("legacy inline R1 parity", () => {
  beforeAll(async () => {
    for (const shape of ["page", "query,page"])
      await admin.searchSnapshot.createMany({
        skipDuplicates: true,
        data: {
          ...scope,
          property: pageUrl,
          startDate: "2026-10-01",
          endDate: "2026-10-28",
          shape,
          status: "complete",
          rows: [
            {
              keys: shape === "page" ? [pageUrl] : ["observed query", pageUrl],
              clicks: 1,
              impressions: 300,
              position: 8,
              ctr: 1 / 300,
            },
          ],
        },
      });
  });
  it.each([
    "fresh-missing-hash",
    "fresh-unexpected",
    "fresh-profile",
    "fresh-mismatch",
  ])(
    "withholds current but untrusted source %s on both locked reads",
    async (auditId) => {
      await expect(
        readAuditSource(
          runtime,
          actor,
          { ...scope, auditId },
          pageUrl,
          async () => actor,
        ),
      ).rejects.toThrow("LEGACY_EVIDENCE_WITHHELD");
    },
  );
  it("keeps trusted current source and enforces scope classification again after identity I/O", async () => {
    const bytes = await readAuditSource(
      runtime,
      actor,
      { ...scope, auditId: "fresh" },
      pageUrl,
      async () => actor,
    );
    expect(Buffer.from(bytes).toString()).toBe("<html>RAW_HTML_fresh</html>");
    let revalidated = 0;
    await expect(
      readAuditSource(
        runtime,
        actor,
        { ...scope, auditId: "fresh" },
        pageUrl,
        async () => {
          revalidated++;
          return { ...actor, securityVersion: 1 };
        },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(revalidated).toBe(1);
  });
  it("withholds audit-derived search opportunities while preserving independent GSC evidence", async () => {
    const result = await readGoogleSearch(runtime, actor, scope);
    expect(result.snapshots).toHaveLength(2);
    expect(
      result.opportunities.some((o) => o.kind === "best-observed-page"),
    ).toBe(true);
    expect(
      result.opportunities.some((o) => o.kind === "demand-and-audit"),
    ).toBe(false);
    expect(result).toMatchObject({
      auditEvidenceStatus: "legacy-lineage-withheld",
    });
    expect(JSON.stringify(result)).not.toContain("E01");
  });
  it("reclassifies the second source read if enrollment commits during identity I/O", async () => {
    const { createHash } = await import("node:crypto");
    const siteId = "r1-enroll-during-read",
      address = "https://read-fixture.example/",
      raw = "<html>enrollment-boundary</html>";
    await admin.site.create({
      data: {
        workspaceId: scope.workspaceId,
        id: siteId,
        origin: "https://read-fixture.example",
        verifiedAt: new Date(),
      },
    });
    const a = await admin.auditRun.create({
      data: {
        workspaceId: scope.workspaceId,
        siteId,
        userId: actor.userId,
        securityVersion: 0,
        idempotencyKey: randomUUID(),
        inputHash: "r1-fixture",
        manifest: [address],
        profile: "CONTROLLED_RAW_TEST_V1",
        methodologyVersion: "readiness-v2",
        declarations: {},
        status: "COMPLETED",
      },
    });
    await admin.auditPage.create({
      data: {
        workspaceId: scope.workspaceId,
        auditId: a.id,
        requestedUrl: address,
        evidence: { requestedUrl: address, acquired: true },
        provenance: {
          channel: "raw-http",
          requestedUrl: address,
          acquiredAt: new Date(Date.now() - 1000).toISOString(),
          rawHtml: raw,
          sha256: createHash("sha256").update(raw).digest("hex"),
          unknownCopy: "withheld",
        },
      },
    });
    let identityReads = 0;
    await expect(
      readAuditSource(
        runtime,
        actor,
        { workspaceId: scope.workspaceId, siteId, auditId: a.id },
        address,
        async () => {
          identityReads++;
          await admin.$executeRaw`INSERT INTO lyraseo_legacy_inline.environment(database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version) SELECT oid,pg_postmaster_start_time(),'lyraseo_artifact_maintenance',${scope.workspaceId},${siteId},'P2B2_INLINE_HTML_V1' FROM pg_database WHERE datname=current_database()`;
          return actor;
        },
      ),
    ).rejects.toThrow("LEGACY_EVIDENCE_WITHHELD");
    expect(identityReads).toBe(1);
  });
  it("preserves unrelated unprotected audit-derived search evidence", async () => {
    const siteId = "r1-unrelated-site",
      address = "https://unrelated-fixture.example/";
    await admin.site.create({
      data: {
        workspaceId: scope.workspaceId,
        id: siteId,
        origin: "https://unrelated-fixture.example",
        verifiedAt: new Date(),
      },
    });
    await admin.auditRun.create({
      data: {
        workspaceId: scope.workspaceId,
        siteId,
        userId: actor.userId,
        securityVersion: 0,
        idempotencyKey: randomUUID(),
        inputHash: "r1-fixture",
        manifest: [address],
        profile: "LOCAL_RAW_V1",
        methodologyVersion: "readiness-v2",
        declarations: {},
        status: "COMPLETED",
        evaluation: {
          rules: [
            { ruleId: "UNRELATED_FAIL", scopeKey: address, outcome: "FAIL" },
          ],
        },
      },
    });
    await admin.searchSnapshot.create({
      data: {
        workspaceId: scope.workspaceId,
        siteId,
        property: address,
        startDate: "2026-10-01",
        endDate: "2026-10-28",
        shape: "page",
        status: "complete",
        rows: [{ keys: [address], impressions: 300, clicks: 1, position: 8 }],
      },
    });
    const result = await readGoogleSearch(runtime, actor, {
      workspaceId: scope.workspaceId,
      siteId,
    });
    expect(result.auditEvidenceStatus).toBe("available");
    expect(
      result.opportunities.some((o) => o.kind === "demand-and-audit"),
    ).toBe(true);
    expect(JSON.stringify(result)).toContain("UNRELATED_FAIL");
  });
  it("retains explicit withheld findings and safe receipts in page detail", async () => {
    const page = await registerPage(runtime, actor, scope, pageUrl);
    const result = await readPage(runtime, actor, scope, page.id);
    expect(result.audits.length).toBeGreaterThan(0);
    expect(
      result.audits.every(
        (a) => a.evidenceStatus === "legacy-lineage-withheld",
      ),
    ).toBe(true);
    expect(result.audits.flatMap((a) => a.findings)).toEqual([]);
    expect(result.audits.some((a) => a.pages.some((p) => !!p.provenance))).toBe(
      true,
    );
    expect(result.search).toMatchObject({
      auditEvidenceStatus: "legacy-lineage-withheld",
    });
  });
  it("returns explicit withheld states through both real SDK MCP tools and search", async () => {
    const origin = "http://127.0.0.1:3026",
      policy = tokenAccessPolicyHash(["inline-fixture@example.com"]);
    const issued = await createApiToken(
      runtime,
      actor,
      {
        workspaceId: scope.workspaceId,
        name: "inline R1",
        siteIds: [scope.siteId],
        scopes: ["sites:read", "audits:read", "search:read"],
        requestKey: randomUUID(),
      },
      policy,
    );
    const client = new Client({ name: "inline-r1-fixture", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(origin + "/api/mcp"),
      {
        requestInit: { headers: { authorization: `Bearer ${issued.secret}` } },
        fetch: async (input, init) =>
          handleMcpRequest(new Request(input, init), {
            db: runtime,
            origin,
            accessPolicyHash: policy,
          }),
      },
    );
    try {
      await client.connect(transport);
      const audit = await client.callTool({
        name: "lyraseo_read_audit",
        arguments: { siteId: scope.siteId, auditId: "due" },
      });
      expect(audit.structuredContent).toMatchObject({
        data: { evidenceStatus: "legacy-lineage-withheld" },
      });
      const findings = await client.callTool({
        name: "lyraseo_list_findings",
        arguments: { siteId: scope.siteId, auditId: "due" },
      });
      expect(findings.isError).toBe(true);
      expect(findings.structuredContent).toMatchObject({
        error: { code: "LEGACY_EVIDENCE_WITHHELD" },
      });
      const search = await client.callTool({
        name: "lyraseo_list_search_opportunities",
        arguments: { siteId: scope.siteId },
      });
      expect(search.structuredContent).toMatchObject({
        data: { auditEvidenceStatus: "legacy-lineage-withheld" },
      });
      expect(JSON.stringify(search)).not.toContain("E01");
    } finally {
      await client.close();
    }
  });
  it("finalizes and reads a real nonempty private page under the enrolled legacy fence", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "inline-r1-private-"),
    );
    const store = await localAuditArtifactStore(root),
      authority = await enrollTestArtifactAuthority(admin, store, [
        scope.workspaceId,
      ]);
    try {
      bindLocalArtifactStore(runtime, store, authority);
      const run = await createAuditRun(runtime, actor, {
        ...scope,
        profile: "LOCAL_RAW_V1",
        idempotencyKey: randomUUID(),
        manifest: [pageUrl],
        declarations: {
          pageDeclarations: [
            { requestedUrl: pageUrl, indexingIntent: "indexable" },
          ],
        },
      });
      const privateScope = { ...scope, auditId: run.id };
      const bytes = Buffer.from(
        "<html><head><title>PRIVATE_R1_NONEMPTY</title></head><body>Private content</body></html>",
      );
      const result = await runRawAuditStep(
        runtime,
        actor,
        privateScope,
        async (u) =>
          u.endsWith("robots.txt")
            ? new Response(null, { status: 404 })
            : new Response(bytes, {
                headers: {
                  "content-type": "text/html",
                  "x-robots-tag": "noindex",
                },
              }),
      );
      expect(result.status).toBe("COMPLETED");
      const persisted = await admin.auditRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(persisted.storageFormat).toBe("AUDIT_PRIVATE_V1");
      expect(await admin.auditPage.count({ where: { auditId: run.id } })).toBe(
        1,
      );
      const view = await readAuditRun(runtime, actor, privateScope);
      expect(view.evidenceStatus).toBe("available");
      expect(view.evaluation).not.toBeNull();
      const finding = view.evaluation!.rules.find((rule) =>
        ["FAIL", "WARNING"].includes(rule.outcome),
      );
      expect(finding).toMatchObject({
        ruleId: "D02",
        outcome: "FAIL",
        reasonCode: "NOINDEX_ON_INTENDED_PAGE",
      });
      const action = await reviewAuditIssue(runtime, actor, privateScope, {
        ruleId: finding!.ruleId,
        scopeKey: finding!.scopeKey,
        disposition: "REVIEWED",
        reason: "Private evidence remains reviewable under legacy enrollment",
      });
      expect(action.ruleId).toBe(finding!.ruleId);

      const maintenance = createDatabase(
        url.replace(
          "lyraseo_runtime:local_runtime_only",
          "lyraseo_artifact_maintenance:local_expiry_only",
        ),
      );
      try {
        const privatePages = await admin.auditPage.findMany({
          where: { auditId: run.id },
        });
        const [preview] = await maintenance.$queryRaw<
          { value: { items: Array<{ id: string; status: string }> } }[]
        >`SELECT lyraseo_legacy_inline.preview(${scope.workspaceId},${scope.siteId},100,'AUDIT_PAGE_RAW_HTML','') AS value`;
        expect(
          preview!.value.items.find((p) => p.id === privatePages[0]!.id)
            ?.status,
        ).toBe("already-compact");
        await maintenance.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout='3s'`;
          const [plan] = await tx.$queryRaw<
            { id: string }[]
          >`SELECT lyraseo_legacy_inline.make_plan(${scope.workspaceId},${scope.siteId})::text AS id`;
          await tx.$queryRaw`SELECT lyraseo_legacy_inline.next(${scope.workspaceId},${scope.siteId},${plan!.id}::uuid)`;
        });
        expect(
          await admin.auditPage.findMany({ where: { auditId: run.id } }),
        ).toEqual(privatePages);
        expect(
          await admin.auditRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toEqual(persisted);
      } finally {
        await maintenance.$disconnect();
      }

      expect(
        Buffer.from(
          await readAuditSource(
            runtime,
            actor,
            privateScope,
            pageUrl,
            async () => actor,
          ),
        ),
      ).toEqual(bytes);
      expect(
        JSON.stringify(
          await admin.auditPage.findMany({ where: { auditId: run.id } }),
        ),
      ).not.toContain("PRIVATE_R1_NONEMPTY");
    } finally {
      await authority.revoke();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
