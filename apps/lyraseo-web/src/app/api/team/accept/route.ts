import { z } from "zod";
import { agencyFailure } from "@/server/agency/http";
import { capabilityPause } from "@/server/capabilities";
import { database, resolveActorWithVerifiedEmail } from "@/server/auth/server";
import { acceptWorkspaceInvitation } from "@lyraseo/db/invitations";
import { privateBody, privateHeaders } from "@/server/editorial/http";
export async function POST(request: Request) {
  try {
    const paused = capabilityPause("agency");
    if (paused) return paused;
    const identity = await resolveActorWithVerifiedEmail(),
      input = z
        .object({
          workspaceId: z.string().min(1).max(128),
          invitationId: z.string().min(1).max(128),
          token: z.string().min(1).max(128),
        })
        .strict()
        .parse(await privateBody(request));
    return Response.json(
      await acceptWorkspaceInvitation(
        database(),
        identity,
        input,
        process.env.LYRA_INVITATION_HMAC_KEY ?? "",
      ),
      { headers: privateHeaders },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "INVITATION_UNAVAILABLE")
      return Response.json(
        {
          error:
            "Invitation unavailable. Check the recipient account, expiry and access with your workspace manager.",
        },
        { status: 404, headers: privateHeaders },
      );
    return agencyFailure(error);
  }
}
