/** Site-scoped setup and immutable previews. No live-send or provider transport is exported. */
import { randomBytes, createHash } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import {
  withActor,
  withEvidenceRead,
  authorizeSiteIn,
  requireFreshAuthentication,
  type Actor,
  type Tx,
} from "./context";
import type { SiteScope } from "./sites";
import type { SecretBox } from "./gsc";
import {
  handoffQualification,
  outboundUrl,
  sha256,
  webhookEnvelope,
  wordpressRequest,
} from "./handoff-codecs";
export type HandoffDestination = {
  id: string;
  kind: "WORDPRESS" | "WEBHOOK";
  url: string;
  generation: number;
  revision: number;
  status: "CONFIGURED" | "REVOKED";
  key_id: string | null;
  previous_key_id: string | null;
  previous_until: string | null;
  event_types: Array<"audit.completed" | "report.created">;
};
export type HandoffIntent = {
  id: string;
  kind: "WORDPRESS" | "WEBHOOK";
  state: string;
  mode: "QUARANTINED" | "FIXTURE";
  destination_url: string;
  attempt: number;
  editor_url: string | null;
  remote_post_id: number | null;
  last_code: string | null;
  created_at: string;
  next_due_at: string;
};
export type HandoffSummary = {
  destinations: HandoffDestination[];
  intents: HandoffIntent[];
  qualification: typeof handoffQualification;
};
export const handoffAad = (
  scope: SiteScope,
  kind: "WORDPRESS" | "WEBHOOK",
  destinationUrl: string,
  generation: number,
) =>
  JSON.stringify([
    "lyraseo-handoff-v1",
    scope.workspaceId,
    scope.siteId,
    kind,
    destinationUrl,
    generation,
  ]);
async function nextGeneration(
  tx: Tx,
  actor: Actor,
  scope: SiteScope,
  kind: "WORDPRESS" | "WEBHOOK",
) {
  const [row] = await tx.$queryRaw<
    { value: Omit<HandoffSummary, "qualification"> }[]
  >`SELECT lyraseo_handoff.summary(${scope.workspaceId},${scope.siteId},${actor.securityVersion}) AS value`;
  return (
    (row?.value.destinations.find((d) => d.kind === kind)?.generation ?? 0) + 1
  );
}
async function command<T>(
  tx: Tx,
  actor: Actor,
  scope: SiteScope,
  action: string,
  payload: Record<string, unknown>,
) {
  const [row] = await tx.$queryRaw<
    { value: T }[]
  >`SELECT lyraseo_handoff.web_command(${scope.workspaceId},${scope.siteId},${actor.securityVersion},${action},${JSON.stringify(payload)}::jsonb) AS value`;
  if (!row) throw Error("HANDOFF_UNAVAILABLE");
  return row.value;
}
async function lock(tx: Tx, actor: Actor, scope: SiteScope, manager: boolean) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
  const site = await authorizeSiteIn(
    tx,
    actor,
    scope.workspaceId,
    scope.siteId,
    "edit",
  );
  if (manager) {
    const member = await tx.membership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: scope.workspaceId,
          userId: actor.userId,
        },
      },
    });
    if (!member || !["OWNER", "ADMIN"].includes(member.role))
      throw Error("FORBIDDEN");
    requireFreshAuthentication(actor);
  }
  return site;
}
export async function readHandoffs(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
): Promise<HandoffSummary> {
  return withEvidenceRead(db, actor, scope, "read", undefined, async (tx) => {
    const [row] = await tx.$queryRaw<
      { value: Omit<HandoffSummary, "qualification"> }[]
    >`SELECT lyraseo_handoff.summary(${scope.workspaceId},${scope.siteId},${actor.securityVersion}) AS value`;
    if (!row) throw Error("HANDOFF_UNAVAILABLE");
    return { ...row.value, qualification: handoffQualification };
  });
}
export async function configureWordPress(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  box: SecretBox,
  input: {
    installation: string;
    username: string;
    applicationPassword: string;
    confirmed: boolean;
    expectedRevision?: number;
  },
) {
  if (
    !input.confirmed ||
    input.username.length < 1 ||
    input.username.length > 200 ||
    /[:\r\n]/.test(input.username) ||
    input.applicationPassword.length < 1 ||
    input.applicationPassword.length > 1024 ||
    /[\r\n]/.test(input.applicationPassword)
  )
    throw Error("INVALID_WORDPRESS_CONNECTION");
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const site = await lock(tx, actor, scope, true);
    wordpressRequest(input.installation, site.origin, {
      title: "Connection",
      body: "",
    });
    const generation = await nextGeneration(tx, actor, scope, "WORDPRESS");
    return command<HandoffDestination>(
      tx,
      actor,
      scope,
      "wordpress.configure",
      {
        url: outboundUrl(input.installation),
        cipher: box.seal(
          JSON.stringify({
            username: input.username,
            applicationPassword: input.applicationPassword,
          }),
          handoffAad(
            scope,
            "WORDPRESS",
            outboundUrl(input.installation),
            generation,
          ),
        ),
        expectedRevision: input.expectedRevision,
      },
    );
  });
}
export async function configureWebhook(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  box: SecretBox,
  input: {
    url: string;
    confirmed: boolean;
    eventTypes?: Array<"audit.completed" | "report.created">;
    expectedRevision?: number;
  },
) {
  if (
    !input.confirmed ||
    input.eventTypes?.some(
      (type) => !["audit.completed", "report.created"].includes(type),
    )
  )
    throw Error("INVALID_DESTINATION_CONFIRMATION");
  const url = outboundUrl(input.url),
    secret = randomBytes(32).toString("base64url"),
    keyId = randomBytes(12).toString("base64url");
  const destination = await withActor(
    db,
    actor,
    scope.workspaceId,
    async (tx) => {
      await lock(tx, actor, scope, true);
      const generation = await nextGeneration(tx, actor, scope, "WEBHOOK");
      return command<HandoffDestination>(
        tx,
        actor,
        scope,
        "webhook.configure",
        {
          url,
          keyId,
          eventTypes: input.eventTypes ?? [],
          cipher: box.seal(
            secret,
            handoffAad(scope, "WEBHOOK", url, generation),
          ),
          expectedRevision: input.expectedRevision,
        },
      );
    },
  );
  return { destination, secret, keyId };
}
export async function disconnectHandoff(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  destinationId: string,
  expectedRevision: number,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, actor, scope, true);
    return command<HandoffDestination>(tx, actor, scope, "disconnect", {
      destinationId,
      expectedRevision,
    });
  });
}
export async function rotateWebhook(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  box: SecretBox,
  destinationId: string,
  expectedRevision: number,
) {
  const secret = randomBytes(32).toString("base64url"),
    keyId = randomBytes(12).toString("base64url");
  const destination = await withActor(
    db,
    actor,
    scope.workspaceId,
    async (tx) => {
      await lock(tx, actor, scope, true);
      const current = await destinationIn(tx, actor, scope, destinationId);
      return command<HandoffDestination>(tx, actor, scope, "webhook.rotate", {
        destinationId,
        expectedRevision,
        keyId,
        cipher: box.seal(
          secret,
          handoffAad(scope, "WEBHOOK", current.url, current.generation),
        ),
      });
    },
  );
  return { destination, secret, keyId };
}
async function destinationIn(
  tx: Tx,
  actor: Actor,
  scope: SiteScope,
  destinationId: string,
) {
  const [row] = await tx.$queryRaw<
    { value: Omit<HandoffSummary, "qualification"> }[]
  >`SELECT lyraseo_handoff.summary(${scope.workspaceId},${scope.siteId},${actor.securityVersion}) AS value`;
  const destination = row?.value.destinations.find(
    (d) => d.id === destinationId && d.status === "CONFIGURED",
  );
  if (!destination) throw Error("NOT_FOUND");
  return destination;
}
export async function previewWordPress(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  input: { destinationId: string; draftRevisionId: string },
) {
  return withEvidenceRead(db, actor, scope, "read", undefined, async (tx) => {
    const destination = await destinationIn(
      tx,
      actor,
      scope,
      input.destinationId,
    );
    if (destination.kind !== "WORDPRESS") throw Error("INVALID_DESTINATION");
    const revision = await tx.contentRevision.findFirst({
      where: { id: input.draftRevisionId, workspaceId: scope.workspaceId },
    });
    const draft =
      revision &&
      (await tx.contentDraft.findFirst({
        where: {
          id: revision.draftId,
          workspaceId: scope.workspaceId,
          siteId: scope.siteId,
          kind: "draft",
        },
      }));
    const pin =
      revision &&
      (await tx.contentRevisionPin.findFirst({
        where: { draftId: revision.draftId, revision: revision.revision },
      }));
    if (
      !revision ||
      !draft ||
      (revision.revision !== draft.revision &&
        revision.createdAt.getTime() < Date.now() - 90 * 86400000 &&
        !pin)
    )
      throw Error("REVISION_UNAVAILABLE");
    const content = revision.content as { title: string; body: string };
    if (typeof content.title !== "string" || typeof content.body !== "string")
      throw Error("INVALID_REVISION");
    const site = await authorizeSiteIn(
      tx,
      actor,
      scope.workspaceId,
      scope.siteId,
      "read",
    );
    return {
      destination,
      draftRevisionId: revision.id,
      draftRevision: revision.revision,
      title: content.title,
      sourceBody: content.body,
      ...wordpressRequest(destination.url, site.origin, content),
      qualification: handoffQualification,
    };
  });
}
export async function prepareWordPress(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  input: {
    destinationId: string;
    draftRevisionId: string;
    expectedBodyHash: string;
    expectedDestinationGeneration: number;
    expectedDestinationUrl: string;
    idempotencyKey: string;
  },
) {
  const preview = await previewWordPress(db, actor, scope, input);
  if (preview.hash !== input.expectedBodyHash) throw Error("REVISION_CONFLICT");
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, actor, scope, false);
    const destination = await destinationIn(
      tx,
      actor,
      scope,
      input.destinationId,
    );
    if (
      destination.generation !== input.expectedDestinationGeneration ||
      destination.url !== input.expectedDestinationUrl ||
      destination.generation !== preview.destination.generation ||
      destination.url !== preview.destination.url
    )
      throw Error("REVISION_CONFLICT");
    return command<HandoffIntent>(tx, actor, scope, "wordpress.prepare", {
      ...input,
      title: preview.title,
      sourceBody: preview.sourceBody,
      body: preview.body,
      bodyHash: preview.hash,
      rendererVersion: preview.rendererVersion,
      destinationUrl: preview.url,
      inputHash: sha256(
        JSON.stringify([
          preview.hash,
          input.draftRevisionId,
          input.destinationId,
          destination.url,
          destination.generation,
        ]),
      ),
    });
  });
}
export async function prepareWebhookTest(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  input: { destinationId: string; idempotencyKey: string },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await lock(tx, actor, scope, true);
    const d = await destinationIn(tx, actor, scope, input.destinationId);
    if (d.kind !== "WEBHOOK") throw Error("INVALID_DESTINATION");
    // Stable ID and time bind replays to one exact body, without storing browser secrets.
    const bytes = createHash("sha256")
      .update(
        JSON.stringify([
          scope.workspaceId,
          scope.siteId,
          actor.userId,
          input.destinationId,
          input.idempotencyKey,
        ]),
      )
      .digest("hex");
    const eventId = `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-4${bytes.slice(13, 16)}-a${bytes.slice(17, 20)}-${bytes.slice(20, 32)}`;
    const occurredAt = new Date().toISOString();
    const body = webhookEnvelope({
      id: eventId,
      type: "test",
      ...scope,
      occurredAt,
      resource: { kind: "test", id: "sample" },
    });
    return command<HandoffIntent>(tx, actor, scope, "webhook.test", {
      ...input,
      eventId,
      body,
      bodyHash: sha256(body),
      rendererVersion: "webhook-test-v1",
      inputHash: sha256(
        JSON.stringify([input.destinationId, d.generation, eventId]),
      ),
    });
  });
}
