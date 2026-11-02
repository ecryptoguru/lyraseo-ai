// The controlled harness supplies observed in-memory Responses. This adapter
// has no DNS, HTTP client, database, environment lookup or fallback transport.
const enrolled = new WeakSet<object>();
export type FixtureResponse = (
  url: string,
  signal: AbortSignal,
) => Promise<Response>;
export type ControlledFixture = Readonly<{
  origin: string;
  request: (
    url: string,
    signal: AbortSignal,
    beforeOpen: () => Promise<void>,
  ) => Promise<Response>;
}>;
export function createControlledFixture(
  origin: string,
  respond: FixtureResponse,
  afterResolve?: (url: string, signal: AbortSignal) => Promise<void>,
): ControlledFixture {
  if (!origin.startsWith("https://") || new URL(origin).origin !== origin)
    throw new Error("INVALID_FIXTURE_ORIGIN");
  const fixture: ControlledFixture = Object.freeze({
    origin,
    async request(url, signal, beforeOpen) {
      if (new URL(url).origin !== origin)
        throw new Error("OUTSIDE_FIXTURE_ORIGIN");
      signal.throwIfAborted();
      let abort: () => void = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([afterResolve?.(url, signal), interrupted]);
        await Promise.race([beforeOpen(), interrupted]);
        signal.throwIfAborted();
        return await Promise.race([
          respond(url, signal).then((response) => {
            if (signal.aborted) {
              void response.body?.cancel().catch(() => {});
              signal.throwIfAborted();
            }
            return response;
          }),
          interrupted,
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });
  enrolled.add(fixture);
  return fixture;
}
export function isControlledFixture(input: ControlledFixture) {
  return enrolled.has(input);
}
