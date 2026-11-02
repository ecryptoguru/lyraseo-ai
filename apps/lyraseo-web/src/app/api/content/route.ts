import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import {
  createContentDraft,
  saveContentDraft,
  readContentDrafts,
} from "@lyraseo/db/content";
import {
  privateBody,
  privateHeaders,
  scopeSchema,
  selectionSchema,
  editorialFailure,
} from "@/server/editorial/http";
const fields = {
  title: z.string().min(1).max(200),
  body: z.string().max(100000),
  assumptions: z.array(z.string().max(1000)).max(50),
  citations: z
    .array(
      z
        .object({
          sourceId: z.string().max(256),
          note: z.string().min(1).max(1000),
        })
        .strict(),
    )
    .max(100),
};
const command = z.discriminatedUnion("action", [
  scopeSchema
    .extend({
      action: z.literal("create"),
      kind: z.enum(["brief", "draft"]),
      ...fields,
      ...selectionSchema,
    })
    .strict(),
  scopeSchema
    .extend({
      action: z.literal("save"),
      draftId: z.string().min(1).max(128),
      expectedRevision: z.number().int().positive(),
      ...fields,
    })
    .strict(),
  scopeSchema.extend({ action: z.literal("generate") }).strict(),
]);
export async function GET(request: Request) {
  try {
    const actor = await resolveActor(),
      query = new URL(request.url).searchParams;
    const scope = scopeSchema.parse(Object.fromEntries(query));
    return Response.json(
      await readContentDrafts(
        database(),
        actor,
        scope,
        query.get("draftId") ?? undefined,
      ),
      { headers: privateHeaders },
    );
  } catch (e) {
    return editorialFailure(e);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      input = command.parse(await privateBody(request));
    const paused = capabilityPause("content");
    if (paused) return paused;

    if (input.action === "generate") {
      // No provider submission path exists until credentials, verified tariffs, and complete-job quotes are configured.
      await readContentDrafts(database(), actor, scopeSchema.parse(input));
      return Response.json(
        {
          error:
            "Generation unavailable: no verified editorial provider tariff and complete-job quote are configured. Manual drafts and evidence reports remain available.",
        },
        { status: 503, headers: privateHeaders },
      );
    }
    const result =
      input.action === "create"
        ? await createContentDraft(
            database(),
            actor,
            scopeSchema.parse(input),
            {
              kind: input.kind,
              title: input.title,
              body: input.body,
              assumptions: input.assumptions,
              citations: input.citations,
              auditIds: input.auditIds,
              searchSnapshotIds: input.searchSnapshotIds,
            },
          )
        : await saveContentDraft(database(), actor, scopeSchema.parse(input), {
            draftId: input.draftId,
            expectedRevision: input.expectedRevision,
            title: input.title,
            body: input.body,
            assumptions: input.assumptions,
            citations: input.citations,
          });
    return Response.json(result, {
      status: input.action === "create" ? 201 : 200,
      headers: privateHeaders,
    });
  } catch (e) {
    return editorialFailure(e);
  }
}
