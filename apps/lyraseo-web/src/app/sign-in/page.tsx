import Link from "next/link";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { authSettings } from "@/server/auth/settings";
import { SignInForm } from "@/components/sign-in-form";
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ mfa?: string; error?: string }>;
}) {
  const enabled = Boolean(authSettings());
  const query = await searchParams;
  return (
    <main id="main" className="auth-page">
      <Link href="/" className="back-link">
        <ArrowLeft size={17} /> Back to LyraSEO AI
      </Link>
      <div className="auth-panel">
        <img
          className="logo-on-light"
          src="/brand/logo-light.svg"
          alt="LyraSEO AI"
          width="210"
          height="42"
        />
        <img
          className="logo-on-dark"
          src="/brand/logo-dark.svg"
          alt="LyraSEO AI"
          width="210"
          height="42"
        />
        <LockKeyhole size={30} />
        <h1>
          Your workspace,
          <br />
          by invitation.
        </h1>
        <p>
          Private-pilot sign-in will use Google or an email code, with
          authenticator protection when enabled.
        </p>
        {query.error === "callback" && (
          <p role="status" className="notice">
            Sign-in could not be completed. Please start again with Google or an
            email code.
          </p>
        )}
        {enabled ? (
          <SignInForm mfa={query.mfa === "1"} />
        ) : (
          <>
            <div className="notice">
              Authentication and email delivery aren’t connected in this local
              build. No sign-in details are collected here.
            </div>
            <Link className="button button-primary" href="/app/audits">
              Explore the local sample
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
