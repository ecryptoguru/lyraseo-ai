import { createHash } from "node:crypto";
import type { PrismaClient } from "../../packages/db/generated/client";
import type { Actor } from "../../packages/db/src/context";
import {
  assertRecoveryJournal,
  type RecoveryJournal,
} from "../../packages/db/src/recovery-journal";
/** Privileged synthetic fixture ONLY. This is not user admission or a production issuer. */
export async function stagePrivilegedSyntheticDeletion(
  admin: PrismaClient,
  actor: Actor,
  scope: { workspaceId: string; siteId: string },
  input: { caseId: string; requestId: string; confirmIncarnation: string },
  journal: RecoveryJournal,
) {
  assertRecoveryJournal(journal);
  const [authority] = await admin.$queryRaw<
    { database: string; role: string }[]
  >`SELECT current_database() database,session_user::text role`;
  if (
    !authority ||
    authority.role !== "postgres" ||
    !/^lyraseo_recovery_[a-f0-9]{12}$/.test(authority.database)
  )
    throw Error("PRIVILEGED_OWNED_SYNTHETIC_FIXTURE_REQUIRED");
  const intent = await journal.intent({
    caseId: input.caseId,
    requestId: input.requestId,
    workspaceId: scope.workspaceId,
    siteId: scope.siteId,
    incarnation: input.confirmIncarnation,
    epoch: 1,
    action: "DELETE_SITE",
  });
  const receiptHash = createHash("sha256")
    .update(JSON.stringify({ fixture: "NOT_USER_ADMISSION", intent }))
    .digest("hex");
  const receipt = await admin.$transaction(async (tx) => {
    const [clock] = await tx.$queryRaw<
      { stamp: string }[]
    >`SELECT clock_timestamp()::text stamp`;
    if (!clock) throw Error("SYNTHETIC_CLOCK_UNAVAILABLE");
    await tx.$executeRaw`UPDATE "Site" SET "deletedAt"=${clock.stamp}::timestamptz AT TIME ZONE 'UTC' WHERE "workspaceId"=${scope.workspaceId} AND id=${scope.siteId}`;
    const [row] = await tx.$queryRaw<
      { acceptedAt: string; deadline: string; recordExpiresAt: string }[]
    >`INSERT INTO lyraseo_deletion.scope_case(id,request_id,workspace_id,site_id,incarnation,actor_id,actor_security_version,journal_partition,journal_sequence,journal_hash,accepted_at,deadline,record_expires_at,receipt_hash) VALUES(${input.caseId}::uuid,${input.requestId}::uuid,${scope.workspaceId},${scope.siteId},${input.confirmIncarnation}::uuid,${actor.userId},${actor.securityVersion},${intent.partition}::uuid,${intent.sequence}::bigint,${intent.hash},${clock.stamp}::timestamptz,${clock.stamp}::timestamptz+interval '7 days',${clock.stamp}::timestamptz+interval '180 days',${receiptHash}) RETURNING accepted_at::text "acceptedAt",deadline::text deadline,record_expires_at::text "recordExpiresAt"`;
    if (!row) throw Error("SYNTHETIC_CASE_NOT_STAGED");
    await tx.$executeRaw`INSERT INTO lyraseo_deletion.task(case_id,kind) SELECT ${input.caseId}::uuid,unnest(ARRAY['IMPORTS','CREDENTIALS','AUTHORED_PAYLOAD','AUDIT_PAYLOAD','ARTIFACTS','VISIBILITY_PAYLOAD','KEYWORD_DATA','HANDOFF_DATA','TEAM_DATA','PROCESSORS','BACKUPS','FINANCIAL_IDENTITY'])`;
    return row;
  });
  await journal.applied(intent, receiptHash, receipt);
  return { id: input.caseId, receiptHash, ...receipt };
}
