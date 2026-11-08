export const dynamic = "force-dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signInDestination } from "@/server/auth/failures";
import { authSettings } from "@/server/auth/settings";
import { resolveActor } from "@/server/auth/server";
import { AuthenticatorEnrollment } from "@/components/authenticator-enrollment";
export default async function Security() {
  if (!authSettings()) redirect("/sign-in");
  let hasAuthenticator = false;
  try {
    hasAuthenticator = (await resolveActor()).mfaVerified;
  } catch (error) {
    const destination = signInDestination(error);
    if (destination) redirect(destination);
    throw error;
  }
  return (
    <main id="main" className="pilot-page">
      <Link href="/app/workspaces">← Back to your workspace</Link>
      <div className="pilot-title">
        <p className="eyebrow">ACCOUNT SECURITY</p>
        <h1>Add authenticator protection.</h1>
        <p>
          Once enabled, an authenticator code is required after Google or email
          sign-in.
        </p>
      </div>
      <section className="pilot-card">
        <h2>Authenticator setup</h2>
        <p>
          Use a fresh sign-in from the last ten minutes. Add a backup on a
          separate device or authenticator app before you need it. Keep setup
          keys private.
        </p>
        <AuthenticatorEnrollment hasAuthenticator={hasAuthenticator} />
        <p>
          At sign-in, choose your backup authenticator if your usual device is
          unavailable. If you lose every enrolled authenticator, self-service
          factor recovery is not currently available.
        </p>
      </section>
    </main>
  );
}
