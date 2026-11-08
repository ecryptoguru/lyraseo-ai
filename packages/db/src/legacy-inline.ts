import type { Tx } from "./context";

/** Hold through payload construction and final actor verification. The maintenance
 * transition and enrollment use the conflicting Workspace → Site locks. */
export async function lockLegacyInlineRead(
  tx: Tx,
  scope: { workspaceId: string; siteId: string },
) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${scope.workspaceId} AND id=${scope.siteId} FOR SHARE`;
  const [policy] = await tx.$queryRaw<Array<{ enrolled: boolean }>>`
    SELECT lyraseo_legacy_inline.protected_scope(${scope.workspaceId},${scope.siteId}) AS enrolled`;
  return policy?.enrolled === true;
}
