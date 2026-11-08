import { afterAll, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { randomUUID } from "node:crypto";
import { localHistoryRetention } from "../../packages/db/src/history-retention";
const name = process.env.LYRA_RECOVERY_DB;
if (!/^lyraseo_recovery_[a-f0-9]{12}$/.test(name ?? ""))
  throw Error("OWNED_RECOVERY_DATABASE_REQUIRED");
const admin = createDatabase(
  `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
);
const maintenance = createDatabase(
  `postgresql://lyraseo_artifact_maintenance:local_expiry_only@127.0.0.1:54329/${name}`,
);
const runtime = createDatabase(
  `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${name}`,
);
afterAll(async () => {
  await Promise.all([
    admin.$disconnect(),
    maintenance.$disconnect(),
    runtime.$disconnect(),
  ]);
});
async function searchFixture() {
  const nonce = randomUUID().replaceAll("-", "");
  const scope = { workspaceId: "w" + nonce, siteId: "s" + nonce },
    id = "search" + nonce;
  await admin.$executeRaw`INSERT INTO "Workspace"(id,name) VALUES(${scope.workspaceId},'Scoped history')`;
  await admin.$executeRaw`INSERT INTO "Site"(id,"workspaceId",origin) VALUES(${scope.siteId},${scope.workspaceId},'https://history.example')`;
  await admin.$executeRaw`INSERT INTO lyraseo_history.environment(workspace_id,site_id,database_oid,postmaster_started_at,policy_version,enabled) SELECT ${scope.workspaceId},${scope.siteId},oid,pg_postmaster_start_time(),'HISTORY_EXPIRY_LOCAL_V1',true FROM pg_database WHERE datname=current_database()`;
  await admin.$executeRaw`INSERT INTO "SearchSnapshot"(id,"workspaceId","siteId",property,"startDate","endDate",shape,status,rows,"importedAt") VALUES(${id},${scope.workspaceId},${scope.siteId},'https://history.example','2024-01-01','2024-01-30','page','complete','[]','2024-01-31T12:00:00.123Z')`;
  const api = localHistoryRetention(maintenance, { enabled: true });
  return { scope, id, api };
}
it("preview makes no writes and two connections apply the same manifest only once", async () => {
  const { scope, api } = await searchFixture();
  const countBefore =
    await admin.$queryRaw`SELECT count(*)::integer n FROM lyraseo_history.plan`;
  const preview = await api.preview(scope);
  expect(
    await admin.$queryRaw`SELECT count(*)::integer n FROM lyraseo_history.plan`,
  ).toEqual(countBefore);
  const plan = await api.record(scope, preview.manifest, preview.hash);
  const attempts = await Promise.all([
    api.apply(scope, plan.id, plan.hash),
    api.apply(scope, plan.id, plan.hash),
  ]);
  expect(attempts.map((row) => row.processed).sort()).toEqual([0, 1]);
  expect(
    await admin.$queryRaw`SELECT count(*)::integer n FROM lyraseo_history.receipt WHERE plan_id=${plan.id}::uuid`,
  ).toEqual([{ n: 1 }]);
});
it("backfills the original expiry on populated accepted history and withdraws only an unpinned historical body", async () => {
  const scope = { workspaceId: "pre32-workspace", siteId: "pre32-site" };
  await admin.$executeRaw`INSERT INTO lyraseo_history.environment(workspace_id,site_id,database_oid,postmaster_started_at,policy_version,enabled) SELECT ${scope.workspaceId},${scope.siteId},oid,pg_postmaster_start_time(),'HISTORY_EXPIRY_LOCAL_V1',true FROM pg_database WHERE datname=current_database()`;
  const before = await admin.$queryRaw<
    Array<{ id: string; protected: unknown }>
  >`SELECT id,to_jsonb(r)-'content' protected FROM "ContentRevision" r WHERE "workspaceId"=${scope.workspaceId} ORDER BY id`;
  expect(
    await admin.$queryRaw`SELECT to_char("historyExpiresAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') deadline FROM "ContentRevision" WHERE id='pre32-old'`,
  ).toEqual([{ deadline: "2024-04-30T12:45:56.789Z" }]);
  const api = localHistoryRetention(maintenance, { enabled: true }),
    preview = await api.preview(scope);
  expect(preview.manifest.map((item) => item.id)).toEqual(["pre32-old"]);
  const plan = await api.record(scope, preview.manifest, preview.hash);
  expect(await api.apply(scope, plan.id, plan.hash)).toMatchObject({
    processed: 1,
  });
  expect(
    await admin.$queryRaw`SELECT id,to_jsonb(r)-'content' protected FROM "ContentRevision" r WHERE "workspaceId"=${scope.workspaceId} ORDER BY id`,
  ).toEqual(before);
  expect(
    await admin.$queryRaw`SELECT content->>'body' body FROM "ContentRevision" WHERE "workspaceId"=${scope.workspaceId} ORDER BY id`,
  ).toEqual([
    { body: "HEAD_SYNTHETIC_BODY" },
    { body: null },
    { body: "PIN_SYNTHETIC_BODY" },
  ]);
});
it("pause is a persisted barrier and a foreign-scope pause cannot mutate another plan", async () => {
  const a = await searchFixture(),
    b = await searchFixture();
  const preview = await b.api.preview(b.scope),
    plan = await b.api.record(b.scope, preview.manifest, preview.hash);
  await expect(a.api.pause(a.scope, plan.id)).rejects.toThrow(
    "HISTORY_PLAN_UNAVAILABLE",
  );
  expect(await b.api.apply(b.scope, plan.id, plan.hash)).toMatchObject({
    processed: 1,
  });
  const p = await a.api.preview(a.scope),
    paused = await a.api.record(a.scope, p.manifest, p.hash);
  expect(await a.api.pause(a.scope, paused.id)).toEqual({ paused: true });
  await expect(a.api.apply(a.scope, paused.id, paused.hash)).rejects.toThrow(
    "HISTORY_PLAN_PAUSED_OR_EXPIRED",
  );
});
it("a changed source is retained and receipted instead of being erased under a stale plan", async () => {
  const { scope, id, api } = await searchFixture(),
    preview = await api.preview(scope),
    plan = await api.record(scope, preview.manifest, preview.hash);
  await admin.$executeRaw`UPDATE "SearchSnapshot" SET rows='[{"marker":"changed"}]' WHERE id=${id}`;
  expect(await api.apply(scope, plan.id, plan.hash)).toMatchObject({
    processed: 1,
  });
  expect(
    await admin.$queryRaw`SELECT outcome FROM lyraseo_history.receipt WHERE plan_id=${plan.id}::uuid`,
  ).toEqual([{ outcome: "CHANGED_OR_RETAINED" }]);
  expect(
    await admin.$queryRaw`SELECT id FROM "SearchSnapshot" WHERE id=${id}`,
  ).toEqual([{ id }]);
  await expect(
    maintenance.$executeRaw`UPDATE lyraseo_history.plan SET paused=false WHERE id=${plan.id}::uuid`,
  ).rejects.toThrow();
  await expect(
    maintenance.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.workspace_id',${scope.workspaceId},true)`;
      return tx.$queryRaw`DELETE FROM "SearchSnapshot" WHERE id=${id}`;
    }),
  ).rejects.toThrow();
});
it("sweeps only due scoped history while preserving authored heads, pins, active results and another tenant", async () => {
  await admin.$executeRawUnsafe(
    `INSERT INTO "ProductUser"(id) VALUES('history-owner')`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO "Workspace"(id,name) VALUES('history-a','A'),('history-b','B')`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO "Site"(id,"workspaceId",origin) VALUES('history-site-a','history-a','https://a.example'),('history-site-b','history-b','https://b.example')`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO lyraseo_history.environment(workspace_id,site_id,database_oid,postmaster_started_at,policy_version,enabled) SELECT 'history-a','history-site-a',oid,pg_postmaster_start_time(),'HISTORY_EXPIRY_LOCAL_V1',true FROM pg_database WHERE datname=current_database()`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO "ContentDraft"(id,"workspaceId","siteId",kind,revision,snapshot) VALUES('history-draft','history-a','history-site-a','draft',3,'{}'),('other-draft','history-b','history-site-b','draft',2,'{}')`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO "ContentRevision"(id,"workspaceId","draftId",revision,content,"userId","createdAt") VALUES('old','history-a','history-draft',1,'{"body":"old"}','history-owner',now()-interval '100 days'),('pinned','history-a','history-draft',2,'{"body":"pinned"}','history-owner',now()-interval '100 days'),('head','history-a','history-draft',3,'{"body":"head"}','history-owner',now()-interval '100 days'),('other-old','history-b','other-draft',1,'{"body":"other"}','history-owner',now()-interval '100 days')`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO "ContentRevisionPin"("workspaceId","draftId",revision,"pinnedBy") VALUES('history-a','history-draft',2,'history-owner')`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO "SearchSnapshot"(id,"workspaceId","siteId",property,"startDate","endDate",shape,status,rows,"importedAt") VALUES('old-search','history-a','history-site-a','https://a.example','2024-01-01','2024-01-30','page','complete','[]','2024-01-31T12:00:00.123Z'),('new-search','history-a','history-site-a','https://a.example','2026-01-01','2026-01-30','page','complete','[]',now())`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO "PageIdentity"(id,"workspaceId","siteId","originalUrl","normalizedUrl","createdBy") VALUES('history-page','history-a','history-site-a','https://a.example/','https://a.example/','history-owner')`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO "PageJournal"(id,"workspaceId","siteId","pageId",revision,action,note,"userId","idempotencyKey","inputHash","contentDraftId","contentDraftRevision") VALUES('history-journal','history-a','history-site-a','history-page',2,'change','linked old revision','history-owner','history-journal','hash','history-draft',1)`,
  );
  const [preview] = await maintenance.$queryRawUnsafe<
    Array<{ manifest: unknown[]; hash: string }>
  >(
    `WITH p AS MATERIALIZED(SELECT lyraseo_history.candidates('history-a','history-site-a',100) v) SELECT v manifest,encode(sha256(convert_to(v::text,'UTF8')),'hex') hash FROM p`,
  );
  expect(preview?.manifest).toHaveLength(2);
  const [plan] = await maintenance.$queryRawUnsafe<
    Array<{ value: { id: string; hash: string } }>
  >(
    `SELECT lyraseo_history.record_plan($1,$2,$3::jsonb,$4) value`,
    "history-a",
    "history-site-a",
    JSON.stringify(preview!.manifest),
    preview!.hash,
  );
  await expect(
    maintenance.$queryRawUnsafe(
      `SELECT lyraseo_history.apply_plan($1,$2,$3::uuid,$4,100)`,
      "history-b",
      "history-site-b",
      plan!.value.id,
      plan!.value.hash,
    ),
  ).rejects.toThrow("HISTORY_SCOPE_UNAVAILABLE");
  const [first] = await maintenance.$queryRawUnsafe<
    Array<{ value: { processed: number; remaining: number } }>
  >(
    `SELECT lyraseo_history.apply_plan($1,$2,$3::uuid,$4,100) value`,
    "history-a",
    "history-site-a",
    plan!.value.id,
    plan!.value.hash,
  );
  expect(first!.value).toMatchObject({ processed: 2, remaining: 0 });
  const [replay] = await maintenance.$queryRawUnsafe<
    Array<{ value: { processed: number; remaining: number } }>
  >(
    `SELECT lyraseo_history.apply_plan($1,$2,$3::uuid,$4,100) value`,
    "history-a",
    "history-site-a",
    plan!.value.id,
    plan!.value.hash,
  );
  expect(replay!.value).toMatchObject({ processed: 0, remaining: 0 });
  expect(
    (
      await admin.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "ContentRevision" WHERE "workspaceId" IN ('history-a','history-b') ORDER BY id`,
      )
    ).map((row) => row.id),
  ).toEqual(["head", "old", "other-old", "pinned"]);
  expect(
    await admin.$queryRawUnsafe(
      `SELECT content FROM "ContentRevision" WHERE id='old'`,
    ),
  ).toEqual([{ content: null }]);
  expect(
    await admin.$queryRawUnsafe(
      `SELECT "contentDraftId","contentDraftRevision" FROM "PageJournal" WHERE id='history-journal'`,
    ),
  ).toEqual([{ contentDraftId: "history-draft", contentDraftRevision: 1 }]);
  expect(
    (
      await admin.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "SearchSnapshot" WHERE "workspaceId"='history-a' ORDER BY id`,
      )
    ).map((row) => row.id),
  ).toEqual(["new-search"]);
  await expect(
    runtime.$queryRawUnsafe(
      `SELECT lyraseo_history.candidates('history-a','history-site-a',100)`,
    ),
  ).rejects.toThrow();
  await expect(
    maintenance.$executeRawUnsafe(
      `DELETE FROM "ContentRevision" WHERE id='head'`,
    ),
  ).rejects.toThrow();
  await expect(
    maintenance.$executeRawUnsafe(
      `UPDATE lyraseo_history.receipt SET outcome='UNAVAILABLE'`,
    ),
  ).rejects.toThrow();
});
