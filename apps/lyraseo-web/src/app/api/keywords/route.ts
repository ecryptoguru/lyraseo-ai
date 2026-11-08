import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { capabilityPause } from "@/server/capabilities";
import {
  googleScope,
  googleHeaders,
  googleFailure,
  smallJson,
} from "@/server/google/http";
import {
  prepareKeywordSelection,
  readKeywordSelections,
  requestKeywordQuote,
} from "@lyraseo/db/keywords";
const select = googleScope
  .extend({
    action: z.literal("select"),
    snapshotId: z.string().min(1).max(128),
    kind: z.string().min(1).max(64),
    query: z.string().max(8192),
    page: z.string().max(8192),
    keywords: z.array(z.string().min(1).max(100)).min(1).max(20),
    country: z.literal("IN"),
    language: z.literal("en"),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
const quote = googleScope
  .extend({ action: z.literal("quote"), selectionId: z.string().uuid() })
  .strict();
const command = z.discriminatedUnion("action", [select, quote]);
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const safe: Record<string, string> = {
    OPPORTUNITY_UNAVAILABLE:
      "This opportunity changed or expired. Refresh the saved search evidence.",
    CONFLICT:
      "This selection changed. Review it before preparing another selection.",
    INVALID_KEYWORD_SELECTION:
      "Select 1–20 distinct keywords of up to 100 characters.",
    KEYWORD_SELECTION_UNAVAILABLE:
      "This saved keyword selection is unavailable.",
  };
  return safe[code]
    ? Response.json(
        { error: safe[code] },
        { status: 409, headers: googleHeaders },
      )
    : googleFailure(error);
}
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
      { selections: await readKeywordSelections(database(), actor, scope) },
      { headers: googleHeaders },
    );
  } catch (error) {
    return failure(error);
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
    const input = command.parse(await smallJson(request)),
      scope = { workspaceId: input.workspaceId, siteId: input.siteId };
    const paused = capabilityPause("search");
    if (paused) return paused;
    return Response.json(
      input.action === "select"
        ? await prepareKeywordSelection(database(), actor, scope, input)
        : await requestKeywordQuote(
            database(),
            actor,
            scope,
            input.selectionId,
          ),
      { headers: googleHeaders },
    );
  } catch (error) {
    return failure(error);
  }
}
