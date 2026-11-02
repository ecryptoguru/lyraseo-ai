import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "../../packages/db/generated/client";
/** Disposable harness/operator provisioning only. The restricted DB clients never see this connection. */
export async function enrollTestArtifactAuthority(admin: PrismaClient) {
  const keyId = randomUUID(),
    secret = new Uint8Array(randomBytes(32));
  const inserted =
    await admin.$executeRaw`INSERT INTO lyraseo_audit.artifact_verifier(id,secret,db_oid,started)
 SELECT ${keyId}::uuid,${secret},oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database() AND lyraseo_kernel.is_test_database()`;
  if (inserted !== 1) throw Error("OWNED_LOCAL_TEST_DATABASE_REQUIRED");
  return {
    keyId,
    secret,
    revoke: async () => {
      await admin.$executeRaw`DELETE FROM lyraseo_audit.artifact_verifier WHERE id=${keyId}::uuid`;
      secret.fill(0);
    },
  };
}
