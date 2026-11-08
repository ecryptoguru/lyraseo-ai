import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import {
  createVisibilityPanel,
  reviewVisibilityPanel,
  recordVisibilityEvidence,
  readVisibility,
} from "../../packages/db/src/visibility";

const name = process.env.LYRA_TEST_DB_NAME ?? "";
if (!/^lyraseo_legacy_[a-f0-9]{12}$/.test(name))
  throw Error("LEGACY_VISIBILITY_OWNED_DATABASE_REQUIRED");
const admin = createDatabase(adminUrl),
  runtime = createDatabase(runtimeUrl);
const maintenance = createDatabase(
  `postgresql://lyraseo_artifact_maintenance:local_expiry_only@127.0.0.1:54329/${name}?options=-c%20statement_timeout%3D30000`,
);
const s = { workspaceId: "a", siteId: "a-site" };
beforeEach(async () => {
  await admin.$executeRawUnsafe(
    "TRUNCATE lyraseo_legacy_visibility.fixture_clock, lyraseo_legacy_visibility.retry, lyraseo_legacy_visibility.authorization, lyraseo_legacy_visibility.event, lyraseo_legacy_visibility.item, lyraseo_legacy_visibility.plan, lyraseo_legacy_visibility.enrollment, lyraseo_legacy_visibility.scope",
  );
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await admin.$executeRawUnsafe(
    "TRUNCATE lyraseo_legacy_visibility.fixture_clock, lyraseo_legacy_visibility.retry, lyraseo_legacy_visibility.authorization, lyraseo_legacy_visibility.event, lyraseo_legacy_visibility.item, lyraseo_legacy_visibility.plan, lyraseo_legacy_visibility.enrollment, lyraseo_legacy_visibility.scope",
  );
  await admin.$disconnect();
  await runtime.$disconnect();
  await maintenance.$disconnect();
});

it("transitions a due enrolled producer row once while preserving every other stored value", async () => {
  const panel = await createVisibilityPanel(
    runtime,
    actor,
    s,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  await reviewVisibilityPanel(runtime, actor, s, panel.id);
  const observedAt = new Date(Date.now() - 5000).toISOString();
  const run = await recordVisibilityEvidence(runtime, actor, s, panel.id, {
    profile: "consumer-chatgpt",
    provider: "dataforseo",
    model: "test",
    modelVersion: "test",
    retrievalMode: "standard",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: "en", market: "IN" },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    rawRightsUntil: new Date(Date.now() - 1000).toISOString(),
    slots: [
      {
        promptId: "p",
        state: "successful",
        body: "synthetic legacy answer",
        annotations: [],
        providerTaskId: "task",
        completedAt: observedAt,
      },
    ],
  });
  const [before] = await admin.$queryRaw<
    { protected: unknown; raw: unknown }[]
  >`SELECT to_jsonb(v)-'rawAnswers' AS protected, "rawAnswers" AS raw FROM "VisibilityRun" v WHERE id=${run.id}`;
  await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_scope(${s.workspaceId}, ${s.siteId})`;
  await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_row(${s.workspaceId}, ${s.siteId}, ${run.id})::text`;
  const [planned] = await maintenance.$queryRaw<
    { plan: { id: string; hash: string } }[]
  >`SELECT lyraseo_legacy_visibility.create_plan(${s.workspaceId}, ${s.siteId}, ARRAY[${run.id}]::text[]) AS plan`;
  const [outcome] = await maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId}, ${s.siteId}, ${planned!.plan.id}::uuid, ${planned!.plan.hash}, ${run.id}) AS result`;
  expect(outcome?.result.state).toBe("erased");
  const [after] = await admin.$queryRaw<
    { protected: unknown; raw: unknown }[]
  >`SELECT to_jsonb(v)-'rawAnswers' AS protected, "rawAnswers" AS raw FROM "VisibilityRun" v WHERE id=${run.id}`;
  expect(after?.raw).toBeNull();
  expect(after?.protected).toEqual(before?.protected);
  const detail = await readVisibility(runtime, actor, s, run.id);
  expect(detail.runs[0]?.rawState).toBe("raw-erased");
  expect(detail.runs[0]?.rawAnswers).toBeNull();
  const [repeat] = await maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId}, ${s.siteId}, ${planned!.plan.id}::uuid, ${planned!.plan.hash}, ${run.id}) AS result`;
  expect(repeat?.result.state).toBe("erased");
  const [count] = await admin.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) AS n FROM lyraseo_legacy_visibility.event WHERE run_id=${run.id}`;
  expect(count?.n).toBe(1n);
});

async function seedRun() {
  const p = await createVisibilityPanel(
    runtime,
    actor,
    s,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  await reviewVisibilityPanel(runtime, actor, s, p.id);
  const observedAt = new Date(Date.now() - 5000).toISOString();
  const evidence = {
    profile: "consumer-chatgpt" as const,
    provider: "dataforseo",
    model: "test",
    modelVersion: "test",
    retrievalMode: "standard",
    requestedLocale: { language: "en" as const, market: "IN" as const },
    confirmedLocale: { language: "en", market: "IN" },
    synthetic: true,
    rawAnswerRights: true,
    observedAt,
    rawRightsUntil: new Date(Date.now() - 1000).toISOString(),
    slots: [
      {
        promptId: "p",
        state: "successful" as const,
        body: "synthetic legacy answer",
        annotations: [],
        providerTaskId: "task",
        completedAt: observedAt,
      },
    ],
  };
  return {
    p,
    evidence,
    run: await recordVisibilityEvidence(runtime, actor, s, p.id, evidence),
  };
}
async function enroll(runId: string) {
  await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_scope(${s.workspaceId}, ${s.siteId})`;
  await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_row(${s.workspaceId}, ${s.siteId}, ${runId})::text`;
  const [v] = await maintenance.$queryRaw<
    { plan: { id: string; hash: string } }[]
  >`SELECT lyraseo_legacy_visibility.create_plan(${s.workspaceId}, ${s.siteId}, ARRAY[${runId}]::text[]) AS plan`;
  return v!.plan;
}
it("fences ordinary legacy inserts and cascading deletion while leaving another site usable", async () => {
  const { p, evidence, run } = await seedRun();
  await enroll(run.id);
  await expect(
    recordVisibilityEvidence(runtime, actor, s, p.id, evidence),
  ).rejects.toThrow("LEGACY_SCOPE_FENCED");
  await expect(
    runtime.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id', ${s.workspaceId}, true)`;
      await tx.$executeRaw`DELETE FROM "Site" WHERE "workspaceId"=${s.workspaceId} AND id=${s.siteId}`;
    }),
  ).rejects.toThrow("LEGACY_SCOPE_FENCED");
  const other = { workspaceId: "b", siteId: "b-site" };
  const otherPanel = await createVisibilityPanel(
    runtime,
    actor,
    other,
    [{ id: "q", text: "Other?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: [] }],
  );
  await reviewVisibilityPanel(runtime, actor, other, otherPanel.id);
  await expect(
    recordVisibilityEvidence(runtime, actor, other, otherPanel.id, {
      ...evidence,
      slots: [{ ...evidence.slots[0]!, promptId: "q" }],
    }),
  ).resolves.toBeTruthy();
});
it("rejects wrong scope and pause before any source mutation", async () => {
  const { run } = await seedRun();
  const plan = await enroll(run.id);
  await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_scope('b','b-site')`;
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.pause('b','b-site',${plan.id}::uuid,${plan.hash})`,
  ).rejects.toThrow("LEGACY_PLAN_INVALID");
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.execute_one('b','b-site',${plan.id}::uuid,${plan.hash},${run.id})`,
  ).rejects.toThrow("LEGACY_PLAN_INVALID");
  await maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.pause(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash})`;
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id})`,
  ).rejects.toThrow("LEGACY_PLAN_PAUSED");
  expect(
    (await admin.visibilityRun.findUniqueOrThrow({ where: { id: run.id } }))
      .rawAnswers,
  ).not.toBeNull();
  const [count] = await admin.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) n FROM lyraseo_legacy_visibility.event`;
  expect(count?.n).toBe(0n);
});
it("blocks a JSON null rather than treating it as an erased answer", async () => {
  const { run } = await seedRun();
  await admin.$executeRaw`UPDATE "VisibilityRun" SET "rawAnswers"='null'::jsonb WHERE id=${run.id}`;
  const plan = await enroll(run.id);
  const [v] = await maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id}) AS result`;
  expect(v?.result.state).toBe("blocked-raw-shape");
  const [row] = await admin.$queryRaw<
    { kind: string }[]
  >`SELECT jsonb_typeof("rawAnswers") AS kind FROM "VisibilityRun" WHERE id=${run.id}`;
  expect(row?.kind).toBe("null");
});
it("preview is read-only and plan progress remains scoped and bounded", async () => {
  const { run } = await seedRun();
  const plan = await enroll(run.id);
  const [before] = await admin.$queryRaw<
    { v: unknown }[]
  >`SELECT to_jsonb(v) v FROM "VisibilityRun" v WHERE id=${run.id}`;
  const [page] = await maintenance.$queryRaw<
    { result: { items: { runId: string; state: string }[] } }[]
  >`SELECT lyraseo_legacy_visibility.preview(${s.workspaceId},${s.siteId},10,NULL) result`;
  expect(page?.result.items).toEqual([
    expect.objectContaining({ runId: run.id, state: "eligible" }),
  ]);
  const [next] = await maintenance.$queryRaw<
    { result: { items: string[] } }[]
  >`SELECT lyraseo_legacy_visibility.next_items(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},10,NULL) result`;
  expect(next?.result.items).toEqual([run.id]);
  const [state] = await maintenance.$queryRaw<
    { result: { total: number; completed: number } }[]
  >`SELECT lyraseo_legacy_visibility.status(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash}) result`;
  expect(state?.result).toMatchObject({ total: 1, completed: 0 });
  const [after] = await admin.$queryRaw<
    { v: unknown }[]
  >`SELECT to_jsonb(v) v FROM "VisibilityRun" v WHERE id=${run.id}`;
  expect(after?.v).toEqual(before?.v);
});
it("an independently seeded consistent current row needs no historic signature or rights-limit field", async () => {
  const { run } = await seedRun();
  const copy = `${run.id}-legacy`;
  await admin.$executeRaw`INSERT INTO "VisibilityRun"(id,"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt","storageFormat") SELECT ${copy},"workspaceId","siteId","panelId",profile,cohort,provenance-'rawRightsUntil',slots,"rawAnswers","rawExpiresAt","createdAt",NULL FROM "VisibilityRun" WHERE id=${run.id}`;
  const plan = await enroll(copy);
  const [v] = await maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${copy}) result`;
  expect(v?.result.state).toBe("erased");
});
it("blocks inconsistent clock and forged maintenance writes without changing source or receipts", async () => {
  const { run } = await seedRun();
  await admin.$executeRaw`UPDATE "VisibilityRun" SET provenance=jsonb_set(provenance,'{observedAt}','"2024-02-30T00:00:00Z"'::jsonb) WHERE id=${run.id}`;
  const plan = await enroll(run.id);
  const [v] = await maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id}) result`;
  expect(v?.result.state).toBe("blocked-clock");
  await expect(
    maintenance.$executeRaw`UPDATE "VisibilityRun" SET "rawAnswers"=NULL WHERE id=${run.id}`,
  ).rejects.toThrow();
  await expect(
    maintenance.$executeRaw`INSERT INTO lyraseo_legacy_visibility.authorization(transaction_id,run_id,plan_id,old_hash) VALUES(txid_current(),${run.id},${plan.id}::uuid,'fake')`,
  ).rejects.toThrow();
  expect(
    (await admin.visibilityRun.findUniqueOrThrow({ where: { id: run.id } }))
      .rawAnswers,
  ).not.toBeNull();
  const [count] = await admin.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) n FROM lyraseo_legacy_visibility.event`;
  expect(count?.n).toBe(0n);
});
it("busy row backoff survives replan and expires against server time", async () => {
  const { run } = await seedRun();
  const first = await enroll(run.id);
  let release!: () => void, entered!: () => void;
  const lockReady = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "VisibilityRun" WHERE id=${run.id} FOR UPDATE`;
      entered();
      await unlock;
    },
    { timeout: 10000 },
  );
  await lockReady;
  try {
    const [busy] = await maintenance.$queryRaw<
      { result: { state: string } }[]
    >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${first.id}::uuid,${first.hash},${run.id}) result`;
    expect(busy?.result.state).toBe("busy");
  } finally {
    release();
    await holder;
  }
  const [fresh] = await maintenance.$queryRaw<
    { plan: { id: string; hash: string } }[]
  >`SELECT lyraseo_legacy_visibility.create_plan(${s.workspaceId},${s.siteId},ARRAY[${run.id}]::text[]) plan`;
  const [backoff] = await maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${fresh!.plan.id}::uuid,${fresh!.plan.hash},${run.id}) result`;
  expect(backoff?.result.state).toBe("backoff");
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const [done] = await maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${fresh!.plan.id}::uuid,${fresh!.plan.hash},${run.id}) result`;
  expect(done?.result.state).toBe("erased");
}, 15000);
it("maintenance cannot become owner or use caller settings to forge a scope or receipt", async () => {
  const { run } = await seedRun();
  await enroll(run.id);
  await expect(
    maintenance.$executeRawUnsafe("SET ROLE lyraseo_legacy_visibility_owner"),
  ).rejects.toThrow();
  await expect(
    maintenance.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id','a',true),set_config('app.actor_id','owner',true),set_config('legacy.authorized','true',true)`;
      return tx.$executeRaw`UPDATE "VisibilityRun" SET "rawAnswers"=NULL WHERE id=${run.id}`;
    }),
  ).rejects.toThrow();
  await expect(
    maintenance.$queryRaw`SELECT * FROM lyraseo_legacy_visibility.event`,
  ).rejects.toThrow();
});
it("pause waits for an admitted atomic transition and prevents later mutation", async () => {
  const { run } = await seedRun();
  const plan = await enroll(run.id);
  let release!: () => void, entered!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = maintenance.$transaction(
    async (tx) => {
      const [v] = await tx.$queryRaw<
        { result: { state: string } }[]
      >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id}) result`;
      expect(v?.result.state).toBe("erased");
      entered();
      await unlock;
    },
    { timeout: 10000 },
  );
  await admitted;
  let paused = false;
  const pausing =
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.pause(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash})`.then(
      () => {
        paused = true;
      },
    );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(paused).toBe(false);
  release();
  await worker;
  await pausing;
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id})`,
  ).rejects.toThrow("LEGACY_PLAN_PAUSED");
  const [events] = await admin.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) n FROM lyraseo_legacy_visibility.event WHERE run_id=${run.id}`;
  expect(events?.n).toBe(1n);
}, 15000);
it("rolls back the source and authorization when the receipt insert fails", async () => {
  const { run } = await seedRun();
  const plan = await enroll(run.id);
  const [before] = await admin.$queryRaw<
    { v: unknown }[]
  >`SELECT to_jsonb(v) v FROM "VisibilityRun" v WHERE id=${run.id}`;
  await admin.$executeRawUnsafe(
    `CREATE FUNCTION public.legacy_test_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_EVENT_FAILURE'; END $$`,
  );
  await admin.$executeRawUnsafe(
    `CREATE TRIGGER legacy_test_reject_event BEFORE INSERT ON lyraseo_legacy_visibility.event FOR EACH ROW EXECUTE FUNCTION public.legacy_test_reject_event()`,
  );
  try {
    await expect(
      maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id})`,
    ).rejects.toThrow("TEST_EVENT_FAILURE");
    const [after] = await admin.$queryRaw<
      { v: unknown }[]
    >`SELECT to_jsonb(v) v FROM "VisibilityRun" v WHERE id=${run.id}`;
    expect(after?.v).toEqual(before?.v);
    const [state] = await admin.$queryRaw<
      { events: bigint; auth: bigint }[]
    >`SELECT (SELECT count(*) FROM lyraseo_legacy_visibility.event) events,(SELECT count(*) FROM lyraseo_legacy_visibility.authorization) auth`;
    expect(state).toEqual({ events: 0n, auth: 0n });
  } finally {
    await admin.$executeRawUnsafe(
      "DROP TRIGGER legacy_test_reject_event ON lyraseo_legacy_visibility.event",
    );
    await admin.$executeRawUnsafe(
      "DROP FUNCTION public.legacy_test_reject_event()",
    );
  }
});
it("fence waits for an admitted direct insert and rejects its later retry", async () => {
  const { run } = await seedRun();
  const original = await admin.visibilityRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  let release!: () => void, entered!: () => void;
  const inserted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = runtime.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id',${s.workspaceId},true)`;
      await tx.$executeRaw`INSERT INTO "VisibilityRun"(id,"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt") VALUES('inflight',${s.workspaceId},${s.siteId},${original.panelId},${original.profile},${original.cohort},${JSON.stringify(original.provenance)}::jsonb,${JSON.stringify(original.slots)}::jsonb,${JSON.stringify(original.rawAnswers)}::jsonb,${original.rawExpiresAt},${original.createdAt})`;
      entered();
      await unlock;
    },
    { timeout: 10000 },
  );
  await inserted;
  let fenced = false;
  const activation =
    admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_scope(${s.workspaceId},${s.siteId})`.then(
      () => {
        fenced = true;
      },
    );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(fenced).toBe(false);
  release();
  await writer;
  await activation;
  await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_row(${s.workspaceId},${s.siteId},'inflight')::text`;
  const [page] = await maintenance.$queryRaw<
    { result: { items: { runId: string }[] } }[]
  >`SELECT lyraseo_legacy_visibility.preview(${s.workspaceId},${s.siteId},10,NULL) result`;
  expect(page?.result.items.map((x) => x.runId)).toContain("inflight");
  await expect(
    runtime.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id',${s.workspaceId},true)`;
      await tx.$executeRaw`INSERT INTO "VisibilityRun"(id,"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt") VALUES('late',${s.workspaceId},${s.siteId},${original.panelId},${original.profile},${original.cohort},${JSON.stringify(original.provenance)}::jsonb,${JSON.stringify(original.slots)}::jsonb,${JSON.stringify(original.rawAnswers)}::jsonb,${original.rawExpiresAt},${original.createdAt})`;
    }),
  ).rejects.toThrow("LEGACY_SCOPE_FENCED");
}, 15000);
it("a retained read linearizes before an expiry transition waiting on its lock", async () => {
  const { run } = await seedRun();
  const deadline = new Date(Date.now() + 1800);
  await admin.$executeRaw`UPDATE "VisibilityRun" SET "rawExpiresAt"=${deadline}, provenance=jsonb_set(provenance,'{rawRightsUntil}',to_jsonb(${deadline.toISOString()}::text)) WHERE id=${run.id}`;
  const plan = await enroll(run.id);
  let release!: () => void, entered!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = runtime.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id',${s.workspaceId},true),set_config('app.actor_id',${actor.userId},true)`;
      const [v] = await tx.$queryRaw<
        { detail: { state: string; rawAnswers: unknown } }[]
      >`SELECT lyraseo_legacy_visibility.read_detail(${s.siteId},${run.id},${actor.securityVersion},${actor.sessionId}) detail`;
      expect(v?.detail.state).toBe("retained");
      expect(v?.detail.rawAnswers).not.toBeNull();
      entered();
      await unlock;
    },
    { timeout: 10000 },
  );
  await admitted;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let completed = false;
  const transition = maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id}) result`.then(
    (v) => {
      completed = true;
      return v;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(completed).toBe(false);
  release();
  await reader;
  const [outcome] = await transition;
  expect(outcome?.result.state).toBe("erased");
  const after = await readVisibility(runtime, actor, s, run.id);
  expect(after.runs[0]?.rawState).toBe("raw-erased");
  expect(after.runs[0]?.rawAnswers).toBeNull();
}, 15000);
it("bounds manifests and pages a backlog larger than one batch without hiding residuals", async () => {
  const { run } = await seedRun();
  await admin.$executeRaw`INSERT INTO "VisibilityRun"(id,"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt") SELECT 'copy-'||lpad(i::text,3,'0'),"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt" FROM "VisibilityRun" CROSS JOIN generate_series(1,101) i WHERE id=${run.id}`;
  const ids = Array.from(
    { length: 101 },
    (_, i) => `copy-${String(i + 1).padStart(3, "0")}`,
  );
  await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_scope(${s.workspaceId},${s.siteId})`;
  for (const id of ids)
    await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_row(${s.workspaceId},${s.siteId},${id})::text`;
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.create_plan(${s.workspaceId},${s.siteId},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)))`,
  ).rejects.toThrow("LEGACY_MANIFEST_INVALID");
  const [plan] = await maintenance.$queryRaw<
    { plan: { id: string; hash: string } }[]
  >`SELECT lyraseo_legacy_visibility.create_plan(${s.workspaceId},${s.siteId},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids.slice(0, 100))}::jsonb))) plan`;
  const snapshot = async () => {
    const [row] = await admin.$queryRaw<
      { state: unknown }[]
    >`SELECT jsonb_build_object(
      'runs',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM "VisibilityRun" v WHERE v."workspaceId"=${s.workspaceId} AND v."siteId"=${s.siteId}),
      'scopes',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM lyraseo_legacy_visibility.scope v),
      'enrollments',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.scope_id,v.run_id) FROM lyraseo_legacy_visibility.enrollment v),
      'plans',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM lyraseo_legacy_visibility.plan v),
      'items',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.plan_id,v.run_id) FROM lyraseo_legacy_visibility.item v),
      'retries',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.scope_id,v.run_id) FROM lyraseo_legacy_visibility.retry v),
      'authorizations',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.transaction_id,v.run_id) FROM lyraseo_legacy_visibility.authorization v),
      'events',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM lyraseo_legacy_visibility.event v),
      'clocks',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.scope_id) FROM lyraseo_legacy_visibility.fixture_clock v)
    ) AS state`;
    return row?.state;
  };
  const beforeNullLimits = await snapshot();
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.preview(${s.workspaceId},${s.siteId},NULL::integer,NULL)`,
  ).rejects.toThrow("LEGACY_LIMIT_INVALID");
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.next_items(${s.workspaceId},${s.siteId},${plan!.plan.id}::uuid,${plan!.plan.hash},NULL::integer,NULL)`,
  ).rejects.toThrow("LEGACY_LIMIT_INVALID");
  expect(await snapshot()).toEqual(beforeNullLimits);
  const [first] = await maintenance.$queryRaw<
    { result: { items: string[]; nextCursor: string } }[]
  >`SELECT lyraseo_legacy_visibility.next_items(${s.workspaceId},${s.siteId},${plan!.plan.id}::uuid,${plan!.plan.hash},50,NULL) result`;
  const [second] = await maintenance.$queryRaw<
    { result: { items: string[] } }[]
  >`SELECT lyraseo_legacy_visibility.next_items(${s.workspaceId},${s.siteId},${plan!.plan.id}::uuid,${plan!.plan.hash},50,${first!.result.nextCursor}) result`;
  expect(first?.result.items).toEqual(ids.slice(0, 50));
  expect(second?.result.items).toEqual(ids.slice(50, 100));
  const [preview] = await maintenance.$queryRaw<
    { result: { items: unknown[]; nextCursor: string } }[]
  >`SELECT lyraseo_legacy_visibility.preview(${s.workspaceId},${s.siteId},100,NULL) result`;
  const [remainder] = await maintenance.$queryRaw<
    { result: { items: { runId: string; state: string }[] } }[]
  >`SELECT lyraseo_legacy_visibility.preview(${s.workspaceId},${s.siteId},100,${preview!.result.nextCursor}) result`;
  expect(preview?.result.items).toHaveLength(100);
  expect(remainder?.result.items.length).toBeGreaterThanOrEqual(2);
  expect(remainder?.result.items.some((x) => x.runId === ids[100])).toBe(true);
}, 30000);
it.each([
  { offset: -1, expected: "not-due" },
  { offset: 0, expected: "erased" },
  { offset: 1, expected: "erased" },
])(
  "uses the unchanged stored deadline at fixture offset $offset ms",
  async ({ offset, expected }) => {
    const { run } = await seedRun();
    const original = await admin.visibilityRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    const plan = await enroll(run.id);
    const fixtureTime = new Date(original.rawExpiresAt.getTime() + offset);
    await admin.$executeRaw`INSERT INTO lyraseo_legacy_visibility.fixture_clock(scope_id,database_oid,postmaster_started_at,eligibility_at,provenance) SELECT id,database_oid,postmaster_started_at,${fixtureTime},'ADMIN_LOCAL_FIXTURE_V1' FROM lyraseo_legacy_visibility.scope WHERE workspace_id=${s.workspaceId} AND site_id=${s.siteId}`;
    await expect(
      maintenance.$executeRaw`INSERT INTO lyraseo_legacy_visibility.fixture_clock(scope_id,database_oid,postmaster_started_at,eligibility_at,provenance) SELECT id,database_oid,postmaster_started_at,${fixtureTime},'ADMIN_LOCAL_FIXTURE_V1' FROM lyraseo_legacy_visibility.scope`,
    ).rejects.toThrow();
    const [result] = await maintenance.$queryRaw<
      { result: { state: string } }[]
    >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id}) result`;
    expect(result?.result.state).toBe(expected);
    const after = await admin.visibilityRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(after.rawExpiresAt).toEqual(original.rawExpiresAt);
    if (expected === "erased") {
      const [event] = await admin.$queryRaw<
        { kind: string; eligibility: Date }[]
      >`SELECT eligibility_clock kind,eligibility_at eligibility FROM lyraseo_legacy_visibility.event WHERE run_id=${run.id}`;
      expect(event?.kind).toBe("ADMIN_LOCAL_FIXTURE_V1");
      expect(event?.eligibility).toEqual(fixtureTime);
    } else expect(after.rawAnswers).not.toBeNull();
  },
);
it("reports an oversized row as blocked without creating an enrollment or receipt", async () => {
  const { run } = await seedRun();
  await admin.$executeRaw`UPDATE "VisibilityRun" SET "rawAnswers"=jsonb_build_array(jsonb_build_object('body',repeat('x',1100000))) WHERE id=${run.id}`;
  await admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_scope(${s.workspaceId},${s.siteId})`;
  await expect(
    admin.$queryRaw`SELECT lyraseo_legacy_visibility.enroll_row(${s.workspaceId},${s.siteId},${run.id})::text`,
  ).rejects.toThrow("LEGACY_ROW_OVERSIZE");
  const [preview] = await maintenance.$queryRaw<
    { result: { items: { state: string; rowHash: string | null }[] } }[]
  >`SELECT lyraseo_legacy_visibility.preview(${s.workspaceId},${s.siteId},10,NULL) result`;
  expect(preview?.result.items[0]).toMatchObject({
    state: "blocked-size",
    rowHash: null,
  });
  const [counts] = await admin.$queryRaw<
    { enrollments: bigint; events: bigint }[]
  >`SELECT (SELECT count(*) FROM lyraseo_legacy_visibility.enrollment) enrollments,(SELECT count(*) FROM lyraseo_legacy_visibility.event) events`;
  expect(counts).toEqual({ enrollments: 0n, events: 0n });
});
it("requires a prior bounded maintenance timeout and PostgreSQL cancels long statements", async () => {
  const { run } = await seedRun();
  await enroll(run.id);
  const unbounded = createDatabase(
    `postgresql://lyraseo_artifact_maintenance:local_expiry_only@127.0.0.1:54329/${name}`,
  );
  try {
    await expect(
      unbounded.$queryRaw`SELECT lyraseo_legacy_visibility.preview(${s.workspaceId},${s.siteId},10,NULL)`,
    ).rejects.toThrow("LEGACY_TIMEOUT_REQUIRED");
  } finally {
    await unbounded.$disconnect();
  }
  await expect(
    maintenance.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '100ms'");
      await tx.$queryRaw`SELECT pg_sleep(2)`;
    }),
  ).rejects.toThrow(/statement timeout/i);
});
it("preserves a copied task string as an explicit undisclosed residual after field clearing", async () => {
  const { p, evidence } = await seedRun();
  const marker = "legacy-other-field-copy-marker";
  const run = await recordVisibilityEvidence(runtime, actor, s, p.id, {
    ...evidence,
    slots: [{ ...evidence.slots[0]!, providerTaskId: marker }],
  });
  const plan = await enroll(run.id);
  const [result] = await maintenance.$queryRaw<
    { result: { state: string } }[]
  >`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id}) result`;
  expect(result?.result.state).toBe("erased");
  const stored = await admin.visibilityRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  expect(stored.rawAnswers).toBeNull();
  expect(JSON.stringify(stored.slots)).toContain(marker);
  const shown = await readVisibility(runtime, actor, s, run.id);
  expect(JSON.stringify(shown)).not.toContain(marker);
  expect(JSON.stringify(shown)).toContain("unclassified");
});
it("a locked site does not stall a legacy writer in another site of the same workspace", async () => {
  const { evidence } = await seedRun();
  const other = { workspaceId: s.workspaceId, siteId: "a-other" };
  await admin.site.create({
    data: {
      id: other.siteId,
      workspaceId: other.workspaceId,
      origin: "https://other-site.invalid",
      verifiedAt: new Date(),
    },
  });
  const panel = await createVisibilityPanel(
    runtime,
    actor,
    other,
    [{ id: "p", text: "Which tools?", label: "neutral" }],
    [{ id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] }],
  );
  await reviewVisibilityPanel(runtime, actor, other, panel.id);
  let release!: () => void, entered!: () => void;
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unlock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${s.workspaceId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${s.workspaceId} AND id=${s.siteId} FOR UPDATE`;
      entered();
      await unlock;
    },
    { timeout: 10000 },
  );
  await locked;
  const writer = recordVisibilityEvidence(
    runtime,
    actor,
    other,
    panel.id,
    evidence,
  );
  const progressed = await Promise.race([
    writer.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
  ]);
  release();
  await holder;
  await writer;
  expect(progressed).toBe(true);
}, 15000);
it("rejects a stale postmaster binding before any plan or source mutation", async () => {
  const { run } = await seedRun();
  const plan = await enroll(run.id);
  const [before] = await admin.$queryRaw<
    { v: unknown }[]
  >`SELECT to_jsonb(v) v FROM "VisibilityRun" v WHERE id=${run.id}`;
  await admin.$executeRaw`UPDATE lyraseo_legacy_visibility.scope SET postmaster_started_at=postmaster_started_at-interval '1 second' WHERE workspace_id=${s.workspaceId} AND site_id=${s.siteId}`;
  await expect(
    maintenance.$queryRaw`SELECT lyraseo_legacy_visibility.execute_one(${s.workspaceId},${s.siteId},${plan.id}::uuid,${plan.hash},${run.id})`,
  ).rejects.toThrow("LEGACY_SCOPE_INVALID");
  const [after] = await admin.$queryRaw<
    { v: unknown }[]
  >`SELECT to_jsonb(v) v FROM "VisibilityRun" v WHERE id=${run.id}`;
  expect(after?.v).toEqual(before?.v);
  const [counts] = await admin.$queryRaw<
    { events: bigint; auth: bigint }[]
  >`SELECT (SELECT count(*) FROM lyraseo_legacy_visibility.event) events,(SELECT count(*) FROM lyraseo_legacy_visibility.authorization) auth`;
  expect(counts).toEqual({ events: 0n, auth: 0n });
});
