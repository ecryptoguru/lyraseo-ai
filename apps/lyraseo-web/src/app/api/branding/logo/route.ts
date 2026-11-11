import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import { readBrandingLogo } from "@lyraseo/db/branding";
import {
  privateHeaders,
  scopeSchema,
  editorialFailure,
} from "@/server/editorial/http";
export async function GET(request: Request) {
  try {
    const input = scopeSchema
      .extend({ revision: z.coerce.number().int().positive() })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return new Response(
      new Uint8Array(
        await readBrandingLogo(
          database(),
          await resolveActor(),
          input,
          input.revision,
        ),
      ),
      {
        headers: {
          ...privateHeaders,
          "Content-Type": "image/png",
          "Content-Security-Policy": "default-src 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      },
    );
  } catch (error) {
    return editorialFailure(error);
  }
}
