import { z } from "zod";
export const googleScope = z.object({
  workspaceId: z.string().min(1).max(128),
  siteId: z.string().min(1).max(128),
});
export const googleHeaders = { "Cache-Control": "private, no-store" };
export function googleFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (["FORBIDDEN", "NOT_FOUND"].includes(message))
    return Response.json(
      { error: "Site access is unavailable." },
      { status: 404, headers: googleHeaders },
    );
  if (
    [
      "UNAUTHENTICATED",
      "SESSION_EXPIRED",
      "FRESH_AUTH_REQUIRED",
      "MFA_REQUIRED",
    ].includes(message)
  )
    return Response.json(
      { error: "Sign in again to continue." },
      { status: 401, headers: googleHeaders },
    );
  const safe = [
    "GOOGLE_IMPORT_RUNNING",
    "GOOGLE_UNAVAILABLE",
    "GOOGLE_DISCONNECTED",
    "GOOGLE_RECONNECT_REQUIRED",
    "GOOGLE_PERMISSION_REQUIRED",
    "GOOGLE_PROPERTY_REQUIRED",
    "GOOGLE_PROPERTY_FORBIDDEN",
    "EXACT_VERIFIED_ORIGIN_REQUIRED",
    "INVALID_OAUTH_STATE",
    "GOOGLE_CONSENT_DENIED",
    "GOOGLE_CONNECTION_CHANGED",
    "GOOGLE_TEMPORARILY_UNAVAILABLE",
  ].includes(message)
    ? message
    : "SEARCH_REQUEST_REJECTED";
  return Response.json(
    { error: safe },
    {
      status: message === "GOOGLE_UNAVAILABLE" ? 503 : 409,
      headers: googleHeaders,
    },
  );
}
export async function smallJson(request: Request, maxBytes = 8192) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_REQUEST");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > maxBytes) throw new Error("INVALID_REQUEST");
      chunks.push(r.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
