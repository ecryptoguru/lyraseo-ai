import { it, expect, vi } from "vitest";
import {
  resolveVerifiedActor,
  type IdentitySource,
} from "../../apps/lyraseo-web/src/server/auth/actor";
const url = "https://pilot.supabase.co",
  sid = "11111111-1111-4111-8111-111111111111";
function source() {
  const now = Math.floor(Date.now() / 1000);
  return {
    currentUser: vi.fn(async () => ({
      id: "provider-id",
      email: "founder@example.com",
      confirmed: true,
      totpEnrolled: false,
    })),
    verifiedClaims: vi.fn(async () => ({
      sub: "provider-id",
      session_id: sid,
      role: "authenticated",
      iss: `${url}/auth/v1`,
      aud: "authenticated",
      exp: now + 800,
      iat: now - 30,
      amr: [{ method: "oauth", timestamp: now - 100 }],
      aal: "aal1",
    })),
    session: vi.fn(async () => ({
      id: sid,
      user_id: "provider-id",
      created_at: new Date((now - 3600) * 1000),
      refreshed_at: new Date(),
      not_after: null,
    })),
    account: vi.fn(async () => ({
      id: "stable-product-id",
      securityVersion: 0,
    })),
    staff: vi.fn(async () => false),
    history: vi.fn(async () => undefined),
  };
}
async function mfaSource() {
  const s = source();
  s.currentUser.mockResolvedValue({
    ...(await s.currentUser()),
    totpEnrolled: true,
  });
  const claims = await s.verifiedClaims();
  s.verifiedClaims.mockResolvedValue({
    ...claims,
    aal: "aal2",
    amr: [...claims.amr, { method: "totp", timestamp: claims.iat }],
  });
  s.currentUser.mockClear();
  s.verifiedClaims.mockClear();
  return s;
}
it("resolves provider-verified data to stable product ownership", async () => {
  const s = await mfaSource();
  const actor = await resolveVerifiedActor(s, url, ["founder@example.com"]);
  expect(actor.userId).toBe("stable-product-id");
  expect(s.currentUser).toHaveBeenCalledOnce();
  expect(s.verifiedClaims).toHaveBeenCalledOnce();
  expect(s.session).toHaveBeenCalledWith(sid, "provider-id");
});
it("rejects uninvited and mismatched identities before provisioning", async () => {
  const s = source();
  await expect(
    resolveVerifiedActor(s, url, ["someone-else@example.com"]),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(s.account).not.toHaveBeenCalled();
  s.verifiedClaims.mockResolvedValue({
    ...(await source().verifiedClaims()),
    sub: "attacker",
  });
  await expect(
    resolveVerifiedActor(s, url, ["founder@example.com"]),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(s.session).not.toHaveBeenCalled();
});
it("requires provider-verified MFA and does not trust profile fields", async () => {
  const s = source();
  s.currentUser.mockResolvedValue({
    ...(await s.currentUser()),
    totpEnrolled: true,
  });
  await expect(
    resolveVerifiedActor(s, url, ["founder@example.com"]),
  ).rejects.toThrow("MFA_REQUIRED");
  expect(s.account).not.toHaveBeenCalled();
});
it("denies missing managed session metadata and staff without MFA", async () => {
  const s = source();
  const missing: IdentitySource = { ...s, session: async () => null };
  await expect(
    resolveVerifiedActor(missing, url, ["founder@example.com"]),
  ).rejects.toThrow("UNAUTHENTICATED");
  s.currentUser.mockResolvedValue({
    ...(await s.currentUser()),
    totpEnrolled: true,
  });
  s.staff.mockResolvedValue(true);
  await expect(
    resolveVerifiedActor(s, url, ["founder@example.com"]),
  ).rejects.toThrow("MFA_REQUIRED");
});
it("does not let a newly refreshed provider timestamp bypass expired product-session history", async () => {
  const s = {
    ...(await mfaSource()),
    history: async () => {
      throw new Error("SESSION_EXPIRED");
    },
  };
  await expect(
    resolveVerifiedActor(s, url, ["founder@example.com"]),
  ).rejects.toThrow("SESSION_EXPIRED");
});

it("withholds factorless first-factor access rather than assuming the identity never had MFA", async () => {
  const s = source();
  await expect(
    resolveVerifiedActor(s, url, ["founder@example.com"]),
  ).rejects.toThrow("AUTH_POLICY_UNVERIFIED");
  expect(s.account).not.toHaveBeenCalled();
  expect(s.history).not.toHaveBeenCalled();
});

it("withholds a factorless identity even when an earlier signed token reports TOTP", async () => {
  const s = source();
  const claims = await s.verifiedClaims();
  s.verifiedClaims.mockResolvedValue({
    ...claims,
    aal: "aal2",
    amr: [...claims.amr, { method: "totp", timestamp: claims.iat }],
  });
  await expect(
    resolveVerifiedActor(s, url, ["founder@example.com"]),
  ).rejects.toThrow("AUTH_POLICY_UNVERIFIED");
  expect(s.account).not.toHaveBeenCalled();
});
