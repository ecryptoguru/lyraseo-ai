import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  authorize: vi.fn(),
  transport: vi.fn(),
  enabled: vi.fn(),
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3000" }),
}));
vi.mock("@/server/auth/server", () => ({ resolveActor: mocks.actor }));
vi.mock("@/server/capabilities", () => ({ capabilityEnabled: mocks.enabled }));
vi.mock("@/server/acquisition/transport", () => ({
  publicHttpsTransport: mocks.transport,
}));
vi.mock("../../packages/db/src/context", () => ({
  withActor: async (
    _db: unknown,
    _actor: unknown,
    _workspace: unknown,
    work: (tx: unknown) => Promise<unknown>,
  ) => work({}),
  authorizeSiteIn: mocks.authorize,
}));
import { discoverSiteCandidates } from "../../apps/lyraseo-web/src/server/acquisition/discovery";
const actor = {
  userId: "user",
  sessionId: "session",
  securityVersion: 1,
  authenticatedAt: "2026-11-03T00:00:00Z",
  mfaVerified: false,
  authProvider: "supabase" as const,
};
let n = 0;
const site = () => ({ workspaceId: "workspace", siteId: `site-${++n}` });
beforeEach(() => {
  vi.stubEnv("LYRA_LOCAL_RAW_AUDITS", "true");
  vi.stubEnv("VERCEL", "");
  mocks.enabled.mockReturnValue(true);
  mocks.actor.mockResolvedValue(actor);
  mocks.authorize.mockResolvedValue({
    origin: "https://example.com",
    verifiedAt: new Date(),
  });
  mocks.transport.mockImplementation(
    async (
      url: string,
      _signal: AbortSignal,
      beforeSocket: () => Promise<void>,
    ) => {
      await beforeSocket();
      return url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response('<a href="/about">About</a>', {
            headers: { "content-type": "text/html" },
          });
    },
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
const db = {} as Parameters<typeof discoverSiteCandidates>[0];
it("requires a currently verified and authorized site before any network request", async () => {
  mocks.authorize.mockResolvedValueOnce({
    origin: "https://example.com",
    verifiedAt: null,
  });
  await expect(discoverSiteCandidates(db, actor, site())).rejects.toThrow(
    "SITE_NOT_VERIFIED",
  );
  expect(mocks.transport).not.toHaveBeenCalled();
  mocks.authorize.mockRejectedValueOnce(new Error("FORBIDDEN"));
  await expect(discoverSiteCandidates(db, actor, site())).rejects.toThrow(
    "FORBIDDEN",
  );
  expect(mocks.transport).not.toHaveBeenCalled();
});
it("keeps hosted and paused collection disabled before access or network", async () => {
  vi.stubEnv("VERCEL", "1");
  await expect(discoverSiteCandidates(db, actor, site())).rejects.toThrow(
    "DISCOVERY_UNAVAILABLE",
  );
  vi.stubEnv("VERCEL", "");
  mocks.enabled.mockReturnValue(false);
  await expect(discoverSiteCandidates(db, actor, site())).rejects.toThrow(
    "FORBIDDEN",
  );
  expect(mocks.transport).not.toHaveBeenCalled();
});
it("blocks a page socket when a site grant is revoked after robots acquisition", async () => {
  let dispatched = 0;
  mocks.transport.mockImplementation(
    async (
      url: string,
      _signal: AbortSignal,
      beforeSocket: () => Promise<void>,
    ) => {
      if (url.endsWith("/"))
        mocks.authorize.mockRejectedValue(new Error("FORBIDDEN"));
      await beforeSocket();
      dispatched++;
      return new Response("", { status: 404 });
    },
  );
  await expect(discoverSiteCandidates(db, actor, site())).rejects.toThrow(
    "FORBIDDEN",
  );
  expect(dispatched).toBe(1);
});
it("rejects a changed session before returning acquired links", async () => {
  let calls = 0;
  mocks.actor.mockImplementation(async () =>
    ++calls > 4 ? { ...actor, sessionId: "new-session" } : actor,
  );
  await expect(discoverSiteCandidates(db, actor, site())).rejects.toThrow(
    "FORBIDDEN",
  );
});
it("bounds repeated local requests and does not send the second request", async () => {
  const scope = site();
  expect((await discoverSiteCandidates(db, actor, scope)).candidates).toEqual([
    "https://example.com/",
    "https://example.com/about",
  ]);
  const calls = mocks.transport.mock.calls.length;
  await expect(discoverSiteCandidates(db, actor, scope)).rejects.toThrow(
    "DISCOVERY_RATE_LIMITED",
  );
  expect(mocks.transport).toHaveBeenCalledTimes(calls);
});

it("does not start discovery when the caller has already cancelled", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    (discoverSiteCandidates as (...args: unknown[]) => Promise<unknown>)(
      db,
      actor,
      site(),
      cancelled.signal,
    ),
  ).rejects.toThrow();
  expect(mocks.transport).not.toHaveBeenCalled();
});

it("stops waiting for fresh authentication when the caller cancels", async () => {
  mocks.actor.mockImplementationOnce(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = discoverSiteCandidates(db, actor, site(), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(mocks.transport).not.toHaveBeenCalled();
});
