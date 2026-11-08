import { afterAll, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../packages/db/src";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  recordVisibilityEvidence,
} from "../../packages/db/src/visibility";
import { readObservationAnswer } from "../../packages/db/src/observation-artifacts";
import { bindLocalArtifactStore } from "../../packages/db/src/artifact-checkpoint";
import { localAuditArtifactStore } from "../../packages/db/src/artifact-store";
import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
if (!/^lyraseo_legacy_[a-f0-9]{12}$/.test(process.env.LYRA_TEST_DB_NAME ?? ""))
  throw Error("LEGACY_VISIBILITY_OWNED_DATABASE_REQUIRED");
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("a fenced legacy scope still finalizes and reads a private observation", async () => {
  await resetDatabase();
  await seedTenants();
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "lyraseo-legacy-private-"),
  );
  const store = await localAuditArtifactStore(root);
  const authority = await enrollTestArtifactAuthority(admin, store);
  bindLocalArtifactStore(db, store, authority);
  const scope = { workspaceId: "a", siteId: "a-site" };
  try {
    const panel = await createVisibilityPanel(
      db,
      actor,
      scope,
      [{ id: "p", text: "Tools?", label: "neutral" }],
      [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
    );
    await reviewVisibilityPanel(db, actor, scope, panel.id);
    await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_scope(${scope.workspaceId},${scope.siteId})`;
    const observedAt = new Date().toISOString();
    const run = await recordVisibilityEvidence(
      db,
      actor,
      scope,
      panel.id,
      {
        profile: "consumer-chatgpt",
        provider: "dataforseo",
        model: "fixture",
        modelVersion: "v1",
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
            body: "Alpha private fixture",
            annotations: [],
            providerTaskId: "task",
            completedAt: observedAt,
          },
        ],
      },
      {
        storageFormat: "OBSERVATION_PRIVATE_V1",
        sourceNamespace: "CONTROLLED_FIXTURE_V1",
        recordingKey: "legacy-fence-private",
      },
    );
    expect(
      (await admin.visibilityRun.findUniqueOrThrow({ where: { id: run.id } }))
        .storageFormat,
    ).toBe("OBSERVATION_PRIVATE_V1");
    const answer = await readObservationAnswer(
      db,
      actor,
      scope,
      run.id,
      "p",
      async () => actor,
    );
    expect(answer.availability.state).toBe("retained-parsed");
  } finally {
    await authority.revoke();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await admin.$executeRawUnsafe(
      "TRUNCATE lyraseo_legacy_visibility.fixture_clock,lyraseo_legacy_visibility.retry,lyraseo_legacy_visibility.authorization,lyraseo_legacy_visibility.event,lyraseo_legacy_visibility.item,lyraseo_legacy_visibility.plan,lyraseo_legacy_visibility.enrollment,lyraseo_legacy_visibility.scope",
    );
  }
}, 30000);
