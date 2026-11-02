import type { Actor } from "@lyraseo/db/context";
import { checkSessionPolicy, type SessionEvidence } from "./policy";
export type IdentitySource = {
  currentUser: () => Promise<{
    id: string;
    email: string;
    confirmed: boolean;
    totpEnrolled: boolean;
  } | null>;
  verifiedClaims: () => Promise<Record<string, unknown> | null>;
  session: (id: string, subject: string) => Promise<SessionEvidence["session"]>;
  account: (
    subject: string,
  ) => Promise<{ id: string; securityVersion: number }>;
  staff: (actor: Actor) => Promise<boolean>;
  history: (
    actor: Actor,
    session: NonNullable<SessionEvidence["session"]>,
  ) => Promise<unknown>;
};
/** Provider adapters supply verified data; HTTP callers cannot supply this structure. */
export async function resolveVerifiedActor(
  source: IdentitySource,
  url: string,
  allowedEmails: string[],
): Promise<Actor> {
  const user = await source.currentUser();
  if (
    !user ||
    !user.confirmed ||
    !allowedEmails.includes(user.email.toLowerCase())
  )
    throw new Error("UNAUTHENTICATED");
  const claims = await source.verifiedClaims();
  if (
    !claims ||
    typeof claims.session_id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(claims.session_id) ||
    claims.sub !== user.id
  )
    throw new Error("UNAUTHENTICATED");
  const evidence: SessionEvidence = {
    subject: user.id,
    email: user.email,
    emailVerified: user.confirmed,
    claims,
    session: await source.session(claims.session_id, user.id),
    hasVerifiedFactor: user.totpEnrolled,
    staff: false,
  };
  const checked = checkSessionPolicy(evidence, url);
  const account = await source.account(user.id);
  const actor: Actor = {
    userId: account.id,
    sessionId: checked.sessionId,
    securityVersion: account.securityVersion,
    authenticatedAt: checked.authenticatedAt.toISOString(),
    mfaVerified: checked.mfaVerified,
    mfaAuthenticatedAt: checked.mfaAuthenticatedAt?.toISOString(),
    authProvider: "supabase",
  };
  checkSessionPolicy({ ...evidence, staff: await source.staff(actor) }, url);
  await source.history(actor, evidence.session!);
  return actor;
}
