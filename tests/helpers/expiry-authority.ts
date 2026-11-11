import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "../../packages/db/generated/client";
import type { AuditArtifactStore } from "../../packages/db/src/artifact-store";
import {
  bindLocalExpiryAuthority,
  unbindLocalExpiryAuthority,
  type ExpiryScope,
} from "../../packages/db/src/artifact-expiry";

/** Explicit administrator-only synthetic fixture enrollment in an owned local DB. */
export async function enrollTestExpiryAuthority(
  admin: PrismaClient,
  store: AuditArtifactStore,
  scope: ExpiryScope,
  fixtureEligibilityAt?: Date,
) {
  const [binding] = await admin.$queryRaw<
    {
      owned: boolean;
      origin: string;
      store_id: string;
      namespace_id: string;
      root_identity: unknown;
    }[]
  >`SELECT lyraseo_kernel.is_test_database() AS owned,
    jsonb_build_object('assertionVersion',r.assertion_version,'qualification',r.qualification,'backend',r.backend,
      'storeId',r.id,'root',r.root_identity,'namespaceId',n.id,'workspaceId',n.workspace_id,'namespace',n.namespace_identity)::text AS origin,
    r.id::text AS store_id,n.id::text AS namespace_id,r.root_identity
    FROM lyraseo_origin.store_registration r JOIN lyraseo_origin.store_namespace n ON n.store_id=r.id
    WHERE n.workspace_id=${scope.workspaceId}`;
  if (!binding?.owned) throw Error("OWNED_LOCAL_TEST_DATABASE_REQUIRED");
  const environmentId = randomUUID(),
    keyId = randomUUID(),
    secret = new Uint8Array(randomBytes(32));
  await admin.$executeRaw`INSERT INTO lyraseo_expiry.environment
    (id,database_oid,postmaster_started_at,maintenance_login,workspace_id,site_id,policy_version,
      store_id,namespace_id,root_identity,enrollment_identity,fixture_eligibility_at,fixture_provenance)
    SELECT ${environmentId}::uuid,oid,pg_postmaster_start_time(),'lyraseo_artifact_maintenance',
      ${scope.workspaceId},${scope.siteId},'P2B1_LOCAL_V1',${binding.store_id}::uuid,
      ${binding.namespace_id}::uuid,${JSON.stringify(binding.root_identity)}::jsonb,${randomUUID()}::uuid,
      ${fixtureEligibilityAt?.toISOString() ?? null}::timestamp,
      ${fixtureEligibilityAt ? "EXPLICIT_SYNTHETIC_CLOCK_P2B1_V1" : null}
    FROM pg_database WHERE datname=current_database() AND lyraseo_kernel.is_test_database()`;
  await admin.$executeRaw`INSERT INTO lyraseo_expiry.absence_verifier
    (id,environment_id,secret,database_oid,postmaster_started_at)
    SELECT ${keyId}::uuid,${environmentId}::uuid,${secret},oid,pg_postmaster_start_time()
    FROM pg_database WHERE datname=current_database() AND lyraseo_kernel.is_test_database()`;
  bindLocalExpiryAuthority(store, {
    keyId,
    secret,
    scope,
    origin: binding.origin,
  });
  return {
    keyId,
    origin: binding.origin,
    revoke: () => {
      unbindLocalExpiryAuthority(store);
      secret.fill(0);
    },
  };
}
