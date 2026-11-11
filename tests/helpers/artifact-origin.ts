import type { PrismaClient } from "../../packages/db/generated/client";
import type { Actor } from "../../packages/db/src/context";
import { withActor } from "../../packages/db/src/context";
import { artifactOriginKeyId } from "../../packages/db/src/artifact-checkpoint";
export async function webOrigin(
  db: PrismaClient,
  actor: Actor,
  scope: { workspaceId: string; siteId: string; auditId: string },
  fence: number,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const [row] = await tx.$queryRaw<
      { origin: string }[]
    >`SELECT lyraseo_origin.web_context(${scope.siteId},${scope.auditId},${actor.securityVersion}::integer,${fence}::integer,${artifactOriginKeyId(db)}) AS origin`;
    return row!.origin;
  });
}
export async function stepOrigin(db: PrismaClient, rid: string, proof: string) {
  const [row] = await db.$queryRaw<
    { origin: string }[]
  >`SELECT lyraseo_origin.step_context(${rid}::uuid,${proof},${artifactOriginKeyId(db)}) AS origin`;
  return row!.origin;
}
export async function observationOrigin(
  db: PrismaClient,
  actor: Actor,
  scope: { workspaceId: string; siteId: string },
  panel: string,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const [row] = await tx.$queryRaw<
      { origin: string }[]
    >`SELECT lyraseo_origin.observation_context(${scope.siteId},${panel},${actor.securityVersion}::integer,${actor.sessionId},${artifactOriginKeyId(db)}) AS origin`;
    return row!.origin;
  });
}
