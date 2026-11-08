import { z } from "zod";
import {
  allocateStaffJobRequest,
  prepareStaffJobRequest,
  executeStaffJobRequest,
  recordStaffJobDenied,
  staffJobAvailability,
  staffJobRequestStatus,
  resolveStaffJobRequest,
} from "@lyraseo/db/staff-job-control";
import { requireStaffFor, staffDatabase } from "@/server/admin/staff";
import { privateBody, privateHeaders } from "@/server/editorial/http";
import { authSettings } from "@/server/auth/settings";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const action = z.enum(["jobs:retry", "jobs:cancel"]);
const requestId = z.string().uuid();
const command = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allocate") }).strict(),
  z.object({ kind: z.literal("resolve"), requestId }).strict(),
  z
    .object({
      kind: z.enum(["prepare", "execute"]),
      action,
      target: id,
      requestId,
      expectedFence: z.number().int().nonnegative().max(2147483647),
      reason: z.string().trim().min(12).max(500),
    })
    .strict(),
]);
function rejectUntrusted(request: Request) {
  const origin = request.headers.get("origin");
  if (
    request.headers.has("authorization") ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin && origin !== authSettings()?.origin)
  )
    throw new Error("STAFF_REQUIRED");
}
function failure() {
  return Response.json(
    {
      error:
        "This job action is unavailable. Refresh access and review the current state.",
    },
    { status: 403, headers: privateHeaders },
  );
}
export async function GET(request: Request) {
  try {
    rejectUntrusted(request);
    const actor = await requireStaffFor("change");
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((key) => key !== "requestId") ||
      params.getAll("requestId").length > 1
    )
      throw new Error("INVALID_REQUEST");
    const requestId = params.get("requestId");
    const result = requestId
      ? await staffJobRequestStatus(
          staffDatabase(),
          actor,
          z.string().uuid().parse(requestId),
        )
      : await staffJobAvailability(staffDatabase(), actor);
    return Response.json(result, { headers: privateHeaders });
  } catch {
    return failure();
  }
}
export async function POST(request: Request) {
  let admitted: Awaited<ReturnType<typeof requireStaffFor>> | undefined;
  let attempted: z.infer<typeof command> | undefined;
  try {
    rejectUntrusted(request);
    const input = command.parse(await privateBody(request));
    const actor = await requireStaffFor("change");
    admitted = actor;
    attempted = input;
    if (input.kind === "allocate") {
      return Response.json(
        await allocateStaffJobRequest(staffDatabase(), actor),
        { headers: privateHeaders },
      );
    }
    if (input.kind === "resolve") {
      return Response.json(
        await resolveStaffJobRequest(staffDatabase(), actor, input.requestId),
        { headers: privateHeaders },
      );
    }
    const args = [
      staffDatabase(),
      actor,
      input.action,
      input.target,
      input.expectedFence,
      input.reason,
      input.requestId,
    ] as const;
    const result =
      input.kind === "prepare"
        ? (await prepareStaffJobRequest(...args), { prepared: true })
        : await executeStaffJobRequest(...args);
    return Response.json(result, { headers: privateHeaders });
  } catch {
    if (
      admitted &&
      attempted &&
      attempted.kind !== "resolve" &&
      attempted.kind !== "allocate"
    ) {
      try {
        await recordStaffJobDenied(
          staffDatabase(),
          admitted,
          attempted.action,
          attempted.target,
        );
      } catch {
        /* Logging failure never permits the action. */
      }
    }
    return failure();
  }
}
