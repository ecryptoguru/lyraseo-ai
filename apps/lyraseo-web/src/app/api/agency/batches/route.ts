import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { readAgencyBatch } from "@lyraseo/db/agency-batches";
import { privateHeaders, editorialFailure } from "@/server/editorial/http";
export async function GET(request: Request) {
  try {
    const input = z
      .object({ batchId: z.string().min(1).max(128) })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      await readAgencyBatch(database(), await resolveActor(), input.batchId),
      { headers: privateHeaders },
    );
  } catch (error) {
    return editorialFailure(error);
  }
}
