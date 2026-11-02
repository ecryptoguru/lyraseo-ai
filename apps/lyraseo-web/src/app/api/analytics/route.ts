import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import {
  configuredAnalytics,
  analyticsConfigured,
} from "@/server/google/analytics";
import { googleScope, googleHeaders, smallJson } from "@/server/google/http";
import { analyticsFailure } from "@/server/google/analytics-http";
import { readGa4LandingPages, importGa4LandingPages } from "@lyraseo/db/ga4";
const command = googleScope
  .extend({ startDate: z.string().max(10), endDate: z.string().max(10) })
  .strict();
export async function GET(request: Request) {
  try {
    if (request.headers.get("sec-fetch-site") === "cross-site")
      return Response.json(
        { error: "Request origin rejected." },
        { status: 403, headers: googleHeaders },
      );
    const actor = await resolveActor(),
      scope = googleScope
        .strict()
        .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      {
        ...(await readGa4LandingPages(database(), actor, scope)),
        configured: analyticsConfigured(),
      },
      { headers: googleHeaders },
    );
  } catch (e) {
    return analyticsFailure(e);
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
    const paused = capabilityPause("analytics");
    if (paused) return paused;
    const { provider, box } = configuredAnalytics(settings.origin),
      snapshot = await importGa4LandingPages(
        database(),
        actor,
        { workspaceId: input.workspaceId, siteId: input.siteId },
        { startDate: input.startDate, endDate: input.endDate },
        provider,
        box,
      );
    const { rows, attempt: _attempt, ...summary } = snapshot;
    void _attempt;
    return Response.json(
      { ...summary, rowCount: Array.isArray(rows) ? rows.length : 0 },
      { headers: googleHeaders },
    );
  } catch (e) {
    return analyticsFailure(e);
  }
}
