import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { configuredAnalytics } from "@/server/google/analytics";
import { googleScope, googleHeaders, smallJson } from "@/server/google/http";
import { analyticsFailure } from "@/server/google/analytics-http";
import {
  beginGa4Connect,
  ga4Properties,
  selectGa4Property,
  disconnectGa4,
} from "@lyraseo/db/ga4";
const command = z.discriminatedUnion("action", [
  googleScope.extend({ action: z.literal("connect") }).strict(),
  googleScope.extend({ action: z.literal("discover") }).strict(),
  googleScope
    .extend({
      action: z.literal("select"),
      property: z
        .string()
        .regex(/^properties\/\d+$/)
        .max(128),
      streamId: z.string().regex(/^\d+$/).max(128),
    })
    .strict(),
  googleScope.extend({ action: z.literal("disconnect") }).strict(),
]);
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
    const scope = { workspaceId: input.workspaceId, siteId: input.siteId };
    if (input.action === "disconnect")
      return Response.json(await disconnectGa4(database(), actor, scope), {
        headers: googleHeaders,
      });
    const paused = capabilityPause("analytics");
    if (paused) return paused;
    const { provider, box } = configuredAnalytics(settings.origin);

    const result =
      input.action === "connect"
        ? await beginGa4Connect(database(), actor, scope, provider, box)
        : input.action === "discover"
          ? {
              properties: await ga4Properties(
                database(),
                actor,
                scope,
                provider,
                box,
              ),
            }
          : await selectGa4Property(
              database(),
              actor,
              scope,
              input.property,
              input.streamId,
              provider,
              box,
            );
    return Response.json(result, { headers: googleHeaders });
  } catch (e) {
    return analyticsFailure(e);
  }
}
