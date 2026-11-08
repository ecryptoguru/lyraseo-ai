import { z } from "zod";
import {
  readStaffView,
  searchStaffSupport,
  prepareStaffStepUp,
  performStaffAction,
  recordStaffDenied,
  prepareStaffRequest,
  executeStaffRequest,
  resolveStaffRequest,
  acknowledgeStaffRequest,
} from "@lyraseo/db/sandbox-billing";
import { requireStaffFor, staffDatabase } from "@/server/admin/staff";
import { privateBody, privateHeaders } from "@/server/editorial/http";
import { authSettings } from "@/server/auth/settings";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const actions = z.enum([
  "billing:reconcile",
  "policy:pause",
  "recovery:open",
  "recovery:hold",
  "recovery:approve",
  "recovery:deny",
  "recovery:complete",
]);
const args = z
  .object({
    expectedRevision: z.number().int().nonnegative().optional(),
    workspaceId: id.optional(),
    evidenceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    noticeReceiptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const command = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("resolve-request"),
      requestId: z.uuid(),
      choice: z.enum(["STATUS", "ABANDON"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ack-request"),
      requestId: z.uuid(),
      resultHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prepare-request"),
      requestId: z.uuid(),
      action: actions,
      target: id,
      args,
      reason: z.string().min(12).max(500),
    })
    .strict(),
  z
    .object({ kind: z.literal("execute-request"), requestId: z.uuid() })
    .strict(),
  z
    .object({ kind: z.literal("step-up"), action: actions, target: id })
    .strict(),
  z
    .object({
      kind: z.literal("action"),
      action: actions,
      target: id,
      token: z.string().min(32).max(128),
      args,
      reason: z.string().min(12).max(500),
    })
    .strict(),
]);
function rejectUntrusted(request: Request) {
  if (
    request.headers.has("authorization") ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (request.headers.get("origin") &&
      request.headers.get("origin") !== authSettings()?.origin)
  )
    throw new Error("STAFF_REQUIRED");
}
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return Response.json(
    {
      error:
        code === "FRESH_AUTH_REQUIRED"
          ? "Reauthenticate with MFA before changing staff controls."
          : code === "STAFF_UNAVAILABLE"
            ? "Private staff tools are not configured."
            : "This staff request is unavailable. Refresh access and review the current state.",
    },
    {
      status: code === "STAFF_UNAVAILABLE" ? 503 : 403,
      headers: privateHeaders,
    },
  );
}
export async function GET(request: Request) {
  try {
    rejectUntrusted(request);
    const input = z
      .discriminatedUnion("view", [
        z
          .object({
            view: z.literal("search"),
            query: z
              .string()
              .min(8)
              .max(128)
              .regex(/^[A-Za-z0-9_-]+$/),
            match: z.enum(["EXACT", "PREFIX"]),
            cursorKind: z.enum(["SITE", "USER", "WORKSPACE"]).optional(),
            cursorId: id.optional(),
          })
          .strict(),
        z
          .object({
            view: z.enum([
              "billing",
              "deliveries",
              "jobs",
              "operations",
              "usage",
              "recovery",
              "audit",
              "controls",
              "privacy",
            ]),
            cursor: z.string().max(128).optional(),
          })
          .strict(),
      ])
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const actor = await requireStaffFor(
      input.view === "search" || input.view === "privacy" ? "change" : "read",
    );
    if (input.view === "search")
      return Response.json(
        await searchStaffSupport(staffDatabase(), actor, input),
        { headers: privateHeaders },
      );
    return Response.json(
      await readStaffView(staffDatabase(), actor, input.view, input.cursor),
      { headers: privateHeaders },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  let admitted: Awaited<ReturnType<typeof requireStaffFor>> | undefined;
  let attempted: z.infer<typeof command> | undefined;
  try {
    rejectUntrusted(request);
    const input = command.parse(await privateBody(request)),
      actor = await requireStaffFor("change");
    admitted = actor;
    attempted = input;
    if (input.kind === "resolve-request")
      return Response.json(
        await resolveStaffRequest(
          staffDatabase(),
          actor,
          input.requestId,
          input.choice,
        ),
        { headers: privateHeaders },
      );
    if (input.kind === "ack-request")
      return Response.json(
        await acknowledgeStaffRequest(
          staffDatabase(),
          actor,
          input.requestId,
          input.resultHash,
        ),
        { headers: privateHeaders },
      );
    if (input.kind === "prepare-request")
      return Response.json(
        await prepareStaffRequest(staffDatabase(), actor, input),
        { headers: privateHeaders },
      );
    if (input.kind === "execute-request")
      return Response.json(
        await executeStaffRequest(staffDatabase(), actor, input.requestId),
        { headers: privateHeaders },
      );
    if (input.kind === "step-up") {
      const token = await prepareStaffStepUp(
        staffDatabase(),
        actor,
        input.action,
        input.target,
      );
      return Response.json({ token }, { headers: privateHeaders });
    }
    const result = await performStaffAction(
      staffDatabase(),
      actor,
      input.action,
      input.target,
      input.token,
      input.args,
      input.reason,
    );
    return Response.json(result, {
      status: result.committed === false ? 409 : 200,
      headers: privateHeaders,
    });
  } catch (error) {
    if (admitted && attempted && "action" in attempted) {
      try {
        await recordStaffDenied(
          staffDatabase(),
          admitted,
          attempted.action,
          attempted.target,
        );
      } catch {
        /* A revoked staff grant cannot write a receipt. */
      }
    }
    return failure(error);
  }
}
