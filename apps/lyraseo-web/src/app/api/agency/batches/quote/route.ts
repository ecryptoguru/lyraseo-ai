import { z } from "zod";
import { agencyFailure } from "@/server/agency/http";
import { capabilityPause } from "@/server/capabilities";
import { database, resolveActor } from "@/server/auth/server";
import { issueAgencyBatchQuote } from "@lyraseo/db/agency-batches";
import { privateBody, privateHeaders } from "@/server/editorial/http";
export async function POST(request: Request) {
  try {
    const paused = capabilityPause("agency");
    if (paused) return paused;
    const actor = await resolveActor(),
      input = z
        .object({
          workspaceId: z.string().min(1).max(128),
          items: z
            .array(
              z
                .object({
                  siteId: z.string().min(1).max(128),
                  kind: z.enum([
                    "GENERATION",
                    "RESEARCH",
                    "API_OBSERVATION",
                    "CHATGPT_OBSERVATION",
                    "GEMINI_OBSERVATION",
                  ]),
                  input: z.record(z.string(), z.unknown()),
                })
                .strict(),
            )
            .min(1)
            .max(10),
        })
        .strict()
        .parse(await privateBody(request));
    return Response.json(
      await issueAgencyBatchQuote(database(), actor, input),
      { headers: privateHeaders },
    );
  } catch (error) {
    return agencyFailure(error);
  }
}
