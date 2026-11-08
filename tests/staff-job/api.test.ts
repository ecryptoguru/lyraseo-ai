import { afterAll, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { prepareStaffJobRequest } from "../../packages/db/src/staff-job-control";
const name = process.env.LYRA_STAFF_JOB_DB;
if (!name || !/^lyraseo_staff_jobs_[a-f0-9]{16}$/.test(name))
  throw Error("OWNED_STAFF_JOB_DATABASE_REQUIRED");
const base = `127.0.0.1:54329/${name}`;
const staff = createDatabase(
  `postgresql://lyraseo_staff_executor:local_staff_executor_only@${base}`,
);
const admin = createDatabase(
  `postgresql://postgres:lyraseo_local_only@${base}`,
);
const actor = {
  userId: "staff",
  sessionId: "staffsession",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  mfaAuthenticatedAt: new Date().toISOString(),
  authProvider: "supabase" as const,
};
vi.mock("@/server/admin/staff", () => ({
  requireStaffFor: async () => actor,
  staffDatabase: () => staff,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3013" }),
}));
import { POST } from "../../apps/lyraseo-web/src/app/api/admin/jobs/route";
afterAll(async () => {
  await Promise.all([staff.$disconnect(), admin.$disconnect()]);
});
const command = (payload: unknown) =>
  POST(
    new Request("http://127.0.0.1:3013/api/admin/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3013",
      },
      body: JSON.stringify(payload),
    }),
  );
const payload = (target: string, requestId: string) => ({
  action: "jobs:retry",
  target,
  requestId,
  expectedFence: 2,
  reason: "Review fixture reason",
});
const ids = { denied: "", conflict: "", terminal: "", lost: "", overlap: "" };
async function addJob(id: string) {
  await admin.$executeRaw`UPDATE "BudgetPeriod" SET reserved=reserved+1, "limit"=100 WHERE "userId"=${"sponsor"}`;
  await admin.$executeRaw`INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost",status,"expiresAt","leaseUntil",fence) VALUES (${id},${"ws"},${"site"},${"sponsor"},${"sponsorsession"},0,${"GENERATION"},${"AZURE"},to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),${"api"},${id},${"hash"},${"v1"},1,${"RUNNING"},(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour',(clock_timestamp() AT TIME ZONE 'UTC')-interval '2 minutes',2)`;
}
async function untilWaiting(count: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await admin.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='lyraseo_staff_executor' AND wait_event_type='Lock'`;
    if (Number(row?.n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw Error("LOCK_TEST_TIMEOUT");
}
it("handles denied prepare, stale and terminal targets, lost responses and in-flight resolution through the real route and database", async () => {
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    const response = await command({ kind: "allocate" });
    expect(response.status).toBe(200);
    ids[key] = (await response.json()).requestId;
  }
  await admin.$executeRaw`UPDATE lyraseo_billing.staff_capability SET enabled=false WHERE user_id=${"staff"} AND action=${"jobs:manage"}`;
  expect(
    (await command({ kind: "prepare", ...payload("denied", ids.denied) }))
      .status,
  ).toBe(403);
  expect(
    (await command({ kind: "resolve", requestId: ids.denied })).status,
  ).toBe(403);
  await admin.$executeRaw`UPDATE lyraseo_billing.staff_capability SET enabled=true WHERE user_id=${"staff"} AND action=${"jobs:manage"}`;
  expect(
    await (await command({ kind: "resolve", requestId: ids.denied })).json(),
  ).toEqual({ state: "CLOSED" });
  expect(
    (await command({ kind: "prepare", ...payload("denied", ids.denied) }))
      .status,
  ).toBe(403);
  for (const mode of ["conflict", "terminal"] as const) {
    const target = `api-${mode}`;
    await addJob(target);
    const prepared = await command({
      kind: "prepare",
      ...payload(target, ids[mode]),
    });
    if (prepared.status !== 200)
      await prepareStaffJobRequest(
        staff,
        actor,
        "jobs:retry",
        target,
        2,
        "Review fixture reason",
        ids[mode],
      );
    expect(prepared.status).toBe(200);
    if (mode === "conflict")
      await admin.$executeRaw`UPDATE "Operation" SET fence=3 WHERE id=${target}`;
    else
      await admin.$executeRaw`UPDATE "Operation" SET status='COMPLETED' WHERE id=${target}`;
    expect(
      (await command({ kind: "execute", ...payload(target, ids[mode]) }))
        .status,
    ).toBe(403);
    expect(
      await (await command({ kind: "resolve", requestId: ids[mode] })).json(),
    ).toEqual({ state: "CLOSED" });
    expect(
      (await command({ kind: "execute", ...payload(target, ids[mode]) }))
        .status,
    ).toBe(403);
  }
  await addJob("api-lost");
  expect(
    (await command({ kind: "prepare", ...payload("api-lost", ids.lost) }))
      .status,
  ).toBe(200);
  expect(
    (await command({ kind: "execute", ...payload("api-lost", ids.lost) }))
      .status,
  ).toBe(200);
  const recovered = await (
    await command({ kind: "resolve", requestId: ids.lost })
  ).json();
  expect(recovered.state).toBe("COMPLETE");
  expect(recovered.result.status).toBe("QUEUED");
  await addJob("api-overlap");
  expect(
    (await command({ kind: "prepare", ...payload("api-overlap", ids.overlap) }))
      .status,
  ).toBe(200);
  let unlock!: () => void, locked!: () => void;
  const lockedPromise = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const unlockPromise = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const gate = admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Operation" WHERE id=${"api-overlap"} FOR UPDATE`;
      locked();
      await unlockPromise;
    },
    { timeout: 15000 },
  );
  await lockedPromise;
  try {
    const executing = command({
      kind: "execute",
      ...payload("api-overlap", ids.overlap),
    });
    await untilWaiting(1);
    const resolving = command({ kind: "resolve", requestId: ids.overlap });
    await untilWaiting(2);
    unlock();
    await gate;
    expect((await executing).status).toBe(200);
    const result = await (await resolving).json();
    expect(result.state).toBe("COMPLETE");
    expect(result.result.status).toBe("QUEUED");
  } finally {
    unlock();
    await gate.catch(() => {});
  }
});
