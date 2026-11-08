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
    const { data, error } = await (
      await authClient()
    ).auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Authenticator ${new Date().toISOString().slice(0, 16)}`,
      issuer: "LyraSEO AI",
    });
    if (error || !data) throw error;
    return {
      message:
        "Scan this code with your authenticator, then enter its six-digit code to enable protection.",
      factorId: data.id,
      qrCode: data.totp.qr_code,
      manualKey: data.totp.secret,
    };
  } catch {
    return {
      message:
        "Setup could not start. Sign in again for a fresh session, then retry. An existing authenticator is still required if you have one.",
    };
  }
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
    await context();
    const factorId = String(form.get("factorId") ?? ""),
      code = String(form.get("code") ?? "");
    if (!/^\d{6}$/.test(code)) throw new Error("INVALID_CODE");
    const client = await authClient();
    const { data, error } = await client.auth.mfa.listFactors();
    if (
      error ||
      !data.all.some(
        (f) =>
          f.id === factorId &&
          f.factor_type === "totp" &&
          f.status === "unverified",
      )
    )
      throw new Error("INVALID_FACTOR");
    const result = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (result.error) throw result.error;
    await resolveActor();
  } catch {
    return {
      message:
        "The authenticator could not be confirmed. Enter a current code or sign in again.",
    };
  }
  redirect("/app/workspaces");
}
