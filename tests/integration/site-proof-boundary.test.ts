import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  issueSiteChallenge,
  verifySiteChallenge,
} from "../../packages/db/src/sites";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const scope = { workspaceId: "a", siteId: "a-site" };
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("does not send the proof request if actor authority is revoked while DNS is pending", async () => {
  const challenge = await issueSiteChallenge(db, actor, scope);
  let sockets = 0;
  await expect(
    verifySiteChallenge(
      db,
      actor,
      scope,
      challenge.id,
      async (url, beforeSocket) => {
        await admin.productUser.update({
          where: { id: actor.userId },
          data: { securityVersion: 1 },
        });
        expect(typeof beforeSocket).toBe("function");
        await beforeSocket!();
        sockets++;
        return { url, status: 200, body: challenge.token };
      },
      async () => actor,
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(sockets).toBe(0);
  expect(
    (
      await admin.siteVerificationChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      })
    ).consumedAt,
  ).toBeNull();
});
it("does not send the proof request after the challenge is replaced during DNS", async () => {
  const challenge = await issueSiteChallenge(db, actor, scope);
  let sockets = 0;
  await expect(
    verifySiteChallenge(
      db,
      actor,
      scope,
      challenge.id,
      async (url, beforeSocket) => {
        await issueSiteChallenge(db, actor, scope);
        expect(typeof beforeSocket).toBe("function");
        await beforeSocket!();
        sockets++;
        return { url, status: 200, body: challenge.token };
      },
      async () => actor,
    ),
  ).rejects.toThrow("INVALID_SITE_CHALLENGE");
  expect(sockets).toBe(0);
});

it("rejects a changed authenticated session before the socket is opened", async () => {
  const challenge = await issueSiteChallenge(db, actor, scope);
  let sockets = 0;
  await expect(
    verifySiteChallenge(
      db,
      actor,
      scope,
      challenge.id,
      async (url, beforeSocket) => {
        await beforeSocket();
        sockets++;
        return { url, status: 200, body: challenge.token };
      },
      async () => ({ ...actor, sessionId: "replacement" }),
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(sockets).toBe(0);
  expect(
    (
      await admin.siteVerificationChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      })
    ).consumedAt,
  ).toBeNull();
});
it("does not consume a valid proof when the authenticated session changes during I/O", async () => {
  const challenge = await issueSiteChallenge(db, actor, scope);
  let refreshes = 0;
  await expect(
    verifySiteChallenge(
      db,
      actor,
      scope,
      challenge.id,
      async (url, beforeSocket) => {
        await beforeSocket();
        return { url, status: 200, body: challenge.token };
      },
      async () =>
        ++refreshes === 1 ? actor : { ...actor, sessionId: "replacement" },
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(refreshes).toBe(2);
  expect(
    (
      await admin.siteVerificationChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      })
    ).consumedAt,
  ).toBeNull();
});

it("does not consume a proof when the observer omits the socket authority check", async () => {
  const challenge = await issueSiteChallenge(db, actor, scope);
  await expect(
    verifySiteChallenge(
      db,
      actor,
      scope,
      challenge.id,
      async (url) => ({ url, status: 200, body: challenge.token }),
      async () => actor,
    ),
  ).rejects.toThrow("INVALID_SITE_PROOF");
  expect(
    (
      await admin.siteVerificationChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      })
    ).consumedAt,
  ).toBeNull();
});

it("rejects a second socket authorization for the same single-use proof", async () => {
  const challenge = await issueSiteChallenge(db, actor, scope);
  await expect(
    verifySiteChallenge(
      db,
      actor,
      scope,
      challenge.id,
      async (url, beforeSocket) => {
        await beforeSocket();
        await beforeSocket();
        return { url, status: 200, body: challenge.token };
      },
      async () => actor,
    ),
  ).rejects.toThrow("INVALID_SITE_PROOF");
  expect(
    (
      await admin.siteVerificationChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      })
    ).consumedAt,
  ).toBeNull();
});
