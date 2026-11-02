import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  recordVisibilityEvidence,
  readVisibility,
  requestVisibilityRun,
  type ProviderEvidence,
} from "../../packages/db/src/visibility";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" };
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
async function panel() {
  const p = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  return reviewVisibilityPanel(db, actor, scope, p.id);
}
const evidence: ProviderEvidence = {
  profile: "consumer-chatgpt",
  provider: "dataforseo",
  model: "provider-undisclosed",
  modelVersion: "provider-undisclosed",
  retrievalMode: "standard",
  requestedLocale: { language: "en", market: "IN" },
  confirmedLocale: { language: "en", market: "IN" },
  synthetic: true,
  rawAnswerRights: true,
  observedAt: new Date().toISOString(),
  slots: [
    {
      promptId: "p",
      state: "successful",
      body: "No brands here",
      annotations: [],
      providerTaskId: "synthetic-contract",
      completedAt: new Date().toISOString(),
    },
  ],
};
it("persists immutable reviewed versions and explicit unavailable collection", async () => {
  const p = await panel();
  await expect(
    admin.visibilityPanel.update({
      where: { id: p.id },
      data: { prompts: [] },
    }),
  ).rejects.toThrow();
  expect(
    await requestVisibilityRun(db, actor, scope, p.id, "azure-sol-api"),
  ).toMatchObject({ available: false });
  const next = await createVisibilityPanel(
    db,
    actor,
    scope,
    [{ id: "p", text: "Changed?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: [] }],
  );
  expect(next.version).toBe(2);
  await expect(
    requestVisibilityRun(db, actor, scope, next.id, "azure-sol-api"),
  ).rejects.toThrow("REVIEWED_PANEL_REQUIRED");
});
it("retains synthetic provenance, hides list raw answers and expires detail on reads", async () => {
  const p = await panel(),
    r = await recordVisibilityEvidence(db, actor, scope, p.id, evidence);
  const list = await readVisibility(db, actor, scope);
  expect(list.runs[0]).not.toHaveProperty("rawAnswers");
  expect(list.runs[0]?.summary?.brands.a?.mention).toMatchObject({
    rate: 0,
    denominator: 1,
  });
  expect(
    (await readVisibility(db, actor, scope, r.id)).runs[0]?.rawAnswers,
  ).not.toBeNull();
  await admin.visibilityRun.update({
    where: { id: r.id },
    data: { rawExpiresAt: new Date(Date.now() - 1) },
  });
  expect(
    (await readVisibility(db, actor, scope, r.id)).runs[0]?.rawAnswers,
  ).toBeNull();
  expect(
    (
      await readVisibility(
        db,
        actor,
        scope,
        r.id,
        new Date(Date.now() + 400 * 86400000),
      )
    ).runs,
  ).toHaveLength(0);
});
it("rejects cross-site evidence, revoked grants and consumer API substitution", async () => {
  const p = await panel();
  await expect(
    recordVisibilityEvidence(
      db,
      actor,
      { workspaceId: "b", siteId: "b-site" },
      p.id,
      evidence,
    ),
  ).rejects.toThrow("REVIEWED_PANEL_REQUIRED");
  await expect(
    recordVisibilityEvidence(db, actor, scope, p.id, {
      ...evidence,
      provider: "azure",
    }),
  ).rejects.toThrow("PROFILE_PROVIDER_MISMATCH");
  await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
  await expect(
    readVisibility(db, { ...actor, userId: "viewer" }, scope),
  ).rejects.toThrow("FORBIDDEN");
});

it("rejects unqualified raw rights and silently substituted locale", async () => {
  const p = await panel();
  await expect(
    recordVisibilityEvidence(db, actor, scope, p.id, {
      ...evidence,
      rawAnswerRights: false,
    }),
  ).rejects.toThrow("INVALID_PROVIDER_EVIDENCE");
  await expect(
    recordVisibilityEvidence(db, actor, scope, p.id, {
      ...evidence,
      confirmedLocale: { language: "en", market: "US" },
    }),
  ).rejects.toThrow("UNSUPPORTED_PROVIDER_LOCALE");
});
