import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { createAuditRun } from "../../packages/db/src/audits";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";

const db = createDatabase(runtimeUrl);
const admin = createDatabase(adminUrl);
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
const request = {
  workspaceId: "a",
  siteId: "a-site",
  idempotencyKey: "race",
  manifest: ["https://example.com/"],
  profile: "LOCAL_RAW_V1" as const,
};

it("does not create an audit after the user's epoch is revoked while admission waits", async () => {
  let admission!: ReturnType<typeof createAuditRun>;
  await admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id='a' FOR UPDATE`;
      admission = createAuditRun(db, actor, request);
      void admission.catch(() => {});
      await expect
        .poll(
          async () => {
            const [row] = await admin.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database()
          AND usename='lyraseo_runtime' AND wait_event_type='Lock'
          AND query LIKE '%Workspace%') AS waiting`;
            return row.waiting;
          },
          { timeout: 5000, interval: 20 },
        )
        .toBe(true);
      await tx.productUser.update({
        where: { id: actor.userId },
        data: { securityVersion: { increment: 1 } },
      });
    },
    { timeout: 10000 },
  );
  await expect(admission).rejects.toThrow("FORBIDDEN");
  expect(await admin.auditRun.count()).toBe(0);
});

it("holds the authenticated epoch lock through the admission transaction", async () => {
  let release!: () => void;
  let guarded!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    guarded = resolve;
  });
  const txn = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id',${actor.userId},true), set_config('app.workspace_id','a',true)`;
      await tx.$queryRaw`SELECT lyraseo_audit.web_guard_create('a-site',${actor.securityVersion}::integer)`;
      guarded();
      await held;
    },
    { timeout: 10000 },
  );
  try {
    await entered;
    const revoke = admin.productUser
      .update({
        where: { id: actor.userId },
        data: { securityVersion: { increment: 1 } },
      })
      .then((value) => value);
    await expect
      .poll(
        async () => {
          const [row] = await admin.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database()
          AND usename='postgres' AND wait_event_type='Lock'
          AND query LIKE '%ProductUser%') AS waiting`;
          return row.waiting;
        },
        { timeout: 5000, interval: 20 },
      )
      .toBe(true);
    release();
    await txn;
    await revoke;
  } finally {
    release();
    await txn.catch(() => {});
  }
});

it("rejects a forged epoch through direct runtime insertion", async () => {
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.actor_id',${actor.userId},true), set_config('app.workspace_id','a',true)`;
      return tx.auditRun.create({
        data: {
          workspaceId: "a",
          siteId: "a-site",
          userId: actor.userId,
          securityVersion: actor.securityVersion + 1,
          idempotencyKey: "direct-forgery",
          inputHash: "forged",
          manifest: ["https://example.com/"],
          profile: "LOCAL_RAW_V1",
          declarations: {},
          methodologyVersion: "readiness-v2",
        },
      });
    }),
  ).rejects.toThrow("FORBIDDEN");
  expect(await admin.auditRun.count()).toBe(0);
});

it("exposes the creation guard only to the restricted runtime role", async () => {
  const [privileges] = await admin.$queryRaw<
    { runtime: boolean; public_: boolean; dispatch: boolean }[]
  >`
    SELECT has_function_privilege('lyraseo_runtime','lyraseo_audit.web_guard_create(text,integer)','EXECUTE') AS runtime,
      EXISTS(SELECT FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE p.oid='lyraseo_audit.web_guard_create(text,integer)'::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_,
      has_function_privilege('lyraseo_dispatch','lyraseo_audit.web_guard_create(text,integer)','EXECUTE') AS dispatch`;
  expect(privileges).toEqual({
    runtime: true,
    public_: false,
    dispatch: false,
  });
});

async function editorWithGrant() {
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: actor.userId } },
    data: { role: "EDITOR" },
  });
  await admin.siteGrant.create({
    data: { workspaceId: "a", siteId: "a-site", userId: actor.userId },
  });
}
async function directInsert(key: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.actor_id',${actor.userId},true), set_config('app.workspace_id','a',true)`;
    return tx.auditRun.create({
      data: {
        workspaceId: "a",
        siteId: "a-site",
        userId: actor.userId,
        securityVersion: actor.securityVersion,
        idempotencyKey: key,
        inputHash: key,
        manifest: ["https://example.com/"],
        profile: "LOCAL_RAW_V1",
        declarations: {},
        methodologyVersion: "readiness-v2",
      },
    });
  });
}
for (const kind of ["grant", "membership"] as const) {
  it(`blocks direct insertion after concurrent ${kind} revocation`, async () => {
    await editorWithGrant();
    let pending!: ReturnType<typeof directInsert>;
    await admin.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id='a' FOR UPDATE`;
        pending = directInsert(`before-${kind}`);
        void pending.catch(() => {});
        await expect
          .poll(
            async () => {
              const [row] = await admin.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database()
            AND usename='lyraseo_runtime' AND wait_event_type='Lock'
            AND query LIKE '%AuditRun%') AS waiting`;
              return row.waiting;
            },
            { timeout: 5000, interval: 20 },
          )
          .toBe(true);
        if (kind === "grant")
          await tx.siteGrant.delete({
            where: {
              workspaceId_siteId_userId: {
                workspaceId: "a",
                siteId: "a-site",
                userId: actor.userId,
              },
            },
          });
        else
          await tx.membership.update({
            where: {
              workspaceId_userId: { workspaceId: "a", userId: actor.userId },
            },
            data: { role: "VIEWER" },
          });
      },
      { timeout: 10000 },
    );
    await expect(pending).rejects.toThrow("FORBIDDEN");
    expect(await admin.auditRun.count()).toBe(0);
  });
  it(`holds ${kind} authority until an admission commits`, async () => {
    await editorWithGrant();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const txn = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.actor_id',${actor.userId},true), set_config('app.workspace_id','a',true)`;
        await tx.$queryRaw`SELECT lyraseo_audit.web_guard_create('a-site',${actor.securityVersion}::integer)`;
        entered();
        await held;
      },
      { timeout: 10000 },
    );
    try {
      await ready;
      const update =
        kind === "grant"
          ? admin.siteGrant
              .delete({
                where: {
                  workspaceId_siteId_userId: {
                    workspaceId: "a",
                    siteId: "a-site",
                    userId: actor.userId,
                  },
                },
              })
              .then((x) => x)
          : admin.membership
              .update({
                where: {
                  workspaceId_userId: {
                    workspaceId: "a",
                    userId: actor.userId,
                  },
                },
                data: { role: "VIEWER" },
              })
              .then((x) => x);
      await expect
        .poll(
          async () => {
            const [row] = await admin.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database()
            AND usename='postgres' AND wait_event_type='Lock'
            AND (query LIKE '%SiteGrant%' OR query LIKE '%Membership%')) AS waiting`;
            return row.waiting;
          },
          { timeout: 5000, interval: 20 },
        )
        .toBe(true);
      release();
      await txn;
      await update;
    } finally {
      release();
      await txn.catch(() => {});
    }
  });
}

it("does not deadlock concurrent direct insertions holding workspace share locks", async () => {
  let count = 0,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const insert = (key: string) =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.actor_id',${actor.userId},true), set_config('app.workspace_id','a',true)`;
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id='a' FOR SHARE`;
        if (++count === 2) release();
        await ready;
        return tx.auditRun.create({
          data: {
            workspaceId: "a",
            siteId: "a-site",
            userId: actor.userId,
            securityVersion: actor.securityVersion,
            idempotencyKey: key,
            inputHash: key,
            manifest: ["https://example.com/"],
            profile: "LOCAL_RAW_V1",
            declarations: {},
            methodologyVersion: "readiness-v2",
          },
        });
      },
      { timeout: 10000 },
    );
  const results = await Promise.allSettled([
    insert("concurrent-1"),
    insert("concurrent-2"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const failure = results.find((result) => result.status === "rejected");
  expect(failure?.status).toBe("rejected");
  if (failure?.status === "rejected") {
    expect(String(failure.reason)).toContain("audit_one_active");
    expect(String(failure.reason)).not.toMatch(/deadlock|40P01/i);
  }
});
