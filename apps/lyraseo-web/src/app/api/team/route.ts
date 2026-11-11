import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import {
  listWorkspaceMembers,
  manageWorkspaceAccess,
  issueStepUp,
} from "@lyraseo/db/tenants";
import {
  privateBody,
  privateHeaders,
  editorialFailure,
} from "@/server/editorial/http";
const id = z.string().min(1).max(128);
const base = z.object({
  workspaceId: id,
  userId: id,
  expectedAccessRevision: z.number().int().nonnegative(),
});
const command = z.discriminatedUnion("action", [
  base
    .extend({
      action: z.literal("role"),
      role: z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]),
      stepUpToken: id.optional(),
    })
    .strict(),
  base
    .extend({ action: z.literal("remove"), stepUpToken: id.optional() })
    .strict(),
  base.extend({ action: z.literal("grant"), siteId: id }).strict(),
  base.extend({ action: z.literal("revoke"), siteId: id }).strict(),
  z.object({ workspaceId: id, action: z.literal("step-up") }).strict(),
]);
export async function GET(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && origin !== authSettings()?.origin)
    )
      throw Error("ORIGIN_REJECTED");
    const input = z
      .object({
        workspaceId: id,
        cursor: id.optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      await listWorkspaceMembers(
        database(),
        await resolveActor(),
        input.workspaceId,
        input,
      ),
      { headers: privateHeaders },
    );
  } catch (error) {
    return editorialFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      input = command.parse(await privateBody(request));
    if (input.action === "step-up")
      return Response.json(
        {
          token: await issueStepUp(
            database(),
            actor,
            "manage-owner",
            input.workspaceId,
          ),
        },
        { headers: privateHeaders },
      );
    return Response.json(
      await manageWorkspaceAccess(database(), actor, input),
      { headers: privateHeaders },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      ["LAST_OWNER", "STEP_UP_REQUIRED", "FRESH_AUTH_REQUIRED"].includes(
        error.message,
      )
    )
      return Response.json(
        {
          error:
            error.message === "LAST_OWNER"
              ? "Keep at least one active owner."
              : "A recent sign-in and MFA verification are required for owner changes.",
        },
        { status: 409, headers: privateHeaders },
      );
    return editorialFailure(error);
  }
}
