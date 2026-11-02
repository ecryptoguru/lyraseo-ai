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
import {
  beginGoogleConnect,
  googleProperties,
  selectGoogleProperty,
  disconnectGoogle,
} from "@lyraseo/db/gsc";
const command = z.discriminatedUnion("action", [
  googleScope.extend({ action: z.literal("connect") }).strict(),
  googleScope.extend({ action: z.literal("discover") }).strict(),
  googleScope
    .extend({ action: z.literal("select"), property: z.string().max(2048) })
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
    if (input.action === "disconnect")
      return Response.json(
        await disconnectGoogle(database(), actor, googleScope.parse(input)),
        {
          headers: googleHeaders,
        },
      );
    const paused = capabilityPause("search");
    if (paused) return paused;
    const { provider, box } = configuredGoogle(settings.origin);

    if (input.action === "discover")
      return Response.json(
        {
          properties: await googleProperties(
            database(),
            actor,
            googleScope.parse(input),
            provider,
            box,
          ),
        },
        { headers: googleHeaders },
      );
    return Response.json(
      input.action === "connect"
        ? await beginGoogleConnect(
            database(),
            actor,
            googleScope.parse(input),
            provider,
            box,
          )
        : await selectGoogleProperty(
            database(),
            actor,
            googleScope.parse(input),
            input.property,
            provider,
            box,
          ),
      { headers: googleHeaders },
    );
  } catch (e) {
    return googleFailure(e);
  }
}
