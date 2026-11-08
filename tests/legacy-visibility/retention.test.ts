import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import {
  createVisibilityPanel,
  recordVisibilityEvidence,
  readVisibility,
  reviewVisibilityPanel,
} from "../../packages/db/src/visibility";

if (!/^lyraseo_legacy_[a-f0-9]{12}$/.test(process.env.LYRA_TEST_DB_NAME ?? ""))
  throw Error("LEGACY_VISIBILITY_OWNED_DATABASE_REQUIRED");
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});

it("denies direct runtime selection of raw answers while permitting a producer insert", async () => {
  const panel = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  await reviewVisibilityPanel(db, actor, scope, panel.id);
  const observedAt = new Date().toISOString();
  await recordVisibilityEvidence(db, actor, scope, panel.id, {
    profile: "consumer-chatgpt",
    provider: "dataforseo",
    model: "test",
    modelVersion: "test",
    retrievalMode: "standard",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: "en", market: "IN" },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    slots: [
      {
        promptId: "p",
        state: "successful",
        body: "fixture",
        annotations: [],
        providerTaskId: "task",
        completedAt: observedAt,
      },
    ],
  });
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
      return tx.$queryRaw`SELECT "rawAnswers" FROM "VisibilityRun"`;
    }),
  ).rejects.toThrow();
});

it("does not return expired raw answers when the caller supplies an earlier clock", async () => {
  const panel = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  await reviewVisibilityPanel(db, actor, scope, panel.id);
  const observedAt = new Date(Date.now() - 2000).toISOString();
  const run = await recordVisibilityEvidence(db, actor, scope, panel.id, {
    profile: "consumer-chatgpt",
    provider: "dataforseo",
    model: "test",
    modelVersion: "test",
    retrievalMode: "standard",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: "en", market: "IN" },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    slots: [
      {
        promptId: "p",
        state: "successful",
        body: "fixture",
        annotations: [],
        providerTaskId: "task",
        completedAt: observedAt,
      },
    ],
  });
  await admin.visibilityRun.update({
    where: { id: run.id },
    data: { rawExpiresAt: new Date(Date.now() - 1000) },
  });
  const result = await readVisibility(
    db,
    actor,
    scope,
    run.id,
    new Date(observedAt),
  );
  expect(result.runs[0]?.rawAnswers).toBeNull();
});
it("withholds input-derived metadata copies while retaining safe measurement status", async () => {
  const panel = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  await reviewVisibilityPanel(db, actor, scope, panel.id);
  const observedAt = new Date(Date.now() - 5000).toISOString();
  const sentinel = "private-failure-answer-marker";
  const run = await recordVisibilityEvidence(db, actor, scope, panel.id, {
    profile: "consumer-chatgpt",
    provider: "dataforseo",
    model: sentinel,
    modelVersion: "test",
    retrievalMode: "standard",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: "en", market: "IN" },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    rawRightsUntil: new Date(Date.now() - 1000).toISOString(),
    slots: [
      {
        promptId: "p",
        state: "failed",
        annotations: [],
        failureReason: sentinel,
        providerTaskId: sentinel,
        completedAt: observedAt,
      },
    ],
  });
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
      return tx.$queryRaw`SELECT slots,provenance FROM "VisibilityRun"`;
    }),
  ).rejects.toThrow();
  const list = await readVisibility(db, actor, scope);
  const detail = await readVisibility(db, actor, scope, run.id);
  expect(JSON.stringify([list, detail])).not.toContain(sentinel);
  expect(detail.runs[0]?.summary?.states.failed).toBe(1);
  expect(detail.runs[0]?.rawState).toBe("raw-expired");
});
it("rechecks the database deadline after waiting for the site lock", async () => {
  const panel = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  await reviewVisibilityPanel(db, actor, scope, panel.id);
  const observedAt = new Date().toISOString();
  const run = await recordVisibilityEvidence(db, actor, scope, panel.id, {
    profile: "consumer-chatgpt",
    provider: "dataforseo",
    model: "test",
    modelVersion: "test",
    retrievalMode: "standard",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: "en", market: "IN" },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    rawRightsUntil: new Date(Date.now() + 1000).toISOString(),
    slots: [
      {
        promptId: "p",
        state: "successful",
        body: "fixture",
        annotations: [],
        providerTaskId: "task",
        completedAt: observedAt,
      },
    ],
  });
  let release!: () => void, entered!: () => void;
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${scope.siteId} FOR UPDATE`;
      entered();
      await unlock;
    },
    { timeout: 10000 },
  );
  await locked;
  const pending = readVisibility(db, actor, scope, run.id);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  release();
  await holder;
  const result = await pending;
  expect(result.runs[0]?.rawState).toBe("raw-expired");
  expect(result.runs[0]?.rawAnswers).toBeNull();
}, 15000);
it("rechecks a revoked site grant after waiting for the site lock", async () => {
  const panel = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  await reviewVisibilityPanel(db, actor, scope, panel.id);
  const observedAt = new Date().toISOString();
  const run = await recordVisibilityEvidence(db, actor, scope, panel.id, {
    profile: "consumer-chatgpt",
    provider: "dataforseo",
    model: "test",
    modelVersion: "test",
    retrievalMode: "standard",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: "en", market: "IN" },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    slots: [
      {
        promptId: "p",
        state: "successful",
        body: "fixture",
        annotations: [],
        providerTaskId: "task",
        completedAt: observedAt,
      },
    ],
  });
  let release!: () => void, entered!: () => void;
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${scope.siteId} FOR UPDATE`;
      await tx.siteGrant.deleteMany({
        where: {
          workspaceId: scope.workspaceId,
          siteId: scope.siteId,
          userId: "viewer",
        },
      });
      entered();
      await unlock;
    },
    { timeout: 10000 },
  );
  await locked;
  const pending = readVisibility(
    db,
    { ...actor, userId: "viewer" },
    scope,
    run.id,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  await holder;
  await expect(pending).rejects.toThrow("FORBIDDEN");
}, 15000);
it("distinguishes an unexplained SQL NULL and malformed stored JSON from an erasure receipt", async () => {
  const panel = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: [] }],
  );
  await reviewVisibilityPanel(db, actor, scope, panel.id);
  const observedAt = new Date().toISOString();
  const run = await recordVisibilityEvidence(db, actor, scope, panel.id, {
    profile: "consumer-chatgpt",
    provider: "dataforseo",
    model: "test",
    modelVersion: "test",
    retrievalMode: "standard",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: "en", market: "IN" },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    slots: [
      {
        promptId: "p",
        state: "successful",
        body: "fixture",
        annotations: [],
        providerTaskId: "task",
        completedAt: observedAt,
      },
    ],
  });
  await admin.$executeRaw`UPDATE "VisibilityRun" SET "rawAnswers"=NULL WHERE id=${run.id}`;
  expect(
    (await readVisibility(db, actor, scope, run.id)).runs[0]?.rawState,
  ).toBe("not-retained-unverified");
  await admin.$executeRaw`UPDATE "VisibilityRun" SET "rawAnswers"='null'::jsonb WHERE id=${run.id}`;
  expect(
    (await readVisibility(db, actor, scope, run.id)).runs[0]?.rawState,
  ).toBe("classification-blocked");
  await admin.$executeRaw`UPDATE "VisibilityRun" SET slots=jsonb_set(slots,'{0,extraction,a,mention}','"unknown-data"'::jsonb) WHERE id=${run.id}`;
  expect(
    (await readVisibility(db, actor, scope, run.id)).runs[0]?.summary,
  ).toBeNull();
});
