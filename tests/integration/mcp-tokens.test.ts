import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createDatabase } from "../../packages/db/src";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  resolveApiToken,
  tokenAccessPolicyHash,
  consumeApiLimit,
} from "../../packages/db/src/tokens";
import { listSites } from "../../packages/db/src/tenants";
import { listAuditRuns, createAuditRun } from "../../packages/db/src/audits";
import { handleMcpRequest } from "../../apps/lyraseo-web/src/server/mcp/server";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const policy = tokenAccessPolicyHash(["pilot@example.com"]),
  origin = "http://127.0.0.1:3000";
const input = () => ({
  workspaceId: "a",
  name: "Agent read access",
  siteIds: ["a-site"],
  scopes: ["sites:read", "audits:read", "search:read"] as const,
  requestKey: randomUUID(),
});
const issue = () =>
  createApiToken(
    db,
    actor,
    { ...input(), scopes: [...input().scopes] },
    policy,
  );
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  await admin.apiThrottle.deleteMany();
  await admin.site.create({
    data: {
      id: "a-hidden",
      workspaceId: "a",
      origin: "https://hidden.example.com",
    },
  });
  await admin.auditRun.create({
    data: {
      id: "saved",
      workspaceId: "a",
      siteId: "a-site",
      userId: "owner",
      securityVersion: 0,
      status: "COMPLETED",
      idempotencyKey: "saved",
      inputHash: "hash",
      manifest: ["https://example.com/"],
      profile: "raw",
      declarations: {},
      methodologyVersion: "readiness-v1",
      evaluation: {
        score: null,
        coverage: 0,
        categoryScores: {},
        rules: [
          {
            ruleId: "A01",
            scopeKey: "https://example.com/",
            category: "answer",
            outcome: "UNKNOWN",
            priority: "high",
            reasonCode: "MISSING_EVIDENCE",
          },
        ],
        manifest: ["https://example.com/"],
        eligible: false,
        methodologyVersion: "readiness-v1",
      },
    },
  });
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
function request(secret: string | null, body: unknown, requestOrigin?: string) {
  return new Request(origin + "/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...(requestOrigin ? { origin: requestOrigin } : {}),
    },
    body: JSON.stringify(body),
  });
}
const dispatch = (req: Request) =>
  handleMcpRequest(req, { db, origin, accessPolicyHash: policy });
it("stores only a hash, shows secret once, validates scope/expiry and requires fresh authentication", async () => {
  const values = { ...input(), scopes: ["sites:read"] as "sites:read"[] };
  const issued = await createApiToken(db, actor, values, policy);
  expect(issued.secret).toMatch(/^lyra_[A-Za-z0-9_-]{43}$/);
  const stored = await admin.apiToken.findUniqueOrThrow({
    where: { id: issued.token.id },
  });
  expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(stored)).not.toContain(issued.secret);
  expect(JSON.stringify(await listApiTokens(db, actor, "a"))).not.toMatch(
    /tokenHash|secret|accessPolicyHash/,
  );
  await expect(createApiToken(db, actor, values, policy)).rejects.toThrow(
    "TOKEN_ALREADY_CREATED",
  );
  await expect(
    createApiToken(
      db,
      { ...actor, authenticatedAt: "2020-01-01" },
      values,
      policy,
    ),
  ).rejects.toThrow("FRESH_AUTH_REQUIRED");
  await expect(
    createApiToken(db, actor, { ...values, expiresInDays: 91 }, policy),
  ).rejects.toThrow("INVALID_TOKEN");
  await expect(
    createApiToken(
      db,
      actor,
      { ...values, requestKey: randomUUID(), siteIds: ["b-site"] },
      policy,
    ),
  ).rejects.toThrow();
  const credential = await resolveApiToken(db, issued.secret, policy);
  expect(credential).not.toHaveProperty("sessionId");
  await expect(
    listAuditRuns(db, credential, { workspaceId: "a", siteId: "a-site" }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    resolveApiToken(
      db,
      issued.secret,
      tokenAccessPolicyHash(["changed@example.com"]),
    ),
  ).rejects.toThrow("UNAUTHENTICATED");
});
it("retains current grants, membership, suspension, security version, expiry and immediate revocation boundaries", async () => {
  const issued = await issue();
  const credential = await resolveApiToken(db, issued.secret, policy);
  expect((await listSites(db, credential, "a")).map((s) => s.id)).toEqual([
    "a-site",
  ]);
  await expect(listSites(db, credential, "b")).rejects.toThrow("FORBIDDEN");
  await expect(
    listAuditRuns(db, credential, { workspaceId: "a", siteId: "a-hidden" }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    listAuditRuns(db, credential, { workspaceId: "b", siteId: "b-site" }),
  ).rejects.toThrow("FORBIDDEN");
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
    data: { role: "VIEWER" },
  });
  expect(await listSites(db, credential, "a")).toEqual([]);
  await expect(
    listAuditRuns(db, credential, { workspaceId: "a", siteId: "a-site" }),
  ).rejects.toThrow("FORBIDDEN");
  await admin.siteGrant.create({
    data: { workspaceId: "a", siteId: "a-site", userId: "owner" },
  });
  expect(await listSites(db, credential, "a")).toHaveLength(1);
  await admin.productUser.update({
    where: { id: "owner" },
    data: { suspended: true },
  });
  await expect(resolveApiToken(db, issued.secret, policy)).rejects.toThrow(
    "FORBIDDEN",
  );
  await admin.productUser.update({
    where: { id: "owner" },
    data: { suspended: false, securityVersion: 1 },
  });
  await expect(listSites(db, credential, "a")).rejects.toThrow("FORBIDDEN");
  await admin.productUser.update({
    where: { id: "owner" },
    data: { securityVersion: 0 },
  });
  await admin.apiToken.update({
    where: { id: issued.token.id },
    data: {
      createdAt: new Date(Date.now() - 200000),
      expiresAt: new Date(Date.now() - 100000),
    },
  });
  await expect(resolveApiToken(db, issued.secret, policy)).rejects.toThrow(
    "UNAUTHENTICATED",
  );
  await admin.apiToken.update({
    where: { id: issued.token.id },
    data: { expiresAt: new Date(Date.now() + 100000) },
  });
  await revokeApiToken(db, actor, "a", issued.token.id);
  await expect(listSites(db, credential, "a")).rejects.toThrow("FORBIDDEN");
  await expect(resolveApiToken(db, issued.secret, policy)).rejects.toThrow(
    "UNAUTHENTICATED",
  );
});
it("enforces DB-backed per-token and global invalid-credential abuse limits", async () => {
  const issued = await issue();
  await admin.apiThrottle.create({
    data: {
      key: `token:${issued.token.id}`,
      count: 60,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  expect(
    (
      await dispatch(
        request(issued.secret, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      )
    ).status,
  ).toBe(429);
  expect(
    (
      await admin.apiThrottle.findUniqueOrThrow({
        where: { key: `token:${issued.token.id}` },
      })
    ).count,
  ).toBe(61);
  await admin.apiThrottle.upsert({
    where: { key: "mcp:global" },
    create: {
      key: "mcp:global",
      count: 600,
      expiresAt: new Date(Date.now() + 60000),
    },
    update: { count: 600 },
  });
  expect((await dispatch(request(null, {}))).status).toBe(429);
  await expect(consumeApiLimit(db, "mcp:global", 600)).rejects.toThrow(
    "RATE_LIMITED",
  );
});
it("uses the official SDK client for initialization, tool discovery and real stateless Streamable HTTP tool calls", async () => {
  const issued = await issue();
  const client = new Client({ name: "integration-client", version: "1.0.0" });
  const seen: string[] = [];
  const transport = new StreamableHTTPClientTransport(
    new URL(origin + "/api/mcp"),
    {
      requestInit: { headers: { authorization: `Bearer ${issued.secret}` } },
      fetch: async (url, init) => {
        const req = new Request(url, init);
        if (init?.body) seen.push(String(init.body));
        return dispatch(req);
      },
    },
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);
    expect(
      tools.tools.every(
        (t) => t.annotations?.readOnlyHint && !t.annotations.destructiveHint,
      ),
    ).toBe(true);
    const result = await client.callTool({
      name: "lyraseo_list_sites",
      arguments: { limit: 1 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: { items: [{ id: "a-site" }], totalAvailable: 1 },
    });
    const audit = await client.callTool({
      name: "lyraseo_read_audit",
      arguments: { siteId: "a-site", auditId: "saved" },
    });
    expect(audit.structuredContent).toMatchObject({
      data: { id: "saved", evaluation: { coverage: 0, score: null } },
    });
    expect(JSON.stringify(audit)).not.toMatch(
      /tokenHash|rawHtml|sessionId|leaseOwner|inputHash/,
    );
    const findings = await client.callTool({
      name: "lyraseo_list_findings",
      arguments: { siteId: "a-site", auditId: "saved" },
    });
    expect(findings.structuredContent).toMatchObject({
      data: { items: [{ outcome: "UNKNOWN" }] },
    });
    const { crawlerSite } = await import("../fixtures/crawler-site");
    const { runRawAuditStep } =
      await import("../../apps/lyraseo-web/src/server/acquisition/runner");
    const fixture = await crawlerSite();
    try {
      const scope = { workspaceId: "a", siteId: "a-site" };
      const fresh = await createAuditRun(db, actor, {
        ...scope,
        manifest: ["https://example.com/"],
        profile: "LOCAL_RAW_V1",
        idempotencyKey: "sdk-v2-read",
      });
      await runRawAuditStep(
        db,
        actor,
        { ...scope, auditId: fresh.id },
        fixture.transport,
      );
      const v2 = await client.callTool({
        name: "lyraseo_read_audit",
        arguments: { siteId: scope.siteId, auditId: fresh.id },
      });
      expect(v2.structuredContent).toMatchObject({
        data: {
          methodologyVersion: "readiness-v2",
          evaluation: { categoryCoverage: { answer: 0 }, score: null },
        },
      });
      const rules = await client.callTool({
        name: "lyraseo_list_findings",
        arguments: { siteId: scope.siteId, auditId: fresh.id, limit: 1 },
      });
      expect(rules.structuredContent).toMatchObject({
        data: {
          items: [
            {
              ruleId: "D01",
              ruleVersion: "2",
              evidenceRefs: [{ source: "page" }, { source: "receipt" }],
              totalEvidenceRefs: 2,
            },
          ],
        },
      });
    } finally {
      await fixture.close();
    }
    const compare = await client.callTool({
      name: "lyraseo_compare_audits",
      arguments: {
        siteId: "a-site",
        beforeAuditId: "saved",
        afterAuditId: "saved",
      },
    });
    expect(compare.isError).not.toBe(true);
    expect(compare.structuredContent).toMatchObject({
      data: { profileComparable: true },
    });
    const search = await client.callTool({
      name: "lyraseo_list_search_opportunities",
      arguments: { siteId: "a-site" },
    });
    expect(search.structuredContent).toMatchObject({ data: { items: [] } });
    const denied = await client.callTool({
      name: "lyraseo_list_audits",
      arguments: { siteId: "a-hidden" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain("hidden.example.com");
    expect(seen.some((x) => x.includes('"initialize"'))).toBe(true);
    expect(seen.some((x) => x.includes('"tools/list"'))).toBe(true);
    expect(seen.some((x) => x.includes('"tools/call"'))).toBe(true);
  } finally {
    await client.close();
  }
});
it("rejects cookie-only access, hostile origins, oversized JSON and mutation calls", async () => {
  const issued = await issue();
  const missing = request(null, {});
  missing.headers.set("cookie", "session=fake");
  expect((await dispatch(missing)).status).toBe(401);
  expect(
    (await dispatch(request(issued.secret, {}, "https://evil.invalid"))).status,
  ).toBe(403);
  expect(
    (await dispatch(request(issued.secret, { value: "x".repeat(32001) })))
      .status,
  ).toBe(413);
  const mutation = await dispatch(
    request(issued.secret, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "lyraseo_run_audit", arguments: {} },
    }),
  );
  expect(JSON.stringify(await mutation.json())).toMatch(
    /not found|Unknown|unknown|not registered|does not exist/i,
  );
});

it("does not let another issuer list or revoke a token, and losing membership/deleted workspaces deny use", async () => {
  const issued = await issue();
  expect(await listApiTokens(db, { ...actor, userId: "other" }, "a")).toEqual(
    [],
  );
  await expect(
    revokeApiToken(db, { ...actor, userId: "other" }, "a", issued.token.id),
  ).rejects.toThrow("NOT_FOUND");
  await admin.membership.delete({
    where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
  });
  await expect(resolveApiToken(db, issued.secret, policy)).rejects.toThrow(
    "FORBIDDEN",
  );
  await admin.membership.create({
    data: { workspaceId: "a", userId: "owner", role: "OWNER" },
  });
  await admin.workspace.update({
    where: { id: "a" },
    data: { deletedAt: new Date() },
  });
  await expect(resolveApiToken(db, issued.secret, policy)).rejects.toThrow(
    "FORBIDDEN",
  );
});
it("atomically limits requests across separate runtime clients and resets expired counters", async () => {
  const second = createDatabase(runtimeUrl);
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        consumeApiLimit(i % 2 ? db : second, "concurrent:test", 5),
      ),
    );
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(5);
    expect(
      (
        await admin.apiThrottle.findUniqueOrThrow({
          where: { key: "concurrent:test" },
        })
      ).count,
    ).toBe(6);
    await admin.apiThrottle.update({
      where: { key: "concurrent:test" },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      consumeApiLimit(db, "concurrent:test", 5),
    ).resolves.toBeUndefined();
  } finally {
    await second.$disconnect();
  }
});
