import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  acceptAttempt,
  admitOperation,
  beginAttempt,
  claimOperation,
  cancelInvalidQueuedOperation,
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

it("disables every legacy send, including retries", async () => {
  await admitOperation(db, actor, request("delivery"));
  let sends = 0;
  for (const paused of [false, true, false]) {
    const result = await publishOperations(
      db,
      actor,
      {
        send: async () => {
          sends++;
        },
      },
      { paused },
    );
    expect(result.disposition).toBe("DISABLED");
  }
  expect(sends).toBe(0);
});

it("recovers an expired lease before intent without sending or reserving twice", async () => {
  const op = await admitOperation(db, actor, request("crash"));
  const first = await claimOperation(db, actor, op.id, "crashed");
  await admin.operation.update({
    where: { id: op.id },
    data: { leaseUntil: new Date(0) },
  });
  expect((await recoverOperations(db, actor)).recovered).toBe(1);
  expect(
    (
      await admin.outboxEvent.findUniqueOrThrow({
        where: { operationId: op.id },
      })
    ).deliveredAt,
  ).toBeNull();
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
  expect(result.disposition).toBe("DISABLED");
});

it.each(["revoked", "security"])(
  "releases 21 definitively invalid %s reservations while retaining valid work",
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
    // The ledger may still release definitively invalid work while publication is off.
    for (const op of [...old, valid])
      await cancelInvalidQueuedOperation(db, currentActor, op.id);
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
