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
} from "@lyraseo/db/visibility";
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
      action: z.literal("request-run"),
      panelId: z.string().min(1).max(128),
      profile,
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    const actor = await resolveActor();
    const q = Object.fromEntries(new URL(request.url).searchParams);
    const input = googleScope
      .extend({ runId: z.string().min(1).max(128).optional() })
      .strict()
      .parse(q);
    return Response.json(
      await readVisibility(
        database(),
        actor,
        googleScope.parse(input),
        input.runId,
      ),
      { headers: googleHeaders },
    );
  } catch (e) {
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
