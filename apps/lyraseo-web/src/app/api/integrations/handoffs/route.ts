import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { capabilityPause } from "@/server/capabilities";
import {
  privateBody,
  privateHeaders,
  scopeSchema,
} from "@/server/editorial/http";
import { secretBox } from "@/server/google/provider";
import {
  configureWordPress,
  configureWebhook,
  disconnectHandoff,
  prepareWordPress,
  previewWordPress,
  prepareWebhookTest,
  readHandoffs,
  rotateWebhook,
} from "@lyraseo/db/handoffs";
const id = z.string().uuid(),
  revision = z.number().int().positive();
const command = z.discriminatedUnion("action", [
  scopeSchema
    .extend({
      action: z.literal("wordpress.configure"),
      installation: z.string().max(2048),
      username: z.string().min(1).max(200),
      applicationPassword: z.string().min(1).max(1024),
      confirmed: z.literal(true),
      expectedRevision: revision.optional(),
    })
    .strict(),
  scopeSchema
    .extend({
      action: z.literal("webhook.configure"),
      url: z.string().max(2048),
      confirmed: z.literal(true),
      eventTypes: z
        .array(z.enum(["audit.completed", "report.created"]))
        .max(2)
        .default([]),
      expectedRevision: revision.optional(),
    })
    .strict(),
  scopeSchema
    .extend({
      action: z.literal("disconnect"),
      destinationId: id,
      expectedRevision: revision,
    })
    .strict(),
  scopeSchema
    .extend({
      action: z.literal("webhook.rotate"),
      destinationId: id,
      expectedRevision: revision,
    })
    .strict(),
  scopeSchema
    .extend({
      action: z.literal("wordpress.prepare"),
      destinationId: id,
      draftRevisionId: z.string().min(1).max(128),
      expectedBodyHash: z.string().regex(/^[a-f0-9]{64}$/),
      expectedDestinationGeneration: z
        .number()
        .int()
        .positive()
        .max(2147483647),
      expectedDestinationUrl: z.string().min(1).max(2048),
      idempotencyKey: z.string().min(1).max(128),
    })
    .strict(),
  scopeSchema
    .extend({
      action: z.literal("webhook.test"),
      destinationId: id,
      idempotencyKey: z.string().min(1).max(128),
    })
    .strict(),
]);
function box() {
  const key = process.env.LYRA_HANDOFF_ENCRYPTION_KEY;
  if (!key) throw Error("HANDOFF_ENCRYPTION_UNAVAILABLE");
  return secretBox(key);
}
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const invalid =
    error instanceof z.ZodError || /INVALID_|REVISION_|IDEMPOTENCY_/.test(code);
  return Response.json(
    {
      error:
        code === "FRESH_AUTH_REQUIRED"
          ? "Sign in again before managing destinations."
          : code === "REVISION_CONFLICT"
            ? "This review is out of date. Review the outgoing draft and destination again before saving."
            : invalid
              ? "Check your destination and revision, then reload and review before saving."
              : ["FORBIDDEN", "NOT_FOUND"].includes(code)
                ? "Resource unavailable."
                : "Handoffs unavailable. Saved audits, drafts and reports remain usable.",
    },
    {
      status: ["FORBIDDEN", "NOT_FOUND", "ORIGIN_REJECTED"].includes(code)
        ? 404
        : invalid
          ? 409
          : 503,
      headers: privateHeaders,
    },
  );
}
export async function GET(request: Request) {
  try {
    const actor = await resolveActor(),
      query = new URL(request.url).searchParams,
      scope = scopeSchema.parse(Object.fromEntries(query));
    if (query.get("action") === "wordpress.preview")
      return Response.json(
        await previewWordPress(database(), actor, scope, {
          destinationId: id.parse(query.get("destinationId")),
          draftRevisionId: z
            .string()
            .min(1)
            .max(128)
            .parse(query.get("draftRevisionId")),
        }),
        { headers: privateHeaders },
      );
    return Response.json(await readHandoffs(database(), actor, scope), {
      headers: privateHeaders,
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      input = command.parse(await privateBody(request)),
      scope = scopeSchema.parse(input),
      paused = capabilityPause("handoffs");
    if (paused && input.action !== "disconnect") return paused;
    let result;
    switch (input.action) {
      case "wordpress.configure":
        result = await configureWordPress(
          database(),
          actor,
          scope,
          box(),
          input,
        );
        break;
      case "webhook.configure":
        result = await configureWebhook(database(), actor, scope, box(), input);
        break;
      case "disconnect":
        result = await disconnectHandoff(
          database(),
          actor,
          scope,
          input.destinationId,
          input.expectedRevision,
        );
        break;
      case "webhook.rotate":
        result = await rotateWebhook(
          database(),
          actor,
          scope,
          box(),
          input.destinationId,
          input.expectedRevision,
        );
        break;
      case "wordpress.prepare":
        result = await prepareWordPress(database(), actor, scope, input);
        break;
      case "webhook.test":
        result = await prepareWebhookTest(database(), actor, scope, input);
        break;
    }
    return Response.json(result, { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
