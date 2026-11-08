import { beforeEach, afterAll, it, expect } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { provisionIdentity, throttle } from "../../packages/db/src/identity";
import { resetDatabase, adminUrl, identityUrl } from "../helpers/database";
const db = createDatabase(identityUrl),
  admin = createDatabase(adminUrl);
beforeEach(async () => {
  await resetDatabase();
  await admin.authThrottle.deleteMany();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("preserves stable product identity under concurrent first sign-ins", async () => {
  const users = await Promise.all(
    Array.from({ length: 4 }, () => provisionIdentity(db, "subject-a")),
  );
  expect(new Set(users.map((u) => u.id)).size).toBe(1);
  expect(await admin.productUser.count()).toBe(1);
  expect((await provisionIdentity(db, "subject-b")).id).not.toBe(users[0]!.id);
});
it("enforces shared auth limits atomically without storing email", async () => {
  const result = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      throttle(db, "verify", "person@example.com", 5, 60000),
    ),
  );
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  const rows = await admin.authThrottle.findMany();
  expect(rows[0]!.key).not.toContain("example");
});
it("does not allow resend cooldown to reset at a clock-minute boundary", async () => {
  const first = new Date("2026-10-23T10:00:59Z");
  await throttle(db, "send", "pilot@example.com", 1, 60000, first);
  await expect(
    throttle(
      db,
      "send",
      "pilot@example.com",
      1,
      60000,
      new Date(first.getTime() + 1000),
    ),
  ).rejects.toThrow("RATE_LIMITED");
  await throttle(
    db,
    "send",
    "pilot@example.com",
    1,
    60000,
    new Date(first.getTime() + 60000),
  );
});
