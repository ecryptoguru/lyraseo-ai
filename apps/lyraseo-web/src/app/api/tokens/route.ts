import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { signInDestination } from "@/server/auth/failures";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  tokenAccessPolicyHash,
  readScopes,
} from "@lyraseo/db/tokens";
import { privateBody, privateHeaders } from "@/server/editorial/http";
const id = z.string().min(1).max(128);
const command = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      workspaceId: id,
      name: z.string().trim().min(1).max(80),
      siteIds: z.array(id).min(1).max(20),
      scopes: z.array(z.enum(readScopes)).min(1).max(3),
      expiresInDays: z.number().int().min(1).max(90).default(90),
      requestKey: z.uuid(),
    })
    .strict(),
  z
    .object({ action: z.literal("revoke"), workspaceId: id, tokenId: id })
    .strict(),
]);
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const status =
    code === "RATE_LIMITED"
      ? 429
      : code === "FRESH_AUTH_REQUIRED"
        ? 401
        : code === "ORIGIN_REJECTED"
          ? 403
          : ["FORBIDDEN", "NOT_FOUND"].includes(code)
            ? 404
            : error instanceof z.ZodError || /^(INVALID_|TOKEN_)/.test(code)
              ? 409
              : signInDestination(error)
                ? 401
                : 503;
  return Response.json(
    {
      error:
        status === 401
          ? "Sign in again with fresh authentication before managing tokens."
          : status === 409
            ? "Check the token fields. A creation request can reveal its secret only once; use a new request key to issue another token."
            : status === 429
              ? "Too many requests. Try again in one minute."
              : "Token service unavailable.",
      code: status === 401 ? "FRESH_AUTH_REQUIRED" : undefined,
    },
    {
      status,
      headers: {
        ...privateHeaders,
        ...(status === 429 ? { "Retry-After": "60" } : {}),
      },
    },
  );
}
export async function GET(request: Request) {
  try {
    const settings = authSettings();
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      !settings ||
      (origin !== null && origin !== settings.origin) ||
      (fetchSite !== null && !["same-origin", "none"].includes(fetchSite))
    )
      throw new Error("ORIGIN_REJECTED");
    const actor = await resolveActor();
    const workspaceId = id.parse(
      new URL(request.url).searchParams.get("workspaceId"),
    );
    return Response.json(
      { tokens: await listApiTokens(database(), actor, workspaceId) },
      { headers: privateHeaders },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor();
    const input = command.parse(await privateBody(request));
    const paused = input.action === "create" && capabilityPause("mcp");
    if (paused) return paused;

    const result =
      input.action === "create"
        ? await createApiToken(
            database(),
            actor,
            input,
            tokenAccessPolicyHash(authSettings()!.allowedEmails),
          )
        : await revokeApiToken(
            database(),
            actor,
            input.workspaceId,
            input.tokenId,
          );
    return Response.json(result, {
      status: input.action === "create" ? 201 : 200,
      headers: privateHeaders,
    });
  } catch (error) {
    return failure(error);
  }
}
