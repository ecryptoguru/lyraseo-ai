import { listReportBrandingChoices } from "@lyraseo/db/branding";
import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import {
  captureEvidenceReport,
  storeEvidenceReport,
  readEvidenceReports,
  previewEvidenceReport,
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
        .extend({
          title: z.string().min(1).max(200),
          reportTemplate: z.enum(["founder", "editor", "agency"]).optional(),
          brandingRevision: z.number().int().positive().optional(),
          ...selectionSchema,
          comparison: z
            .object({
              beforeAuditId: z.string().min(1).max(128),
              afterAuditId: z.string().min(1).max(128),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(await privateBody(request));
    const paused = capabilityPause("content");
    if (paused) return paused;

    const snapshot = await captureEvidenceReport(
      database(),
      actor,
      scopeSchema.parse(input),
      {
        auditIds: input.auditIds,
        searchSnapshotIds: input.searchSnapshotIds,
        comparison: input.comparison,
        reportTemplate: input.reportTemplate,
        brandingRevision: input.brandingRevision,
      },
    );
    return Response.json(
      await storeEvidenceReport(database(), actor, scopeSchema.parse(input), {
        title: input.title,
        snapshot,
        render: renderEvidenceReport,
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
    if (query.get("brandingOptions") === "1") {
      if (query.has("reportId") || query.has("format"))
        throw new Error("INVALID_REQUEST");
      return Response.json(
        { choices: await listReportBrandingChoices(database(), actor, scope) },
        { headers: privateHeaders },
      );
    }
    const reportId = query.get("reportId") ?? undefined;
    if (reportId && query.get("format") === "preview")
      return Response.json(
        await previewEvidenceReport(database(), actor, scope, reportId),
        { headers: privateHeaders },
      );
    const format = query.get("format");
    if (reportId && format !== "pdf" && format !== "csv")
      throw new Error("INVALID_FORMAT");
    const result = await readEvidenceReports(
      database(),
      actor,
      scope,
      reportId,
      format === "pdf" || format === "csv" ? format : undefined,
    );
    if (!Array.isArray(result) && reportId) {
      if (
        (format === "pdf" && !result.pdf) ||
        (format === "csv" && result.csv === undefined)
      )
        throw new Error("INVALID_FORMAT");
      return new Response(
        format === "pdf" ? new Uint8Array(result.pdf!) : result.csv,
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
