import { z } from "zod";
import { agencyFailure } from "@/server/agency/http";
import { capabilityPause } from "@/server/capabilities";
import { database, resolveActor } from "@/server/auth/server";
import {
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
} from "@lyraseo/db/invitations";
import { privateBody, privateHeaders } from "@/server/editorial/http";
const id = z.string().min(1).max(128);
export async function GET(request: Request) {
  try {
    const { workspaceId } = z
      .object({ workspaceId: id })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      await listWorkspaceInvitations(
        database(),
        await resolveActor(),
        workspaceId,
      ),
      { headers: privateHeaders },
    );
  } catch (error) {
    return agencyFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      input = z
        .discriminatedUnion("action", [
          z
            .object({
              workspaceId: id,
              action: z.literal("invite"),
              email: z.email().max(254),
              role: z.enum(["EDITOR", "VIEWER"]),
              siteIds: z.array(id).max(100),
              expectedAccessRevision: z.number().int().nonnegative(),
            })
            .strict(),
          z
            .object({
              workspaceId: id,
              action: z.literal("revoke"),
              invitationId: id,
              expectedAccessRevision: z.number().int().nonnegative(),
            })
            .strict(),
        ])
        .parse(await privateBody(request));
    if (input.action === "invite") {
      const paused = capabilityPause("agency");
      if (paused) return paused;
    }
    return Response.json(
      input.action === "invite"
        ? await createWorkspaceInvitation(
            database(),
            actor,
            input,
            process.env.LYRA_INVITATION_HMAC_KEY ?? "",
          )
        : await revokeWorkspaceInvitation(database(), actor, input),
      { headers: privateHeaders },
    );
  } catch (error) {
    return agencyFailure(error);
  }
}
