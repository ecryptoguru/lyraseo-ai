import type { PrismaClient } from "../generated/client";
import type { ProviderEvidence } from "./visibility";
import type { SiteScope } from "./sites";
import {
  withActor,
  authorizeSiteIn,
  isTokenActor,
  type Actor,
  type ReadActor,
  type Tx,
} from "./context";
import {
  artifactStore,
  witnessedNormalizedObservation,
  verifiedNormalizedPublication,
  verifyReturnedBytes,
  type ObservationReservation,
} from "./artifact-checkpoint";
import {
  normalizeObservation,
  OBSERVATION_STORAGE,
  ANSWER_LIMIT,
  ANSWER_REPRESENTATION,
  type ObservationRecording,
} from "./observation-source";
import type { ArtifactVersion } from "./artifact-store";
export type AnswerAvailability = {
  promptId: string;
  state:
    | "retained-parsed"
    | "expired"
    | "rights-unavailable"
    | "not-retained"
    | "unavailable";
  reason: string;
  representation: typeof ANSWER_REPRESENTATION;
  producerClass: "CONTROLLED_FIXTURE_V1";
  originalProviderWire: false;
};
type Ticket = {
  state: AnswerAvailability["state"];
  reason: string;
  version?: ArtifactVersion;
  deadline?: string;
  refId?: string;
  observedAt?: string;
};
const publicAvailability = (
  promptId: string,
  t: Ticket,
): AnswerAvailability => ({
  promptId,
  state: t.state,
  reason: t.reason,
  representation: ANSWER_REPRESENTATION,
  producerClass: "CONTROLLED_FIXTURE_V1",
  originalProviderWire: false,
});
/** Selected-format controlled producer only; not mounted on any upload/collect route. */
export async function recordPrivateObservation(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  panelId: string,
  evidence: ProviderEvidence,
  recording: ObservationRecording,
) {
  if (isTokenActor(actor)) throw Error("FORBIDDEN");
  const s = { workspaceId: scope.workspaceId, siteId: scope.siteId };
  const prepared = await withActor(db, actor, s.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "run");
    const panel = await tx.visibilityPanel.findFirst({
      where: { ...s, id: panelId, reviewedAt: { not: null } },
    });
    if (!panel) throw Error("REVIEWED_PANEL_REQUIRED");
    const source = normalizeObservation(panel, evidence, recording, true);
    const [row] = await tx.$queryRaw<
      { context: string }[]
    >`SELECT lyraseo_observation.source_context(${s.siteId},${panelId},${actor.securityVersion}::integer,${actor.sessionId}) AS context`;
    if (!row) throw Error("ARTIFACT_UNAVAILABLE");
    const [replay] = await tx.$queryRaw<
      { replay: { id: string; storageFormat: string } | null }[]
    >`SELECT lyraseo_observation.replay(${s.siteId},${panelId},${actor.securityVersion}::integer,${actor.sessionId},${recording.recordingKey},${JSON.stringify({ evidence: source.manifest, provenance: source.provenance })}::json) AS replay`;
    if (
      !replay?.replay &&
      Date.parse(source.manifest.rawExpiresAt) <= Date.now()
    )
      throw Error("SOURCE_EXPIRED");
    return { source, context: row.context, replay: replay?.replay };
  });
  if (prepared.replay) return prepared.replay;
  const witness = witnessedNormalizedObservation(
    db,
    prepared.source,
    prepared.context,
  );
  const reservation = await withActor(db, actor, s.workspaceId, async (tx) => {
    const [row] = await tx.$queryRaw<
      { reservation: ObservationReservation }[]
    >`SELECT lyraseo_observation.reserve(${s.siteId},${panelId},${actor.securityVersion}::integer,${actor.sessionId},${recording.sourceNamespace},${recording.recordingKey},${JSON.stringify(witness.submitted)}::json,${JSON.stringify(witness.confirmation)}::json) AS reservation`;
    if (!row) throw Error("ARTIFACT_UNAVAILABLE");
    return row.reservation;
  });
  if (reservation.state === "FINALIZED")
    return { id: reservation.runId, storageFormat: OBSERVATION_STORAGE };
  const publication = await verifiedNormalizedPublication(
    db,
    prepared.source,
    reservation,
  );
  return withActor(db, actor, s.workspaceId, async (tx) => {
    const [row] = await tx.$queryRaw<
      { result: { id: string; storageFormat: string } }[]
    >`SELECT lyraseo_observation.finalize(${s.siteId},${reservation.id}::uuid,${actor.securityVersion}::integer,${actor.sessionId},${reservation.proof}::uuid,${JSON.stringify(publication.submitted)}::json,${JSON.stringify(publication.confirmation)}::json) AS result`;
    if (!row) throw Error("ARTIFACT_UNAVAILABLE");
    return row.result;
  });
}
async function ticketIn(
  tx: Tx,
  actor: Actor,
  s: SiteScope,
  runId: string,
  promptId: string,
) {
  const [row] = await tx.$queryRaw<
    { ticket: Ticket }[]
  >`SELECT lyraseo_observation.ticket(${s.siteId},${runId},${promptId},${actor.securityVersion}::integer,${actor.sessionId}) AS ticket`;
  if (!row?.ticket) throw Error("NOT_FOUND");
  return row.ticket;
}
export async function observationAvailabilityIn(
  tx: Tx,
  actor: Actor,
  s: SiteScope,
  runId: string,
  promptIds: string[],
) {
  if (isTokenActor(actor)) throw Error("FORBIDDEN");
  const result: AnswerAvailability[] = [];
  for (const promptId of promptIds)
    result.push(
      publicAvailability(
        promptId,
        await ticketIn(tx, actor, s, runId, promptId),
      ),
    );
  return result;
}
/** One bounded buffered representation per explicit authenticated read. Never returns keys/tickets. */
export async function readObservationAnswer(
  db: PrismaClient,
  actor: ReadActor,
  scope: SiteScope,
  runId: string,
  promptId: string,
  revalidateActor: () => Promise<Actor>,
) {
  if (isTokenActor(actor)) throw Error("FORBIDDEN");
  if (typeof revalidateActor !== "function")
    throw Error("CURRENT_ACTOR_REQUIRED");
  const s = { workspaceId: scope.workspaceId, siteId: scope.siteId },
    started = Date.now();
  const getTicket = (current: Actor = actor) =>
    withActor(db, current, s.workspaceId, (tx) =>
      ticketIn(tx, current, s, runId, promptId),
    );
  const ticket = await getTicket();
  if (ticket.state !== "retained-parsed" || !ticket.version)
    return { availability: publicAvailability(promptId, ticket), answer: null };
  let bytes: Uint8Array | undefined, reason: string | undefined;
  const store = artifactStore(db);
  if (!store) reason = "BACKEND_UNAVAILABLE";
  else {
    try {
      if (!(await store.statVersion(ticket.version))) reason = "MISSING_BLOB";
      else {
        const returned = await store.openBounded(ticket.version);
        try {
          bytes = verifyReturnedBytes(ticket.version, returned);
          if (bytes.byteLength > ANSWER_LIMIT) throw Error();
        } catch {
          reason = "ARTIFACT_CORRUPT";
        }
      }
    } catch {
      reason = "BACKEND_UNAVAILABLE";
    }
  }
  let answer: unknown;
  if (bytes && !reason) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        value = JSON.parse(decoded);
      if (
        value.representation !== ANSWER_REPRESENTATION ||
        value.clockContract !== "COMMON_OBSERVED_AT_V1" ||
        value.promptId !== promptId ||
        typeof value.body !== "string" ||
        value.body.length > 100000 ||
        !Array.isArray(value.annotations) ||
        value.annotations.length > 256 ||
        value.provenance?.synthetic !== true ||
        value.provenance?.producerClass !== "CONTROLLED_FIXTURE_V1" ||
        JSON.stringify(value) !== decoded
      )
        throw Error();
      answer = value;
    } catch {
      reason = "ARTIFACT_CORRUPT";
    }
  }
  // External session verification runs outside DB locks, then the final scoped ticket
  // observes revocation/rights changes which happened during that verification.
  const currentActor = await revalidateActor();
  if (
    !currentActor ||
    currentActor.userId !== actor.userId ||
    currentActor.sessionId !== actor.sessionId ||
    currentActor.securityVersion !== actor.securityVersion
  )
    throw Error("FORBIDDEN");
  // No buffered prefix escapes a late authorization/rights/identity recheck.
  const late = await getTicket(currentActor);
  if (late.state !== "retained-parsed")
    return { availability: publicAvailability(promptId, late), answer: null };
  if (
    JSON.stringify(late) !== JSON.stringify(ticket) ||
    Date.now() - started >= 30000 ||
    !ticket.deadline ||
    Date.parse(ticket.deadline) <= Date.now()
  )
    throw Error("SOURCE_EXPIRED");
  if (reason || !answer)
    return {
      availability: publicAvailability(promptId, {
        state: "unavailable",
        reason: reason ?? "ARTIFACT_CORRUPT",
      }),
      answer: null,
    };
  return { availability: publicAvailability(promptId, ticket), answer };
}
/** Scoped local cancellation/rights retirement; objects become tracked ORPHAN cleanup work. */
export async function retireObservationAnswers(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  runId: string,
) {
  if (isTokenActor(actor)) throw Error("FORBIDDEN");
  await withActor(db, actor, s.workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT lyraseo_observation.retire(${s.siteId},${runId},${actor.securityVersion}::integer,${actor.sessionId})::text`;
  });
}
