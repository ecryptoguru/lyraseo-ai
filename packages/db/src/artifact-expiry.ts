import { createHmac } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import {
  assertLocalArtifactOrigin,
  inspectLocalArtifactAbsence,
  type ArtifactVersion,
  type AuditArtifactStore,
} from "./artifact-store";

export type ExpiryScope = { workspaceId: string; siteId: string };
export type ExpiryManifestItem = { class: string; id: string };
export type ExpiryPreview = {
  items: {
    class: string;
    id: string;
    deadline: string;
    qualified: boolean;
    reason: string;
  }[];
  manifest: ExpiryManifestItem[];
  hash: string;
  nextCursor: string | null;
  databaseNow: string;
  eligibilityNow: string;
};
type Claim = {
  itemId: string;
  planId?: string;
  status: "CLAIMED" | "COMPLETE";
  token?: string;
  workerToken?: string;
  sequence?: string | number;
  version?: ArtifactVersion;
  origin?: string;
  signingPrefix?: string;
  reconcileFirst?: boolean;
  inspectOnly?: boolean;
};
type Authority = {
  keyId: string;
  secret: Buffer;
  scope: ExpiryScope;
  origin: string;
};
const authorities = new WeakMap<AuditArtifactStore, Authority>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Trusted local harness enrollment. No arbitrary signing method is exposed. */
export function bindLocalExpiryAuthority(
  store: AuditArtifactStore,
  input: {
    keyId: string;
    secret: Uint8Array;
    scope: ExpiryScope;
    origin: string;
  },
) {
  if (
    store.qualification !== "LOCAL_TEST_ONLY" ||
    !uuid.test(input.keyId) ||
    input.secret.byteLength !== 32 ||
    !input.scope.workspaceId ||
    !input.scope.siteId ||
    !input.origin
  )
    throw Error("EXPIRY_AUTHORITY_INVALID");
  authorities.set(store, {
    keyId: input.keyId,
    secret: Buffer.from(input.secret),
    scope: Object.freeze({ ...input.scope }),
    origin: input.origin,
  });
}
export function unbindLocalExpiryAuthority(store: AuditArtifactStore) {
  const authority = authorities.get(store);
  if (authority) authority.secret.fill(0);
  authorities.delete(store);
}
function authorityFor(store: AuditArtifactStore, scope: ExpiryScope) {
  const authority = authorities.get(store);
  if (
    !authority ||
    authority.scope.workspaceId !== scope.workspaceId ||
    authority.scope.siteId !== scope.siteId
  )
    throw Error("EXPIRY_AUTHORITY_REQUIRED");
  return authority;
}
function stillBound(store: AuditArtifactStore, original: Authority) {
  if (authorities.get(store) !== original)
    throw Error("EXPIRY_AUTHORITY_CHANGED");
}

export async function previewPrivateArtifactExpiry(
  db: PrismaClient,
  store: AuditArtifactStore,
  scope: ExpiryScope,
  limit = 100,
  cursor: string | null = null,
): Promise<ExpiryPreview> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("INVALID_LIMIT");
  const authority = authorityFor(store, scope);
  await assertLocalArtifactOrigin(
    store,
    authority.scope.workspaceId,
    authority.origin,
  );
  stillBound(store, authority);
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const [row] = await tx.$queryRaw<
      { result: ExpiryPreview }[]
    >`SELECT lyraseo_expiry.preview(${JSON.stringify(authority.scope)}::jsonb,${limit}::integer,${cursor}) AS result`;
    if (!row) throw Error("EXPIRY_UNAVAILABLE");
    return row.result;
  });
}

export async function recordPrivateArtifactExpiryPlan(
  db: PrismaClient,
  store: AuditArtifactStore,
  scope: ExpiryScope,
  manifest: ExpiryManifestItem[],
  expectedHash: string,
) {
  const authority = authorityFor(store, scope);
  await assertLocalArtifactOrigin(
    store,
    authority.scope.workspaceId,
    authority.origin,
  );
  stillBound(store, authority);
  const [row] = await db.$queryRaw<
    {
      result: {
        planId: string;
        hash: string;
        count: number;
        expiresAt: string;
      };
    }[]
  >`SELECT lyraseo_expiry.record_plan(${JSON.stringify(authority.scope)}::jsonb,${JSON.stringify(manifest)}::jsonb,${expectedHash}) AS result`;
  if (!row) throw Error("EXPIRY_UNAVAILABLE");
  return row.result;
}

export async function privateArtifactExpiryStatus(
  db: PrismaClient,
  scope: ExpiryScope,
  planId: string,
) {
  const expected = Object.freeze({
    workspaceId: scope.workspaceId,
    siteId: scope.siteId,
  });
  const [row] = await db.$queryRaw<{ result: Record<string, unknown> }[]>`
    SELECT lyraseo_expiry.status(${JSON.stringify(expected)}::jsonb,${planId}::uuid) AS result`;
  if (!row) throw Error("EXPIRY_UNAVAILABLE");
  return row.result;
}
export async function pausePrivateArtifactExpiry(
  db: PrismaClient,
  store: AuditArtifactStore,
  scope: ExpiryScope,
  planId: string,
) {
  const authority = authorityFor(store, scope);
  await assertLocalArtifactOrigin(
    store,
    authority.scope.workspaceId,
    authority.origin,
  );
  stillBound(store, authority);
  const [row] = await db.$queryRaw<{ result: Record<string, unknown> }[]>`
    SELECT lyraseo_expiry.pause(${JSON.stringify(authority.scope)}::jsonb,${planId}::uuid) AS result`;
  if (!row) throw Error("EXPIRY_UNAVAILABLE");
  return row.result;
}

async function pending(
  db: PrismaClient,
  token: string,
  workerToken: string,
  reason: string,
) {
  await db.$executeRaw`SELECT lyraseo_expiry.record_pending(${token}::uuid,${workerToken}::uuid,${reason})`;
}
async function processClaim(
  db: PrismaClient,
  store: AuditArtifactStore,
  authority: Authority,
  claim: Claim,
) {
  if (claim.status === "COMPLETE") return "complete";
  if (
    !claim.token ||
    !claim.planId ||
    !claim.version ||
    !claim.origin ||
    !claim.signingPrefix ||
    claim.version.origin !== claim.origin
  )
    throw Error("EXPIRY_CLAIM_INVALID");
  const version = claim.version;
  try {
    await assertLocalArtifactOrigin(store, version.workspaceId, claim.origin);
    stillBound(store, authority);
    let absence: "marker" | "missing" | undefined;
    if (claim.reconcileFirst) {
      absence = await inspectLocalArtifactAbsence(store, version).catch(
        () => undefined,
      );
      stillBound(store, authority);
    }
    if (!absence && claim.inspectOnly) return "inflight";
    if (!claim.inspectOnly && !claim.workerToken)
      throw Error("EXPIRY_CLAIM_INVALID");
    if (!absence) {
      await store.deleteExactVersion(version);
      stillBound(store, authority);
      absence = await inspectLocalArtifactAbsence(store, version);
      stillBound(store, authority);
    }
    const inspectedAt = new Date().toISOString();
    const payload = claim.signingPrefix + "\n" + inspectedAt + "\n" + absence;
    const mac = createHmac("sha256", authority.secret)
      .update(payload)
      .digest("hex");
    stillBound(store, authority);
    await db.$queryRaw`SELECT lyraseo_expiry.complete(${claim.token}::uuid,${JSON.stringify(
      {
        keyId: authority.keyId,
        itemId: claim.itemId,
        planId: claim.planId,
        token: claim.token,
        sequence: String(claim.sequence),
        inspectedAt,
        absence,
        mac,
      },
    )}::jsonb)`;
    return "complete";
  } catch {
    if (claim.inspectOnly) return "inflight";
    if (!claim.workerToken) return "blocked";
    const recorded = await pending(
      db,
      claim.token,
      claim.workerToken,
      "BACKEND_UNAVAILABLE",
    ).then(
      () => true,
      () => false,
    );
    return recorded ? "pending" : "blocked";
  }
}

export async function applyPrivateArtifactExpiry(
  db: PrismaClient,
  store: AuditArtifactStore,
  scope: ExpiryScope,
  planId: string,
  expectedHash: string,
  limit = 100,
  reconcile = false,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("INVALID_LIMIT");
  const authority = authorityFor(store, scope);
  await assertLocalArtifactOrigin(
    store,
    authority.scope.workspaceId,
    authority.origin,
  );
  stillBound(store, authority);
  const [page] = await db.$queryRaw<
    { result: { items: { id: string; class: string }[] } }[]
  >`SELECT lyraseo_expiry.next_items(${JSON.stringify(authority.scope)}::jsonb,${planId}::uuid,${expectedHash},${limit}::integer,NULL::uuid) AS result`;
  if (!page) throw Error("EXPIRY_UNAVAILABLE");
  stillBound(store, authority);
  const outcomes: { itemId: string; status: string }[] = [];
  for (const item of page.result.items) {
    try {
      stillBound(store, authority);
      const [row] = reconcile
        ? await db.$queryRaw<
            { result: Claim }[]
          >`SELECT lyraseo_expiry.reconcile_claim(${JSON.stringify(authority.scope)}::jsonb,${planId}::uuid,${item.id}::uuid,${expectedHash}) AS result`
        : await db.$queryRaw<
            { result: Claim }[]
          >`SELECT lyraseo_expiry.claim(${JSON.stringify(authority.scope)}::jsonb,${planId}::uuid,${item.id}::uuid,${expectedHash}) AS result`;
      if (!row) throw Error("EXPIRY_UNAVAILABLE");
      outcomes.push({
        itemId: item.id,
        status: await processClaim(db, store, authority, row.result),
      });
    } catch {
      outcomes.push({ itemId: item.id, status: "blocked" });
    }
  }
  return { attempted: outcomes.length, outcomes };
}
