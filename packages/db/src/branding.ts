import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import {
  withActor,
  withEvidenceRead,
  authorizeSiteIn,
  type Actor,
  type Tx,
} from "./context";
import { checkAccessRevision, requireWorkspaceManager } from "./tenants";
export type SanitizedBrandLogo = {
  bytes: Uint8Array;
  sha256: string;
  mime: "image/png";
  width: number;
  height: number;
};
/** Cheap current authorization before native decoding; save rechecks under its lock. */
export async function authorizeBrandingManagement(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
) {
  return withActor(db, actor, workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, workspaceId);
    await requireWorkspaceManager(tx, actor, workspaceId);
  });
}
export type FrozenWorkspaceBranding = {
  schemaVersion: 1;
  brandingRevisionId: string;
  revision: number;
  displayName: string;
  logo?: {
    base64: string;
    sha256: string;
    mime: "image/png";
    width: number;
    height: number;
  };
};
type BrandRow = {
  id: string;
  workspaceId: string;
  revision: number;
  displayName: string;
  logoBytes: Uint8Array | null;
  logoSha256: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
};
export async function saveWorkspaceBranding(
  db: PrismaClient,
  actor: Actor,
  input: {
    workspaceId: string;
    expectedRevision: number;
    displayName: string;
    logo?: SanitizedBrandLogo | null;
  },
) {
  const name = input.displayName.trim();
  if (
    name.length > 100 ||
    Buffer.byteLength(name) > 400 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw Error("INVALID_BRANDING");
  const logo = input.logo;
  if (
    logo &&
    (logo.bytes.length > 65536 ||
      logo.mime !== "image/png" ||
      !Number.isInteger(logo.width) ||
      logo.width < 1 ||
      logo.width > 512 ||
      !Number.isInteger(logo.height) ||
      logo.height < 1 ||
      logo.height > 256 ||
      !Buffer.from(logo.bytes)
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      createHash("sha256").update(logo.bytes).digest("hex") !== logo.sha256)
  )
    throw Error("INVALID_BRANDING");
  return withActor(db, actor, input.workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
    await checkAccessRevision(tx, actor, input.workspaceId);
    await requireWorkspaceManager(tx, actor, input.workspaceId);
    const [current] = await tx.$queryRaw<
      BrandRow[]
    >`SELECT * FROM "WorkspaceBrandingRevision" WHERE "workspaceId"=${input.workspaceId} ORDER BY revision DESC LIMIT 1`;
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw Error("REVISION_CONFLICT");
    const next =
      logo === undefined && current?.logoBytes
        ? {
            bytes: current.logoBytes,
            sha256: current.logoSha256!,
            mime: "image/png",
            width: current.width!,
            height: current.height!,
          }
        : logo;
    const revision = (current?.revision ?? 0) + 1,
      id = randomUUID();
    await tx.$executeRaw`INSERT INTO "WorkspaceBrandingRevision" (id,"workspaceId",revision,"displayName","logoBytes","logoSha256",mime,width,height,"createdBy") VALUES (${id},${input.workspaceId},${revision},${name},${next ? Buffer.from(next.bytes) : null},${next?.sha256 ?? null},${next?.mime ?? null},${next?.width ?? null},${next?.height ?? null},${actor.userId})`;
    return {
      id,
      revision,
      displayName: name,
      logoSha256: next?.sha256 ?? null,
    };
  });
}
export async function readWorkspaceBranding(
  db: PrismaClient,
  actor: Actor,
  workspaceId: string,
) {
  return withActor(db, actor, workspaceId, async (tx) => {
    await checkAccessRevision(tx, actor, workspaceId);
    await requireWorkspaceManager(tx, actor, workspaceId);
    const [row] = await tx.$queryRaw<
      Omit<BrandRow, "logoBytes">[]
    >`SELECT id,"workspaceId",revision,"displayName","logoSha256",mime,width,height,"createdAt" FROM "WorkspaceBrandingRevision" WHERE "workspaceId"=${workspaceId} ORDER BY revision DESC LIMIT 1`;
    return row ?? null;
  });
}
/** Called inside the report's authorized capture/revalidation transaction. No implicit brand on old reports. */
export async function captureWorkspaceBranding(
  tx: Tx,
  scope: { workspaceId: string; siteId: string },
  revision: number | undefined,
): Promise<FrozenWorkspaceBranding | undefined> {
  if (revision === undefined) return undefined;
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw Error("INVALID_BRANDING");
  const [row] = await tx.$queryRaw<
    BrandRow[]
  >`SELECT * FROM "WorkspaceBrandingRevision" WHERE "workspaceId"=${scope.workspaceId} AND revision=${revision} AND ("createdAt">clock_timestamp() AT TIME ZONE 'UTC'-interval '90 days' OR revision=(SELECT max(revision) FROM "WorkspaceBrandingRevision" WHERE "workspaceId"=${scope.workspaceId}))`;
  if (!row) throw Error("INVALID_BRANDING");
  return {
    schemaVersion: 1,
    brandingRevisionId: row.id,
    revision: row.revision,
    displayName: row.displayName,
    ...(row.logoBytes
      ? {
          logo: {
            base64: Buffer.from(row.logoBytes).toString("base64"),
            sha256: row.logoSha256!,
            mime: "image/png" as const,
            width: row.width!,
            height: row.height!,
          },
        }
      : {}),
  };
}
export async function readBrandingLogo(
  db: PrismaClient,
  actor: Actor,
  scope: { workspaceId: string; siteId: string },
  revision: number,
) {
  return withActor(db, actor, scope.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "read");
    const brand = await captureWorkspaceBranding(tx, scope, revision);
    await checkAccessRevision(tx, actor, scope.workspaceId);
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "read");
    if (!brand?.logo) throw Error("NOT_FOUND");
    return Buffer.from(brand.logo.base64, "base64");
  });
}

/** Report creators choose bounded eligible metadata; logo bytes remain private. */
export async function listReportBrandingChoices(
  db: PrismaClient,
  actor: Actor,
  scope: { workspaceId: string; siteId: string },
) {
  return withEvidenceRead(db, actor, scope, "export", undefined, async (tx) => {
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    const rows = await tx.$queryRaw<
      { revision: number; displayName: string }[]
    >`SELECT revision,"displayName" FROM "WorkspaceBrandingRevision" WHERE "workspaceId"=${scope.workspaceId} AND ("createdAt">clock_timestamp() AT TIME ZONE 'UTC'-interval '90 days' OR revision=(SELECT max(revision) FROM "WorkspaceBrandingRevision" WHERE "workspaceId"=${scope.workspaceId})) ORDER BY revision DESC LIMIT 20`;
    await authorizeSiteIn(tx, actor, scope.workspaceId, scope.siteId, "edit");
    return rows;
  });
}
