import { z } from "zod";
import { agencyFailure } from "@/server/agency/http";
import { capabilityPause } from "@/server/capabilities";
import { database, resolveActor } from "@/server/auth/server";
import { confirmAgencyBatch } from "@lyraseo/db/agency-batches";
import { privateBody, privateHeaders } from "@/server/editorial/http";
export async function POST(request: Request) {
  try {
    const paused = capabilityPause("agency");
    if (paused) return paused;
    const actor = await resolveActor(),
      input = z
        .object({
          batchQuoteId: z.string().min(1).max(128),
          confirmationHash: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z.string().min(1).max(128),
        })
        .strict()
        .parse(await privateBody(request));
    return Response.json(await confirmAgencyBatch(database(), actor, input), {
      headers: privateHeaders,
    });
  } catch (error) {
    return agencyFailure(error);
  }
}
