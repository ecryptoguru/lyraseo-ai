import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { listAgencyPortfolio } from "@lyraseo/db/agency";
import { privateHeaders, editorialFailure } from "@/server/editorial/http";
export async function GET(request: Request) {
  try {
    const input = z
      .object({
        workspaceId: z.string().min(1).max(128),
        cursor: z.string().min(1).max(512).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      await listAgencyPortfolio(
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
