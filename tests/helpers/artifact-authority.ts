import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "../../packages/db/generated/client";
import {
  provisionLocalArtifactNamespace,
  type AuditArtifactStore,
} from "../../packages/db/src/artifact-store";
/** Disposable operator provisioning only. Never imported by application boot or HTTP. */
export async function enrollTestArtifactAuthority(
  admin: PrismaClient,
  store: AuditArtifactStore,
  workspaces = ["a", "b"],
) {
  const keyId = randomUUID(),
    secret = new Uint8Array(randomBytes(32));
  const [environment] = await admin.$queryRaw<
    { owned: boolean }[]
  >`SELECT lyraseo_kernel.is_test_database() AS owned`;
  if (!environment?.owned) throw Error("OWNED_LOCAL_TEST_DATABASE_REQUIRED");
  let storeId: string | undefined;
  for (const workspace of workspaces) {
    const origin = await provisionLocalArtifactNamespace(store, workspace);
    const provenance = createHash("sha256")
      .update(
        JSON.stringify(["EXPLICIT_LOCAL_FIXTURE_ORIGIN_V1", workspace, origin]),
      )
      .digest("hex");
    const rootJson = JSON.stringify(origin.root),
      namespaceJson = JSON.stringify(origin.namespace);
    await admin.$executeRaw`INSERT INTO lyraseo_origin.store_registration(id,root_identity,assertion_version,backend,qualification,provenance_digest) VALUES(${randomUUID()}::uuid,${rootJson}::jsonb,'STORE_ORIGIN_V1','POSIX_FD_V1','LOCAL_TEST_ONLY',${provenance}) ON CONFLICT(root_identity) DO NOTHING`;
    const [registered] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT id::text FROM lyraseo_origin.store_registration WHERE root_identity=${rootJson}::jsonb`;
    if (!registered) throw Error("ARTIFACT_ORIGIN_REQUIRED");
    storeId = registered.id;
    await admin.$executeRaw`INSERT INTO lyraseo_origin.store_namespace(id,store_id,workspace_id,namespace_identity,provenance_digest) VALUES(${randomUUID()}::uuid,${storeId}::uuid,${workspace},${namespaceJson}::jsonb,${provenance}) ON CONFLICT(store_id,workspace_id) DO NOTHING`;
    const [namespace] = await admin.$queryRaw<
      { same: boolean }[]
    >`SELECT namespace_identity=${namespaceJson}::jsonb AS same FROM lyraseo_origin.store_namespace WHERE store_id=${storeId}::uuid AND workspace_id=${workspace}`;
    if (!namespace?.same) throw Error("IMMUTABLE_ARTIFACT_ORIGIN");
  }
  if (!storeId) throw Error("ARTIFACT_ORIGIN_REQUIRED");
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO lyraseo_audit.artifact_verifier(id,secret,db_oid,started) SELECT ${keyId}::uuid,${secret},oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database() AND lyraseo_kernel.is_test_database()`;
    const provenance = createHash("sha256")
      .update(JSON.stringify(["EXPLICIT_LOCAL_FIXTURE_KEY_V1", keyId, storeId]))
      .digest("hex");
    await tx.$executeRaw`INSERT INTO lyraseo_origin.source_store_key(key_id,store_id,provenance_digest) VALUES(${keyId}::uuid,${storeId}::uuid,${provenance})`;
  });
  return {
    keyId,
    secret,
    revoke: async () => {
      // Revoke live authority; immutable historical key/store provenance survives.
      await admin.$executeRaw`DELETE FROM lyraseo_audit.artifact_verifier WHERE id=${keyId}::uuid`;
      secret.fill(0);
    },
  };
}
