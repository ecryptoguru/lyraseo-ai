import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { authSettings } from "@/server/auth/settings";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import {
  createSite,
  issueSiteChallenge,
  verifySiteChallenge,
  readSiteContextRevisions,
  reviewSiteContext,
} from "@lyraseo/db/sites";
import { observeSiteProof } from "@/server/acquisition/proof";
const headers = { "Cache-Control": "private, no-store" };
const id = z.string().min(1).max(128),
  text = z.string().max(4000),
  items = z.array(z.string().max(2048)).max(50);
const scope = z.object({ workspaceId: id, siteId: id });
const context = z
  .object({
    audience: text,
    positioning: text,
    conversionGoal: text,
    brandName: text,
    editorialPreferences: text,
    approvedAliases: items,
    competitors: items,
    keyPages: items,
    supportedClaims: items,
  })
  .strict();
const command = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      workspaceId: id,
      origin: z.string().max(2048),
    })
    .strict(),
  scope.extend({ action: z.literal("challenge") }).strict(),
  scope.extend({ action: z.literal("verify"), challengeId: id }).strict(),
  scope
    .extend({
      action: z.literal("context"),
      expectedRevision: z.number().int().min(0),
      content: context,
    })
    .strict(),
]);
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (["FORBIDDEN", "NOT_FOUND"].includes(code))
    return Response.json(
      { error: "Site access is unavailable." },
      { status: 404, headers },
    );
  if (signInDestination(error))
    return Response.json(
      { error: "Sign in again to continue." },
      { status: 401, headers },
    );
  return Response.json(
    {
      error:
        "The site could not be updated. Check the origin, verification file and current revision, then retry.",
    },
    { status: 409, headers },
  );
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      settings = authSettings();
    if (!settings || request.headers.get("origin") !== settings.origin)
      return Response.json(
        { error: "Request origin rejected." },
        { status: 403, headers },
      );
    const reader = request.body?.getReader();
    if (!reader) throw new Error("INVALID_REQUEST");
    let body = "",
      bytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65536) throw new Error("INVALID_REQUEST_SIZE");
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const input = command.parse(JSON.parse(body));
    const paused = capabilityPause(
      input.action === "challenge" || input.action === "verify"
        ? "audits"
        : "context",
    );
    if (paused) return paused;

    switch (input.action) {
      case "create":
        return Response.json(
          await createSite(database(), actor, {
            workspaceId: input.workspaceId,
            origin: input.origin,
          }),
          {
            status: 201,
            headers,
          },
        );
      case "challenge":
        return Response.json(
          await issueSiteChallenge(database(), actor, scope.parse(input)),
          { headers },
        );
      case "verify":
        if (
          process.env.LYRA_LOCAL_RAW_AUDITS !== "true" ||
          process.env.VERCEL === "1" ||
          !["localhost", "127.0.0.1"].includes(
            new URL(settings.origin).hostname,
          )
        )
          return Response.json(
            {
              error:
                "Site proof acquisition requires qualified operator configuration.",
            },
            { status: 503, headers },
          );
        await verifySiteChallenge(
          database(),
          actor,
          scope.parse(input),
          input.challengeId,
          observeSiteProof,
        );
        return Response.json({ ok: true }, { headers });
      case "context":
        return Response.json(
          await reviewSiteContext(
            database(),
            actor,
            scope.parse(input),
            input.expectedRevision,
            input.content,
          ),
          { headers },
        );
    }
  } catch (error) {
    return failure(error);
  }
}
export async function GET(request: Request) {
  try {
    const actor = await resolveActor(),
      query = new URL(request.url).searchParams;
    const selected = scope.parse({
      workspaceId: query.get("workspaceId"),
      siteId: query.get("siteId"),
    });
    return Response.json(
      await readSiteContextRevisions(database(), actor, selected),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
