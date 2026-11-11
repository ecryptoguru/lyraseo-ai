import { obj } from "./saved-evidence";
import { withEvidenceRead } from "./context";
import { siteScope } from "./sites";
import { normalizeUrl } from "@lyraseo/visibility";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Prisma } from "../generated/client";
import { withActor, authorizeSiteIn, type Actor, type Tx } from "./context";
import type { SiteScope } from "./sites";
import { readGoogleSearch, validateSearchWindow, type SecretBox } from "./gsc";
export const GA4_SHAPE = "landing-organic-session-v1";
export type Ga4Property = {
  property: string;
  displayName: string;
  timeZone: string;
  streams: { streamId: string; displayName: string; defaultUri: string }[];
};
export type Ga4Row = {
  date: string;
  rawLandingPage: string;
  hostName: string;
  streamId: string;
  channel: string;
  sessions: number;
  engagedSessions: number;
  sessionKeyEventRate: number | null;
  normalizedUrl?: string | null;
  unavailableReason?: string | null;
};
export type Ga4Report = {
  rows: Ga4Row[];
  rowCount: number;
  diagnostics: Record<string, unknown>;
  timeZone: string;
};
export type Ga4Provider = {
  authorize(state: string, verifier: string): string;
  exchange(code: string, verifier: string): Promise<string>;
  properties(refresh: string): Promise<Ga4Property[]>;
  report(
    refresh: string,
    property: string,
    input: {
      startDate: string;
      endDate: string;
      streamId: string;
      hostName: string;
    },
  ): Promise<Ga4Report>;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const aad = (s: SiteScope) => `analytics.readonly:${s.workspaceId}:${s.siteId}`;
async function authorize(tx: Tx, actor: Actor, s: SiteScope, edit = false) {
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
export async function beginGa4Connect(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  p: Ga4Provider,
  box: SecretBox,
) {
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  await withActor(db, actor, s.workspaceId, async (tx) => {
    await lock(tx, s);
    await authorize(tx, actor, s, true);
    await tx.analyticsOAuthState.deleteMany({ where: siteScope(s) });
    await tx.analyticsOAuthState.create({
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
export async function completeGa4Connect(
  db: PrismaClient,
  actor: Actor,
  state: string,
  code: string,
  p: Ga4Provider,
  box: SecretBox,
) {
  // Locate only in actor-authorized workspaces: no global credential lookup bypasses RLS.
  const memberships = await withActor(db, actor, "", (tx) =>
    tx.membership.findMany({ where: { userId: actor.userId } }),
  );
  let attempt: Awaited<ReturnType<typeof consume>> | undefined;
  async function consume(workspaceId: string) {
    return withActor(db, actor, workspaceId, async (tx) => {
      const row = await tx.analyticsOAuthState.findFirst({
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
      const n = await tx.analyticsOAuthState.updateMany({
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
  if (!code) throw new Error("ANALYTICS_CONSENT_DENIED");
  const refresh = await p.exchange(code, box.open(attempt.verifier, aad(s)));
  await withActor(db, actor, s.workspaceId, async (tx) => {
    await lock(tx, s);
    await authorize(tx, actor, s, true);
    const current = await tx.analyticsOAuthState.findUnique({
      where: { id: attempt!.id },
    });
    if (!current) throw new Error("INVALID_OAUTH_STATE");
    await tx.analyticsConnection.upsert({
      where: { siteId: s.siteId },
      create: {
        ...siteScope(s),
        encryptedRefreshToken: box.seal(refresh, aad(s)),
      },
      update: {
        encryptedRefreshToken: box.seal(refresh, aad(s)),
        property: null,
        streamId: null,
        timeZone: null,
        catalog: [],
        status: "connected",
        generation: { increment: 1 },
      },
    });
    // Selection/consent changes fence inflight work without erasing immutable history.
    await tx.analyticsImport.updateMany({
      where: { ...siteScope(s), status: "running" },
      data: { status: "failed", failure: "ANALYTICS_CONNECTION_CHANGED" },
    });
    await tx.analyticsOAuthState.deleteMany({ where: siteScope(s) });
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
    const c = await tx.analyticsConnection.findFirst({ where: siteScope(s) });
    if (!c) throw new Error("ANALYTICS_DISCONNECTED");
    return { site, c };
  });
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
async function fenced(
  tx: Tx,
  actor: Actor,
  s: SiteScope,
  c: { id: string; generation: number },
) {
  await lock(tx, s);
  await authorize(tx, actor, s, true);
  const current = await tx.analyticsConnection.findFirst({
    where: { ...siteScope(s), id: c.id, generation: c.generation },
  });
  if (!current) throw new Error("ANALYTICS_CONNECTION_CHANGED");
  return current;
}
export async function ga4Properties(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  p: Ga4Provider,
  box: SecretBox,
) {
  const { c } = await connection(db, actor, s, true);
  const properties = await p.properties(
    box.open(c.encryptedRefreshToken, aad(s)),
  );
  await withActor(db, actor, s.workspaceId, async (tx) => {
    await fenced(tx, actor, s, c);
    await tx.analyticsConnection.update({
      where: { id: c.id },
      data: { catalog: json(properties) },
    });
  });
  return properties;
}
export async function selectGa4Property(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  property: string,
  streamId: string,
  p: Ga4Provider,
  box: SecretBox,
) {
  const { site, c } = await connection(db, actor, s, true);
  const properties = await p.properties(
    box.open(c.encryptedRefreshToken, aad(s)),
  );
  const selected = properties.find((x) => x.property === property),
    stream = selected?.streams.find((x) => x.streamId === streamId);
  let origin = "";
  try {
    origin = new URL(normalizeUrl(stream?.defaultUri ?? "")).origin;
  } catch {}
  if (!site.verifiedAt || !stream || origin !== site.origin)
    throw new Error("EXACT_VERIFIED_ORIGIN_REQUIRED");
  await withActor(db, actor, s.workspaceId, async (tx) => {
    await fenced(tx, actor, s, c);
    const activeSite = await authorize(tx, actor, s, true);
    if (!activeSite.verifiedAt || activeSite.origin !== site.origin)
      throw new Error("EXACT_VERIFIED_ORIGIN_REQUIRED");

    await tx.analyticsConnection.update({
      where: { id: c.id },
      data: {
        property,
        streamId,
        timeZone: selected!.timeZone,
        generation: { increment: 1 },
        status: "connected",
        catalog: json(properties),
      },
    });
    // Selection/consent changes fence inflight work without erasing immutable history.
    await tx.analyticsImport.updateMany({
      where: { ...siteScope(s), status: "running" },
      data: { status: "failed", failure: "ANALYTICS_CONNECTION_CHANGED" },
    });
  });
  return { property, streamId, timeZone: selected!.timeZone };
}
export async function disconnectGa4(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
) {
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await lock(tx, s);
    await authorize(tx, actor, s, true);
    await tx.analyticsOAuthState.deleteMany({ where: siteScope(s) });
    await tx.analyticsConnection.deleteMany({ where: siteScope(s) });
    await tx.analyticsImport.deleteMany({ where: siteScope(s) });
    return { disconnected: true, purged: true };
  });
}
export function normalizeGa4Rows(
  report: Ga4Report,
  origin: string,
  streamId: string,
  startDate: string,
  endDate: string,
) {
  if (
    !Array.isArray(report.rows) ||
    report.rows.length > 10000 ||
    !Number.isSafeInteger(report.rowCount) ||
    report.rowCount < report.rows.length
  )
    throw new Error("INVALID_ANALYTICS_RESPONSE");
  return report.rows.map((row) => {
    const date = row.date;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < startDate ||
      date > endDate ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      !Number.isSafeInteger(row.sessions) ||
      !Number.isSafeInteger(row.engagedSessions) ||
      row.sessions < 0 ||
      row.engagedSessions < 0 ||
      row.engagedSessions > row.sessions ||
      !(
        row.sessionKeyEventRate === null ||
        (Number.isFinite(row.sessionKeyEventRate) &&
          row.sessionKeyEventRate >= 0 &&
          row.sessionKeyEventRate <= 1)
      )
    )
      throw new Error("INVALID_ANALYTICS_RESPONSE");
    let normalizedUrl: string | null = null,
      unavailableReason: string | null = null;
    if (
      row.hostName !== new URL(origin).hostname ||
      row.streamId !== streamId ||
      row.channel !== "Organic Search"
    )
      unavailableReason = "scope_mismatch";
    else if (
      !row.rawLandingPage ||
      ["(not set)", "(other)"].includes(row.rawLandingPage)
    )
      unavailableReason = "missing_landing_page";
    else
      try {
        if (
          !row.rawLandingPage.startsWith("/") ||
          row.rawLandingPage.startsWith("//")
        )
          throw 0;
        normalizedUrl = normalizeUrl(origin + row.rawLandingPage);
        if (new URL(normalizedUrl).origin !== origin) throw 0;
      } catch {
        normalizedUrl = null;
        unavailableReason = "invalid_landing_page";
      }
    return { ...row, normalizedUrl, unavailableReason };
  });
}
export async function importGa4LandingPages(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  input: { startDate: string; endDate: string },
  p: Ga4Provider,
  box: SecretBox,
) {
  validateSearchWindow(input.startDate, input.endDate);
  const { site, c } = await connection(db, actor, s, true);
  if (!site.verifiedAt || !c.property || !c.streamId || !c.timeZone)
    throw new Error("ANALYTICS_SELECTION_REQUIRED");
  const id = hash(
    JSON.stringify([
      s.workspaceId,
      s.siteId,
      site.origin,
      c.timeZone,
      c.property,
      c.streamId,
      input.startDate,
      input.endDate,
      GA4_SHAPE,
    ]),
  );
  const attempt = randomBytes(16).toString("hex");
  const admitted = await withActor(db, actor, s.workspaceId, async (tx) => {
    await fenced(tx, actor, s, c);
    const now = new Date();
    await tx.analyticsImport.deleteMany({
      where: { ...siteScope(s), resultExpiresAt: { lte: now } },
    });
    const existing = await tx.analyticsImport.findUnique({ where: { id } });
    if (existing && !existing.resultExpiresAt)
      throw new Error("SOURCE_EXPIRED");
    if (
      existing &&
      ["complete", "partial", "no_data"].includes(existing.status)
    )
      return { cached: existing };
    if (existing?.status === "running" && existing.leaseUntil > new Date())
      throw new Error("ANALYTICS_IMPORT_RUNNING");
    const data = {
      status: "running",
      failure: null,
      attempt,
      leaseUntil: new Date(Date.now() + 300000),
    };
    await tx.analyticsImport.upsert({
      where: { id },
      create: {
        ...siteScope(s),
        id,
        property: c.property!,
        streamId: c.streamId!,
        timeZone: c.timeZone!,
        origin: site.origin,
        ...input,
        shape: GA4_SHAPE,
        generation: c.generation,
        ...data,
      },
      update: { ...data, generation: c.generation },
    });
    return { cached: null };
  });
  if (admitted.cached) return { ...admitted.cached, cached: true };
  try {
    const token = box.open(c.encryptedRefreshToken, aad(s));
    const properties = await p.properties(token),
      selected = properties.find((x) => x.property === c.property);
    const stream = selected?.streams.find((x) => x.streamId === c.streamId);
    if (
      !stream ||
      new URL(normalizeUrl(stream.defaultUri)).origin !== site.origin ||
      selected?.timeZone !== c.timeZone
    )
      throw new Error("ANALYTICS_SCOPE_ERROR");
    const report = await p.report(token, c.property, {
      ...input,
      streamId: c.streamId,
      hostName: new URL(site.origin).hostname,
    });
    if (report.timeZone !== c.timeZone)
      throw new Error("ANALYTICS_SCOPE_ERROR");
    const rows = normalizeGa4Rows(
      report,
      site.origin,
      c.streamId,
      input.startDate,
      input.endDate,
    );
    if (rows.some((x) => x.unavailableReason === "scope_mismatch"))
      throw new Error("ANALYTICS_SCOPE_ERROR");
    const diagnostics = {
      ...report.diagnostics,
      rowCount: report.rowCount,
      processedRows: rows.length,
      offset: 0,
      limit: 10000,
      truncated: report.rowCount > rows.length,
      source: "GA4 Data API v1beta",
      provider: "GOOGLE_ANALYTICS",
      shape: GA4_SHAPE,
      dimensions: [
        "date",
        "landingPagePlusQueryString",
        "hostName",
        "streamId",
        "sessionDefaultChannelGroup",
      ],
      metrics: ["sessions", "engagedSessions", "sessionKeyEventRate"],
      filters: {
        streamId: c.streamId,
        hostName: new URL(site.origin).hostname,
        sessionDefaultChannelGroup: "Organic Search",
      },
      normalizationVersion: "normalizeUrl-v1",
      rateSemantics:
        "Observed GA4 session key-event rate; no exact converting-session count inferred.",
      unmatchedRows: rows.filter((x) => x.unavailableReason).length,
      provisional:
        input.endDate >=
        new Intl.DateTimeFormat("en-CA", {
          timeZone: c.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(Date.now() - 3 * 86400000)),
    };
    const restricted = !!report.diagnostics.restricted,
      partial =
        report.rowCount > rows.length ||
        !!report.diagnostics.partial ||
        restricted ||
        rows.some((x) => x.unavailableReason);
    return await withActor(db, actor, s.workspaceId, async (tx) => {
      await fenced(tx, actor, s, c);
      const activeSite = await authorize(tx, actor, s, true);
      if (!activeSite.verifiedAt || activeSite.origin !== site.origin)
        throw new Error("ANALYTICS_SCOPE_ERROR");
      const n = await tx.analyticsImport.updateMany({
        where: { id, attempt, status: "running" },
        data: {
          status: partial ? "partial" : rows.length ? "complete" : "no_data",
          rows: json(rows),
          diagnostics: json(diagnostics),
          importedAt: new Date(),
        },
      });
      if (n.count !== 1) throw new Error("ANALYTICS_IMPORT_CHANGED");
      return tx.analyticsImport.findUniqueOrThrow({ where: { id } });
    });
  } catch (error) {
    const reason =
      error instanceof Error && /^ANALYTICS_[A-Z_]+$/.test(error.message)
        ? error.message
        : "ANALYTICS_IMPORT_FAILED";
    await withActor(db, actor, s.workspaceId, async (tx) => {
      await authorize(tx, actor, s, true);
      await tx.analyticsImport.updateMany({
        where: { id, attempt, status: "running" },
        data: { status: "failed", failure: reason },
      });
      if (
        ["ANALYTICS_RECONNECT_REQUIRED", "ANALYTICS_SCOPE_ERROR"].includes(
          reason,
        )
      )
        await tx.analyticsConnection.updateMany({
          where: { id: c.id, generation: c.generation },
          data: {
            status:
              reason === "ANALYTICS_RECONNECT_REQUIRED"
                ? "revoked"
                : "scope_error",
          },
        });
    }).catch(() => {});
    throw new Error(reason);
  }
}
function ga4RowFacts(value: unknown) {
  const r = obj(value),
    text = (v: unknown) =>
      typeof v === "string" && v.length <= 2048 ? v : null,
    measure = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    date: text(r.date),
    rawLandingPage: text(r.rawLandingPage),
    hostName: text(r.hostName),
    streamId: text(r.streamId),
    channel: text(r.channel),
    normalizedUrl: text(r.normalizedUrl),
    unavailableReason: text(r.unavailableReason),
    sessions: measure(r.sessions),
    engagedSessions: measure(r.engagedSessions),
    sessionKeyEventRate: measure(r.sessionKeyEventRate),
  };
}
export function analyticsDiagnostics(value: unknown) {
  const d = obj(value);
  const flags = [
    "restricted",
    "partial",
    "thresholded",
    "sampled",
    "otherLoss",
    "qualifiedCompatibility",
    "keyEventsConfigured",
    "provisional",
    "truncated",
  ];
  const counts = [
    "rowCount",
    "processedRows",
    "offset",
    "limit",
    "unmatchedRows",
  ];
  const text = [
    "source",
    "provider",
    "shape",
    "normalizationVersion",
    "rateSemantics",
    "emptyReason",
  ];
  const fields = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x) => typeof x === "string" && x.length <= 128).slice(0, 12)
      : undefined;
  const f = obj(d.filters);
  return {
    ...Object.fromEntries(
      flags.filter((k) => typeof d[k] === "boolean").map((k) => [k, d[k]]),
    ),
    ...Object.fromEntries(
      counts.filter((k) => Number.isSafeInteger(d[k])).map((k) => [k, d[k]]),
    ),
    ...Object.fromEntries(
      text
        .filter(
          (k) => typeof d[k] === "string" && (d[k] as string).length <= 512,
        )
        .map((k) => [k, d[k]]),
    ),
    dimensions: fields(d.dimensions),
    metrics: fields(d.metrics),
    filters: Object.fromEntries(
      ["streamId", "hostName", "sessionDefaultChannelGroup"]
        .filter(
          (k) => typeof f[k] === "string" && (f[k] as string).length <= 256,
        )
        .map((k) => [k, f[k]]),
    ),
  };
}
export async function readGa4LandingPages(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
) {
  // Reuse saved, actor-authorized GSC opportunities. This path never refreshes either provider.
  const now = new Date();
  const search = await readGoogleSearch(db, actor, s, now);
  return withEvidenceRead(db, actor, s, "read", undefined, async (tx) => {
    const site = await authorize(tx, actor, s);
    const membership = await tx.membership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: s.workspaceId,
          userId: actor.userId,
        },
      },
    });
    const canManage =
      !!membership && ["OWNER", "ADMIN"].includes(membership.role);
    const connection = await tx.analyticsConnection.findFirst({
      where: siteScope(s),
      select: {
        property: true,
        streamId: true,
        timeZone: true,
        status: true,
        catalog: canManage,
        createdAt: true,
      },
    });
    const imports = await tx.analyticsImport.findMany({
      where: { ...siteScope(s), resultExpiresAt: { gt: now } },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    const opportunityOutcomes = search.opportunities.map((opportunity) => {
      const startDate = String(opportunity.evidence.startDate ?? ""),
        endDate = String(opportunity.evidence.endDate ?? "");
      const snapshot =
        imports.find(
          (x) =>
            x.startDate === startDate &&
            x.endDate === endDate &&
            x.property === connection?.property &&
            x.streamId === connection?.streamId,
        ) ??
        imports[0] ??
        null;
      const result = joinGa4Outcomes(
        [opportunity],
        connection?.status === "connected" ? snapshot : null,
        {
          origin: site.origin,
          property: connection?.property ?? "",
          streamId: connection?.streamId ?? "",
          startDate,
          endDate,
        },
      )[0]!;
      return {
        ...result,
        analyticsWindow: snapshot
          ? {
              startDate: snapshot.startDate,
              endDate: snapshot.endDate,
              timeZone: snapshot.timeZone,
            }
          : null,
        searchWindow: { startDate, endDate, timeZone: "America/Los_Angeles" },
      };
    });
    return {
      connection,
      properties: connection?.catalog ?? [],
      snapshots: imports.map(({ attempt: _attempt, ...x }) => ({
        ...x,
        diagnostics: analyticsDiagnostics(x.diagnostics),
        stale:
          !!x.importedAt && Date.now() - x.importedAt.getTime() > 7 * 86400000,
        recoverable:
          x.status === "failed" ||
          (x.status === "running" && x.leaseUntil <= new Date()),
        rowCount: Array.isArray(x.rows) ? x.rows.length : 0,
        rows: Array.isArray(x.rows)
          ? x.rows.slice(0, 100).map(ga4RowFacts)
          : [],
        displayLimited: Array.isArray(x.rows) && x.rows.length > 100,
      })),
      opportunityOutcomes,
      coverage:
        "Exact landing pages, selected stream and hostname, Organic Search sessions only. Missing or hidden rows are unavailable, never zero. GA4 dates use the property timezone; GSC dates use America/Los_Angeles.",
    };
  });
}
export function joinGa4Outcomes<T extends { page: string }>(
  opportunities: T[],
  snapshot: {
    origin: string;
    property: string;
    streamId: string;
    timeZone: string;
    startDate: string;
    endDate: string;
    status: string;
    rows: unknown;
    diagnostics: unknown;
  } | null,
  scope: {
    origin: string;
    property: string;
    streamId: string;
    startDate: string;
    endDate: string;
    timeZone?: string;
  },
) {
  return opportunities.map((opportunity) => {
    let reason: string | null = !snapshot ? "not_connected" : null;
    if (
      snapshot &&
      (snapshot.origin !== scope.origin ||
        snapshot.property !== scope.property ||
        snapshot.streamId !== scope.streamId)
    )
      reason = "scope_mismatch";
    if (
      snapshot &&
      (snapshot.timeZone !== (scope.timeZone ?? "America/Los_Angeles") ||
        snapshot.startDate !== scope.startDate ||
        snapshot.endDate !== scope.endDate)
    )
      reason = "incompatible_window";
    if (
      snapshot &&
      (snapshot.status !== "complete" ||
        (snapshot.diagnostics as Record<string, unknown>)?.provisional)
    )
      reason = reason ?? "restricted_or_partial_data";
    if (
      snapshot &&
      (snapshot.diagnostics as Record<string, unknown>)?.keyEventsConfigured ===
        false
    )
      reason = reason ?? "missing_key_event_setup";
    let rows: Ga4Row[] = [];
    if (!reason && snapshot)
      try {
        const url = normalizeUrl(opportunity.page);
        rows = (snapshot.rows as Ga4Row[]).filter(
          (x) => x.normalizedUrl === url && !x.unavailableReason,
        );
      } catch {}
    if (!reason && !rows.length) reason = "no_matching_page";
    return {
      ...opportunity,
      conversionEvidence: reason
        ? { status: "unavailable" as const, reason }
        : {
            status: "available" as const,
            label: "GA4 observed session context; no query attribution",
            rows: rows.map(ga4RowFacts),
            window: {
              startDate: snapshot!.startDate,
              endDate: snapshot!.endDate,
              timeZone: snapshot!.timeZone,
            },
          },
    };
  });
}
