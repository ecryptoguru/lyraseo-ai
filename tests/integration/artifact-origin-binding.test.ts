import type { ProviderEvidence } from "../../packages/db/src/visibility";
import { beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { randomUUID, createHash, createHmac } from "node:crypto";
import {
  mkdtemp,
  realpath,
  rm,
  rename,
  cp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../packages/db/src";
import {
  createAuditRun,
  claimAuditRun,
  checkpointPrivateAudit,
  readAuditSource,
} from "../../packages/db/src/audits";
import { withActor } from "../../packages/db/src/context";
import {
  localAuditArtifactStore,
  localArtifactFaultFacade,
  provisionLocalArtifactNamespace,
  type AuditArtifactStore,
} from "../../packages/db/src/artifact-store";
import {
  bindLocalArtifactStore,
  witnessedObservation,
  verifiedPublication,
  type ArtifactReservation,
} from "../../packages/db/src/artifact-checkpoint";
import { acquireRawPage } from "../../packages/visibility/src/acquisition";
import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
import { webOrigin } from "../helpers/artifact-origin";
import {
  adminUrl,
  runtimeUrl,
  actor,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  roots: string[] = [],
  stores: AuditArtifactStore[] = [];
let store: AuditArtifactStore,
  root: string,
  authority: Awaited<ReturnType<typeof enrollTestArtifactAuthority>>;
const transport = async (url: string) =>
  url.endsWith("robots.txt")
    ? new Response(null, { status: 404 })
    : new Response(
        "<html><body>Origin original <a href='/about'>About</a></body></html>",
        { headers: { "content-type": "text/html" } },
      );
const hash = (x: string) => createHash("sha256").update(x).digest("hex");
async function local() {
  const path = await mkdtemp(
    join(await realpath(tmpdir()), "lyraseo-origin-db-"),
  );
  roots.push(path);
  const value = await localAuditArtifactStore(path);
  stores.push(value);
  return { path, value };
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  const local_ = await local();
  root = local_.path;
  store = local_.value;
  authority = await enrollTestArtifactAuthority(admin, store);
  bindLocalArtifactStore(db, store, authority);
});
afterEach(async () => {
  await authority?.revoke();
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
afterAll(() => Promise.all([db.$disconnect(), admin.$disconnect()]));
async function prepared(workspaceId = "a") {
  const siteId = workspaceId + "-site",
    url = workspaceId === "a" ? "https://example.com/" : "https://other.com/";
  const run = await createAuditRun(db, actor, {
    workspaceId,
    siteId,
    profile: "LOCAL_RAW_V1",
    idempotencyKey: randomUUID(),
    manifest: [url],
  });
  const scope = { workspaceId, siteId, auditId: run.id },
    lease = await claimAuditRun(db, actor, scope, "origin-test"),
    receipt = await acquireRawPage(url, url, transport),
    origin = await webOrigin(db, actor, scope, lease.fence);
  return { scope, lease, receipt, origin };
}
async function witnessed(p: Awaited<ReturnType<typeof prepared>>) {
  return witnessedObservation(
    db,
    p.lease,
    "web/" + p.scope.auditId + "/" + p.lease.fence,
    p.receipt,
    p.origin,
  );
}
async function reserve(p: Awaited<ReturnType<typeof prepared>>, data: unknown) {
  return withActor(db, actor, p.scope.workspaceId, async (tx) => {
    const [row] = await tx.$queryRaw<
      { r: ArtifactReservation }[]
    >`SELECT lyraseo_audit.web_artifact_reserve(${p.scope.siteId},${p.scope.auditId},0,${p.lease.fence}::integer,${JSON.stringify(data)}::json) AS r`;
    return row!.r;
  });
}
it("one immutable key/client/root serves two separately enrolled workspace namespaces", async () => {
  const a = await prepared("a");
  await checkpointPrivateAudit(db, actor, a.scope, a.lease.fence, a.receipt);
  const b = await prepared("b");
  await checkpointPrivateAudit(db, actor, b.scope, b.lease.fence, b.receipt);
  const bindings = await admin.$queryRaw<
    { workspace_id: string; store_id: string; namespace_id: string }[]
  >`SELECT workspace_id,store_id::text,namespace_id::text FROM lyraseo_origin.blob_store_binding ORDER BY workspace_id`;
  expect(bindings.map((b) => b.workspace_id)).toEqual(["a", "b"]);
  expect(new Set(bindings.map((b) => b.store_id)).size).toBe(1);
  expect(new Set(bindings.map((b) => b.namespace_id)).size).toBe(2);
  await expect(
    readAuditSource(
      db,
      actor,
      { ...a.scope, workspaceId: "b" },
      a.receipt.evidence.requestedUrl,
      async () => actor,
    ),
  ).rejects.toThrow();
});
it.each([
  "empty-root",
  "copied-root",
  "fabricated-inspector",
  "copied-store",
] as const)(
  "rejects %s using the original key before reservation",
  async (kind) => {
    const p = await prepared(),
      other = await local();
    let replacement: AuditArtifactStore = other.value;
    if (kind === "empty-root")
      await provisionLocalArtifactNamespace(other.value, "a");
    if (kind === "copied-root")
      await cp(root, other.path, { recursive: true, force: true });
    if (kind === "fabricated-inspector")
      replacement = {
        ...other.value,
        inspectOrigin: async () => store.inspectOrigin("a"),
      };
    if (kind === "copied-store") replacement = { ...store };
    bindLocalArtifactStore(db, replacement, authority);
    await expect(witnessed(p)).rejects.toThrow("ARTIFACT_UNAVAILABLE");
    expect(await admin.artifactBlob.count()).toBe(0);
    expect(
      await admin.$queryRaw`SELECT * FROM lyraseo_origin.blob_store_binding`,
    ).toEqual([]);
  },
);
it("backend replacement after a source inspection begins cannot inherit its signing authority", async () => {
  const p = await prepared(),
    other = await local(),
    pending = witnessed(p);
  bindLocalArtifactStore(db, other.value, authority);
  await expect(pending).rejects.toThrow("ARTIFACT_UNAVAILABLE");
  expect(await admin.artifactBlob.count()).toBe(0);
});
it.each(["after-witness", "after-reserve", "after-put", "after-read"] as const)(
  "namespace/root mutation %s never publishes or rebinds the original physical generation",
  async (phase) => {
    const p = await prepared(),
      data = await witnessed(p);
    const mutate = async () => {
      const marker = join(root, ".store-origin-v1"),
        bytes = await readFile(marker);
      await rename(marker, marker + "-original");
      await writeFile(marker, bytes, { mode: 0o600 });
    };
    if (phase === "after-witness") await mutate();
    const reservation = await reserve(p, data),
      original = await admin.artifactBlob.findFirstOrThrow();
    if (phase === "after-reserve") {
      const ns = join(root, hash("a"));
      await rename(ns, ns + "-original");
      await cp(ns + "-original", ns, { recursive: true });
    }
    if (phase === "after-put" || phase === "after-read")
      bindLocalArtifactStore(
        db,
        localArtifactFaultFacade(store, {
          after: async (op) => {
            if (op === (phase === "after-put" ? "put" : "read")) await mutate();
          },
        }),
        authority,
      );
    await expect(
      verifiedPublication(db, p.lease, p.receipt, reservation),
    ).rejects.toThrow("ARTIFACT_UNAVAILABLE");
    expect(await admin.artifactBlob.findFirstOrThrow()).toEqual(original);
    expect(await admin.artifactRef.count()).toBe(0);
    expect(await admin.auditPage.count()).toBe(0);
    const [binding] = await admin.$queryRaw<
      { origin: string }[]
    >`SELECT lyraseo_origin.blob_descriptor(b) AS origin FROM "ArtifactBlob" b`;
    expect(binding!.origin).toBe(p.origin);
  },
);
it("blob and immutable binding roll back together when binding insertion fails", async () => {
  const p = await prepared(),
    data = await witnessed(p);
  await admin.$executeRawUnsafe(
    "CREATE FUNCTION public.origin_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ORIGIN_BINDING_ROLLBACK';END $$",
  );
  await admin.$executeRawUnsafe(
    "CREATE TRIGGER origin_test_failure AFTER INSERT ON lyraseo_origin.blob_store_binding FOR EACH ROW EXECUTE FUNCTION public.origin_test_fail()",
  );
  try {
    await expect(reserve(p, data)).rejects.toThrow("ORIGIN_BINDING_ROLLBACK");
    expect(await admin.artifactBlob.count()).toBe(0);
    expect(
      await admin.$queryRaw`SELECT * FROM lyraseo_origin.blob_store_binding`,
    ).toEqual([]);
  } finally {
    await admin.$executeRawUnsafe(
      "DROP FUNCTION public.origin_test_fail() CASCADE",
    );
  }
});
it("concurrent/replayed reservation retains exactly one original generation and binding", async () => {
  const p = await prepared(),
    data = await witnessed(p),
    [a, b] = await Promise.all([reserve(p, data), reserve(p, data)]);
  expect(a).toEqual(b);
  expect(await admin.artifactBlob.count()).toBe(1);
  expect(
    (
      await admin.$queryRaw<
        unknown[]
      >`SELECT * FROM lyraseo_origin.blob_store_binding`
    ).length,
  ).toBe(1);
  const before = await admin.artifactBlob.findFirstOrThrow();
  expect(await reserve(p, data)).toEqual(a);
  expect(await admin.artifactBlob.findFirstOrThrow()).toEqual(before);
});
it("old in-flight unbound generation cannot be adopted, while unbound finalized reads keep fresh Actor behavior", async () => {
  const p = await prepared(),
    data = await witnessed(p);
  await reserve(p, data);
  await admin.$executeRaw`TRUNCATE lyraseo_origin.blob_store_binding`;
  const original = await admin.artifactBlob.findFirstOrThrow();
  await expect(reserve(p, data)).rejects.toThrow("ARTIFACT_ORIGIN_REQUIRED");
  expect(await admin.artifactBlob.findFirstOrThrow()).toEqual(original);
  expect(
    await admin.$queryRaw`SELECT * FROM lyraseo_origin.blob_store_binding`,
  ).toEqual([]);
  await authority.revoke();
  await resetDatabase();
  await seedTenants();
  authority = await enrollTestArtifactAuthority(admin, store);
  bindLocalArtifactStore(db, store, authority);
  const q = await prepared();
  await checkpointPrivateAudit(db, actor, q.scope, q.lease.fence, q.receipt);
  await admin.$executeRaw`TRUNCATE lyraseo_origin.blob_store_binding`;
  const saved = await admin.artifactBlob.findFirstOrThrow();
  let refresh = 0;
  const source = await readAuditSource(
    db,
    actor,
    q.scope,
    q.receipt.evidence.requestedUrl,
    async () => {
      refresh++;
      return actor;
    },
  );
  expect(source.length).toBe(saved.sourceLength);
  expect(refresh).toBe(1);
  expect(await admin.artifactBlob.findFirstOrThrow()).toEqual(saved);
  expect(
    await admin.$queryRaw`SELECT * FROM lyraseo_origin.blob_store_binding`,
  ).toEqual([]);
});
it("SQL independently rejects downgraded/pasted origin and cross-workspace source assertions", async () => {
  const p = await prepared(),
    data = await witnessed(p);
  for (const forged of [
    {
      ...data,
      originAssertion: {
        ...data.originAssertion,
        origin: data.originAssertion.origin.replace(
          "STORE_ORIGIN_V1",
          "STORE_ORIGIN_V0",
        ),
      },
    },
    {
      ...data,
      originAssertion: {
        ...data.originAssertion,
        origin: JSON.stringify({
          ...JSON.parse(p.origin),
          storeId: randomUUID(),
        }),
      },
    },
    {
      ...data,
      originAssertion: {
        ...data.originAssertion,
        origin: JSON.stringify({ ...JSON.parse(p.origin), workspaceId: "b" }),
      },
    },
    {
      ...data,
      originAssertion: {
        keyId: authority.keyId,
        mac: data.originAssertion.mac,
      },
    },
  ])
    await expect(reserve(p, forged)).rejects.toThrow(
      "ARTIFACT_ORIGIN_REQUIRED",
    );
  // An old-format MAC cannot authorize a new selected reservation even with a pasted correct descriptor.
  const oldMac = createHmac("sha256", authority.secret)
    .update(
      [
        "audit-origin-v1",
        "web/" + p.scope.auditId + "/" + p.lease.fence,
        hash(JSON.stringify(data.evidence)),
        hash(JSON.stringify(data.provenance)),
      ].join("\n"),
    )
    .digest("hex");
  await expect(
    reserve(p, {
      ...data,
      originAssertion: { ...data.originAssertion, mac: oldMac },
    }),
  ).rejects.toThrow("CONFIRMATION_REQUIRED");
  expect(await admin.artifactBlob.count()).toBe(0);
});
it("restricted runtime/dispatch/identity logins cannot enroll, read, mutate or bind origins", async () => {
  const { testDatabaseRoleUrl } =
    await import("../helpers/test-database-target");
  for (const role of [
    "lyraseo_runtime",
    "lyraseo_dispatch",
    "lyraseo_identity",
  ]) {
    const login = createDatabase(testDatabaseRoleUrl(role));
    try {
      expect(await login.$queryRaw`SELECT current_user AS role`).toEqual([
        { role },
      ]);
      for (const table of [
        "store_registration",
        "store_namespace",
        "source_store_key",
        "blob_store_binding",
      ]) {
        await expect(
          login.$queryRawUnsafe("SELECT * FROM lyraseo_origin." + table),
        ).rejects.toThrow();
        await expect(
          login.$executeRawUnsafe(
            "INSERT INTO lyraseo_origin." + table + " DEFAULT VALUES",
          ),
        ).rejects.toThrow();
        await expect(
          login.$executeRawUnsafe("DELETE FROM lyraseo_origin." + table),
        ).rejects.toThrow();
      }
      await expect(
        login.$queryRaw`SELECT lyraseo_origin.descriptor('a',${authority.keyId})`,
      ).rejects.toThrow();
    } finally {
      await login.$disconnect();
    }
  }
});
it("verifier revocation removes live authority without erasing/remapping historical key-store provenance", async () => {
  const p = await prepared(),
    data = await witnessed(p),
    [before] = await admin.$queryRaw<
      unknown[]
    >`SELECT * FROM lyraseo_origin.source_store_key WHERE key_id=${authority.keyId}::uuid`;
  await authority.revoke();
  await expect(reserve(p, data)).rejects.toThrow("ARTIFACT_ORIGIN_REQUIRED");
  const [after] = await admin.$queryRaw<
    unknown[]
  >`SELECT * FROM lyraseo_origin.source_store_key WHERE key_id=${authority.keyId}::uuid`;
  expect(after).toEqual(before);
  await expect(
    admin.$executeRaw`UPDATE lyraseo_origin.source_store_key SET store_id=${randomUUID()}::uuid WHERE key_id=${authority.keyId}::uuid`,
  ).rejects.toThrow("IMMUTABLE_ARTIFACT_ORIGIN");
});

// No physical origin exists for a logical slot without bytes. The original facts/clocks
// remain authoritative, including when a current all-NO_BODY attempt changes roots.
it.each([false, true])(
  "%s mixed recording root change respects physical origin versus NO_BODY identity",
  async (mixed) => {
    const {
      createVisibilityPanel,
      reviewVisibilityPanel,
      recordVisibilityEvidence,
    } = await import("../../packages/db/src/visibility");
    const { normalizeObservation } =
      await import("../../packages/db/src/observation-source");
    const { witnessedNormalizedObservation } =
      await import("../../packages/db/src/artifact-checkpoint");
    const { observationOrigin } = await import("../helpers/artifact-origin");
    const scope = { workspaceId: "a", siteId: "a-site" },
      recording = {
        storageFormat: "OBSERVATION_PRIVATE_V1" as const,
        sourceNamespace: "CONTROLLED_FIXTURE_V1" as const,
        recordingKey: "origin-no-body",
      };
    const panel = await reviewVisibilityPanel(
      db,
      actor,
      scope,
      (
        await createVisibilityPanel(
          db,
          actor,
          scope,
          [
            { id: "p", text: "Which?", label: "neutral" as const },
            ...(mixed
              ? [{ id: "q", text: "Other?", label: "neutral" as const }]
              : []),
          ],
          [
            {
              id: "a",
              name: "Alpha",
              aliases: ["Alpha"],
              domains: ["alpha.com"],
            },
          ],
        )
      ).id,
    );
    const evidence: ProviderEvidence = {
      profile: "consumer-chatgpt" as const,
      provider: "dataforseo",
      model: "fixture",
      modelVersion: "v1",
      retrievalMode: "standard",
      requestedLocale: { language: "en", market: "IN" },
      confirmedLocale: { language: "en", market: "IN" },
      synthetic: true,
      rawAnswerRights: true,
      observedAt: new Date(Date.now() - 86400000).toISOString(),
      slots: [
        {
          promptId: "p",
          state: "failed" as const,
          failureReason: "PROVIDER_FAILED",
          providerTaskId: "fixture-p",
          completedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
          annotations: [],
        },
        ...(mixed
          ? [
              {
                promptId: "q",
                state: "successful" as const,
                body: "Alpha",
                providerTaskId: "fixture-q",
                completedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
                annotations: [],
              },
            ]
          : []),
      ],
    };
    const source = normalizeObservation(panel, evidence, recording),
      origin = await observationOrigin(db, actor, scope, panel.id);
    const [ctx] = await withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw<
          { context: string }[]
        >`SELECT lyraseo_observation.source_context('a-site',${panel.id},0,${actor.sessionId}) AS context`,
    );
    const witness = await witnessedNormalizedObservation(
      db,
      source,
      ctx!.context,
      origin,
    );
    await withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw`SELECT lyraseo_observation.reserve('a-site',${panel.id},0,${actor.sessionId},'CONTROLLED_FIXTURE_V1',${recording.recordingKey},${JSON.stringify(witness.submitted)}::json,${JSON.stringify(witness.confirmation)}::json)`,
    );
    const before = await admin.visibilityRecording.findFirstOrThrow(),
      slots = await admin.visibilityObservationSlot.findMany({
        orderBy: { promptId: "asc" },
      }),
      blobs = await admin.artifactBlob.findMany();
    const next = await local(),
      nextAuthority = await enrollTestArtifactAuthority(admin, next.value);
    bindLocalArtifactStore(db, next.value, nextAuthority);
    try {
      if (mixed) {
        await expect(
          recordVisibilityEvidence(
            db,
            actor,
            scope,
            panel.id,
            evidence,
            recording,
          ),
        ).rejects.toThrow("ARTIFACT_ORIGIN_REQUIRED");
        expect(await admin.visibilityRecording.findFirstOrThrow()).toEqual(
          before,
        );
        expect(await admin.artifactBlob.findMany()).toEqual(blobs);
        expect(
          await admin.visibilityObservationSlot.findMany({
            orderBy: { promptId: "asc" },
          }),
        ).toEqual(slots);
        expect(await admin.visibilityRun.count()).toBe(0);
      } else {
        const result = await recordVisibilityEvidence(
            db,
            actor,
            scope,
            panel.id,
            evidence,
            recording,
          ),
          after = await admin.visibilityRecording.findFirstOrThrow();
        expect(after.observedAt).toEqual(before.observedAt);
        expect(after.rawExpiresAt).toEqual(before.rawExpiresAt);
        expect(after.sourceBinding).toBe(before.sourceBinding);
        expect(after.manifestHash).toBe(before.manifestHash);
        expect(await admin.visibilityObservationSlot.findMany()).toEqual(slots);
        expect(await admin.artifactBlob.count()).toBe(0);
        expect(
          await admin.$queryRaw`SELECT * FROM lyraseo_origin.blob_store_binding`,
        ).toEqual([]);
        await nextAuthority.revoke();
        bindLocalArtifactStore(db, { ...next.value });
        expect(
          await recordVisibilityEvidence(
            db,
            actor,
            scope,
            panel.id,
            evidence,
            recording,
          ),
        ).toEqual(result);
        await expect(
          recordVisibilityEvidence(
            db,
            actor,
            scope,
            panel.id,
            {
              ...evidence,
              slots: [
                {
                  promptId: "p",
                  state: "successful",
                  body: "new body",
                  providerTaskId: "fixture-p",
                  completedAt: evidence.slots[0]!.completedAt,
                  annotations: [],
                },
              ],
            },
            recording,
          ),
        ).rejects.toThrow("IMMUTABLE_OBSERVATION");
      }
    } finally {
      await nextAuthority.revoke();
    }
  },
);
it.each(["copied", "different-root"] as const)(
  "a %s backend rebind after verified reads cannot reuse a prior publication witness",
  async (kind) => {
    const p = await prepared(),
      data = await witnessed(p),
      reservation = await reserve(p, data),
      other = await local();
    await provisionLocalArtifactNamespace(other.value, "a");
    let read = false;
    const facade = localArtifactFaultFacade(store, {
      after: (operation) => {
        if (operation !== "read") return;
        read = true;
        bindLocalArtifactStore(
          db,
          kind === "copied" ? { ...store } : other.value,
          authority,
        );
      },
    });
    bindLocalArtifactStore(db, facade, authority);
    await expect(
      verifiedPublication(db, p.lease, p.receipt, reservation),
    ).rejects.toThrow("ARTIFACT_UNAVAILABLE");
    expect(read).toBe(true);
    expect(await store.statVersion(reservation.version!)).toBe(true);
    expect(await admin.artifactRef.count()).toBe(0);
    expect(await admin.auditPage.count()).toBe(0);
  },
);
it("an authorized but unenrolled workspace cannot initialize or reuse another namespace", async () => {
  const before = await readdir(root);
  await admin.workspace.create({ data: { id: "c", name: "Unenrolled" } });
  await admin.membership.create({
    data: { workspaceId: "c", userId: actor.userId, role: "OWNER" },
  });
  await admin.site.create({
    data: {
      id: "c-site",
      workspaceId: "c",
      origin: "https://other.com",
      verifiedAt: new Date(),
    },
  });
  await expect(prepared("c")).rejects.toThrow("ARTIFACT_ORIGIN_REQUIRED");
  expect(await readdir(root)).toEqual(before);
  expect(await admin.artifactBlob.count()).toBe(0);
});
it("a live migration25-style verifier key without immutable enrollment cannot authorize a new reservation", async () => {
  const p = await prepared(),
    keyId = randomUUID(),
    secret = Buffer.alloc(32, 7);
  await admin.$executeRaw`INSERT INTO lyraseo_audit.artifact_verifier(id,secret,db_oid,started) SELECT ${keyId}::uuid,${secret},oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database()`;
  try {
    bindLocalArtifactStore(db, store, { keyId, secret });
    await expect(webOrigin(db, actor, p.scope, p.lease.fence)).rejects.toThrow(
      "ARTIFACT_ORIGIN_REQUIRED",
    );
    expect(await admin.artifactBlob.count()).toBe(0);
  } finally {
    await admin.$executeRaw`DELETE FROM lyraseo_audit.artifact_verifier WHERE id=${keyId}::uuid`;
    secret.fill(0);
  }
});
it("publication independently rejects pasted/downgraded origin, source-MAC reuse and generation substitution", async () => {
  const p = await prepared(),
    data = await witnessed(p),
    reservation = await reserve(p, data),
    publication = await verifiedPublication(
      db,
      p.lease,
      p.receipt,
      reservation,
    );
  const commit = (body: unknown) =>
    withActor(
      db,
      actor,
      "a",
      (tx) =>
        tx.$queryRaw`SELECT lyraseo_audit.web_artifact_commit('a-site',${p.scope.auditId},0,${p.lease.fence}::integer,${JSON.stringify(body)}::json,NULL)`,
    );
  await expect(
    commit({
      ...publication,
      confirmation: {
        ...publication.confirmation,
        origin: publication.confirmation.origin.replace(
          "STORE_ORIGIN_V1",
          "STORE_ORIGIN_V0",
        ),
      },
    }),
  ).rejects.toThrow("ARTIFACT_ORIGIN_REQUIRED");
  await expect(
    commit({
      ...publication,
      confirmation: {
        ...publication.confirmation,
        origin: JSON.stringify({
          ...JSON.parse(publication.confirmation.origin),
          namespaceId: randomUUID(),
        }),
      },
    }),
  ).rejects.toThrow("ARTIFACT_ORIGIN_REQUIRED");
  await expect(
    commit({ ...publication, confirmation: data.captureConfirmation }),
  ).rejects.toThrow("CONFIRMATION_REQUIRED");
  await expect(
    commit({
      ...publication,
      version: { ...publication.version, generation: randomUUID() },
    }),
  ).rejects.toThrow("INVALID_ARTIFACT");
  expect(await admin.auditPage.count()).toBe(0);
  expect(await admin.artifactRef.count()).toBe(0);
});
