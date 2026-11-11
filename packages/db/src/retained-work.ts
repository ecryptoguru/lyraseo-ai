import { Prisma as Sql, type PrismaClient } from "../generated/client";
import { withEvidenceRead, type Actor } from "./context";
import type { HistoryScope } from "./history-retention";
import type { RecoveryRecordInput } from "./recovery-points";

/** One PostgreSQL statement provides one consistent data snapshot. Final
 * withEvidenceRead checks use a fresh READ COMMITTED statement after the export.
 * No original PDF/CSV, raw source, token, integration or execution row is selected. */
export async function exportRetainedWork(
  db: PrismaClient,
  actor: Actor,
  scope: HistoryScope,
) {
  if ("credential" in actor) throw Error("FORBIDDEN");
  return withEvidenceRead(db, actor, scope, "export", undefined, async (tx) => {
    type Revision = {
      id: string;
      draftId: string;
      revision: number;
      head: boolean;
      pinned: boolean;
      createdAt: string;
      content: unknown;
    };
    type Summary = {
      id: string;
      title: string;
      createdAt: string;
      snapshot: unknown;
    };
    const [reportService] = await tx.$queryRaw<
      { available: boolean }[]
    >`SELECT to_regprocedure('lyraseo_report.snapshot(text,text,text)') IS NOT NULL available`;
    // Presence does not prove an exact historical schema/ACL profile. Never
    // fall back to reading raw report columns when the authorized service is absent.
    if (!reportService?.available)
      throw Error("RECOVERY_REPORT_PROJECTION_UNQUALIFIED");
    const reportProjection = Sql.sql`lyraseo_report.snapshot(${scope.workspaceId},${scope.siteId},id)`;
    const [row] = await tx.$queryRaw<
      Array<{
        identity: { incarnation: string; deleted: boolean };
        snapshotAt: string;
        draftCount: number;
        revisions: Revision[];
        summaries: Summary[];
      }>
    >`
      SELECT lyraseo_deletion.identity(${scope.workspaceId},${scope.siteId},${actor.securityVersion}::integer) identity,
       to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "snapshotAt",
       (SELECT count(*)::integer FROM "ContentDraft" WHERE "workspaceId"=${scope.workspaceId} AND "siteId"=${scope.siteId}) "draftCount",
       (SELECT coalesce(jsonb_agg(to_jsonb(bounded)),'[]') FROM (
         SELECT r.id,r."draftId",r.revision,r.revision=d.revision head,p."draftId" IS NOT NULL pinned,
          to_char(r."createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "createdAt",r.content
         FROM "ContentRevision" r JOIN "ContentDraft" d ON (d."workspaceId",d.id)=(r."workspaceId",r."draftId")
          LEFT JOIN "ContentRevisionPin" p ON (p."workspaceId",p."draftId",p.revision)=(r."workspaceId",r."draftId",r.revision)
         WHERE d."workspaceId"=${scope.workspaceId} AND d."siteId"=${scope.siteId}
          AND (r.revision=d.revision OR p."draftId" IS NOT NULL OR r."historyExpiresAt">statement_timestamp() AT TIME ZONE 'UTC')
         ORDER BY r.id LIMIT 10001) bounded) revisions,
       (SELECT coalesce(jsonb_agg(to_jsonb(bounded)),'[]') FROM (
         SELECT id,title,to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "createdAt",${reportProjection} snapshot
         FROM "EvidenceReport" WHERE "workspaceId"=${scope.workspaceId} AND "siteId"=${scope.siteId}
         ORDER BY id LIMIT 10001) bounded) summaries`;
    if (!row?.identity || row.identity.deleted)
      throw Error("RECOVERY_SCOPE_UNAVAILABLE");
    if (
      row.revisions.length > 10000 ||
      row.summaries.length > 10000 ||
      row.revisions.filter((r) => r.head).length !== row.draftCount
    )
      throw Error("RECOVERY_EXPORT_INCOMPLETE");
    const identity = { ...scope, incarnation: row.identity.incarnation };
    const records: RecoveryRecordInput[] = [
      ...row.revisions.map((revision): RecoveryRecordInput => ({
        ...identity,
        id: revision.id,
        kind: revision.head
          ? "AUTHORED_HEAD"
          : revision.pinned
            ? "PINNED_REVISION"
            : "RECENT_REVISION",
        createdAt: revision.createdAt,
        data: {
          draftId: revision.draftId,
          revision: revision.revision,
          content: revision.content,
        },
      })),
      ...row.summaries.map((summary): RecoveryRecordInput => ({
        ...identity,
        id: summary.id,
        kind: "SAVED_SUMMARY",
        createdAt: summary.createdAt,
        data: { title: summary.title, snapshot: summary.snapshot },
      })),
    ];
    if (records.length > 10000) throw Error("RECOVERY_EXPORT_INCOMPLETE");
    return {
      sourceSnapshotAt: row.snapshotAt,
      records,
      profile: "LOCAL_RETAINED_WORK_ONLY" as const,
    };
  });
}
