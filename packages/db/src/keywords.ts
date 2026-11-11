import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "../generated/client";
import {
  buildSearchOpportunities,
  comparableSearchWindow,
} from "@lyraseo/visibility";
import {
  withActor,
  authorizeSiteIn,
  withEvidenceRead,
  type Actor,
  type ReadActor,
} from "./context";
import type { SiteScope } from "./sites";
export type KeywordSelectionInput = {
  snapshotId: string;
  kind: string;
  query: string;
  page: string;
  keywords: string[];
  country: "IN";
  language: "en";
  idempotencyKey: string;
};
export type KeywordSelection = {
  id: string;
  status: "UNQUALIFIED";
  requestHash: string;
  request: {
    keywords: string[];
    page: string;
    query: string;
    market: { country: "IN"; language: "en"; support: "UNCONFIRMED" };
    opportunity: unknown;
  };
  createdAt: Date;
  resultExpiresAt: Date;
  result: Prisma.JsonValue | null;
};
function normalize(input: KeywordSelectionInput) {
  if (
    input.country !== "IN" ||
    input.language !== "en" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 128 ||
    !Array.isArray(input.keywords) ||
    input.keywords.length < 1 ||
    input.keywords.length > 20
  )
    throw Error("INVALID_KEYWORD_SELECTION");
  const keywords = input.keywords.map((k) =>
    typeof k === "string" ? k.trim().normalize("NFC") : "",
  );
  if (
    keywords.some(
      (k) => !k || k.length > 100 || /[\u0000-\u001f\u007f]/.test(k),
    ) ||
    new Set(keywords.map((k) => k.toLowerCase())).size !== keywords.length
  )
    throw Error("INVALID_KEYWORD_SELECTION");
  return keywords;
}
export async function prepareKeywordSelection(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  input: KeywordSelectionInput,
) {
  const keywords = normalize(input);
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "run");
    const source = await tx.searchSnapshot.findFirst({
      where: {
        id: input.snapshotId,
        workspaceId: s.workspaceId,
        siteId: s.siteId,
        resultExpiresAt: { gt: new Date() },
      },
    });
    let previous: typeof source = null;
    if (
      source &&
      input.kind === "declining-clicks" &&
      source.shape === "page"
    ) {
      const candidates = await tx.searchSnapshot.findMany({
        where: {
          workspaceId: s.workspaceId,
          siteId: s.siteId,
          resultExpiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          shape: true,
          startDate: true,
          endDate: true,
          property: true,
          status: true,
        },
        orderBy: { endDate: "desc" },
        take: 200,
      });
      const match = comparableSearchWindow(source, candidates);
      if (match)
        previous = await tx.searchSnapshot.findFirst({
          where: {
            id: match.id,
            workspaceId: s.workspaceId,
            siteId: s.siteId,
            resultExpiresAt: { gt: new Date() },
          },
        });
    }
    const opportunity =
      source &&
      buildSearchOpportunities(previous ? [source, previous] : [source]).find(
        (x) =>
          x.kind === input.kind &&
          x.query === input.query &&
          x.page === input.page,
      );
    if (!source || !opportunity) throw Error("OPPORTUNITY_UNAVAILABLE");
    const request = {
      version: 1,
      keywords,
      page: opportunity.page,
      query: opportunity.query,
      market: { country: "IN", language: "en", support: "UNCONFIRMED" },
      opportunity,
      sourceSnapshots: [source, ...(previous ? [previous] : [])].map(
        (snapshot) => ({
          id: snapshot.id,
          property: snapshot.property,
          startDate: snapshot.startDate,
          endDate: snapshot.endDate,
          resultExpiresAt: snapshot.resultExpiresAt.toISOString(),
        }),
      ),
    };
    const expiresAt = new Date(
      Math.min(
        source.resultExpiresAt.getTime(),
        previous?.resultExpiresAt.getTime() ?? Infinity,
      ),
    );
    const encoded = JSON.stringify(request),
      hash = createHash("sha256").update(encoded).digest("hex");
    // Serialize this selection's retry key without locking unrelated sites/users.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`keyword:${s.workspaceId}:${s.siteId}:${actor.userId}:${input.idempotencyKey}`},0))::text`;
    const prior = await tx.$queryRaw<
      { id: string; requestHash: string; status: "UNQUALIFIED" }[]
    >`SELECT id,"requestHash",status FROM "KeywordSelection" WHERE "workspaceId"=${s.workspaceId} AND "siteId"=${s.siteId} AND "createdBy"=${actor.userId} AND "idempotencyKey"=${input.idempotencyKey}`;
    const currentUser = await tx.productUser.findUnique({
      where: { id: actor.userId },
    });
    if (
      !currentUser ||
      currentUser.suspended ||
      currentUser.securityVersion !== actor.securityVersion
    )
      throw Error("FORBIDDEN");
    if (prior[0]) {
      if (prior[0].requestHash !== hash) throw Error("CONFLICT");
      return prior[0];
    }
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "run");
    if (expiresAt <= new Date()) throw Error("SOURCE_EXPIRED");
    const [saved] = await tx.$queryRaw<
      { id: string; requestHash: string; status: "UNQUALIFIED" }[]
    >`INSERT INTO "KeywordSelection"(id,"workspaceId","siteId","createdBy","idempotencyKey","requestHash",request,"sourceSnapshotId","resultExpiresAt") VALUES(${randomUUID()}::uuid,${s.workspaceId},${s.siteId},${actor.userId},${input.idempotencyKey},${hash},${encoded}::jsonb,${source.id},${expiresAt}) RETURNING id,"requestHash",status`;
    if (!saved) throw Error("KEYWORD_SELECTION_UNAVAILABLE");
    return saved;
  });
}
export async function readKeywordSelections(
  db: PrismaClient,
  actor: ReadActor,
  s: SiteScope,
) {
  return withEvidenceRead(
    db,
    actor,
    s,
    "read",
    "search:read",
    (tx) =>
      tx.$queryRaw<
        KeywordSelection[]
      >`SELECT q.id,q.status,q."requestHash",q.request,q."createdAt",q."resultExpiresAt",CASE WHEN r."resultExpiresAt">clock_timestamp() THEN jsonb_build_object('source',r.source,'currency',r.currency,'method',r.method,'market',r.market,'collectedAt',r."collectedAt",'rows',r.rows) ELSE NULL END AS result FROM "KeywordSelection" q LEFT JOIN "KeywordEnrichmentResult" r ON r."selectionId"=q.id WHERE q."workspaceId"=${s.workspaceId} AND q."siteId"=${s.siteId} AND q."resultExpiresAt">clock_timestamp() ORDER BY q."createdAt" DESC,q.id DESC LIMIT 100`,
  );
}
/** Qualification is deliberately unavailable. A saved selection is not a quote,
 * provider request or permission to spend. Reads never invoke a provider. */
export async function requestKeywordQuote(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  id: string,
) {
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "run");
    const [row] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "KeywordSelection" WHERE id::text=${id} AND "workspaceId"=${s.workspaceId} AND "siteId"=${s.siteId} AND "resultExpiresAt">clock_timestamp()`;
    if (!row) throw Error("KEYWORD_SELECTION_UNAVAILABLE");
    return {
      selectionId: row.id,
      status: "UNQUALIFIED" as const,
      provider: "DATAFORSEO" as const,
      maximumCost: null,
      quoteId: null,
      dispatchable: false as const,
      reason:
        "Provider account, tariff, locale and storage rights require qualification.",
    };
  });
}
