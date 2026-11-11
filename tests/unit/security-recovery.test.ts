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
import {
  enrollAuthenticator,
  enrollBackupAuthenticator,
  confirmAuthenticator,
} from "../../apps/lyraseo-web/src/app/app/security/actions";

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

it("withholds initial enrollment when current factor absence cannot prove first enrollment", async () => {
  mocks.actor.mockResolvedValue({ ...actor(), mfaVerified: false });
  mocks.factors.mockResolvedValue({ data: { all: [] }, error: null });
  const result = await enrollAuthenticator();
  expect(result.factorId).toBeUndefined();
  expect(result.qrCode).toBeUndefined();
  expect(result.manualKey).toBeUndefined();
  expect(mocks.enroll).not.toHaveBeenCalled();
});

function confirmation() {
  const form = new FormData();
  form.set("factorId", "pending");
  form.set("code", "123456");
  return form;
}

it("does not verify an unbound factor from an AAL1 session even with browser-supplied enrollment state", async () => {
  mocks.actor.mockResolvedValue({ ...actor(), mfaVerified: false });
  mocks.factors.mockResolvedValue({
    data: {
      all: [{ id: "pending", factor_type: "totp", status: "unverified" }],
    },
    error: null,
  });
  mocks.challengeAndVerify.mockResolvedValue({ error: null });
  const result = await confirmAuthenticator(
    { message: "", factorId: "pending", manualKey: "forged" },
    confirmation(),
  );
  expect(result.factorId).toBeUndefined();
  expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
});

it("rejects backup confirmation after session revocation during factor lookup", async () => {
  mocks.actor
    .mockResolvedValueOnce(actor())
    .mockResolvedValue({ ...actor(), securityVersion: 2 });
  mocks.factors.mockResolvedValue({
    data: {
      all: [
        { id: "primary", factor_type: "totp", status: "verified" },
        { id: "pending", factor_type: "totp", status: "unverified" },
      ],
    },
    error: null,
  });
  mocks.challengeAndVerify.mockResolvedValue({ error: null });
  const result = await confirmAuthenticator({ message: "" }, confirmation());
  expect(result.factorId).toBeUndefined();
  expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
});

it("confirms a provider-owned backup under the same fresh AAL2 session", async () => {
  mocks.factors.mockResolvedValue({
    data: {
      all: [
        { id: "primary", factor_type: "totp", status: "verified" },
        { id: "pending", factor_type: "totp", status: "unverified" },
      ],
    },
    error: null,
  });
  mocks.challengeAndVerify.mockResolvedValue({ error: null });
  await expect(
    confirmAuthenticator({ message: "" }, confirmation()),
  ).rejects.toThrow("REDIRECT:/app/workspaces");
  expect(mocks.challengeAndVerify).toHaveBeenCalledExactlyOnceWith({
    factorId: "pending",
    code: "123456",
  });
});

it("does not confirm a backup without a currently verified primary factor", async () => {
  mocks.factors.mockResolvedValue({
    data: {
      all: [{ id: "pending", factor_type: "totp", status: "unverified" }],
    },
    error: null,
  });
  const result = await confirmAuthenticator({ message: "" }, confirmation());
  expect(result.factorId).toBeUndefined();
  expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
});

it("does not redirect after verification if the provider returns a replacement session", async () => {
  mocks.actor
    .mockResolvedValueOnce(actor())
    .mockResolvedValueOnce(actor())
    .mockResolvedValueOnce({ ...actor(), sessionId: "replacement" });
  mocks.factors.mockResolvedValue({
    data: {
      all: [
        { id: "primary", factor_type: "totp", status: "verified" },
        { id: "pending", factor_type: "totp", status: "unverified" },
      ],
    },
    error: null,
  });
  mocks.challengeAndVerify.mockResolvedValue({ error: null });
  const result = await confirmAuthenticator({ message: "" }, confirmation());
  expect(result.factorId).toBeUndefined();
  expect(mocks.challengeAndVerify).toHaveBeenCalledOnce();
});
