import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { configuredGoogle } from "@/server/google/provider";
import {
  googleScope,
  googleHeaders,
  googleFailure,
  smallJson,
} from "@/server/google/http";
import { readGoogleSearch, importGoogleSearch } from "@lyraseo/db/gsc";
const command = googleScope
  .extend({
    startDate: z.string().max(10),
    endDate: z.string().max(10),
    shape: z.enum(["page", "query", "date", "query,page"]),
  })
  .strict();
export async function GET(request: Request) {
  try {
    const actor = await resolveActor(),
      s = googleScope.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
    return Response.json(await readGoogleSearch(database(), actor, s), {
      headers: googleHeaders,
    });
  } catch (e) {
    return googleFailure(e);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      settings = authSettings();
    if (!settings || request.headers.get("origin") !== settings.origin)
      return Response.json(
        { error: "Request origin rejected." },
        { status: 403, headers: googleHeaders },
      );
    const input = command.parse(await smallJson(request));
    const paused = capabilityPause("search");
    if (paused) return paused;
    const { provider, box } = configuredGoogle(settings.origin);
    const snapshot = await importGoogleSearch(
      database(),
      actor,
      googleScope.parse(input),
      {
        startDate: input.startDate,
        endDate: input.endDate,
        shape: input.shape,
      },
      provider,
      box,
    );
    const { rows, ...summary } = snapshot;
    return Response.json(
      { ...summary, rowCount: Array.isArray(rows) ? rows.length : 0 },
      { headers: googleHeaders },
    );
  } catch (e) {
    return googleFailure(e);
  }
}
