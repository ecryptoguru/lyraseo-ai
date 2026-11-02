import { capabilityPause } from "@/server/capabilities";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { configuredAnalytics } from "@/server/google/analytics";
import { analyticsFailure } from "@/server/google/analytics-http";
import { completeGa4Connect } from "@lyraseo/db/ga4";
export async function GET(request: Request) {
  try {
    const actor = await resolveActor(),
      settings = authSettings();
    if (!settings) throw new Error("ANALYTICS_UNAVAILABLE");
    const paused = capabilityPause("analytics");
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
    const { provider, box } = configuredAnalytics(settings.origin);
    const s = await completeGa4Connect(
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
          "/analytics?workspaceId=" +
          encodeURIComponent(s.workspaceId),
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    return analyticsFailure(e);
  }
}
