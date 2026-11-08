import { beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../packages/db/src";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  recordVisibilityEvidence,
} from "../../packages/db/src/visibility";
import { bindLocalArtifactStore } from "../../packages/db/src/artifact-checkpoint";
import {
  localAuditArtifactStore,
  type AuditArtifactStore,
} from "../../packages/db/src/artifact-store";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
const seams = vi.hoisted(() => ({
  db: null as unknown,
  actor: null as unknown,
  resolve: null as (() => Promise<unknown>) | null,
}));
vi.mock("@/server/auth/server", () => ({
  database: () => seams.db,
  resolveActor: async () => (seams.resolve ? seams.resolve() : seams.actor),
}));
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/visibility/route";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" };
let root: string,
  store: AuditArtifactStore,
  authority: Awaited<ReturnType<typeof enrollTestArtifactAuthority>>;
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  seams.db = db;
  seams.actor = actor;
  seams.resolve = null;
  root = await mkdtemp(
    join(await realpath(tmpdir()), "lyraseo-observation-route-"),
  );
  store = await localAuditArtifactStore(root);
  authority = await enrollTestArtifactAuthority(admin, store);
  bindLocalArtifactStore(db, store, authority);
});
afterEach(async () => {
  await authority?.revoke();
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
afterAll(() => Promise.all([db.$disconnect(), admin.$disconnect()]));
async function privateRun() {
  const p = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: [] }],
  );
  await reviewVisibilityPanel(db, actor, scope, p.id);
  const now = new Date().toISOString(),
    run = await recordVisibilityEvidence(
      db,
      actor,
      scope,
      p.id,
      {
        profile: "azure-sol-api",
        provider: "azure",
        model: "fixture",
        modelVersion: "v1",
        retrievalMode: "fixture",
        requestedLocale: { language: "en", market: "IN" },
        confirmedLocale: { language: null, market: null },
        synthetic: true,
        rawAnswerRights: true,
        observedAt: now,
        slots: [
          {
            promptId: "p",
            state: "successful",
            body: "PRIVATE_ROUTE_ANSWER",
            annotations: [],
            providerTaskId: "fixture-task",
            completedAt: now,
          },
        ],
      },
      {
        sourceNamespace: "CONTROLLED_FIXTURE_V1",
        recordingKey: "route-1",
        storageFormat: "OBSERVATION_PRIVATE_V1",
      },
    );
  return run;
}
it("requires explicit scoped read and returns private parsed JSON with no storage descriptors", async () => {
  const run = await privateRun();
  const url = `http://localhost:3000/api/visibility?workspaceId=a&siteId=a-site&runId=${run.id}`;
  const detail = await GET(new Request(url));
  expect(await detail.text()).not.toContain("PRIVATE_ROUTE_ANSWER");
  const response = await GET(
      new Request(url + "&promptId=p&action=read-answer"),
    ),
    body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain("PRIVATE_ROUTE_ANSWER");
  expect(body).not.toContain("storageKey");
  expect(body).toContain("ANSWER_PARSED_JSON_V1");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="answer.json"',
  );
  bindLocalArtifactStore(
    db,
    {
      ...store,
      openBounded: async (v) => {
        const bytes = await store.openBounded(v);
        return bytes.slice(1);
      },
    },
    authority,
  );
  const corrupt = await GET(
    new Request(url + "&promptId=p&action=read-answer"),
  );
  expect(corrupt.status).toBe(503);
  expect(await corrupt.text()).not.toContain("PRIVATE_ROUTE_ANSWER");
});
it("exposes no provider upload, collector or signer command", async () => {
  const response = await POST(
    new Request("http://localhost:3000/api/visibility", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...scope,
        action: "upload-answer",
        body: "PRIVATE_REJECTED_ANSWER",
      }),
    }),
  );
  expect(response.status).not.toBe(200);
  expect(await response.text()).not.toContain("PRIVATE_REJECTED_ANSWER");
  expect(await admin.visibilityRun.count()).toBe(0);
});
it.each(["revoked-session", "changed-session"])(
  "fresh identity verification denies %s after artifact I/O",
  async (mode) => {
    const run = await privateRun();
    let read = false;
    bindLocalArtifactStore(
      db,
      {
        ...store,
        openBounded: async (v) => {
          const bytes = await store.openBounded(v);
          read = true;
          return bytes;
        },
      },
      authority,
    );
    seams.resolve = async () => {
      if (read) {
        if (mode === "revoked-session") throw Error("UNAUTHENTICATED");
        return { ...actor, sessionId: "replacement-session" };
      }
      return actor;
    };
    const response = await GET(
      new Request(
        `http://localhost:3000/api/visibility?workspaceId=a&siteId=a-site&runId=${run.id}&promptId=p&action=read-answer`,
      ),
    );
    expect(response.status).toBe(mode === "revoked-session" ? 401 : 404);
    expect(await response.text()).not.toContain("PRIVATE_ROUTE_ANSWER");
  },
);
import { retireObservationAnswers } from "../../packages/db/src/observation-artifacts";
it.each(["grant", "rights"])(
  "rechecks %s revocation which wins while fresh identity verification is pending",
  async (mode) => {
    const run = await privateRun(),
      viewer = { ...actor, userId: "viewer" };
    let calls = 0;
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    seams.resolve = async () => {
      calls++;
      if (calls === 2) {
        reached();
        await gate;
      }
      return viewer;
    };
    const result = GET(
      new Request(
        `http://localhost:3000/api/visibility?workspaceId=a&siteId=a-site&runId=${run.id}&promptId=p&action=read-answer`,
      ),
    );
    await entered;
    try {
      if (mode === "grant")
        await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
      else await retireObservationAnswers(db, actor, scope, run.id);
    } finally {
      release();
    }
    const response = await result;
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("PRIVATE_ROUTE_ANSWER");
  },
);
it("reports a separately expired visibility result explicitly", async () => {
  const p = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: [] }],
  );
  await reviewVisibilityPanel(db, actor, scope, p.id);
  const observedAt = new Date(Date.now() - 450 * 86400000).toISOString();
  const run = await recordVisibilityEvidence(db, actor, scope, p.id, {
    profile: "azure-sol-api",
    provider: "azure",
    model: "fixture",
    modelVersion: "v1",
    retrievalMode: "fixture",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: null, market: null },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    slots: [
      {
        promptId: "p",
        state: "successful",
        body: "expired legacy",
        annotations: [],
        providerTaskId: "task",
        completedAt: observedAt,
      },
    ],
  });
  const response = await GET(
    new Request(
      `http://localhost:3000/api/visibility?workspaceId=a&siteId=a-site&runId=${run.id}`,
    ),
  );
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({ state: "result-expired" });
});
