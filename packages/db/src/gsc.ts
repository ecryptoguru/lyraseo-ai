import { siteScope } from "./sites";
import {
  buildSearchOpportunities,
  buildSearchAuditOpportunities,
} from "@lyraseo/visibility";
/** Shared authorization/persistence boundary for web and future MCP consumers. */
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Prisma } from "../generated/client";
import {
  withActor,
  authorizeSiteIn,
  type Actor,
  type ReadActor,
  requireReadScope,
  isTokenActor,
  type Tx,
} from "./context";
import type { SiteScope } from "./sites";
export type SearchRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  position: number | null;
  ctr: number | null;
};
export type SearchShape = "page" | "query" | "date" | "query,page";
export type GoogleProvider = {
  authorize(state: string, verifier: string): string;
  exchange(code: string, verifier: string): Promise<string>;
  properties(
    refreshToken: string,
  ): Promise<{ siteUrl: string; permissionLevel: string }[]>;
  query(
    refreshToken: string,
    property: string,
    input: {
      startDate: string;
      endDate: string;
      shape: SearchShape;
      startRow: number;
    },
  ): Promise<SearchRow[]>;
};
export type SecretBox = {
  seal(value: string, aad: string): string;
  open(value: string, aad: string): string;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const retentionCutoff = () => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - 13);
  return date;
};
const aad = (s: SiteScope) => `${s.workspaceId}:${s.siteId}`;
async function authorize(tx: Tx, actor: ReadActor, s: SiteScope, edit = false) {
  const site = await authorizeSiteIn(
    tx,
    actor,
    s.workspaceId,
    s.siteId,
    edit ? "edit" : "read",
  );
  if (edit) {
    const m = await tx.membership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: s.workspaceId,
          userId: actor.userId,
        },
      },
    });
    if (!m || !["OWNER", "ADMIN"].includes(m.role))
      throw new Error("FORBIDDEN");
  }
  return site;
}
async function lock(tx: Tx, s: SiteScope) {
  await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${s.siteId} AND "workspaceId"=${s.workspaceId} FOR UPDATE`;
}
export async function beginGoogleConnect(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  p: GoogleProvider,
  box: SecretBox,
) {
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  await withActor(db, actor, s.workspaceId, async (tx) => {
    await lock(tx, s);
    await authorize(tx, actor, s, true);
    await tx.googleOAuthState.deleteMany({ where: siteScope(s) });
    await tx.googleOAuthState.create({
      data: {
        ...siteScope(s),
        id: hash(state),
        userId: actor.userId,
        sessionId: actor.sessionId,
        securityVersion: actor.securityVersion,
        verifier: box.seal(verifier, aad(s)),
        expiresAt: new Date(Date.now() + 600000),
      },
    });
  });
  return { url: p.authorize(state, verifier) };
}
export async function completeGoogleConnect(
  db: PrismaClient,
  actor: Actor,
  state: string,
  code: string,
  p: GoogleProvider,
  box: SecretBox,
) {
  // Locate only in actor-authorized workspaces: no global credential lookup bypasses RLS.
  const memberships = await withActor(db, actor, "", (tx) =>
    tx.membership.findMany({ where: { userId: actor.userId } }),
  );
  let attempt: Awaited<ReturnType<typeof consume>> | undefined;
  async function consume(workspaceId: string) {
    return withActor(db, actor, workspaceId, async (tx) => {
      const row = await tx.googleOAuthState.findFirst({
        where: {
          id: hash(state),
          userId: actor.userId,
          sessionId: actor.sessionId,
          securityVersion: actor.securityVersion,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!row) return null;
      await lock(tx, row);
      await authorize(tx, actor, row, true);
      const n = await tx.googleOAuthState.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (n.count !== 1) throw new Error("INVALID_OAUTH_STATE");
      return row;
    });
  }
  for (const m of memberships) {
    const row = await consume(m.workspaceId);
    if (row) {
      attempt = row;
      break;
    }
  }
  if (!attempt) throw new Error("INVALID_OAUTH_STATE");
  const s = { workspaceId: attempt.workspaceId, siteId: attempt.siteId };
  if (!code) throw new Error("GOOGLE_CONSENT_DENIED");
  const refresh = await p.exchange(code, box.open(attempt.verifier, aad(s)));
  await withActor(db, actor, s.workspaceId, async (tx) => {
    await lock(tx, s);
    await authorize(tx, actor, s, true);
    const current = await tx.googleOAuthState.findUnique({
      where: { id: attempt!.id },
    });
    if (!current) throw new Error("INVALID_OAUTH_STATE");
    await tx.googleConnection.upsert({
      where: { siteId: s.siteId },
      create: {
        ...siteScope(s),
        encryptedRefreshToken: box.seal(refresh, aad(s)),
      },
      update: {
        encryptedRefreshToken: box.seal(refresh, aad(s)),
        property: null,
        generation: { increment: 1 },
      },
    });
    // Preserve immutable evidence across consent or selection refresh. Disconnect explicitly purges it.

    await tx.googleOAuthState.deleteMany({ where: siteScope(s) });
  });
  return s;
}
async function connection(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  edit = false,
) {
  return withActor(db, actor, s.workspaceId, async (tx) => {
    const site = await authorize(tx, actor, s, edit);
    const c = await tx.googleConnection.findFirst({ where: siteScope(s) });
    if (!c) throw new Error("GOOGLE_DISCONNECTED");
    return { site, c };
  });
}
export async function googleProperties(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  p: GoogleProvider,
  box: SecretBox,
) {
  const { c } = await connection(db, actor, s, true);
  const properties = await p.properties(
    box.open(c.encryptedRefreshToken, aad(s)),
  );
  await connection(db, actor, s, true);
  return properties.filter((x) => x.permissionLevel !== "siteUnverifiedUser");
}
export async function selectGoogleProperty(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  property: string,
  p: GoogleProvider,
  box: SecretBox,
) {
  const { site, c } = await connection(db, actor, s, true);
  if (!site.verifiedAt || property !== site.origin + "/")
    throw new Error("EXACT_VERIFIED_ORIGIN_REQUIRED");
  const properties = await p.properties(
    box.open(c.encryptedRefreshToken, aad(s)),
  );
  if (
    !properties.some(
      (x) =>
        x.siteUrl === property &&
        ["siteOwner", "siteFullUser", "siteRestrictedUser"].includes(
          x.permissionLevel,
        ),
    )
  )
    throw new Error("GOOGLE_PROPERTY_FORBIDDEN");
  await withActor(db, actor, s.workspaceId, async (tx) => {
    await lock(tx, s);
    await authorize(tx, actor, s, true);
    const n = await tx.googleConnection.updateMany({
      where: { id: c.id, generation: c.generation },
      data: { property, generation: { increment: 1 } },
    });
    if (n.count !== 1) throw new Error("GOOGLE_CONNECTION_CHANGED");
    // Preserve immutable evidence across consent or selection refresh. Disconnect explicitly purges it.
  });
  return { property };
}
export function validateSearchWindow(startDate: string, endDate: string) {
  const valid = (x: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(x) &&
    new Date(x + "T00:00:00Z").toISOString().slice(0, 10) === x;
  try {
    if (!valid(startDate) || !valid(endDate)) throw 0;
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
    if (days < 0 || days > 89 || Date.parse(endDate) > Date.now()) throw 0;
  } catch {
    throw new Error("INVALID_SEARCH_WINDOW");
  }
}
export async function importGoogleSearch(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  input: { startDate: string; endDate: string; shape: SearchShape },
  p: GoogleProvider,
  box: SecretBox,
) {
  input = {
    startDate: input.startDate,
    endDate: input.endDate,
    shape: input.shape,
  };
  validateSearchWindow(input.startDate, input.endDate);
  if (!["page", "query", "date", "query,page"].includes(input.shape))
    throw new Error("INVALID_SEARCH_SHAPE");
  const { c, site } = await connection(db, actor, s, true);
  if (!c.property || !site.verifiedAt || c.property !== site.origin + "/")
    throw new Error("GOOGLE_PROPERTY_REQUIRED");
  const key = {
    ...siteScope(s),
    property: c.property,
    startDate: input.startDate,
    endDate: input.endDate,
    shape: input.shape,
  };
  const id = hash(JSON.stringify(key)),
    attempt = randomBytes(16).toString("hex");
  const admitted = await withActor(db, actor, s.workspaceId, async (tx) => {
    await lock(tx, s);
    await authorize(tx, actor, s, true);
    const current = await tx.googleConnection.findFirst({
      where: {
        ...siteScope(s),
        id: c.id,
        generation: c.generation,
        property: c.property,
      },
    });
    if (!current) throw new Error("GOOGLE_CONNECTION_CHANGED");
    const cached = await tx.searchSnapshot.findFirst({
      where: { ...key, importedAt: { gte: retentionCutoff() } },
    });
    if (cached) return cached;
    await tx.searchImport.deleteMany({
      where: { ...siteScope(s), startedAt: { lt: retentionCutoff() } },
    });
    await tx.searchImport.updateMany({
      where: {
        ...siteScope(s),
        status: "running",
        OR: [
          { leaseUntil: { lte: new Date() } },
          { generation: { not: c.generation } },
        ],
      },
      data: {
        status: "failed",
        failure: "GOOGLE_IMPORT_LEASE_EXPIRED",
        completedAt: new Date(),
      },
    });
    // Site lock serializes admission only; no transaction remains open during HTTP.
    if (
      await tx.searchImport.count({
        where: { ...siteScope(s), status: "running" },
      })
    )
      throw new Error("GOOGLE_IMPORT_RUNNING");
    const data = {
      status: "running",
      generation: c.generation,
      attempt,
      leaseUntil: new Date(Date.now() + 300000),
      failure: null,
      startedAt: new Date(),
      completedAt: null,
    };
    await tx.searchImport.upsert({
      where: { id },
      create: { id, ...key, ...data },
      update: data,
    });
    return null;
  });
  if (admitted) return { ...admitted, cached: true };
  async function activeLease() {
    await withActor(db, actor, s.workspaceId, async (tx) => {
      await authorize(tx, actor, s, true);
      const active = await tx.googleConnection.findFirst({
        where: {
          ...siteScope(s),
          id: c.id,
          generation: c.generation,
          property: c.property,
        },
      });
      const lease = await tx.searchImport.findFirst({
        where: {
          id,
          attempt,
          generation: c.generation,
          status: "running",
          leaseUntil: { gt: new Date() },
        },
      });
      if (!active || !lease) throw new Error("GOOGLE_CONNECTION_CHANGED");
    });
  }
  try {
    await activeLease();
    const token = box.open(c.encryptedRefreshToken, aad(s));
    const properties = await p.properties(token);
    if (
      !properties.some(
        (x) =>
          x.siteUrl === c.property &&
          x.permissionLevel !== "siteUnverifiedUser",
      )
    )
      throw new Error("GOOGLE_PROPERTY_FORBIDDEN");
    const rows: SearchRow[] = [];
    let capped = false;
    while (rows.length < 100000) {
      await activeLease();
      const batch = await p.query(token, c.property, {
        ...input,
        startRow: rows.length,
      });
      if (batch.length > 25000) throw new Error("INVALID_GOOGLE_RESPONSE");
      rows.push(...batch);
      if (rows.length === 100000) {
        capped = true;
        break;
      }
      if (batch.length < 25000) break;
    }
    return await withActor(db, actor, s.workspaceId, async (tx) => {
      await lock(tx, s);
      await authorize(tx, actor, s, true);
      const current = await tx.googleConnection.findFirst({
        where: {
          ...siteScope(s),
          id: c.id,
          generation: c.generation,
          property: c.property,
        },
      });
      if (!current) throw new Error("GOOGLE_CONNECTION_CHANGED");
      const completed = await tx.searchImport.updateMany({
        where: {
          id,
          attempt,
          generation: c.generation,
          status: "running",
          leaseUntil: { gt: new Date() },
        },
        data: { status: "complete", completedAt: new Date() },
      });
      if (completed.count !== 1) throw new Error("GOOGLE_CONNECTION_CHANGED");
      await tx.searchSnapshot.deleteMany({
        where: { ...siteScope(s), importedAt: { lt: retentionCutoff() } },
      });
      const key = {
        ...siteScope(s),
        property: c.property!,
        startDate: input.startDate,
        endDate: input.endDate,
        shape: input.shape,
      };
      const existing = await tx.searchSnapshot.findUnique({
        where: { workspaceId_siteId_property_startDate_endDate_shape: key },
      });
      if (existing) return { ...existing, cached: true };
      return tx.searchSnapshot.upsert({
        where: { workspaceId_siteId_property_startDate_endDate_shape: key },
        create: {
          ...key,
          status: capped ? "partial" : "complete",
          rows: rows as unknown as Prisma.InputJsonValue,
        },
        update: {
          rows: rows as unknown as Prisma.InputJsonValue,
          status: capped ? "partial" : "complete",
          importedAt: new Date(),
        },
      });
    });
  } catch (error) {
    const reason =
      error instanceof Error &&
      /^(GOOGLE_|INVALID_GOOGLE_RESPONSE)/.test(error.message)
        ? error.message
        : "GOOGLE_TEMPORARILY_UNAVAILABLE";
    await withActor(db, actor, s.workspaceId, async (tx) => {
      await authorize(tx, actor, s, true);
      await tx.searchImport.updateMany({
        where: { id, attempt, status: "running" },
        data: { status: "failed", failure: reason, completedAt: new Date() },
      });
    }).catch(() => {});
    throw new Error(reason);
  }
}
export async function disconnectGoogle(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
) {
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await lock(tx, s);
    await authorize(tx, actor, s, true);
    await tx.googleOAuthState.deleteMany({ where: siteScope(s) });
    await tx.googleConnection.deleteMany({ where: siteScope(s) });
    await tx.searchSnapshot.deleteMany({ where: siteScope(s) });
    await tx.searchImport.deleteMany({ where: siteScope(s) });
    return { disconnected: true, purged: true };
  });
}
export async function readGoogleSearch(
  db: PrismaClient,
  actor: ReadActor,
  s: SiteScope,
) {
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await requireReadScope(tx, actor, "search:read");
    await authorize(tx, actor, s);
    const c = await tx.googleConnection.findFirst({
      where: siteScope(s),
      select: { property: true, createdAt: true },
    });
    const cutoff = retentionCutoff();
    const snapshots = await tx.$queryRaw<
      Array<{
        id: string;
        workspaceId: string;
        siteId: string;
        property: string;
        startDate: string;
        endDate: string;
        shape: string;
        status: string;
        importedAt: Date;
        rows: Prisma.JsonValue;
        rowCount: number;
        rowsTruncated: boolean;
      }>
    >`SELECT id,"workspaceId","siteId",property,"startDate","endDate",shape,status,"importedAt",jsonb_path_query_array(rows,'$[0 to 99]') AS rows,jsonb_array_length(rows) AS "rowCount",jsonb_array_length(rows)>100 AS "rowsTruncated" FROM "SearchSnapshot" WHERE "workspaceId"=${s.workspaceId} AND "siteId"=${s.siteId} AND "importedAt">=${cutoff} ORDER BY "importedAt" DESC LIMIT 20`;
    const metadata = await tx.searchSnapshot.findMany({
      where: { ...siteScope(s), importedAt: { gte: cutoff } },
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
    const detailed = metadata.find((x) => x.shape === "query,page"),
      current = metadata.find((x) => x.shape === "page");
    const prior =
      current &&
      metadata.find(
        (x) =>
          x.shape === "page" &&
          x.endDate < current.startDate &&
          x.property === current.property &&
          x.status === "complete" &&
          Date.parse(x.endDate) - Date.parse(x.startDate) ===
            Date.parse(current.endDate) - Date.parse(current.startDate),
      );
    const evidenceIds = [detailed?.id, current?.id, prior?.id].filter(
      (id): id is string => !!id,
    );
    const evidence = await tx.searchSnapshot.findMany({
      where: { ...siteScope(s), id: { in: evidenceIds } },
    });
    // Search-only credentials must not reveal audit evidence through a derived opportunity.
    const includeAudits =
      !isTokenActor(actor) ||
      (
        await tx.apiToken.findUnique({
          where: { id: actor.tokenId },
          select: { scopes: true },
        })
      )?.scopes.includes("audits:read");
    const audits = includeAudits
      ? await tx.auditRun.findMany({
          where: {
            ...siteScope(s),
            status: "COMPLETED",
            createdAt: { gte: cutoff },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
          select: {
            id: true,
            createdAt: true,
            manifest: true,
            evaluation: true,
          },
        })
      : [];
    return {
      connection: c,
      snapshots: snapshots.map((snapshot) => ({
        ...snapshot,
        displayLimited: snapshot.rowsTruncated,
      })),
      coverage:
        "Available provider rows only; Google omits some searches and limits daily rows. Empty rows mean no available data, not proven zero traffic.",
      opportunities: [
        ...buildSearchAuditOpportunities(evidence, audits),
        ...searchOpportunities(evidence),
      ].slice(0, 100),
    };
  });
}
export const searchOpportunities = buildSearchOpportunities;
