import { PrismaClient, type Prisma } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

export function createDatabase(connectionString: string) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 5 }),
  });
}
export async function withWorkspace<T>(
  db: PrismaClient,
  workspaceId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!workspaceId) throw new Error("FORBIDDEN");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return work(tx);
  });
}
export async function authorizeSite(
  db: PrismaClient,
  input: {
    userId: string;
    workspaceId: string;
    siteId: string;
    action: "read" | "export" | "run" | "edit";
  },
): Promise<void> {
  return withWorkspace(db, input.workspaceId, async (tx) => {
    const user = await tx.productUser.findUnique({
      where: { id: input.userId },
      select: { suspended: true },
    });
    if (!user || user.suspended) throw new Error("FORBIDDEN");
    const membership = await tx.membership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
      },
    });
    const workspace = await tx.workspace.findUnique({
      where: { id: input.workspaceId },
    });
    if (!membership || !workspace || workspace.deletedAt)
      throw new Error("FORBIDDEN");
    const site = await tx.site.findUnique({
      where: {
        workspaceId_id: { workspaceId: input.workspaceId, id: input.siteId },
      },
    });
    if (!site || site.deletedAt) throw new Error("NOT_FOUND");
    if (membership.role === "OWNER" || membership.role === "ADMIN") return;
    if (
      membership.role === "VIEWER" &&
      !["read", "export"].includes(input.action)
    )
      throw new Error("FORBIDDEN");
    const grant = await tx.siteGrant.findUnique({
      where: {
        workspaceId_siteId_userId: {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          userId: input.userId,
        },
      },
    });
    if (!grant) throw new Error("FORBIDDEN");
  });
}
