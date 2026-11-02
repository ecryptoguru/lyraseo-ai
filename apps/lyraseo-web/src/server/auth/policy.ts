export type SessionEvidence = {
  subject: string;
  email: string;
  emailVerified: boolean;
  claims: Record<string, unknown>;
  session: {
    id: string;
    user_id: string;
    created_at: Date;
    refreshed_at: Date | null;
    not_after: Date | null;
  } | null;
  hasVerifiedFactor: boolean;
  staff: boolean;
};
const day = 86400000;
/** All claims and user fields must come from Supabase verification, never a decoded browser JWT. */
export function checkSessionPolicy(
  e: SessionEvidence,
  url: string,
  now = new Date(),
) {
  const c = e.claims,
    s = e.session,
    t = now.getTime();
  const fail = (code = "UNAUTHENTICATED"): never => {
    throw new Error(code);
  };
  if (
    !s ||
    !e.emailVerified ||
    !e.email ||
    s.user_id !== e.subject ||
    c.sub !== e.subject ||
    c.session_id !== s.id ||
    c.role !== "authenticated" ||
    c.iss !== `${url.replace(/\/$/, "")}/auth/v1` ||
    c.is_anonymous === true ||
    !(
      c.aud === "authenticated" ||
      (Array.isArray(c.aud) && c.aud.includes("authenticated"))
    )
  )
    fail();
  if (
    typeof c.exp !== "number" ||
    typeof c.iat !== "number" ||
    !Number.isFinite(c.exp) ||
    !Number.isFinite(c.iat) ||
    c.exp <= c.iat ||
    c.exp * 1000 <= t ||
    c.iat * 1000 > t + 30000
  )
    fail();
  if ((c.exp as number) - (c.iat as number) > 900)
    fail("AUTH_POLICY_UNVERIFIED");
  const session = s!;
  const created = session.created_at.getTime(),
    refreshed = (session.refreshed_at ?? session.created_at).getTime();
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(refreshed) ||
    (session.not_after !== null &&
      !Number.isFinite(session.not_after.getTime())) ||
    created > t + 30000 ||
    refreshed > t + 30000 ||
    refreshed < created
  )
    fail("AUTH_POLICY_UNVERIFIED");
  if (
    t - created >= 30 * day ||
    t - refreshed >= 7 * day ||
    (session.not_after && session.not_after.getTime() <= t)
  )
    fail("SESSION_EXPIRED");
  const amr = Array.isArray(c.amr)
    ? c.amr.filter(
        (a): a is { method: string; timestamp: number } =>
          typeof a === "object" &&
          a !== null &&
          typeof a.method === "string" &&
          typeof a.timestamp === "number" &&
          Number.isFinite(a.timestamp),
      )
    : [];
  if (
    !amr.length ||
    amr.some(
      (a) =>
        a.timestamp * 1000 > t + 30000 || a.timestamp * 1000 < created - 30000,
    )
  )
    fail();
  const first = amr.filter((a) => ["oauth", "otp"].includes(a.method));
  if (!first.length) fail("AUTH_POLICY_UNVERIFIED");
  const second = amr.filter((a) => ["totp", "mfa/totp"].includes(a.method));
  const mfaVerified = c.aal === "aal2" && second.length > 0;
  if ((e.hasVerifiedFactor || e.staff) && !mfaVerified) fail("MFA_REQUIRED");
  return {
    subject: e.subject,
    sessionId: session.id,
    authenticatedAt: new Date(
      Math.max(...first.map((a) => a.timestamp)) * 1000,
    ),
    mfaVerified,
    mfaAuthenticatedAt: second.length
      ? new Date(Math.max(...second.map((a) => a.timestamp)) * 1000)
      : undefined,
  };
}
