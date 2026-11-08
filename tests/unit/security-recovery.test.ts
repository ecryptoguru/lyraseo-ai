import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  throttle: vi.fn(),
  factors: vi.fn(),
  enroll: vi.fn(),
  challengeAndVerify: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "http://localhost:3000" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://localhost:3000" }),
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: mocks.actor,
  identityDatabase: () => ({}),
  authClient: async () => ({
    auth: {
      mfa: {
        listFactors: mocks.factors,
        enroll: mocks.enroll,
        challengeAndVerify: mocks.challengeAndVerify,
      },
    },
  }),
}));
vi.mock("../../packages/db/src/identity", () => ({ throttle: mocks.throttle }));
import { enrollBackupAuthenticator } from "../../apps/lyraseo-web/src/app/app/security/actions";

const actor = () => ({
  userId: "member",
  sessionId: "session",
  securityVersion: 1,
  authenticatedAt: new Date().toISOString(),
  mfaAuthenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  authProvider: "supabase" as const,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(actor());
  mocks.factors.mockResolvedValue({
    data: { all: [{ id: "primary", factor_type: "totp", status: "verified" }] },
    error: null,
  });
  mocks.enroll.mockResolvedValue({
    data: { id: "backup", totp: { qr_code: "<svg/>", secret: "SECRET" } },
    error: null,
  });
});
it("enrolls a separately named backup only after current fresh MFA and verified factor", async () => {
  const result = await enrollBackupAuthenticator();
  expect(result.factorId).toBe("backup");
  expect(mocks.enroll).toHaveBeenCalledOnce();
  expect(mocks.enroll.mock.calls[0][0]).toMatchObject({
    factorType: "totp",
    issuer: "LyraSEO AI",
    friendlyName: expect.stringMatching(/^Backup authenticator /),
  });
});
it("does not enroll a backup for a first-factor-only or stale MFA session", async () => {
  mocks.actor.mockResolvedValueOnce({ ...actor(), mfaVerified: false });
  expect((await enrollBackupAuthenticator()).factorId).toBeUndefined();
  expect(mocks.enroll).not.toHaveBeenCalled();
  mocks.actor.mockResolvedValueOnce({
    ...actor(),
    mfaAuthenticatedAt: new Date(Date.now() - 600001).toISOString(),
  });
  expect((await enrollBackupAuthenticator()).factorId).toBeUndefined();
  expect(mocks.enroll).not.toHaveBeenCalled();
});
it("does not call enrollment when the provider has no verified factor or fails", async () => {
  mocks.factors.mockResolvedValueOnce({
    data: {
      all: [{ id: "pending", factor_type: "totp", status: "unverified" }],
    },
    error: null,
  });
  expect((await enrollBackupAuthenticator()).factorId).toBeUndefined();
  mocks.factors.mockResolvedValueOnce({
    data: null,
    error: new Error("unavailable"),
  });
  expect((await enrollBackupAuthenticator()).factorId).toBeUndefined();
  expect(mocks.enroll).not.toHaveBeenCalled();
});
it("rechecks current session and security version after provider factor lookup", async () => {
  mocks.actor
    .mockResolvedValueOnce(actor())
    .mockResolvedValueOnce({ ...actor(), securityVersion: 2 });
  expect((await enrollBackupAuthenticator()).factorId).toBeUndefined();
  expect(mocks.enroll).not.toHaveBeenCalled();
});
