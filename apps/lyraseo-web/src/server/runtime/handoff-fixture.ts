import type { HandoffBinding } from "@lyraseo/db/bridge";

// This harness has no network fallback. Only explicit in-process fixtures can
// enroll it, and a fixture may open only its own HTTPS origin.
const enrolled = new WeakSet<object>();
export type HandoffFixture = Readonly<{
  origin: string;
  open: (cipher: string, binding: HandoffBinding) => string;
  post: (
    url: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    beforeOpen: () => Promise<void>,
  ) => Promise<{ status: number; body: string }>;
}>;
export function createHandoffFixture(
  origin: string,
  open: HandoffFixture["open"],
  respond: (
    url: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<{ status: number; body: string }>,
  afterResolve?: (signal: AbortSignal) => Promise<void>,
): HandoffFixture {
  if (!origin.startsWith("https://") || new URL(origin).origin !== origin)
    throw Error("INVALID_FIXTURE_ORIGIN");
  const fixture: HandoffFixture = Object.freeze({
    origin,
    open,
    async post(url, body, headers, signal, beforeOpen) {
      if (new URL(url).origin !== origin) throw Error("OUTSIDE_FIXTURE_ORIGIN");
      signal.throwIfAborted();
      let abort: () => void = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(Error("HANDOFF_ABORTED"));
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([afterResolve?.(signal), interrupted]);
        await Promise.race([beforeOpen(), interrupted]);
        signal.throwIfAborted();
        const result = await Promise.race([
          respond(url, body, headers, signal),
          interrupted,
        ]);
        signal.throwIfAborted();
        if (
          !Number.isInteger(result.status) ||
          result.status < 200 ||
          result.status > 599 ||
          typeof result.body !== "string" ||
          Buffer.byteLength(result.body) > 65536
        )
          throw Error("INVALID_RESPONSE");
        return result;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });
  enrolled.add(fixture);
  return fixture;
}
export function isHandoffFixture(value: HandoffFixture) {
  return enrolled.has(value);
}
