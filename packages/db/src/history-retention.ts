import type { PrismaClient } from "../generated/client";
export type HistoryScope = { workspaceId: string; siteId: string };
export type HistoryManifestItem = {
  kind: "REVISION" | "SEARCH" | "SEARCH_IMPORT" | "ANALYTICS";
  id: string;
  deadline: string;
  fingerprint: string;
};
/** The SQL purpose role verifies enrolled scope, DB OID and postmaster epoch.
 * This local adapter is deliberately independent of web/queue execution. */
export function localHistoryRetention(
  db: PrismaClient,
  options: { enabled: boolean },
) {
  if (!options.enabled) throw Error("HISTORY_RETENTION_DISABLED");
  return {
    qualification: "LOCAL_TEST_ONLY" as const,
    async preview(scope: HistoryScope, limit = 100) {
      const [row] = await db.$queryRaw<
        Array<{ manifest: HistoryManifestItem[]; hash: string }>
      >`
        WITH p AS MATERIALIZED(SELECT lyraseo_history.candidates(${scope.workspaceId},${scope.siteId},${limit}::integer) v)
        SELECT v manifest,encode(sha256(convert_to(v::text,'UTF8')),'hex') hash FROM p`;
      if (!row) throw Error("HISTORY_PREVIEW_UNAVAILABLE");
      return row;
    },
    async record(
      scope: HistoryScope,
      manifest: HistoryManifestItem[],
      hash: string,
    ) {
      const [row] = await db.$queryRaw<
        Array<{
          value: { id: string; hash: string; count: number; expiresAt: string };
        }>
      >`
        SELECT lyraseo_history.record_plan(${scope.workspaceId},${scope.siteId},${JSON.stringify(manifest)}::jsonb,${hash}) value`;
      if (!row) throw Error("HISTORY_PLAN_UNAVAILABLE");
      return row.value;
    },
    async apply(scope: HistoryScope, id: string, hash: string, limit = 100) {
      const [row] = await db.$queryRaw<
        Array<{
          value: { processed: number; receipts: number; remaining: number };
        }>
      >`
        SELECT lyraseo_history.apply_plan(${scope.workspaceId},${scope.siteId},${id}::uuid,${hash},${limit}::integer) value`;
      if (!row) throw Error("HISTORY_PLAN_UNAVAILABLE");
      return row.value;
    },
    async pause(scope: HistoryScope, id: string) {
      await db.$queryRaw`SELECT lyraseo_history.pause_plan(${scope.workspaceId},${scope.siteId},${id}::uuid)::text`;
      return { paused: true };
    },
  };
}
