import type { Actor } from "@lyraseo/db/context";
import { authorizeSiteIn, withActor } from "@lyraseo/db/context";
import type { createDatabase } from "@lyraseo/db";
import { discoverCandidates } from "@lyraseo/visibility/acquisition";
import { capabilityEnabled } from "@/server/capabilities";
import { authSettings } from "@/server/auth/settings";
import { resolveActor } from "@/server/auth/server";
import { publicHttpsTransport } from "./transport";

// Local pilot only. This is deliberately not a distributed production limiter.
const recent = new Map<string, number>();
let active = 0;
const INTERVAL_MS = 30_000;
async function beforeDeadline<T>(signal: AbortSignal, work: () => Promise<T>) {
  signal.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([work(), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function reserve(key: string) {
  const now = Date.now();
  for (const [entry, at] of recent)
    if (now - at >= INTERVAL_MS) recent.delete(entry);
  if (active >= 3 || recent.has(key) || recent.size >= 1024)
    throw new Error("DISCOVERY_RATE_LIMITED");
  recent.set(key, now);
  active++;
  return () => {
    active--;
  };
}

export async function discoverSiteCandidates(
  db: ReturnType<typeof createDatabase>,
  actor: Actor,
  scope: { workspaceId: string; siteId: string },
  outer?: AbortSignal,
) {
  const settings = authSettings();
  if (
    !settings ||
    process.env.LYRA_LOCAL_RAW_AUDITS !== "true" ||
    process.env.VERCEL === "1" ||
    !["localhost", "127.0.0.1"].includes(new URL(settings.origin).hostname)
  )
    throw new Error("DISCOVERY_UNAVAILABLE");
  const deadline = AbortSignal.timeout(15_000);
  const signal = outer ? AbortSignal.any([outer, deadline]) : deadline;
  let expectedOrigin: string | undefined;
  const assertAccess = async () => {
    signal.throwIfAborted();
    if (!capabilityEnabled("audits")) throw new Error("FORBIDDEN");
    const fresh = await beforeDeadline(signal, () => resolveActor());
    if (
      fresh.userId !== actor.userId ||
      fresh.sessionId !== actor.sessionId ||
      fresh.securityVersion !== actor.securityVersion
    )
      throw new Error("FORBIDDEN");
    const site = await beforeDeadline(signal, () =>
      withActor(db, fresh, scope.workspaceId, (tx) =>
        authorizeSiteIn(tx, fresh, scope.workspaceId, scope.siteId, "run"),
      ),
    );
    const verified = site.verifiedAt?.getTime();
    if (!verified || verified > Date.now() || Date.now() - verified > 86400000)
      throw new Error("SITE_NOT_VERIFIED");
    if (expectedOrigin && site.origin !== expectedOrigin)
      throw new Error("FORBIDDEN");
    expectedOrigin = site.origin;
  };
  await assertAccess();
  const release = reserve(
    JSON.stringify([actor.userId, scope.workspaceId, scope.siteId]),
  );
  try {
    return await discoverCandidates(
      expectedOrigin!,
      (url, signal) => publicHttpsTransport(url, signal, assertAccess),
      assertAccess,
      signal,
    );
  } finally {
    release();
  }
}
