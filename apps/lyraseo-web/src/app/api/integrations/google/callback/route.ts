import { capabilityPause } from "@/server/capabilities";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { configuredGoogle } from "@/server/google/provider";
import { googleFailure } from "@/server/google/http";
import { completeGoogleConnect } from "@lyraseo/db/gsc";
export async function GET(request: Request) {
  try {
    const actor = await resolveActor(),
      settings = authSettings();
    if (!settings) throw new Error("GOOGLE_UNAVAILABLE");
    const paused = capabilityPause("search");
    if (paused) return paused;

    const q = new URL(request.url).searchParams;
    if (
      q.getAll("state").length !== 1 ||
      q.getAll("code").length > 1 ||
      q.getAll("error").length > 1 ||
      !q.get("state") ||
      q.get("state")!.length > 128
    )
      throw new Error("INVALID_OAUTH_STATE");
    const { provider, box } = configuredGoogle(settings.origin);
    const s = await completeGoogleConnect(
      database(),
      actor,
      q.get("state")!,
      q.has("error") ? "" : (q.get("code") ?? ""),
      provider,
      box,
    );
    return new Response(null, {
      status: 303,
      headers: {
        Location:
          settings.origin +
          "/app/sites/" +
          encodeURIComponent(s.siteId) +
          "/search?workspaceId=" +
          encodeURIComponent(s.workspaceId),
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    return googleFailure(e);
  }
}
