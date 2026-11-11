import { createHash, createHmac } from "node:crypto";
import {
  type AcquisitionReceipt,
  originalBody,
  isOriginalObservation,
  restoreOriginalReceipt,
  receiptAttestation,
  receiptFacts,
  extractRawHtml,
  unavailablePage,
} from "@lyraseo/visibility/acquisition";
import {
  fingerprint,
  validateRawPage,
  type AuditFacts,
} from "./audit-evidence";
import {
  assertLocalArtifactOrigin,
  type ArtifactVersion,
  type AuditArtifactStore,
} from "./artifact-store";
import {
  checkedObservationSource,
  answerRepresentation,
  verifyAnswerRepresentation,
  type NormalizedObservation,
} from "./observation-source";
import type { PrismaClient } from "../generated/client";
export const STORAGE = "AUDIT_PRIVATE_V1";
export type LocalArtifactAuthority = { keyId: string; secret: Uint8Array };
export interface ArtifactReservation {
  version: ArtifactVersion | null;
  binding: string;
  origin: string;
}
const authorities = new WeakMap<PrismaClient, LocalArtifactAuthority>();
const stores = new WeakMap<PrismaClient, AuditArtifactStore>();
/** Explicit process-local capability on an existing restricted client, never supplied by HTTP or environment. */
export function bindLocalArtifactStore(
  db: PrismaClient,
  store: AuditArtifactStore,
  authority?: LocalArtifactAuthority,
) {
  if (
    store.qualification !== "LOCAL_TEST_ONLY" ||
    (authority && authority.secret.length !== 32)
  )
    throw Error("ARTIFACT_UNAVAILABLE");
  authorities.get(db)?.secret.fill(0);
  if (authority)
    authorities.set(db, {
      keyId: authority.keyId,
      secret: new Uint8Array(authority.secret),
    });
  else authorities.delete(db);
  stores.set(db, store);
}
/** Public key selector only; secret/witness remain process-private. */
export function artifactOriginKeyId(db: PrismaClient) {
  const key = authorities.get(db);
  if (!key) throw Error("ARTIFACT_UNAVAILABLE");
  return key.keyId;
}
async function witnessOrigin(db: PrismaClient, origin: string) {
  const store = stores.get(db),
    key = authorities.get(db);
  if (!store || !key || typeof origin !== "string")
    throw Error("ARTIFACT_UNAVAILABLE");
  let workspace: string;
  try {
    workspace = JSON.parse(origin).workspaceId;
  } catch {
    throw Error("ARTIFACT_UNAVAILABLE");
  }
  await assertLocalArtifactOrigin(store, workspace, origin).catch(() => {
    throw Error("ARTIFACT_UNAVAILABLE");
  });
  if (stores.get(db) !== store || authorities.get(db) !== key)
    throw Error("ARTIFACT_UNAVAILABLE");
  return { store, key };
}
function sameBinding(
  db: PrismaClient,
  store: AuditArtifactStore,
  key: LocalArtifactAuthority,
) {
  if (stores.get(db) !== store || authorities.get(db) !== key)
    throw Error("ARTIFACT_UNAVAILABLE");
}
export function artifactStore(db: PrismaClient) {
  return stores.get(db);
}
export function attestArtifactReceipt(
  run: AuditFacts,
  receipt: AcquisitionReceipt,
) {
  validateRawPage(run, receipt.evidence, receipt.provenance);
  if (
    receiptAttestation(receipt) !==
    createHash("sha256").update(receiptFacts(receipt)).digest("hex")
  )
    throw Error("INVALID_PAGE_EVIDENCE");
  if (
    run.methodologyVersion !== "readiness-v2" ||
    !["CONTROLLED_RAW_TEST_V1", "LOCAL_RAW_V1"].includes(run.profile)
  )
    throw Error("UNSUPPORTED_STORAGE_PROFILE");
  const { provenance: p, evidence: e } = receipt,
    bytes = originalBody(receipt);
  if (bytes && createHash("sha256").update(bytes).digest("hex") !== p.sha256)
    throw Error("INVALID_PAGE_EVIDENCE");
  if (e.acquired) {
    if (
      !bytes ||
      !p.finalUrl ||
      !p.rawHtml ||
      p.error ||
      p.finalUrl !== e.finalUrl ||
      p.status !== e.status ||
      p.headers["content-type"] !== e.contentType
    )
      throw Error("INVALID_PAGE_EVIDENCE");
    const raw = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (raw !== p.rawHtml) throw Error("INVALID_PAGE_EVIDENCE");
    const parsed = {
      ...extractRawHtml(
        raw.replace(/^\uFEFF/, ""),
        e.requestedUrl,
        p.finalUrl,
        new Headers(p.headers),
      ),
      status: p.status,
      contentType: p.headers["content-type"],
      robotsGoogleAllowed: e.robotsGoogleAllowed,
      requestedRobotsGoogleAllowed: e.requestedRobotsGoogleAllowed,
    };
    if (fingerprint(parsed) !== fingerprint(e))
      throw Error("INVALID_PAGE_EVIDENCE");
  }
  // The raw profile cannot observe a rendered head/body or complete JSON-LD.
  // Both page and origin v2 rules return unavailable for those channels.
  const scratch = {
    ...unavailablePage(e.requestedUrl),
    finalUrl: e.finalUrl,
    status: e.status,
    contentType: e.contentType,
    acquired: e.acquired,
    robotsGoogleAllowed: e.robotsGoogleAllowed,
    requestedRobotsGoogleAllowed: e.requestedRobotsGoogleAllowed,
    metadata: e.metadata,
    jsonLdComplete: e.jsonLdComplete,
  };
  return { scratch, source: e.acquired ? bytes : undefined };
}
export async function putReserved(
  store: AuditArtifactStore | undefined,
  version: ArtifactVersion | null,
  bytes: Uint8Array | undefined,
) {
  if (!store) throw Error("ARTIFACT_UNAVAILABLE");
  if (!version) {
    if (bytes) throw Error("INVALID_ARTIFACT");
    return;
  }
  if (!bytes) throw Error("INVALID_ARTIFACT");
  if (!version.origin) throw Error("ARTIFACT_UNAVAILABLE");
  try {
    await store.putImmutable(version, bytes);
  } catch {
    // A lost reply is resolved by the exact-version check below.
  }
  if (!(await store.statVersion(version).catch(() => false)))
    throw Error("ARTIFACT_UNAVAILABLE");
}

// Only the two verified operations below can produce a signature. No generic signing RPC.
function receiptMac(
  db: PrismaClient,
  purpose: string,
  binding: string,
  receipt: AcquisitionReceipt,
  origin: string,
) {
  const key = authorities.get(db);
  if (!key) throw Error("ARTIFACT_UNAVAILABLE");
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const message = [
    purpose,
    binding,
    origin,
    digest(receipt.evidence),
    digest(receipt.provenance),
  ].join("\n");
  return {
    keyId: key.keyId,
    origin,
    mac: createHmac("sha256", key.secret).update(message).digest("hex"),
  };
}
function wireReceipt(receipt: AcquisitionReceipt): AcquisitionReceipt {
  if (receipt.evidence.acquired) return receipt;
  const provenance = { ...receipt.provenance };
  delete provenance.rawHtml;
  return { evidence: receipt.evidence, provenance };
}
export async function witnessedObservation(
  db: PrismaClient,
  run: AuditFacts,
  context: string,
  receipt: AcquisitionReceipt,
  origin: string,
) {
  await witnessOrigin(db, origin);
  attestArtifactReceipt(run, receipt);
  const submitted = wireReceipt(receipt);
  const captureConfirmation = isOriginalObservation(receipt)
    ? receiptMac(db, "audit-observation-v1", context, submitted, origin)
    : null;
  return {
    ...submitted,
    captureConfirmation,
    originAssertion: receiptMac(
      db,
      "audit-origin-v1",
      context,
      submitted,
      origin,
    ),
  };
}
export function verifyReturnedBytes(
  version: ArtifactVersion,
  value: Uint8Array,
) {
  if (
    !(value instanceof Uint8Array) ||
    version.codec !== "IDENTITY" ||
    value.length !== version.sourceLength ||
    value.length !== version.storedLength ||
    value.length > 5 * 1024 * 1024
  )
    throw Error("ARTIFACT_UNAVAILABLE");
  const copy = new Uint8Array(value),
    hash = createHash("sha256").update(copy).digest("hex");
  if (hash !== version.sourceHash || hash !== version.storedHash)
    throw Error("ARTIFACT_UNAVAILABLE");
  return copy;
}
export async function verifiedPublication(
  db: PrismaClient,
  run: AuditFacts,
  receipt: AcquisitionReceipt,
  reservation: ArtifactReservation,
) {
  const attested = attestArtifactReceipt(run, receipt),
    { store, key } = await witnessOrigin(db, reservation.origin);
  if (!store || !reservation.binding) throw Error("ARTIFACT_UNAVAILABLE");
  if (reservation.version && reservation.version.origin !== reservation.origin)
    throw Error("ARTIFACT_UNAVAILABLE");
  await putReserved(store, reservation.version, attested.source);
  sameBinding(db, store, key);
  if (reservation.version) {
    const returned = await store.openBounded(reservation.version).catch(() => {
      throw Error("ARTIFACT_UNAVAILABLE");
    });
    const bytes = verifyReturnedBytes(reservation.version, returned);
    const replay = await restoreOriginalReceipt(receipt.provenance, bytes);
    attestArtifactReceipt(run, replay);
    if (
      fingerprint(replay.evidence) !== fingerprint(receipt.evidence) ||
      replay.provenance.rawHtml !== receipt.provenance.rawHtml
    )
      throw Error("INVALID_PAGE_EVIDENCE");
  }
  await witnessOrigin(db, reservation.origin);
  sameBinding(db, store, key);
  attestArtifactReceipt(run, receipt);
  const submitted = wireReceipt(receipt);
  return {
    ...submitted,
    storageFormat: STORAGE,
    version: reservation.version,
    confirmation: receiptMac(
      db,
      "audit-publication-v1",
      reservation.binding,
      submitted,
      reservation.origin,
    ),
  };
}
/** Controlled operator recovery only. Mark under DB locks, delete and verify outside the DB,
 * then record the result for that exact orphan generation. No READY/retained object is eligible.
 * This existing pre-deadline operation is not qualified expiry/deletion maintenance. */
export async function recoverAuditArtifactOrphans(
  db: PrismaClient,
  store: AuditArtifactStore,
  auditId: string,
  limit = 25,
) {
  const rows = await db.$queryRaw<
    { v: ArtifactVersion }[]
  >`SELECT v FROM lyraseo_audit.orphan_artifacts(${auditId},${limit}::integer) v`;
  let recovered = 0;
  for (const { v } of rows) {
    try {
      await store.deleteExactVersion(v);
    } catch {
      // Reconfirm the no-resurrection marker even if the first reply was lost.
      await store.deleteExactVersion(v);
    }
    if (await store.statVersion(v)) continue;
    recovered +=
      await db.$executeRaw`UPDATE "ArtifactBlob" SET state='DELETED' WHERE "workspaceId"=${v.workspaceId} AND "auditId"=${auditId} AND "storageKey"=${v.storageKey}::uuid AND generation=${v.generation}::uuid AND state='ORPHAN'`;
  }
  return recovered;
}

/** A fixture source seal has no provider or wire-capture authority. */
export async function witnessedNormalizedObservation(
  db: PrismaClient,
  source: NormalizedObservation,
  binding: string,
  origin: string,
) {
  await witnessOrigin(db, origin);
  checkedObservationSource(source);
  const submitted = {
    evidence: source.manifest,
    provenance: source.provenance,
  };
  const key = authorities.get(db);
  if (!key) throw Error("ARTIFACT_UNAVAILABLE");
  const mac = createHmac("sha256", key.secret)
    .update(
      [
        "observation-fixture-source-v1",
        binding,
        origin,
        createHash("sha256")
          .update(JSON.stringify(submitted.evidence))
          .digest("hex"),
        createHash("sha256")
          .update(JSON.stringify(submitted.provenance))
          .digest("hex"),
      ].join("\n"),
    )
    .digest("hex");
  return { submitted, confirmation: { keyId: key.keyId, origin, mac } };
}
export type ObservationReservation = {
  id: string;
  runId: string;
  state: "STAGED" | "FINALIZED";
  proof: string;
  binding: string;
  origin: string;
  versions: { promptId: string; version: ArtifactVersion | null }[];
};
/** Publication is independent of the source MAC and requires every exact stored generation. */
export async function verifiedNormalizedPublication(
  db: PrismaClient,
  source: NormalizedObservation,
  reservation: ObservationReservation,
) {
  checkedObservationSource(source);
  const { store, key } = await witnessOrigin(db, reservation.origin);
  if (
    !store ||
    !key ||
    reservation.versions.length !== source.manifest.slots.length
  )
    throw Error("ARTIFACT_UNAVAILABLE");
  for (let i = 0; i < source.manifest.slots.length; i++) {
    const slot = source.manifest.slots[i]!,
      matches = reservation.versions.filter(
        (v) => v.promptId === slot.promptId,
      );
    if (matches.length !== 1) throw Error("INVALID_ARTIFACT");
    const version = matches[0]!.version;
    if (!version) {
      if (slot.answerHash !== null) throw Error("INVALID_ARTIFACT");
      continue;
    }
    if (
      version.sourceHash !== slot.answerHash ||
      version.sourceLength !== slot.answerLength
    )
      throw Error("INVALID_ARTIFACT");
    if (version.origin !== reservation.origin)
      throw Error("ARTIFACT_UNAVAILABLE");
    const bytes = answerRepresentation(source, i);
    await putReserved(store, version, bytes);
    sameBinding(db, store, key);
    const returned = verifyReturnedBytes(
      version,
      await store.openBounded(version).catch(() => {
        throw Error("ARTIFACT_UNAVAILABLE");
      }),
    );
    verifyAnswerRepresentation(source, i, returned);
  }
  await witnessOrigin(db, reservation.origin);
  checkedObservationSource(source);
  if (authorities.get(db) !== key || artifactStore(db) !== store)
    throw Error("ARTIFACT_UNAVAILABLE");
  const submitted = {
    evidence: source.manifest,
    provenance: source.provenance,
  };
  const mac = createHmac("sha256", key.secret)
    .update(
      [
        "observation-fixture-publication-v1",
        reservation.binding,
        reservation.origin,
        createHash("sha256")
          .update(JSON.stringify(submitted.evidence))
          .digest("hex"),
        createHash("sha256")
          .update(JSON.stringify(submitted.provenance))
          .digest("hex"),
      ].join("\n"),
    )
    .digest("hex");
  return {
    submitted,
    confirmation: { keyId: key.keyId, origin: reservation.origin, mac },
  };
}
