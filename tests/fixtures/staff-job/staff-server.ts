import { AsyncLocalStorage } from "node:async_hooks";
import { createDatabase } from "../../../packages/db/src";
const dbName = process.env.LYRA_STAFF_JOB_DB;
if (!dbName || !/^lyraseo_staff_jobs_[a-f0-9]{16}$/.test(dbName))
  throw Error("OWNED_STAFF_JOB_DATABASE_REQUIRED");
const db = createDatabase(
  `postgresql://lyraseo_staff_executor:local_staff_executor_only@127.0.0.1:54329/${dbName}`,
);
export function staffDatabase() {
  return db;
}
export async function closeFixtureStaffDatabase() {
  await db.$disconnect();
}
type FixtureActor = {
  userId: string;
  sessionId: string;
  securityVersion: number;
};
const actorContext = new AsyncLocalStorage<FixtureActor>();
let fixtureActor = {
  userId: "staff",
  sessionId: "staffsession",
  securityVersion: 0,
};
export function setFixtureActor(
  userId: string,
  sessionId: string,
  securityVersion: number,
) {
  fixtureActor = { userId, sessionId, securityVersion };
}
export function snapshotFixtureActor() {
  return { ...fixtureActor };
}
export function withFixtureActor<T>(
  actor: FixtureActor,
  work: () => Promise<T>,
) {
  return actorContext.run(actor, work);
}
export async function requireStaffFor() {
  const now = new Date().toISOString();
  return {
    ...(actorContext.getStore() ?? fixtureActor),
    authenticatedAt: now,
    mfaVerified: true,
    mfaAuthenticatedAt: now,
    authProvider: "supabase" as const,
  };
}
