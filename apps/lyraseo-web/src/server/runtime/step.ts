import type { createDatabase } from "@lyraseo/db";
import { admitStep, checkStep, commitStep } from "@lyraseo/db/bridge";
import type { KernelRequest } from "@lyraseo/db/dispatch";
import { runAuditPage } from "@lyraseo/visibility/acquisition";

import type { ControlledFixture } from "./fixture";
export async function signedStep(
  db: ReturnType<typeof createDatabase>,
  envelope: KernelRequest,
  fixture: ControlledFixture,
  outer: AbortSignal,
  deadline: Date,
  assertSigner: () => void,
) {
  outer.throwIfAborted();
  const attempt = await admitStep(
    db,
    envelope,
    fixture.origin,
    deadline,
    () => {
      assertSigner();
      outer.throwIfAborted();
    },
  );
  if (attempt.disposition !== "ADMITTED") return attempt;
  const controller = new AbortController();
  const signal = AbortSignal.any([outer, controller.signal]);
  let active: Promise<void> | undefined;
  // All polls and hop checks share a single in-flight DB read. Uncertainty
  // aborts the socket after at most 650ms; polls run every 200ms.
  const check = () => {
    signal.throwIfAborted();
    try {
      assertSigner();
    } catch (error) {
      controller.abort(error);
      throw error;
    }
    if (!active) {
      const timer = setTimeout(
        () => controller.abort(new Error("CHECK_UNAVAILABLE")),
        650,
      );
      active = checkStep(db, envelope.requestId, attempt.proof, deadline)
        .catch((error) => {
          controller.abort(new Error("STALE_ATTEMPT"));
          throw error;
        })
        .finally(() => {
          clearTimeout(timer);
          active = undefined;
        });
    }
    return active;
  };
  const hopCheck = async () => {
    // A poll already in flight might have observed policy before this hop.
    // Finish it, then obtain a fresh proof check for this dispatch point.
    if (active) await active;
    await check();
    signal.throwIfAborted();
  };
  const poll = setInterval(() => {
    if (!signal.aborted)
      void Promise.resolve()
        .then(check)
        .catch(() => {});
  }, 200);
  try {
    return await runAuditPage(
      attempt.url,
      attempt.origin,
      async (url, rawSignal) => {
        await hopCheck();
        rawSignal.throwIfAborted();
        if (new URL(url).origin !== fixture.origin)
          throw new Error("REDIRECT_OUTSIDE_ORIGIN");
        return fixture.request(url, rawSignal, async () => {
          await hopCheck();
          rawSignal.throwIfAborted();
        });
      },
      async (receipt) => {
        clearInterval(poll);
        if (active) await active;
        signal.throwIfAborted();
        return commitStep(
          db,
          envelope.requestId,
          attempt,
          receipt,
          signal,
          assertSigner,
          deadline,
        );
      },
      signal,
    );
  } finally {
    clearInterval(poll);
    controller.abort();
  }
}
