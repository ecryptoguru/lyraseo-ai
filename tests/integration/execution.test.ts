import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  acceptAttempt,
  admitOperation,
  beginAttempt,
  claimOperation,
  settleOperation,
} from "../../packages/db/src/accounting";
import {
  publishOperations,
  readOperation,
  recoverOperations,
} from "../../packages/db/src/execution";
import {
  actor,
  adminUrl,
  resetDatabase,
  runtimeUrl,
  seedTenants,
} from "../helpers/database";

const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
const request = (id: string) => ({
  workspaceId: "a",
  siteId: "a-site",
  kind: "GENERATION" as const,
  provider: "AZURE" as const,
  route: "content",
  idempotencyKey: id,
  input: { revision: 1 },
  maximumCost: "0.3",
  tariffVersion: "synthetic-test-v1",
});

it("retains failed publications and sends only persisted operation references", async () => {
  const op = await admitOperation(db, actor, request("delivery"));
  expect(
    await publishOperations(
      db,
      actor,
      {
        send: async () => {
          throw new Error("offline");
        },
      },
      { paused: false },
    ),
  ).toEqual({ published: 0, skipped: 0, failed: 1 });
  const sent: unknown[] = [];
  const queue = {
    send: async (message: unknown) => {
      sent.push(message);
    },
  };
  expect(
    (await publishOperations(db, actor, queue, { paused: true })).published,
  ).toBe(0);
  expect(
    (await publishOperations(db, actor, queue, { paused: false })).published,
  ).toBe(1);
  await publishOperations(db, actor, queue, { paused: false });
  expect(sent).toEqual([{ operationId: op.id }]);
});

it("recovers an expired lease before intent and republishes without reserving twice", async () => {
  const op = await admitOperation(db, actor, request("crash"));
  await publishOperations(
    db,
    actor,
    { send: async () => {} },
    { paused: false },
  );
  const first = await claimOperation(db, actor, op.id, "crashed");
  await admin.operation.update({
    where: { id: op.id },
    data: { leaseUntil: new Date(0) },
  });
  expect((await recoverOperations(db, actor)).recovered).toBe(1);
  expect(
    (
      await publishOperations(
        db,
        actor,
        { send: async () => {} },
        { paused: false },
      )
    ).published,
  ).toBe(1);
  const second = await claimOperation(db, actor, op.id, "retry");
  expect(second.fence).toBeGreaterThan(first.fence);
  await expect(beginAttempt(db, actor, op.id, first.fence)).rejects.toThrow(
    "STALE_LEASE",
  );
  expect(await admin.operation.count()).toBe(1);
  expect(
    (
      await admin.budgetPeriod.findFirstOrThrow({ where: { bucket: "AZURE" } })
    ).reserved.toString(),
  ).toBe("0.3");
});

it("keeps uncertain commitments and permits late receipts after recovery", async () => {
  const op = await admitOperation(db, actor, request("uncertain"));
  const lease = await claimOperation(db, actor, op.id, "crashed");
  await beginAttempt(db, actor, op.id, lease.fence);
  await admin.operation.update({
    where: { id: op.id },
    data: { leaseUntil: new Date(0) },
  });
  await recoverOperations(db, actor);
  await expect(claimOperation(db, actor, op.id, "retry")).rejects.toThrow(
    "RECONCILING",
  );
  expect((await readOperation(db, actor, op.id)).reservedCost).toBe(
    "0.300000000",
  );
  await acceptAttempt(db, actor, op.id, lease.fence, "late-task");
  await settleOperation(db, actor, op.id, lease.fence, {
    receiptId: "late-receipt",
    amount: "0.1",
    acceptedOutput: true,
  });
  expect((await readOperation(db, actor, op.id)).actualCost).toBe(
    "0.100000000",
  );
});

it("releases expired unstarted commitments even for a suspended owner", async () => {
  const op = await admitOperation(db, actor, request("expired"));
  await admin.operation.update({
    where: { id: op.id },
    data: { expiresAt: new Date(0) },
  });
  await admin.productUser.update({
    where: { id: actor.userId },
    data: { suspended: true },
  });
  await recoverOperations(db, actor);
  expect(
    (await admin.operation.findUniqueOrThrow({ where: { id: op.id } })).status,
  ).toBe("EXPIRED");
  expect(
    (
      await admin.budgetPeriod.findFirstOrThrow({ where: { bucket: "AZURE" } })
    ).reserved.toString(),
  ).toBe("0");
});

it("reauthorizes reads and publications after site access is revoked", async () => {
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
    data: { role: "EDITOR" },
  });
  await admin.siteGrant.create({
    data: { workspaceId: "a", siteId: "a-site", userId: "owner" },
  });
  const op = await admitOperation(db, actor, request("revoked"));
  await admin.siteGrant.deleteMany({ where: { userId: "owner" } });
  await expect(readOperation(db, actor, op.id)).rejects.toThrow("FORBIDDEN");
  await expect(
    readOperation(db, { ...actor, userId: "other" }, op.id),
  ).rejects.toThrow("NOT_FOUND");
  const result = await publishOperations(
    db,
    actor,
    {
      send: async () => {
        throw new Error("must not send");
      },
    },
    { paused: false },
  );
  expect(result).toEqual({ published: 0, skipped: 1, failed: 0 });
});

it.each(["revoked", "security"])(
  "progresses past 21 older %s rows over bounded publication sweeps",
  async (reason) => {
    const old = [];
    for (let i = 0; i < 21; i++)
      old.push(await admitOperation(db, actor, request(`old-${i}`)));
    let currentActor = actor;
    if (reason === "revoked") {
      await admin.membership.delete({
        where: {
          workspaceId_userId: { workspaceId: "a", userId: actor.userId },
        },
      });
    } else {
      await admin.productUser.update({
        where: { id: actor.userId },
        data: { securityVersion: 1 },
      });
      currentActor = { ...actor, securityVersion: 1 };
    }
    const valid = await admitOperation(db, currentActor, {
      ...request("valid-later"),
      workspaceId: "b",
      siteId: "b-site",
    });
    const sent: string[] = [];
    const queue = {
      send: async ({ operationId }: { operationId: string }) => {
        sent.push(operationId);
      },
    };
    for (let i = 0; i < 3; i++)
      await publishOperations(db, currentActor, queue, { paused: false });
    expect(sent).toEqual([valid.id]);
    expect(
      await admin.operation.count({
        where: { id: { in: old.map((op) => op.id) }, status: "CANCELLED" },
      }),
    ).toBe(21);
    expect(
      await admin.outboxEvent.count({
        where: {
          operationId: { in: old.map((op) => op.id) },
          deliveredAt: null,
        },
      }),
    ).toBe(21);
    expect(
      (
        await admin.budgetPeriod.findFirstOrThrow({
          where: { userId: actor.userId, bucket: "AZURE" },
        })
      ).reserved.toString(),
    ).toBe("0.3");
  },
);

it("does not let a delayed old send acknowledgement erase recovery redelivery", async () => {
  const op = await admitOperation(db, actor, request("delayed-ack"));
  let sends = 0;
  await publishOperations(
    db,
    actor,
    {
      send: async () => {
        sends++;
        await claimOperation(db, actor, op.id, "consumer-before-ack");
        await admin.operation.update({
          where: { id: op.id },
          data: { leaseUntil: new Date(0) },
        });
        expect((await recoverOperations(db, actor)).recovered).toBe(1);
      },
    },
    { paused: false },
  );
  const event = await admin.outboxEvent.findUniqueOrThrow({
    where: { operationId: op.id },
  });
  expect(event.deliveredAt).toBeNull();
  expect(event.attempts).toBe(0);
  expect(
    (
      await publishOperations(
        db,
        actor,
        {
          send: async () => {
            sends++;
          },
        },
        { paused: false },
      )
    ).published,
  ).toBe(1);
  expect(sends).toBe(2);
  expect(
    (
      await admin.outboxEvent.findUniqueOrThrow({
        where: { operationId: op.id },
      })
    ).deliveredAt,
  ).not.toBeNull();
});
