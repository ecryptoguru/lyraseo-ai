import { z } from "zod";
import { authSettings } from "@/server/auth/settings";
import { signInDestination } from "@/server/auth/failures";
export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export const scopeSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  siteId: z.string().min(1).max(128),
});
export const selectionSchema = {
  auditIds: z.array(z.string().min(1).max(128)).max(5).default([]),
  searchSnapshotIds: z.array(z.string().min(1).max(128)).max(5).default([]),
};
export async function privateBody(request: Request) {
  const settings = authSettings();
  if (!settings || request.headers.get("origin") !== settings.origin)
    throw new Error("ORIGIN_REJECTED");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_BODY");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 200000) throw new Error("INVALID_BODY");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_BODY");
  }
}
export function editorialFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "LEGACY_EVIDENCE_WITHHELD")
    return Response.json(
      {
        code,
        error:
          "Historical source evidence is withheld pending source-lineage verification. Your authored revisions remain available.",
      },
      { status: 409, headers: privateHeaders },
    );
  if (
    [
      "LEGACY_REVIEW",
      "REPORT_WITHDRAWN",
      "SOURCE_EXPIRED",
      "REVISION_UNAVAILABLE",
    ].includes(code)
  )
    return Response.json(
      {
        error:
          code === "REPORT_WITHDRAWN"
            ? "This original report has been withdrawn."
            : code === "LEGACY_REVIEW"
              ? "Original download unavailable pending review. The saved preview is available."
              : code === "REVISION_UNAVAILABLE"
                ? "This historical revision is no longer available."
                : "This source has expired or disconnected.",
      },
      { status: 410, headers: privateHeaders },
    );
  const status =
    code === "ORIGIN_REJECTED"
      ? 403
      : ["FORBIDDEN", "NOT_FOUND"].includes(code)
        ? 404
        : ["FORBIDDEN", "NOT_FOUND"].includes(code)
          ? 404
          : signInDestination(error)
            ? 401
            : error instanceof z.ZodError ||
                /^(INVALID_|SOURCE_|REVISION_|CONTEXT_REVISION_CONFLICT|REVIEWED_CONTEXT_REQUIRED)/.test(
                  code,
                )
              ? 409
              : 503;
  return Response.json(
    {
      error:
        status === 409
          ? code === "REVIEWED_CONTEXT_REQUIRED"
            ? "Review and save site business context before requesting a writing template."
            : code === "SOURCE_CHANGED"
              ? "Selected evidence changed after this template or report was prepared. Your edits remain available. Prepare it again from the current saved evidence before saving."
              : code === "CONTEXT_REVISION_CONFLICT"
                ? "Site context changed after this template was prepared. Your edits remain available. Request a new template using the latest reviewed context before saving."
                : code === "INVALID_COMPARISON"
                  ? "Choose two distinct completed audits included in this report. Before must be no newer than after. Your selections are preserved."
                  : "Check the selected sources and fields, or reload the latest revision."
          : status === 404
            ? "Resource unavailable."
            : status === 401
              ? "Sign in again to continue."
              : "Editorial service unavailable.",
    },
    { status, headers: privateHeaders },
  );
}
