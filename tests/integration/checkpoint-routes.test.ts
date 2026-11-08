import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { authorizeSiteIn, withActor } from "../../packages/db/src/context";
import { replayGoogleRobots } from "../../packages/visibility/src/robots-source";
import type { RobotsPolicyObservation } from "../../packages/visibility/src/types";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const seams = vi.hoisted(() => ({
  db: null as unknown,
  actor: null as unknown,
  proof: "",
  beforeProof: null as null | (() => Promise<void>),
  proofSockets: 0,
  transport: null as
    null | import("../../packages/visibility/src/acquisition").PublicTransport,
  configured: null as unknown,
}));
vi.mock("@/server/auth/server", () => ({
  database: () => seams.db,
  resolveActor: async () => seams.actor,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://localhost:3000" }),
}));
vi.mock("@/server/acquisition/transport", () => ({
  publicHttpsTransport: (url: string, signal: AbortSignal) => {
    if (!seams.transport) throw new Error("No local transport fixture");
    return seams.transport(url, signal);
  },
}));
vi.mock("@/server/acquisition/proof", () => ({
  observeSiteProof: async (url: string, beforeSocket: () => Promise<void>) => {
    await seams.beforeProof?.();
    await beforeSocket();
    seams.proofSockets++;
    return { url, status: 200, body: seams.proof };
  },
}));
vi.mock("@/server/google/provider", async (original) => ({
  ...(await original<
    typeof import("../../apps/lyraseo-web/src/server/google/provider")
  >()),
  configuredGoogle: () => seams.configured,
}));
import * as sites from "../../apps/lyraseo-web/src/app/api/sites/route";
import * as content from "../../apps/lyraseo-web/src/app/api/content/route";
import * as reports from "../../apps/lyraseo-web/src/app/api/reports/route";
import * as google from "../../apps/lyraseo-web/src/app/api/integrations/google/route";
import * as analytics from "../../apps/lyraseo-web/src/app/api/analytics/route";
import * as audits from "../../apps/lyraseo-web/src/app/api/audits/route";
import * as search from "../../apps/lyraseo-web/src/app/api/search/route";
import {
  emptySiteContext,
  issueSiteChallenge,
} from "../../packages/db/src/sites";
import { completeGoogleConnect } from "../../packages/db/src/gsc";
import { secretBox } from "../../apps/lyraseo-web/src/server/google/provider";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
const box = secretBox(Buffer.alloc(32, 7).toString("base64"));
const provider = {
  authorize: (state: string) => state,
  exchange: async () => "refresh",
  properties: vi.fn(async () => [
    { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
  ]),
  query: vi.fn(async () => []),
};
const post = (body: unknown) =>
  new Request("http://localhost:3000/api", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...scope, ...(body as object) }),
  });
const get = (query = "") =>
  new Request(`http://localhost:3000/api?workspaceId=a&siteId=a-site${query}`);
async function json(response: Response, status = 200) {
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return result;
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  seams.db = db;
  seams.actor = actor;
  seams.configured = { provider, box };
  seams.beforeProof = null;
  seams.proofSockets = 0;
  provider.properties.mockClear();
  provider.query.mockClear();
  vi.stubEnv("LYRA_LOCAL_RAW_AUDITS", "true");
  vi.stubEnv("VERCEL", "0");
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
  vi.unstubAllEnvs();
});
it("executes real site challenge, proof verification and context handlers against restricted PostgreSQL", async () => {
  const challenge = await json(await sites.POST(post({ action: "challenge" })));
  seams.proof = challenge.token;
  await json(
    await sites.POST(post({ action: "verify", challengeId: challenge.id })),
  );
  const saved = await json(
    await sites.POST(
      post({
        action: "context",
        expectedRevision: 0,
        content: { ...emptySiteContext(), brandName: "Actual route" },
      }),
    ),
  );
  expect(saved.revision).toBe(1);
  expect(await json(await sites.GET(get()))).toHaveLength(1);
  // Service boundary also rejects accidental structural widening as Prisma input.
  await expect(
    issueSiteChallenge(db, actor, {
      ...scope,
      action: "challenge",
    } as typeof scope),
  ).resolves.toHaveProperty("token");
});
it("honors an audit capability pause after DNS and before the proof socket", async () => {
  const oldCapabilities = process.env.LYRA_ENABLED_CAPABILITIES;
  const challenge = await json(await sites.POST(post({ action: "challenge" })));
  seams.proof = challenge.token;
  seams.beforeProof = async () => {
    process.env.LYRA_ENABLED_CAPABILITIES = "";
  };
  try {
    const response = await sites.POST(
      post({ action: "verify", challengeId: challenge.id }),
    );
    expect(response.status).toBe(503);
    expect(seams.proofSockets).toBe(0);
    expect(
      (
        await admin.siteVerificationChallenge.findUniqueOrThrow({
          where: { id: challenge.id },
        })
      ).consumedAt,
    ).toBeNull();
  } finally {
    if (oldCapabilities === undefined)
      delete process.env.LYRA_ENABLED_CAPABILITIES;
    else process.env.LYRA_ENABLED_CAPABILITIES = oldCapabilities;
  }
});
it("executes real create/save/report and report-download handlers without leaking query fields into Prisma", async () => {
  await admin.searchSnapshot.create({
    data: {
      id: "source",
      ...scope,
      property: "https://example.com/",
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      shape: "page",
      status: "complete",
      rows: [],
    },
  });
  const fields = {
    title: "Real draft",
    body: "Manual",
    assumptions: [],
    citations: [],
  };
  const draft = await json(
    await content.POST(
      post({
        action: "create",
        kind: "draft",
        ...fields,
        auditIds: [],
        searchSnapshotIds: ["source"],
      }),
    ),
    201,
  );
  expect(draft.history).toHaveLength(1);
  await json(
    await content.POST(
      post({
        action: "save",
        draftId: draft.id,
        expectedRevision: 1,
        ...fields,
        body: "Updated",
      }),
    ),
  );
  const read = await json(await content.GET(get(`&draftId=${draft.id}`)));
  expect(read[0].history[0].content.body).toBe("Updated");
  const report = await json(
    await reports.POST(
      post({
        title: "Real report",
        auditIds: [],
        searchSnapshotIds: ["source"],
      }),
    ),
    201,
  );
  const csv = await reports.GET(get(`&reportId=${report.id}&format=csv`));
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-type")).toContain("text/csv");
  expect((await csv.text()).length).toBeGreaterThan(0);
});
it("executes real GSC connect/discover/select/import/disconnect and leaves GET provider-free", async () => {
  const consent = await json(await google.POST(post({ action: "connect" })));
  await completeGoogleConnect(db, actor, consent.url, "code", provider, box);
  expect(
    (await json(await google.POST(post({ action: "discover" })))).properties,
  ).toHaveLength(1);
  await json(
    await google.POST(
      post({ action: "select", property: "https://example.com/" }),
    ),
  );
  const imported = await json(
    await search.POST(
      post({ startDate: "2026-01-01", endDate: "2026-01-02", shape: "page" }),
    ),
  );
  expect(imported.rowCount).toBe(0);
  expect(provider.query).toHaveBeenCalledTimes(1);
  provider.query.mockClear();
  provider.properties.mockClear();
  expect((await json(await search.GET(get()))).snapshots).toHaveLength(1);
  expect(provider.query).not.toHaveBeenCalled();
  expect(provider.properties).not.toHaveBeenCalled();
  await json(await google.POST(post({ action: "disconnect" })));
  expect(await admin.googleConnection.count()).toBe(0);
  expect(await admin.searchSnapshot.count()).toBe(0);
  expect(await admin.searchImport.count()).toBe(0);
});

it("projects audit review commands into clean scope and append-only issue fields", async () => {
  await admin.auditRun.create({
    data: {
      id: "review-route",
      ...scope,
      userId: actor.userId,
      securityVersion: 0,
      idempotencyKey: "review-route",
      inputHash: "fixture",
      manifest: ["https://example.com/"],
      profile: "LOCAL_RAW_V1",
      declarations: {},
      methodologyVersion: "readiness-v1",
      status: "COMPLETED",
      evaluation: {
        rules: [
          { ruleId: "D01", scopeKey: "https://example.com/", outcome: "FAIL" },
        ],
      },
    },
  });
  await json(
    await audits.POST(
      post({
        action: "review",
        auditId: "review-route",
        ruleId: "D01",
        scopeKey: "https://example.com/",
        disposition: "REVIEWED",
        reason: "Confirmed HTTP failure",
      }),
    ),
  );
  expect(await admin.issueAction.findFirstOrThrow()).toMatchObject({
    auditId: "review-route",
    ruleId: "D01",
    reason: "Confirmed HTTP failure",
  });
});

it("removes both management catalog forms from real analytics GET for a single-site reader", async () => {
  const catalog = [
    { property: "properties/123", displayName: "Client A", streams: [] },
    {
      property: "properties/999",
      displayName: "Private client B",
      streams: [{ streamId: "999", defaultUri: "https://private.example" }],
    },
  ];
  await admin.analyticsConnection.create({
    data: {
      ...scope,
      encryptedRefreshToken: "unread-by-GET",
      property: "properties/123",
      streamId: "456",
      timeZone: "UTC",
      catalog,
    },
  });
  expect((await json(await analytics.GET(get()))).properties).toHaveLength(2);
  seams.actor = { ...actor, userId: "viewer" };
  const response = await json(await analytics.GET(get()));
  expect(response.properties).toEqual([]);
  expect(response.connection).not.toHaveProperty("catalog");
  expect(JSON.stringify(response)).not.toContain("Private client B");
});

it("admits reviewed declarations through actual handlers, freezes evidence and exports before/after runs", async () => {
  const { crawlerSite } = await import("../fixtures/crawler-site");
  const site = await crawlerSite();
  seams.transport = site.transport;
  const home = "https://example.com/",
    missing = home + "missing";
  const manifest = [home, missing, home + "unreadable"];
  const declarations = {
    officialUrls: [home],
    contactUrl: home + "contact",
    requiredPolicyUrls: [home + "privacy"],
    pageDeclarations: [
      {
        requestedUrl: home,
        pageType: "marketing",
        indexingIntent: "indexable",
        intendedCanonical: home,
      },
    ],
  };
  const create = (key: string, d: unknown) =>
    audits.POST(
      post({
        action: "create",
        idempotencyKey: key,
        manifest,
        declarations: d,
      }),
    );
  try {
    await json(
      await create("bad", { ...declarations, headComplete: true }),
      409,
    );
    await json(
      await create("bad", {
        pageDeclarations: [
          { requestedUrl: home, intendedCanonical: "file:///tmp/private" },
        ],
      }),
      409,
    );
    const before = await json(await create("first", declarations), 201);
    for (const url of manifest) {
      void url;
      await json(
        await audits.POST(post({ action: "step", auditId: before.id })),
      );
    }
    const saved = await json(await audits.GET(get("&auditId=" + before.id)));
    expect(saved).toMatchObject({
      methodologyVersion: "readiness-v2",
      declarations,
      evaluation: { methodologyVersion: "readiness-v2", score: null },
    });
    await json(
      await audits.POST(
        post({
          action: "review",
          auditId: before.id,
          ruleId: "D01",
          scopeKey: missing,
          disposition: "REVIEWED",
          reason: "Verified the saved 404 receipt.",
        }),
      ),
    );
    expect(
      (await json(await audits.GET(get("&auditId=" + before.id)))).evaluation,
    ).toEqual(saved.evaluation);
    site.fix();
    const next = await json(
      await create("second", {
        ...declarations,
        pageDeclarations: [
          {
            requestedUrl: home,
            intendedCanonical: missing,
            pageType: "marketing",
            indexingIntent: "indexable",
          },
        ],
      }),
      201,
    );
    for (let i = 0; i < manifest.length; i++)
      await json(await audits.POST(post({ action: "step", auditId: next.id })));
    const delta = await json(
      await audits.GET(get("&auditId=" + next.id + "&before=" + before.id)),
    );
    expect(delta.resolved).toContainEqual(
      expect.objectContaining({ ruleId: "D01", scopeKey: missing }),
    );
    expect(delta.unevaluated).toContainEqual(
      expect.objectContaining({ ruleId: "D03", scopeKey: home }),
    );
    expect(delta.scoreDelta).toBeNull();
    expect(
      (await json(await audits.GET(get("&auditId=" + before.id)))).declarations,
    ).toEqual(saved.declarations);
    const csv = await audits.GET(get("&auditId=" + before.id + "&format=csv"));
    expect(csv.status).toBe(200);
    const body = await csv.text();
    expect(body).toContain("readiness-v2");
    expect(body).toContain("Evidence references");
    const { createHash } = await import("node:crypto");
    const policyHash = createHash("sha256")
      .update("User-agent: *\nDisallow: /blocked\n")
      .digest("hex");
    const savedPage = saved.pages.find(
      (p: { requestedUrl: string }) => p.requestedUrl === home,
    );
    const finding = saved.evaluation.rules.find(
      (r: { ruleId: string; scopeKey: string }) =>
        r.ruleId === "D04" && r.scopeKey === home,
    );
    expect(finding.evidenceRefs).toContainEqual({
      source: "receipt",
      requestedUrl: home,
      fields: ["robotsPolicy"],
    });
    expect(savedPage.provenance.robotsPolicy).toMatchObject({
      sha256: policyHash,
      state: "available",
      groupAgent: "*",
      ruleCount: 1,
      requested: { url: home, allowed: true },
    });
    expect(savedPage.provenance.robotsPolicy).not.toHaveProperty("googleGroup");
    expect(body).not.toContain("googleGroup");
    const immutable = await withActor(
      db,
      actor,
      scope.workspaceId,
      async (tx) => {
        await authorizeSiteIn(
          tx,
          actor,
          scope.workspaceId,
          scope.siteId,
          "read",
        );
        return tx.auditPage.findFirstOrThrow({
          where: {
            id: savedPage.id,
            auditId: before.id,
            workspaceId: scope.workspaceId,
            audit: { siteId: scope.siteId },
          },
          select: { provenance: true, audit: { select: { evaluation: true } } },
        });
      },
    );
    const policy = (immutable.provenance as { robotsPolicy: unknown })
      .robotsPolicy as RobotsPolicyObservation;
    expect(policy).toMatchObject({
      sha256: policyHash,
      state: "available",
      googleGroup: {
        agent: "*",
        rules: [{ directive: "disallow", pattern: "/blocked" }],
      },
    });
    expect(replayGoogleRobots(policy, home)).toBe(true);
    expect(replayGoogleRobots(policy, home + "blocked")).toBe(false);
    const result = {
      ruleId: "D04",
      scopeKey: home,
      ruleVersion: "2",
      outcome: "PASS",
      reasonCode: "GOOGLEBOT_ALLOWED",
    };
    expect(finding).toMatchObject(result);
    expect(immutable.audit.evaluation).toMatchObject({
      methodologyVersion: "readiness-v2",
      rules: expect.arrayContaining([expect.objectContaining(result)]),
    });
    expect(savedPage.provenance.robotsPolicy.sha256).not.toBe(
      savedPage.provenance.sha256,
    );
    expect(body.split("\r\n").find((line) => line.includes('"D04"'))).toContain(
      policyHash,
    );
    expect(
      body.split("\r\n").find((line) => line.includes('"D01"')),
    ).not.toContain(policyHash);
  } finally {
    seams.transport = null;
    await site.close();
  }
});

it("serves the exact private original through the existing authenticated attachment handler", async () => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { localAuditArtifactStore } =
    await import("../../packages/db/src/artifact-store");
  const { bindLocalArtifactStore } =
    await import("../../packages/db/src/artifact-checkpoint");
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "lyraseo-attachment-"),
  );
  const selected = createDatabase(runtimeUrl);
  const home = "https://example.com/";
  const body = Buffer.from(
    "\uFEFF<html><body>PRIVATE_ATTACHMENT_ONLY</body></html>",
  );
  const local = await localAuditArtifactStore(root);
  const authority = await enrollTestArtifactAuthority(admin, local);
  try {
    bindLocalArtifactStore(selected, local, authority);
    seams.db = selected;
    seams.transport = async (u) =>
      u.endsWith("robots.txt")
        ? new Response(null, { status: 404 })
        : new Response(body, { headers: { "content-type": "text/html" } });
    const audit = await json(
      await audits.POST(
        post({
          action: "create",
          idempotencyKey: "private-attachment",
          manifest: [home],
        }),
      ),
      201,
    );
    const result = await json(
      await audits.POST(post({ action: "step", auditId: audit.id })),
    );
    expect(result.pages[0]).toMatchObject({
      sourceAvailability: "current",
      sourceRepresentation: "original-body",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ATTACHMENT_ONLY");
    const source = () =>
      get(
        "&auditId=" +
          audit.id +
          "&format=source&url=" +
          encodeURIComponent(home),
      );
    const attachment = await audits.GET(source());
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("Cache-Control")).toBe("private, no-store");
    expect(attachment.headers.get("Content-Disposition")).toMatch(
      /^attachment/,
    );
    expect(Buffer.from(await attachment.arrayBuffer())).toEqual(body);
    const token = source();
    token.headers.set("authorization", "Bearer synthetic-test");
    expect((await audits.GET(token)).status).toBe(404);

    for (const wrong of [
      Buffer.alloc(body.length),
      body.subarray(0, body.length - 1),
    ]) {
      bindLocalArtifactStore(selected, {
        ...local,
        async openBounded() {
          return wrong;
        },
      });
      const damaged = await audits.GET(source());
      expect(damaged.status).toBe(503);
      expect(await damaged.json()).toMatchObject({
        error: expect.stringContaining("unavailable"),
      });
    }
    seams.db = db;
    const unavailable = await audits.GET(source());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: expect.stringContaining("Private source storage is unavailable"),
    });
  } finally {
    seams.db = db;
    await authority.revoke();
    await local.close();
    await selected.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
