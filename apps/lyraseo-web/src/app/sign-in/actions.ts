"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  authClient,
  identityDatabase,
  resolveActor,
} from "@/server/auth/server";
import { authSettings } from "@/server/auth/settings";
import { throttle } from "@lyraseo/db/identity";
import { chooseVerifiedFactor } from "@/server/auth/factors";
export type SignInState = {
  message: string;
  stage: "email" | "code" | "mfa";
  email?: string;
};
async function context() {
  const settings = authSettings();
  if (!settings) throw new Error("AUTH_UNAVAILABLE");
  if ((await headers()).get("origin") !== settings.origin)
    throw new Error("FORBIDDEN");
  return settings;
}
export async function signIn(
  _previous: SignInState,
  form: FormData,
): Promise<SignInState> {
  let destination = false;
  const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase(),
    code = String(form.get("code") ?? "").trim();

  try {
    const settings = await context(),
      client = await authClient();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254)
      throw new Error("INVALID_EMAIL");
    await throttle(identityDatabase(), "global-auth", "pilot", 60, 60000);
    await throttle(
      identityDatabase(),
      code ? "verify" : "send",
      email,
      code ? 5 : 1,
      60000,
    );
    if (!settings.allowedEmails.includes(email))
      return {
        stage: "code",
        email,
        message:
          "If this address has a pilot invitation, a code will arrive shortly.",
      };
    if (!code) {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });
      if (error) throw error;
      return {
        stage: "code",
        email,
        message:
          "If this address has a pilot invitation, a code will arrive shortly.",
      };
    }
    if (!/^\d{6,10}$/.test(code)) throw new Error("INVALID_CODE");
    const { error } = await client.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error) throw error;
    try {
      await resolveActor();
      destination = true;
    } catch (error) {
      if ((error as Error).message === "MFA_REQUIRED")
        return {
          stage: "mfa",
          message: "Enter the code from your authenticator.",
        };
      throw error;
    }
  } catch {
    return {
      stage:
        code && /^\S+@\S+\.\S+$/.test(email) && email.length <= 254
          ? "code"
          : "email",
      email,
      message:
        "Sign-in could not be completed. Check your code or wait a minute before trying again.",
    };
  }
  if (destination) redirect("/app/workspaces");
  return { stage: "email", message: "Please try again." };
}
export async function googleSignIn(): Promise<{ message: string }> {
  let destination: string;
  try {
    const settings = await context();
    await throttle(identityDatabase(), "google", "pilot", 30, 60000);
    const { data, error } = await (
      await authClient()
    ).auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${settings.origin}/auth/callback` },
    });
    if (error || !data.url) throw new Error("OAUTH_UNAVAILABLE");
    destination = data.url;
  } catch {
    return {
      message:
        "Google sign-in is unavailable. Try again in a minute or use an email code.",
    };
  }
  redirect(destination);
}
export async function verifyMfa(
  _previous: SignInState,
  form: FormData,
): Promise<SignInState> {
  try {
    await context();
    const client = await authClient();
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) throw new Error("UNAUTHENTICATED");
    await throttle(identityDatabase(), "mfa", user.id, 5, 60000);
    const { data, error } = await client.auth.mfa.listFactors();
    const factor = chooseVerifiedFactor(
      data?.totp ?? [],
      String(form.get("factorId") ?? ""),
    );
    const code = String(form.get("mfa") ?? "");
    if (error || !factor || !/^\d{6}$/.test(code))
      throw new Error("MFA_REQUIRED");
    const result = await client.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code,
    });
    if (result.error) throw result.error;
    await resolveActor();
  } catch {
    return {
      stage: "mfa",
      message:
        "That authenticator code could not be verified. Try a current code.",
    };
  }
  redirect("/app/workspaces");
}
export async function signOut() {
  await context();
  await (await authClient()).auth.signOut({ scope: "local" });
  redirect("/sign-in");
}

export async function mfaChoices(): Promise<{ id: string; name: string }[]> {
  try {
    const settings = await context(),
      client = await authClient();
    const {
      data: { user },
    } = await client.auth.getUser();
    if (
      !user?.email_confirmed_at ||
      !user.email ||
      !settings.allowedEmails.includes(user.email.toLowerCase())
    )
      return [];
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) return [];
    return (data?.totp ?? [])
      .filter((f) => f.status === "verified")
      .map((f, index) => ({
        id: f.id,
        name: f.friendly_name || `Authenticator ${index + 1}`,
      }));
  } catch {
    return [];
  }
}
