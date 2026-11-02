import { capabilityPause } from "@/server/capabilities";
import { z } from "zod";
import { authSettings } from "@/server/auth/settings";
import { database, resolveActor } from "@/server/auth/server";
import { signInDestination } from "@/server/auth/failures";
import {
  cancelAuditRun,
  compareAuditRuns,
  createAuditRun,
  listAuditRuns,
  readAuditRun,
  reviewAuditIssue,
} from "@lyraseo/db/audits";
import { runRawAuditStep } from "@/server/acquisition/runner";
import { publicHttpsTransport } from "@/server/acquisition/transport";
import type { AuditEvaluation } from "@lyraseo/visibility";

const headers = { "Cache-Control": "private, no-store" };
function auditView(run: Awaited<ReturnType<typeof readAuditRun>>) {
  return {
    ...run,
    pages: run.pages.map((page) => {
      const provenance = { ...page.provenance };
      delete provenance.rawHtml;
      return { ...page, provenance };
    }),
  };
}
async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_BODY");
  let size = 0,
    body = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return body + decoder.decode();
      size += chunk.value.byteLength;
      if (size > 65536) throw new Error("INVALID_BODY_SIZE");
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const scope = z.object({
  workspaceId: z.string().min(1).max(128),
  siteId: z.string().min(1).max(128),
});
const auditScope = scope.extend({ auditId: z.string().min(1).max(128) });
const command = z.discriminatedUnion("action", [
  scope
    .extend({
      action: z.literal("create"),
      idempotencyKey: z.string().min(1).max(128),
      manifest: z.array(z.string().max(2048)).min(1).max(25),
    })
    .strict(),
  auditScope.extend({ action: z.literal("step") }).strict(),
  auditScope.extend({ action: z.literal("cancel") }).strict(),
  auditScope
    .extend({
      action: z.literal("review"),
      ruleId: z.string().max(32),
      scopeKey: z.string().max(2048),
      disposition: z.enum(["OPEN", "REVIEWED", "DISMISSED"]),
      reason: z.string().min(1).max(512),
    })
    .strict(),
]);
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (["FORBIDDEN", "NOT_FOUND"].includes(code))
    return Response.json(
      { error: "Access to this audit is unavailable." },
      { status: 404, headers },
    );
  if (signInDestination(error))
    return Response.json(
      { error: "Sign in again to continue." },
      { status: 401, headers },
    );
  if (
    error instanceof z.ZodError ||
    /^(INVALID_|SITE_|IDEMPOTENCY_|AUDIT_|LEASE_|IMMUTABLE_)/.test(code)
  )
    return Response.json(
      {
        error:
          "The audit could not continue. Check the selected pages and site verification, or resume after the current step finishes.",
      },
      { status: 409, headers },
    );
  return Response.json(
    {
      error:
        "Audit service unavailable. Captured pages remain saved; retry shortly.",
    },
    { status: 503, headers },
  );
}

export async function POST(request: Request) {
  try {
    const actor = await resolveActor();
    const settings = authSettings();
    if (!settings || request.headers.get("origin") !== settings.origin)
      return Response.json(
        { error: "Request origin rejected." },
        { status: 403, headers },
      );
    if (Number(request.headers.get("content-length")) > 65536)
      return Response.json(
        { error: "Request too large." },
        { status: 413, headers },
      );
    const body = await boundedBody(request);
    if (body.length > 65536)
      return Response.json(
        { error: "Request too large." },
        { status: 413, headers },
      );
    const input = command.parse(JSON.parse(body));
    const paused = input.action !== "cancel" && capabilityPause("audits");
    if (paused) return paused;
    // Private controlled execution is local until hosting/runtime acceptance passes.
    if (
      input.action !== "cancel" &&
      (process.env.LYRA_LOCAL_RAW_AUDITS !== "true" ||
        process.env.VERCEL === "1" ||
        !["localhost", "127.0.0.1"].includes(new URL(settings.origin).hostname))
    )
      return Response.json(
        { error: "Local raw audits are not enabled on this deployment." },
        { status: 503, headers },
      );

    switch (input.action) {
      case "create": {
        const run = await createAuditRun(database(), actor, {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          manifest: input.manifest,
          idempotencyKey: input.idempotencyKey,
          profile: "LOCAL_RAW_V1",
        });
        return Response.json(
          { id: run.id, status: run.status },
          { status: 201, headers },
        );
      }
      case "step":
        return Response.json(
          auditView(
            await runRawAuditStep(
              database(),
              actor,
              auditScope.parse(input),
              publicHttpsTransport,
            ),
          ),
          { headers },
        );
      case "cancel":
        await cancelAuditRun(database(), actor, auditScope.parse(input));
        break;
      case "review":
        await reviewAuditIssue(database(), actor, auditScope.parse(input), {
          ruleId: input.ruleId,
          scopeKey: input.scopeKey,
          disposition: input.disposition,
          reason: input.reason,
        });
        break;
    }
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request) {
  try {
    const actor = await resolveActor();
    const query = new URL(request.url).searchParams;
    const selected = scope.parse(
      Object.fromEntries(
        ["workspaceId", "siteId"].map((key) => [key, query.get(key)]),
      ),
    );
    const auditId = query.get("auditId");
    if (!auditId)
      return Response.json(await listAuditRuns(database(), actor, selected), {
        headers,
      });
    const resource = auditScope.parse({ ...selected, auditId });
    if (query.get("before"))
      return Response.json(
        await compareAuditRuns(
          database(),
          actor,
          resource,
          query.get("before")!,
        ),
        { headers },
      );
    const run = await readAuditRun(
      database(),
      actor,
      resource,
      query.get("format") === "csv" ? "export" : "read",
    );
    if (query.get("format") === "source") {
      const raw = run.pages.find(
        (page) => page.requestedUrl === query.get("url"),
      )?.provenance.rawHtml;
      if (typeof raw !== "string")
        return Response.json(
          { error: "Source unavailable or expired." },
          { status: 410, headers },
        );
      return new Response(raw, {
        headers: {
          ...headers,
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="page-source.txt"',
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (query.get("format") === "csv") {
      const csvCell = (value: unknown) => {
        let text = String(value ?? "");
        if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
      };
      const evaluation = run.evaluation as unknown as AuditEvaluation | null;
      const rows = [
        [
          "Audit",
          "Methodology",
          "Profile",
          "Context revision",
          "Created UTC",
          "Coverage",
          "Rule",
          "URL",
          "Outcome",
          "Reason",
        ],
        ...(evaluation?.rules ?? []).map((rule) => [
          run.id,
          run.methodologyVersion,
          run.profile,
          (run.declarations as { contextRevision?: number }).contextRevision ??
            "undeclared",
          run.createdAt.toISOString(),
          evaluation?.coverage,
          rule.ruleId,
          rule.scopeKey,
          rule.outcome,
          rule.reasonCode,
        ]),
      ];
      return new Response(
        rows.map((row) => row.map(csvCell).join(",")).join("\r\n"),
        {
          headers: {
            ...headers,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="lyraseo-audit.csv"',
          },
        },
      );
    }
    return Response.json(auditView(run), { headers });
  } catch (error) {
    return failure(error);
  }
}
