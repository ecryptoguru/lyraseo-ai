import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import {
  googleScope,
  googleHeaders,
  googleFailure,
  smallJson,
} from "@/server/google/http";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  readVisibility,
  requestVisibilityRun,
  previewVisibilityRun,
} from "@lyraseo/db/visibility";
import { readObservationAnswer } from "@lyraseo/db/observation-artifacts";
const profile = z.enum([
  "azure-sol-api",
  "consumer-chatgpt",
  "consumer-gemini",
]);
const base = {
  workspaceId: z.string().min(1).max(128),
  siteId: z.string().min(1).max(128),
};
const command = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      action: z.literal("create-panel"),
      prompts: z
        .array(
          z
            .object({
              id: z.string().min(1).max(80),
              text: z.string().min(1).max(4000),
              label: z.enum(["neutral", "branded"]),
            })
            .strict(),
        )
        .min(1)
        .max(25),
      brands: z
        .array(
          z
            .object({
              id: z.string().min(1).max(80),
              name: z.string().min(1).max(150),
              aliases: z.array(z.string().min(1).max(150)).min(1).max(20),
              domains: z.array(z.string().max(253)).max(20),
            })
            .strict(),
        )
        .min(1)
        .max(10),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("review-panel"),
      panelId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("preview-run"),
      panelId: z.string().min(1).max(128),
      profile,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("request-run"),
      panelId: z.string().min(1).max(128),
      profile,
    })
    .strict(),
]);
export async function GET(request: Request) {
  let detailRead = false;
  try {
    const actor = await resolveActor();
    const q = Object.fromEntries(new URL(request.url).searchParams);
    const input = googleScope
      .extend({
        runId: z.string().min(1).max(128).optional(),
        promptId: z.string().min(1).max(80).optional(),
        action: z.literal("read-answer").optional(),
      })
      .strict()
      .parse(q);
    if (input.action === "read-answer") {
      if (!input.runId || !input.promptId) throw Error("INVALID_REQUEST");
      const result = await readObservationAnswer(
        database(),
        actor,
        googleScope.parse(input),
        input.runId,
        input.promptId,
        resolveActor,
      );
      return Response.json(result, {
        status: result.answer
          ? 200
          : result.availability.state === "unavailable"
            ? 503
            : 410,
        headers: {
          ...googleHeaders,
          "X-Robots-Tag": "noindex, nofollow",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": 'attachment; filename="answer.json"',
        },
      });
    }
    if (input.promptId) throw Error("INVALID_REQUEST");
    detailRead = Boolean(input.runId);
    return Response.json(
      await readVisibility(
        database(),
        actor,
        googleScope.parse(input),
        input.runId,
        undefined,
        resolveActor,
      ),
      { headers: googleHeaders },
    );
  } catch (e) {
    if (detailRead && e instanceof Error && e.message === "SOURCE_EXPIRED")
      return Response.json(
        {
          state: "result-expired",
          error: "This saved visibility result has expired.",
        },
        { status: 410, headers: googleHeaders },
      );
    return googleFailure(e);
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
    const input = command.parse(await smallJson(request, 131072));
    const paused = capabilityPause("visibility");
    if (paused) return paused;

    if (input.action === "create-panel")
      return Response.json(
        await createVisibilityPanel(
          database(),
          actor,
          googleScope.parse(input),
          input.prompts,
          input.brands,
        ),
        { headers: googleHeaders },
      );
    if (input.action === "review-panel")
      return Response.json(
        await reviewVisibilityPanel(
          database(),
          actor,
          googleScope.parse(input),
          input.panelId,
        ),
        { headers: googleHeaders },
      );
    if (input.action === "preview-run") {
      const db = database(),
        scope = googleScope.parse(input);
      // Do not hold product locks while rechecking the identity provider. The
      // second read rechecks current site grants after that external boundary.
      await previewVisibilityRun(
        db,
        actor,
        scope,
        input.panelId,
        input.profile,
      );
      const current = await resolveActor();
      if (
        current.userId !== actor.userId ||
        current.sessionId !== actor.sessionId ||
        current.securityVersion !== actor.securityVersion
      )
        throw new Error("FORBIDDEN");
      return Response.json(
        await previewVisibilityRun(
          db,
          current,
          scope,
          input.panelId,
          input.profile,
        ),
        { headers: googleHeaders },
      );
    }
    const availability = await requestVisibilityRun(
      database(),
      actor,
      googleScope.parse(input),
      input.panelId,
      input.profile,
    );
    return Response.json(
      { error: "VISIBILITY_UNAVAILABLE", ...availability },
      { status: 503, headers: googleHeaders },
    );
  } catch (e) {
    return googleFailure(e);
  }
}
