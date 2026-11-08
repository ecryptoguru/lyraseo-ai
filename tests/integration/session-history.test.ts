import { afterAll, beforeEach, it, expect } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { acceptSessionHistory } from "../../packages/db/src/identity";
import { resetDatabase, identityUrl } from "../helpers/database";
const db = createDatabase(identityUrl);
beforeEach(resetDatabase);
afterAll(() => db.$disconnect());
const start = new Date("2026-10-01T10:00:00Z"),
  day = 86400000;
const evidence = {
  sessionId: "session-history",
  userId: "stable-user",
  securityVersion: 0,
  createdAt: start,
  refreshedAt: start,
  authenticatedAt: start,
};
it("rejects a provider refresh that attempts to hide an eight-day inactivity gap", async () => {
  await acceptSessionHistory(db, evidence, start);
  const later = new Date(start.getTime() + 8 * day);
  await expect(
    acceptSessionHistory(db, { ...evidence, refreshedAt: later }, later),
  ).rejects.toThrow("SESSION_EXPIRED");
});
it("records successful refreshes but page visits do not extend the window", async () => {
  await acceptSessionHistory(db, evidence, start);
  await acceptSessionHistory(db, evidence, new Date(start.getTime() + 6 * day));
  await expect(
    acceptSessionHistory(db, evidence, new Date(start.getTime() + 7 * day)),
  ).rejects.toThrow("SESSION_EXPIRED");
  const other = { ...evidence, sessionId: "another" };
  await acceptSessionHistory(db, other, start);
  const refresh = new Date(start.getTime() + 6 * day);
  await acceptSessionHistory(db, { ...other, refreshedAt: refresh }, refresh);
  await acceptSessionHistory(
    db,
    { ...other, refreshedAt: refresh },
    new Date(start.getTime() + 8 * day),
  );
});
it("requires fresh sign-in to bootstrap history and rejects stale security versions", async () => {
  await expect(
    acceptSessionHistory(db, evidence, new Date(start.getTime() + day)),
  ).rejects.toThrow("FRESH_AUTH_REQUIRED");
  await acceptSessionHistory(db, evidence, start);
  await expect(
    acceptSessionHistory(db, { ...evidence, securityVersion: 1 }, start),
  ).rejects.toThrow("SESSION_EXPIRED");
});

it("accepts concurrent older evidence without moving the refresh clock backwards", async () => {
  await acceptSessionHistory(db, evidence, start);
  const later = new Date(start.getTime() + 60000);
  await acceptSessionHistory(db, { ...evidence, refreshedAt: later }, later);
  const result = await acceptSessionHistory(db, evidence, later);
  expect(result.refreshedAt).toEqual(later);
});

it("interprets provider refresh timestamps explicitly as UTC regardless of database timezone", async () => {
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Kolkata'`;
    return tx.$queryRaw<
      { refreshed_at: Date }[]
    >`SELECT TIMESTAMPTZ '2026-10-23 10:00:00+00' AT TIME ZONE 'UTC' AS refreshed_at`;
  });
  expect(result[0]?.refreshed_at.toISOString()).toBe(
    "2026-10-23T10:00:00.000Z",
  );
});
