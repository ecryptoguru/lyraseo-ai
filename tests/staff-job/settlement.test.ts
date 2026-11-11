import { expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { settleOperation } from "../../packages/db/src/accounting";
const name = process.env.LYRA_STAFF_JOB_DB;
if (!name || !/^lyraseo_staff_jobs_[a-f0-9]{16}$/.test(name))
  throw Error("OWNED_STAFF_JOB_DATABASE_REQUIRED");
const base = `127.0.0.1:54329/${name}`;
const actor = {
  userId: "sponsor",
  sessionId: "sponsorsession",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: false,
  authProvider: "supabase" as const,
};
const staffActor = {
  userId: "staff",
  sessionId: "staffsession",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  mfaAuthenticatedAt: new Date().toISOString(),
  authProvider: "supabase" as const,
};
const requestId = process.env.LYRA_STAFF_JOB_REQUEST_ID;
if (!requestId || !/^[0-9a-f-]{36}$/.test(requestId))
  throw Error("FIXTURE_REQUEST_ID_REQUIRED");
const cancelRequestId = process.env.LYRA_STAFF_JOB_CANCEL_REQUEST_ID;
if (!cancelRequestId || !/^[0-9a-f-]{36}$/.test(cancelRequestId))
  throw Error("FIXTURE_CANCEL_REQUEST_ID_REQUIRED");
it("serializes actual receipt settlement and pre-attempt cancellation with one release each", async () => {
  const ledger = createDatabase(
    `postgresql://lyraseo_runtime:local_runtime_only@${base}`,
  );
  const staff = createDatabase(
    `postgresql://lyraseo_staff_executor:local_staff_executor_only@${base}`,
  );
  const admin = createDatabase(
    `postgresql://postgres:lyraseo_local_only@${base}`,
  );
  try {
    const before = await admin.budgetPeriod.findMany({
      where: { userId: "sponsor", bucket: { in: ["COMBINED", "AZURE"] } },
      orderBy: { bucket: "asc" },
    });
    const [settlement, cancellation, preAttempt] = await Promise.allSettled([
      settleOperation(ledger, actor, "settle-race", 2, {
        receiptId: "fixture-receipt",
        amount: "0.2",
        acceptedOutput: true,
      }),
      staff.$queryRaw`SELECT lyraseo_billing.execute_job_request(${JSON.stringify(staffActor)}::jsonb,${"jobs:cancel"}::text,${"settle-race"}::text,${2}::integer,${"Review fixture reason"}::text,${requestId}::uuid)`,
      staff.$queryRaw`SELECT lyraseo_billing.execute_job_request(${JSON.stringify(staffActor)}::jsonb,${"jobs:cancel"}::text,${"cancel-race"}::text,${2}::integer,${"Review fixture reason"}::text,${cancelRequestId}::uuid)`,
    ]);
    if (preAttempt.status === "rejected") throw preAttempt.reason;
    await staff.$queryRaw`SELECT lyraseo_billing.execute_job_request(${JSON.stringify(staffActor)}::jsonb,${"jobs:cancel"}::text,${"cancel-race"}::text,${2}::integer,${"Review fixture reason"}::text,${cancelRequestId}::uuid)`;
    if (settlement.status === "rejected") throw settlement.reason;
    expect(settlement.status).toBe("fulfilled");
    if (cancellation.status === "rejected")
      expect(String(cancellation.reason)).toMatch(/JOB_TERMINAL/);
    const after = await admin.budgetPeriod.findMany({
      where: { userId: "sponsor", bucket: { in: ["COMBINED", "AZURE"] } },
      orderBy: { bucket: "asc" },
    });
    for (let i = 0; i < before.length; i++) {
      expect(before[i]!.reserved.minus(after[i]!.reserved).toString()).toBe(
        "2",
      );
      expect(after[i]!.spent.minus(before[i]!.spent).toString()).toBe("0.2");
    }
    expect(
      await admin.usageReceipt.count({ where: { operationId: "settle-race" } }),
    ).toBe(1);
    const operation = await admin.operation.findUniqueOrThrow({
      where: { id: "settle-race" },
    });
    expect(["CANCELLED", "COMPLETED"]).toContain(operation.status);
    expect(operation.attemptState).toBe("ACCEPTED");
    expect(
      (
        await admin.operation.findUniqueOrThrow({
          where: { id: "cancel-race" },
        })
      ).status,
    ).toBe("CANCELLED");
  } finally {
    await Promise.all([
      ledger.$disconnect(),
      staff.$disconnect(),
      admin.$disconnect(),
    ]);
  }
});
