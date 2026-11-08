import type { PrismaClient } from "../generated/client";
import { withActor, authorizeSiteIn, type Actor } from "./context";
import { membership, checkAccessRevision } from "./tenants";

/** Stored evidence only. Listing never creates work, dispatches providers or pools scores. */
export async function listAgencyPortfolio(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
  paging: { limit?: number; cursor?: string } = {},
) {
  const limit = paging.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error("INVALID_PAGING");
  let cursor: { createdAt: Date; id: string } | undefined;
  if (paging.cursor) {
    try {
      if (paging.cursor.length > 512) throw Error();
      const parsed = JSON.parse(
        Buffer.from(paging.cursor, "base64url").toString("utf8"),
      );
      if (
        typeof parsed.id !== "string" ||
        !parsed.id ||
        parsed.id.length > 128 ||
        typeof parsed.createdAt !== "string"
      )
        throw Error();
      const createdAt = new Date(parsed.createdAt);
      if (!Number.isFinite(createdAt.getTime())) throw Error();
      cursor = { id: parsed.id, createdAt };
    } catch {
      throw Error("INVALID_PAGING");
    }
  }
  return withActor(db, actor, workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, workspaceId);
    const member = await membership(tx, actor, workspaceId);
    const rows = await tx.site.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(["OWNER", "ADMIN"].includes(member.role)
          ? {}
          : { grants: { some: { userId: actor.userId } } }),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: { id: true, origin: true, verifiedAt: true, createdAt: true },
    });
    const selected = rows.slice(0, limit),
      ids = selected.map((s) => s.id),
      now = new Date();
    const audits = await tx.auditRun.findMany({
      where: { workspaceId, siteId: { in: ids }, resultExpiresAt: { gt: now } },
      distinct: ["siteId"],
      orderBy: [{ siteId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        siteId: true,
        status: true,
        createdAt: true,
        completedAt: true,
        methodologyVersion: true,
        profile: true,
        evaluation: true,
      },
    });
    const reports = await tx.evidenceReport.groupBy({
      by: ["siteId"],
      where: { workspaceId, siteId: { in: ids } },
      _count: { id: true },
      _max: { createdAt: true },
    });
    const assignments = await tx.pageIdentity.groupBy({
      by: ["siteId", "assignedTo"],
      where: { workspaceId, siteId: { in: ids } },
      _count: { id: true },
    });
    const sites = selected.map((site) => {
      const audit = audits.find((a) => a.siteId === site.id),
        report = reports.find((r) => r.siteId === site.id);
      const evaluation = audit?.evaluation as
        { coverage?: unknown } | null | undefined;
      return {
        ...site,
        latestAudit: audit
          ? {
              id: audit.id,
              status: audit.status,
              createdAt: audit.createdAt,
              completedAt: audit.completedAt,
              methodologyVersion: audit.methodologyVersion,
              profile: audit.profile,
              coverage: evaluation?.coverage ?? null,
            }
          : null,
        reports: {
          count: report?._count.id ?? 0,
          latestAt: report?._max.createdAt ?? null,
        },
        tasks: {
          assigned: assignments
            .filter((a) => a.siteId === site.id && a.assignedTo !== null)
            .reduce((n, a) => n + a._count.id, 0),
          unassigned: assignments
            .filter((a) => a.siteId === site.id && a.assignedTo === null)
            .reduce((n, a) => n + a._count.id, 0),
        },
      };
    });
    // A changed grant/role while composing a summary cannot return buffered foreign data.
    await checkAccessRevision(tx, actor, workspaceId);
    const current = await membership(tx, actor, workspaceId);
    if (current.role !== member.role) throw Error("REVISION_CONFLICT");
    for (const site of selected)
      await authorizeSiteIn(tx, actor, workspaceId, site.id, "read");
    const last = selected.at(-1);
    return {
      role: member.role,
      sites,
      limit,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                createdAt: last.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  });
}
