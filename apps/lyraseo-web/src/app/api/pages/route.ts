import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { authSettings } from "@/server/auth/settings";
import { database, resolveActor } from "@/server/auth/server";
import {
  registerPage,
  changePage,
  listPages,
  readPage,
} from "@lyraseo/db/pages";
import {
  privateBody,
  privateHeaders,
  scopeSchema,
  editorialFailure,
} from "@/server/editorial/http";
const id = z.string().min(1).max(128);
const revision = {
  pageId: id,
  expectedRevision: z.number().int().positive(),
  idempotencyKey: id,
};
const command = z.discriminatedUnion("action", [
  scopeSchema
    .extend({ action: z.literal("register"), url: z.string().min(1).max(2048) })
    .strict(),
  scopeSchema
    .extend({
      action: z.literal("change"),
      ...revision,
      note: z.string().min(1).max(4000),
      contentDraftId: id.optional(),
    })
    .strict(),
  scopeSchema.extend({ action: z.literal("claim"), ...revision }).strict(),
  scopeSchema.extend({ action: z.literal("unassign"), ...revision }).strict(),
  scopeSchema
    .extend({
      action: z.literal("assign"),
      ...revision,
      assigneeUserId: id.nullable(),
    })
    .strict(),
]);
function failure(error: unknown) {
  if (error instanceof Error && error.message === "SOURCE_CHANGED")
    return Response.json(
      {
        error:
          "Page evidence changed while loading. Please reload the latest revision and retry.",
      },
      { status: 409, headers: privateHeaders },
    );
  if (error instanceof Error && error.message === "PAGE_LIMIT")
    return Response.json(
      { error: "This site has reached its 500 registered page limit." },
      { status: 409, headers: privateHeaders },
    );
  return editorialFailure(error);
}
export async function GET(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && origin !== authSettings()?.origin)
    )
      throw new Error("ORIGIN_REJECTED");
    const actor = await resolveActor();
    const input = scopeSchema
      .extend({ pageId: id.optional() })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      input.pageId
        ? await readPage(
            database(),
            actor,
            { workspaceId: input.workspaceId, siteId: input.siteId },
            input.pageId,
          )
        : await listPages(database(), actor, {
            workspaceId: input.workspaceId,
            siteId: input.siteId,
          }),
      { headers: privateHeaders },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      input = command.parse(await privateBody(request));
    const scope = { workspaceId: input.workspaceId, siteId: input.siteId };
    const paused = capabilityPause("context");
    if (paused) return paused;

    return Response.json(
      input.action === "register"
        ? await registerPage(database(), actor, scope, input.url)
        : await changePage(database(), actor, scope, input),
      {
        status: input.action === "register" ? 201 : 200,
        headers: privateHeaders,
      },
    );
  } catch (error) {
    return failure(error);
  }
}
