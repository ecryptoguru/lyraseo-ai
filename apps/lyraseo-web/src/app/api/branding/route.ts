import { z } from "zod";
import { capabilityPause } from "@/server/capabilities";
import { database, resolveActor } from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import {
  readWorkspaceBranding,
  saveWorkspaceBranding,
  authorizeBrandingManagement,
} from "@lyraseo/db/branding";
import {
  sanitizeBrandLogo,
  BRAND_UPLOAD_MAX_BYTES,
} from "@/server/branding/sanitize";
import { privateHeaders, editorialFailure } from "@/server/editorial/http";
const fields = z
  .object({
    workspaceId: z.string().min(1).max(128),
    expectedRevision: z.coerce.number().int().nonnegative(),
    displayName: z.string().max(100),
    clearLogo: z.enum(["true", "false"]).optional(),
  })
  .strict();
export async function GET(request: Request) {
  try {
    const input = z
      .object({ workspaceId: z.string().min(1).max(128) })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      await readWorkspaceBranding(
        database(),
        await resolveActor(),
        input.workspaceId,
      ),
      { headers: privateHeaders },
    );
  } catch (error) {
    return editorialFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    const paused = capabilityPause("agency");
    if (paused) return paused;
    if (
      !authSettings() ||
      request.headers.get("origin") !== authSettings()?.origin
    )
      throw Error("ORIGIN_REJECTED");
    const actor = await resolveActor();
    // Bound the actual stream before the multipart parser or image decoder can allocate it.
    const reader = request.body?.getReader();
    if (!reader) throw Error("INVALID_BODY");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > BRAND_UPLOAD_MAX_BYTES + 16000)
          throw Error("INVALID_BRAND_LOGO");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
    const entries = Array.from(form.entries());
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      throw Error("INVALID_BODY");
    const logo = form.get("logo"),
      input = fields.parse(
        Object.fromEntries(entries.filter(([key]) => key !== "logo")),
      );
    if (logo !== null && !(logo instanceof File))
      throw Error("INVALID_BRAND_LOGO");
    if (logo && input.clearLogo === "true") throw Error("INVALID_BRAND_LOGO");
    await authorizeBrandingManagement(database(), actor, input.workspaceId);
    const sanitized = logo
      ? await sanitizeBrandLogo(
          new Uint8Array(await logo.arrayBuffer()),
          logo.type,
        )
      : input.clearLogo === "true"
        ? null
        : undefined;
    return Response.json(
      await saveWorkspaceBranding(database(), actor, {
        workspaceId: input.workspaceId,
        expectedRevision: input.expectedRevision,
        displayName: input.displayName,
        logo: sanitized,
      }),
      { headers: privateHeaders },
    );
  } catch (error) {
    return editorialFailure(error);
  }
}
