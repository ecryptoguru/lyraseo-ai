import {
  artifactStore,
  attestArtifactReceipt,
  verifiedPublication,
  witnessedObservation,
  artifactOriginKeyId,
  verifyReturnedBytes,
  type ArtifactReservation,
  STORAGE,
} from "./artifact-checkpoint";
import type { ArtifactVersion } from "./artifact-store";
import type { AcquisitionReceipt } from "@lyraseo/visibility/acquisition";
import { createHash } from "node:crypto";
import { compactEvaluation, compactGroups, declared } from "./saved-evidence";
import { pageReceipts } from "./page-receipts";
import { isTokenActor, withEvidenceRead } from "./context";
import { auditErrorCode } from "./audit-errors";
import {
  fingerprint,
  validateRawPage,
  frozenEvaluation,
} from "./audit-evidence";
import { auditManifest } from "@lyraseo/visibility/url";
import { siteScope } from "./sites";
/** Local, unmetered raw acquisition lifecycle. Never admits a paid provider call. */
import type { PrismaClient, Prisma } from "../generated/client";
import {
  compareAudits,
  validateDeclarations,
  type ReadinessDeclarations,
  type PageEvidence,
  type AuditEvaluation,
} from "@lyraseo/visibility";
import {
  withActor,
  authorizeSiteIn,
  type Actor,
  type ReadActor,
  type Tx,
} from "./context";
export type AuditScope = {
  workspaceId: string;
  siteId: string;
  auditId: string;
};
export type AuditDeclarations = ReadinessDeclarations & {
  contextRevisionId?: string;
  contextRevision?: number;
};
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function scoped(
  tx: Tx,
  actor: ReadActor,
  scope: AuditScope,
  action: "read" | "run" | "edit" | "export",
  now = new Date(),
) {
  await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, action);
  const run = await tx.auditRun.findFirst({
    where: {
      id: scope.auditId,
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      resultExpiresAt: { gt: now },
    },
  });
  if (!run)
    throw new Error(
      (await tx.auditRun.count({
        where: { ...siteScope(scope), id: scope.auditId },
      }))
        ? "SOURCE_EXPIRED"
        : "NOT_FOUND",
    );
  return run;
}
function freshVerification(site: { verifiedAt: Date | null }) {
  const verified = site.verifiedAt?.getTime();
  if (!verified || verified > Date.now() || Date.now() - verified > 86400000)
    throw new Error("SITE_NOT_VERIFIED");
}
async function lock(tx: Tx, scope: AuditScope) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${scope.siteId} AND "workspaceId"=${scope.workspaceId} FOR UPDATE`;
}
export async function createAuditRun(
  db: PrismaClient,
  actor: Actor,
  input: {
    workspaceId: string;
    siteId: string;
    idempotencyKey: string;
    manifest: string[];
    profile: "LOCAL_RAW_V1";
    declarations?: AuditDeclarations;
  },
) {
  if (
    !input.idempotencyKey ||
    input.idempotencyKey.length > 128 ||
    input.profile !== "LOCAL_RAW_V1"
  )
    throw new Error("INVALID_AUDIT_INPUT");
  return withActor(db, actor, input.workspaceId, async (tx) => {
    await lock(tx, { ...input, auditId: "" });
    const site = await authorizeSiteIn(
      tx,
      actor,
      input.workspaceId,
      input.siteId,
      "run",
    );
    freshVerification(site);
    const manifest = auditManifest(input.manifest, site.origin);
    const previous = await tx.auditRun.findUnique({
      where: {
        workspaceId_siteId_userId_idempotencyKey: {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          userId: actor.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (previous?.methodologyVersion === "readiness-v1") {
      const historicalHash = fingerprint({
        manifest,
        profile: input.profile,
        declarations: input.declarations ?? {},
      });
      if (previous.inputHash !== historicalHash)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return previous;
    }
    const declarations = validateDeclarations(
      input.declarations ?? {},
      manifest,
      site.origin,
    );
    const inputHash = fingerprint({
      manifest,
      profile: input.profile,
      declarations,
    });
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return previous;
    }
    const context = await tx.siteContextRevision.findFirst({
      where: { workspaceId: input.workspaceId, siteId: input.siteId },
      orderBy: { revision: "desc" },
    });
    const contextContent = context?.content as
      { brandName?: string; approvedAliases?: string[] } | undefined;
    const frozenDeclarations = context
      ? {
          brandName: contextContent?.brandName,
          approvedAliases: contextContent?.approvedAliases,
          ...declarations,
          contextRevisionId: context.id,
          contextRevision: context.revision,
        }
      : declarations;
    if (
      await tx.auditRun.findFirst({
        where: {
          workspaceId: input.workspaceId,
          status: { in: ["QUEUED", "RUNNING"] },
        },
      })
    )
      throw new Error("AUDIT_ALREADY_ACTIVE");
    return tx.auditRun.create({
      data: {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        userId: actor.userId,
        securityVersion: actor.securityVersion,
        idempotencyKey: input.idempotencyKey,
        inputHash,
        manifest: json(manifest),
        profile: input.profile,
        declarations: json(frozenDeclarations),
        methodologyVersion: "readiness-v2",
        storageFormat: artifactStore(db) ? STORAGE : null,
      },
    });
  });
}
export async function listAuditRuns(
  db: PrismaClient,
  actor: ReadActor,
  scope: Omit<AuditScope, "auditId">,
) {
  return withEvidenceRead(
    db,
    actor,
    scope,
    "read",
    "audits:read",
    async (tx) => {
      return tx.auditRun.findMany({
        where: { ...siteScope(scope), resultExpiresAt: { gt: new Date() } },
        select: {
          id: true,
          status: true,
          createdAt: true,
          completedAt: true,
          profile: true,
          methodologyVersion: true,
          resultExpiresAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
      });
    },
  );
}
export async function readAuditRun(
  db: PrismaClient,
  actor: ReadActor,
  scope: AuditScope,
  action: "read" | "export" = "read",
  now = new Date(),
) {
  return withEvidenceRead(
    db,
    actor,
    scope,
    action,
    "audits:read",
    async (tx) => {
      const run = await scoped(tx, actor, scope, action, now);
      const pages = await pageReceipts(
        tx,
        scope,
        now,
        artifactStore(db) && !isTokenActor(actor)
          ? actor.securityVersion
          : null,
      );
      const actions = await tx.issueAction.findMany({
        where: { auditId: run.id, workspaceId: scope.workspaceId },
        orderBy: { createdAt: "asc" },
      });
      return {
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
        resultExpiresAt: run.resultExpiresAt,
        profile: run.profile,
        methodologyVersion: run.methodologyVersion,
        declarations: declared(run.declarations),
        manifest: Array.isArray(run.manifest)
          ? run.manifest
              .filter(
                (u): u is string => typeof u === "string" && u.length <= 2048,
              )
              .slice(0, 25)
          : [],
        evaluation: compactEvaluation(run.evaluation),
        pages,
        actions,
      };
    },
  );
}
/** Only the scoped browser runner needs checkpoint identities to choose its next page. */
export async function readAuditProgress(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const run = await scoped(tx, actor, scope, "run");
    const pages = await tx.auditPage.findMany({
      where: { workspaceId: scope.workspaceId, auditId: run.id },
      select: { requestedUrl: true },
    });
    return { manifest: run.manifest, pages };
  });
}
export async function readAuditSource(
  db: PrismaClient,
  actor: ReadActor,
  scope: AuditScope,
  url: string,
  revalidateActor: () => Promise<Actor>,
) {
  if (isTokenActor(actor)) throw new Error("FORBIDDEN");
  if (typeof revalidateActor !== "function")
    throw Error("CURRENT_ACTOR_REQUIRED");
  const currentActor = async () => {
    const current = await revalidateActor();
    if (
      !current ||
      current.userId !== actor.userId ||
      current.sessionId !== actor.sessionId ||
      current.securityVersion !== actor.securityVersion
    )
      throw Error("FORBIDDEN");
    return current;
  };
  const ticket = (current: Actor = actor) =>
    withEvidenceRead(db, current, scope, "read", undefined, async (tx) => {
      const [row] = await tx.$queryRaw<
        { version: ArtifactVersion | null; format: string | null }[]
      >`
      SELECT r."storageFormat" AS format,lyraseo_audit.source_ticket(${scope.siteId},${scope.auditId},${url},${current.securityVersion}::integer) AS version
      FROM "AuditRun" r JOIN "AuditPage" p ON p."auditId"=r.id AND p."workspaceId"=r."workspaceId"
      WHERE r."workspaceId"=${scope.workspaceId} AND r."siteId"=${scope.siteId} AND r.id=${scope.auditId} AND p."requestedUrl"=${url}`;
      if (!row) throw Error("NOT_FOUND");
      return row;
    });
  const first = await ticket();
  if (first.format === STORAGE) {
    if (!first.version) throw Error("SOURCE_EXPIRED");
    const store = artifactStore(db);
    if (!store) throw Error("ARTIFACT_UNAVAILABLE");
    const bytes = await store.openBounded(first.version).catch(() => {
      throw Error("ARTIFACT_UNAVAILABLE");
    });
    const copy = verifyReturnedBytes(first.version, bytes);
    // Identity I/O runs after buffering and outside every product transaction.
    // The final scope check observes changes made while identity was pending.
    const latest = await ticket(await currentActor());
    if (
      latest.format !== first.format ||
      !latest.version ||
      fingerprint(latest.version) !== fingerprint(first.version)
    )
      throw Error("SOURCE_EXPIRED");
    return copy;
  }
  const readLegacy = (current: Actor) =>
    withEvidenceRead(db, current, scope, "read", undefined, async (tx) => {
      const now = new Date();
      const rows = await tx.$queryRaw<
        Array<{
          raw: string | null;
          sha256: string | null;
          pageId: string;
          rawExpiresAt: Date;
          resultExpiresAt: Date;
        }>
      >`
      SELECT p.provenance->>'rawHtml' AS raw,p.provenance->>'sha256' AS sha256,p.id AS "pageId",t."rawExpiresAt",r."resultExpiresAt" FROM "AuditPage" p
      JOIN "AuditRun" r ON r.id=p."auditId" AND r."workspaceId"=p."workspaceId"
      JOIN "AuditPageRetention" t ON t."pageId"=p.id AND t."workspaceId"=p."workspaceId" AND t."auditId"=p."auditId"
      WHERE r."workspaceId"=${scope.workspaceId} AND r."siteId"=${scope.siteId} AND r.id=${scope.auditId}
        AND p."requestedUrl"=${url} AND r."resultExpiresAt">${now} AND t."rawExpiresAt">${now}
        AND r."storageFormat" IS NULL AND jsonb_typeof(p.provenance->'rawHtml')='string'
        AND octet_length(p.provenance->>'rawHtml')<=5242880`;
      if (!rows[0]?.raw) {
        if (
          !(await tx.auditPage.count({
            where: {
              workspaceId: scope.workspaceId,
              auditId: scope.auditId,
              requestedUrl: url,
              audit: { siteId: scope.siteId },
            },
          }))
        )
          throw new Error("NOT_FOUND");
        throw new Error("SOURCE_EXPIRED");
      }
      const bytes = new TextEncoder().encode(rows[0].raw);
      if (bytes.byteLength > 5 * 1024 * 1024) throw Error("SOURCE_EXPIRED");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (rows[0].sha256 && digest !== rows[0].sha256)
        throw new Error("SOURCE_EXPIRED");
      return {
        bytes,
        digest,
        sha256: rows[0].sha256,
        pageId: rows[0].pageId,
        rawExpiresAt: +rows[0].rawExpiresAt,
        resultExpiresAt: +rows[0].resultExpiresAt,
      };
    });
  const legacy = await readLegacy(actor);
  const latest = await readLegacy(await currentActor());
  if (
    legacy.pageId !== latest.pageId ||
    legacy.sha256 !== latest.sha256 ||
    legacy.digest !== latest.digest ||
    legacy.rawExpiresAt !== latest.rawExpiresAt ||
    legacy.resultExpiresAt !== latest.resultExpiresAt ||
    !Buffer.from(legacy.bytes).equals(latest.bytes)
  )
    throw Error("SOURCE_EXPIRED");
  return legacy.bytes;
}
// Browser-only fixed storage adapter. Its caller must already be in the scoped
// web transaction; the SQL guard independently binds and locks that actor.
async function webTransition(
  tx: Tx,
  actor: Actor,
  scope: AuditScope,
  action: string,
  fence: number | null = null,
  owner: string | null = null,
  data: unknown = null,
) {
  if ("credential" in actor) throw new Error("FORBIDDEN");
  const [row] = await tx.$queryRaw<
    { id: string }[]
  >`SELECT lyraseo_audit.web_transition(
   ${scope.siteId}::text,${scope.auditId}::text,${actor.securityVersion}::integer,${action}::text,
   ${fence}::integer,${owner}::text,${data === null ? null : JSON.stringify(data)}::json) AS id`.catch(
    (error: unknown) => {
      const code = auditErrorCode(error);
      if (code) throw new Error(code);
      throw error;
    },
  );
  return row!.id;
}
export async function claimAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  leaseOwner: string,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const run = await scoped(tx, actor, scope, "run");
    if (run.storageFormat === STORAGE && !artifactStore(db))
      throw Error("ARTIFACT_UNAVAILABLE");
    const id = await webTransition(tx, actor, scope, "claim", null, leaseOwner);
    const lease = await tx.auditRun.findUniqueOrThrow({ where: { id } });
    if (run.storageFormat === STORAGE)
      await tx.$queryRaw`SELECT lyraseo_audit.web_artifact_pages(${scope.siteId},${scope.auditId},${actor.securityVersion}::integer,${lease.fence}::integer)`;
    return lease;
  });
}
export async function checkpointAuditPage(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
  evidence: PageEvidence,
  provenance: Record<string, unknown>,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const id = await webTransition(tx, actor, scope, "prepare", fence);
    validateRawPage(
      await tx.auditRun.findUniqueOrThrow({ where: { id } }),
      evidence,
      provenance,
    );
    const pageId = await webTransition(
      tx,
      actor,
      scope,
      "checkpoint",
      fence,
      null,
      { evidence, provenance },
    );
    return tx.auditPage.findUniqueOrThrow({ where: { id: pageId } });
  });
}
/** Persist private checkpoints and their yield/completion atomically; filesystem I/O separates the transactions. */
export async function checkpointPrivateAudit(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
  receipt: AcquisitionReceipt,
) {
  const scopedTx = <T>(work: (tx: Tx) => Promise<T>) =>
    withActor(db, actor, scope.workspaceId, work);
  const prepared = await scopedTx(async (tx) => {
    const run = await scoped(tx, actor, scope, "run");
    const [row] = await tx.$queryRaw<
      { origin: string }[]
    >`SELECT lyraseo_origin.web_context(${scope.siteId},${scope.auditId},${actor.securityVersion}::integer,${fence}::integer,${artifactOriginKeyId(db)}) AS origin`;
    if (!row) throw Error("ARTIFACT_UNAVAILABLE");
    return { run, origin: row.origin };
  });
  const raw = JSON.stringify(
    await witnessedObservation(
      db,
      prepared.run,
      "web/" + scope.auditId + "/" + fence,
      receipt,
      prepared.origin,
    ),
  );
  const reservation = await scopedTx(async (tx) => {
    await scoped(tx, actor, scope, "run");
    const [row] = await tx.$queryRaw<
      { result: ArtifactReservation }[]
    >`SELECT lyraseo_audit.web_artifact_reserve(${scope.siteId},${scope.auditId},${actor.securityVersion}::integer,${fence}::integer,${raw}::json) AS result`;
    return row!.result;
  });
  const initialRun = prepared.run;
  const data = JSON.stringify(
    await verifiedPublication(db, initialRun, receipt, reservation),
  );
  await scopedTx(async (tx) => {
    const run = await scoped(tx, actor, scope, "run");
    const { scratch } = attestArtifactReceipt(run, receipt);
    const [prior] = await tx.$queryRaw<
      { pages: PageEvidence[] }[]
    >`SELECT lyraseo_audit.web_artifact_pages(${scope.siteId},${scope.auditId},${actor.securityVersion}::integer,${fence}::integer) AS pages`;
    const pages = [...prior!.pages, scratch].sort((a, b) =>
      a.requestedUrl < b.requestedUrl
        ? -1
        : a.requestedUrl > b.requestedUrl
          ? 1
          : 0,
    );
    const evaluation =
      pages.length === (run.manifest as string[]).length
        ? compactEvaluation(
            frozenEvaluation(
              run,
              (await tx.site.findUniqueOrThrow({ where: { id: scope.siteId } }))
                .origin,
              pages,
            ),
          )
        : null;
    await tx.$queryRaw`SELECT lyraseo_audit.web_artifact_commit(${scope.siteId},${scope.auditId},${actor.securityVersion}::integer,${fence}::integer,${data}::json,${evaluation ? JSON.stringify(evaluation) : null}::json)`;
  });
}
export async function finishAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const id = await webTransition(tx, actor, scope, "prepare", fence);
    const run = await tx.auditRun.findUniqueOrThrow({ where: { id } });
    const pages = await tx.auditPage.findMany({
      where: { auditId: id },
      select: { evidence: true },
      orderBy: { requestedUrl: "asc" },
    });
    const site = await tx.site.findUniqueOrThrow({
      where: { id: scope.siteId },
    });
    const evaluation = frozenEvaluation(
      run,
      site.origin,
      pages.map((p) => p.evidence as unknown as PageEvidence),
    );
    await webTransition(tx, actor, scope, "finish", fence, null, evaluation);
    return tx.auditRun.findUniqueOrThrow({ where: { id } });
  });
}
export async function compareAuditRuns(
  db: PrismaClient,
  actor: ReadActor,
  scope: AuditScope,
  beforeAuditId: string,
) {
  return withEvidenceRead(
    db,
    actor,
    scope,
    "read",
    "audits:read",
    async (tx) => {
      const now = new Date();
      const after = await scoped(tx, actor, scope, "read", now),
        before = await scoped(
          tx,
          actor,
          { ...scope, auditId: beforeAuditId },
          "read",
          now,
        );
      if (!before.evaluation || !after.evaluation)
        throw new Error("AUDIT_INCOMPLETE");
      const result = compareAudits(
        {
          ...(before.evaluation as unknown as AuditEvaluation),
          profile: before.profile,
          declarations: before.declarations as AuditDeclarations,
        },
        {
          ...(after.evaluation as unknown as AuditEvaluation),
          profile: after.profile,
          declarations: after.declarations as AuditDeclarations,
        },
      );
      if (before.profile !== after.profile) result.scoreDelta = null;
      return {
        ...compactGroups(result),
        profileComparable: before.profile === after.profile,
      };
    },
  );
}
export async function reviewAuditIssue(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  input: {
    ruleId: string;
    scopeKey: string;
    disposition: "OPEN" | "REVIEWED" | "DISMISSED";
    reason: string;
  },
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const run = await scoped(tx, actor, scope, "edit");
    if (!run.evaluation) throw new Error("AUDIT_INCOMPLETE");
    const evaluation = run.evaluation as unknown as AuditEvaluation;
    if (
      !evaluation.rules.some(
        (r) =>
          r.ruleId === input.ruleId &&
          r.scopeKey === input.scopeKey &&
          ["WARNING", "FAIL"].includes(r.outcome),
      ) ||
      !["OPEN", "REVIEWED", "DISMISSED"].includes(input.disposition) ||
      !input.reason.trim() ||
      input.reason.length > 512
    )
      throw new Error("INVALID_ISSUE_ACTION");
    return tx.issueAction.create({
      data: {
        ruleId: input.ruleId,
        scopeKey: input.scopeKey,
        disposition: input.disposition,
        reason: input.reason,
        userId: actor.userId,
        workspaceId: scope.workspaceId,
        auditId: run.id,
      },
    });
  });
}
/** Terminates a failed controlled acquisition without publishing a partial score. */
async function endLease(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  action: "fail" | "yield" | "cancel",
  fence: number | null,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    const id = await webTransition(tx, actor, scope, action, fence);
    return tx.auditRun.findUniqueOrThrow({ where: { id } });
  });
}
export function failAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return endLease(db, actor, scope, "fail", fence);
}
export function yieldAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
  fence: number,
) {
  return endLease(db, actor, scope, "yield", fence);
}
/** Authorized editors can stop another sponsor's abandoned run across profiles. */
export function cancelAuditRun(
  db: PrismaClient,
  actor: Actor,
  scope: AuditScope,
) {
  return endLease(db, actor, scope, "cancel", null);
}
