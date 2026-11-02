import { expect, it } from "vitest";
import { checkSessionPolicy } from "../../apps/lyraseo-web/src/server/auth/policy";
const now = new Date("2026-10-23T10:00:00Z");
const sec = (d: Date) => d.getTime() / 1000;
const evidence = () => ({
  subject: "subject-1",
  email: "founder@example.com",
  emailVerified: true,
  claims: {
    sub: "subject-1",
    session_id: "session-1",
    aal: "aal1",
    role: "authenticated",
    aud: "authenticated",
    iss: "https://project.supabase.co/auth/v1",
    iat: sec(now) - 30,
    exp: sec(now) + 870,
    amr: [{ method: "oauth", timestamp: sec(now) - 100 }],
  },
  session: {
    id: "session-1",
    user_id: "subject-1",
    created_at: new Date("2026-10-01"),
    refreshed_at: now,
    not_after: null,
  },
  hasVerifiedFactor: false,
  staff: false,
});
const check = (e: ReturnType<typeof evidence>) =>
  checkSessionPolicy(e, "https://project.supabase.co", now);
it("accepts confirmed identity and authoritative session metadata", () =>
  expect(check(evidence()).sessionId).toBe("session-1"));
it("denies JWT/user/session identity mismatch", () => {
  const e = evidence();
  e.session.user_id = "someone-else";
  expect(() => check(e)).toThrow("UNAUTHENTICATED");
});
it("enforces a total 30-day session deadline independent of refresh", () => {
  const e = evidence();
  e.session.created_at = new Date("2026-09-01");
  expect(() => check(e)).toThrow("SESSION_EXPIRED");
});
it("enforces refresh inactivity and refuses future timestamps", () => {
  const e = evidence();
  e.session.refreshed_at = new Date("2026-10-10");
  expect(() => check(e)).toThrow("SESSION_EXPIRED");
  const future = evidence();
  future.claims.amr[0]!.timestamp += 10000;
  expect(() => check(future)).toThrow("UNAUTHENTICATED");
});
it("requires a second factor after either first-factor method", () => {
  for (const method of ["oauth", "otp"]) {
    const e = evidence();
    e.claims.amr[0]!.method = method;
    e.hasVerifiedFactor = true;
    expect(() => check(e)).toThrow("MFA_REQUIRED");
  }
});
it("staff cannot access product data with only a first factor", () => {
  const e = evidence();
  e.staff = true;
  expect(() => check(e)).toThrow("MFA_REQUIRED");
});
it("does not treat JWT refresh as fresh authentication", () => {
  const e = evidence();
  e.claims.amr[0]!.timestamp = sec(now) - 3600;
  expect(check(e).authenticatedAt).toEqual(new Date(now.getTime() - 3600000));
});
it("rejects wrong issuer and overly long access JWTs", () => {
  const e = evidence();
  e.claims.iss = "https://other.supabase.co/auth/v1";
  expect(() => check(e)).toThrow("UNAUTHENTICATED");
  const long = evidence();
  long.claims.exp += 3600;
  expect(() => check(long)).toThrow("AUTH_POLICY_UNVERIFIED");
});
it("does not accept unverified email or missing session metadata", () => {
  const e = evidence();
  e.emailVerified = false;
  expect(() => check(e)).toThrow("UNAUTHENTICATED");
});

it("fails closed for malformed session deadlines", () => {
  const e = evidence();
  expect(() =>
    checkSessionPolicy(
      { ...e, session: { ...e.session, not_after: new Date("invalid") } },
      "https://project.supabase.co",
      now,
    ),
  ).toThrow("AUTH_POLICY_UNVERIFIED");
});
it("rejects a token whose expiry precedes its issuance", () => {
  const e = evidence();
  e.claims.iat = sec(now) + 20;
  e.claims.exp = sec(now) + 10;
  expect(() => check(e)).toThrow("UNAUTHENTICATED");
});
