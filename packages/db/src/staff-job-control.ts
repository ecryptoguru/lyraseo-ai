import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/client";
import type { Actor } from "./context";

export type StaffJobAction = "jobs:retry" | "jobs:cancel";
export type StaffJobResult = {
  id: string;
  status: "QUEUED" | "CANCELLED" | "RECONCILING";
  fence: number;
  reconciliationRequired: boolean;
  delivery: "UNAVAILABLE";
};

/** Call separately after a rejected action, without including raw request data. */
export async function recordStaffJobDenied(
  db: PrismaClient,
  actor: Actor,
  action: StaffJobAction,
  target: string,
) {
  await db.$queryRaw`SELECT lyraseo_billing.staff_job_denied(${JSON.stringify(actor)}::jsonb,${action}::text,${target}::text)::text`;
}

/** Availability is local rehearsal only; individual actions recheck sponsor proof. */
export async function staffJobAvailability(db: PrismaClient, actor: Actor) {
  const [row] = await db.$queryRaw<
    { value: { available: boolean; profile: "LOCAL_REHEARSAL" } }[]
  >`SELECT lyraseo_billing.staff_job_availability(${JSON.stringify(actor)}::jsonb) AS value`;
  return row!.value;
}

/** Acknowledged server-generated allocation binds the reference to this staff principal. */
export async function allocateStaffJobRequest(db: PrismaClient, actor: Actor) {
  const requestId = randomUUID();
  await db.$queryRaw`SELECT lyraseo_billing.allocate_job_request(${JSON.stringify(actor)}::jsonb,${requestId}::uuid) AS value`;
  return { requestId };
}

/** Persist only the token hash; requestId is an opaque, non-secret replay key. */
export async function prepareStaffJobRequest(
  db: PrismaClient,
  actor: Actor,
  action: StaffJobAction,
  target: string,
  expectedFence: number,
  reason: string,
  requestId: string,
) {
  const token = randomBytes(32).toString("base64url");
  await db.$queryRaw`SELECT lyraseo_billing.prepare_job_request(${JSON.stringify(actor)}::jsonb,${action}::text,${target}::text,${token}::text,${expectedFence}::integer,${reason}::text,${requestId}::uuid)::text`;
}

export async function executeStaffJobRequest(
  db: PrismaClient,
  actor: Actor,
  action: StaffJobAction,
  target: string,
  expectedFence: number,
  reason: string,
  requestId: string,
) {
  const [row] = await db.$queryRaw<
    { value: StaffJobResult }[]
  >`SELECT lyraseo_billing.execute_job_request(${JSON.stringify(actor)}::jsonb,${action}::text,${target}::text,${expectedFence}::integer,${reason}::text,${requestId}::uuid) AS value`;
  return row!.value;
}

export async function staffJobRequestStatus(
  db: PrismaClient,
  actor: Actor,
  requestId: string,
) {
  const [row] = await db.$queryRaw<
    {
      value:
        | { state: "PENDING" | "CLOSED" }
        | { state: "COMPLETE"; result: StaffJobResult };
    }[]
  >`SELECT lyraseo_billing.job_request_status(${JSON.stringify(actor)}::jsonb,${requestId}::uuid) AS value`;
  return row!.value;
}

/** Serialize resolution with prepare and execute before releasing a UI reference. */
export async function resolveStaffJobRequest(
  db: PrismaClient,
  actor: Actor,
  requestId: string,
) {
  const [row] = await db.$queryRaw<
    {
      value:
        { state: "CLOSED" } | { state: "COMPLETE"; result: StaffJobResult };
    }[]
  >`SELECT lyraseo_billing.resolve_job_request(${JSON.stringify(actor)}::jsonb,${requestId}::uuid) AS value`;
  return row!.value;
}
