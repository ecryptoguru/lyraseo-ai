"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  authClient,
  resolveActor,
  identityDatabase,
} from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { requireFreshAuthentication } from "@lyraseo/db/context";
import { throttle } from "@lyraseo/db/identity";
export type Enrollment = {
  message: string;
  factorId?: string;
  qrCode?: string;
  manualKey?: string;
};
async function context() {
  const settings = authSettings();
  if (!settings || (await headers()).get("origin") !== settings.origin)
    throw new Error("FORBIDDEN");
  const actor = await resolveActor();
  requireFreshAuthentication(actor);
  await throttle(identityDatabase(), "enrollment", actor.userId, 5, 60000);
  return actor;
}
export async function enrollAuthenticator(): Promise<Enrollment> {
  try {
    await context();
  } catch {
    return {
      message:
        "Setup could not start. Sign in again before opening account security.",
    };
  }
  // Empty provider inventory cannot distinguish first enrollment from factor loss.
  // No trusted initial-enrollment issuer exists; never turn AAL1 into recovery.
  return {
    message:
      "Initial authenticator setup is unavailable until enrollment history is qualified. If you already have a verified authenticator, use backup setup after verifying it.",
  };
}
export async function enrollBackupAuthenticator(): Promise<Enrollment> {
  try {
    const actor = await context();
    if (!actor.mfaVerified) throw new Error("MFA_REQUIRED");
    const client = await authClient();
    const { data, error } = await client.auth.mfa.listFactors();
    if (
      error ||
      !data?.all.some(
        (factor) =>
          factor.factor_type === "totp" && factor.status === "verified",
      )
    )
      throw new Error("MFA_REQUIRED");
    // Provider I/O may take long enough for the session or access to change.
    const current = await resolveActor();
    requireFreshAuthentication(current);
    if (
      !current.mfaVerified ||
      current.userId !== actor.userId ||
      current.sessionId !== actor.sessionId ||
      current.securityVersion !== actor.securityVersion
    )
      throw new Error("MFA_REQUIRED");
    const result = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Backup authenticator ${new Date().toISOString().slice(0, 16)}`,
      issuer: "LyraSEO AI",
    });
    if (result.error || !result.data) throw result.error;
    return {
      message:
        "Set up this backup on a separate device or app, then enter its current code to confirm it.",
      factorId: result.data.id,
      qrCode: result.data.totp.qr_code,
      manualKey: result.data.totp.secret,
    };
  } catch {
    return {
      message:
        "Backup setup could not start. Sign in again and verify an existing authenticator before retrying.",
    };
  }
}
export async function confirmAuthenticator(
  _previous: Enrollment,
  form: FormData,
): Promise<Enrollment> {
  try {
    const actor = await context();
    if (!actor.mfaVerified) throw new Error("MFA_REQUIRED");
    const factorId = String(form.get("factorId") ?? ""),
      code = String(form.get("code") ?? "");
    if (!/^\d{6}$/.test(code)) throw new Error("INVALID_CODE");
    const client = await authClient();
    const { data, error } = await client.auth.mfa.listFactors();
    if (
      error ||
      !data?.all.some(
        (f) =>
          f.id === factorId &&
          f.factor_type === "totp" &&
          f.status === "unverified",
      ) ||
      !data.all.some((f) => f.factor_type === "totp" && f.status === "verified")
    )
      throw new Error("INVALID_FACTOR");
    const current = await resolveActor();
    requireFreshAuthentication(current);
    if (
      !current.mfaVerified ||
      current.userId !== actor.userId ||
      current.sessionId !== actor.sessionId ||
      current.securityVersion !== actor.securityVersion
    )
      throw new Error("MFA_REQUIRED");
    const result = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (result.error) throw result.error;
    const confirmed = await resolveActor();
    requireFreshAuthentication(confirmed);
    if (
      !confirmed.mfaVerified ||
      confirmed.userId !== actor.userId ||
      confirmed.sessionId !== actor.sessionId ||
      confirmed.securityVersion !== actor.securityVersion
    )
      throw new Error("MFA_REQUIRED");
  } catch {
    return {
      message:
        "The authenticator could not be confirmed. Enter a current code or sign in again.",
    };
  }
  redirect("/app/workspaces");
}
