import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import {
  captureEditorialEvidence,
  storeEvidenceReport,
  readEvidenceReports,
} from "@lyraseo/db/content";
import { renderEvidenceReport } from "@/server/editorial/reports";
import {
  privateBody,
  privateHeaders,
  scopeSchema,
  selectionSchema,
  editorialFailure,
} from "@/server/editorial/http";
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      input = scopeSchema
        .extend({ title: z.string().min(1).max(200), ...selectionSchema })
        .strict()
        .parse(await privateBody(request));
    const paused = capabilityPause("content");
    if (paused) return paused;

    const snapshot = await captureEditorialEvidence(
      database(),
      actor,
      scopeSchema.parse(input),
      { auditIds: input.auditIds, searchSnapshotIds: input.searchSnapshotIds },
    );
    const output = await renderEvidenceReport(input.title, snapshot);
    return Response.json(
      await storeEvidenceReport(database(), actor, scopeSchema.parse(input), {
        title: input.title,
        snapshot,
        ...output,
      }),
      { status: 201, headers: privateHeaders },
    );
  } catch (e) {
    return editorialFailure(e);
  }
}
export async function GET(request: Request) {
  try {
    const actor = await resolveActor(),
      query = new URL(request.url).searchParams,
      scope = scopeSchema.parse(Object.fromEntries(query));
    const reportId = query.get("reportId") ?? undefined;
    const result = await readEvidenceReports(
      database(),
      actor,
      scope,
      reportId,
    );
    if (!Array.isArray(result) && reportId) {
      const format = query.get("format");
      if (format !== "pdf" && format !== "csv")
        throw new Error("INVALID_FORMAT");
      return new Response(
        format === "pdf" ? new Uint8Array(result.pdf) : result.csv,
        {
          headers: {
            ...privateHeaders,
            "Content-Type":
              format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="lyraseo-report.${format}"`,
          },
        },
      );
    }
    return Response.json(result, { headers: privateHeaders });
  } catch (e) {
    return editorialFailure(e);
  }
}
