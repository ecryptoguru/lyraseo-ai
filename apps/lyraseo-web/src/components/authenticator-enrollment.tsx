"use client";
import { useActionState, useState, useTransition } from "react";
import {
  enrollAuthenticator,
  enrollBackupAuthenticator,
  confirmAuthenticator,
  type Enrollment,
} from "@/app/app/security/actions";
export function AuthenticatorEnrollment({
  hasAuthenticator = false,
}: {
  hasAuthenticator?: boolean;
}) {
  const [setup, setSetup] = useState<Enrollment>({ message: "" }),
    [starting, start] = useTransition();
  const [result, confirm, pending] = useActionState<Enrollment, FormData>(
    confirmAuthenticator,
    { message: "" },
  );
  return (
    <>
      <p role="status">{setup.message}</p>
      {setup.factorId && setup.qrCode ? (
        <form action={confirm} className="auth-form">
          <img
            src={
              setup.qrCode.startsWith("data:image/svg+xml")
                ? setup.qrCode
                : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrCode)}`
            }
            alt="Authenticator setup QR code. Scan with your authenticator app."
            width="220"
            height="220"
          />
          {setup.manualKey && (
            <details>
              <summary>Enter setup key manually</summary>
              <code>{setup.manualKey}</code>
            </details>
          )}
          <input type="hidden" name="factorId" value={setup.factorId} />
          <label htmlFor="authenticator-code">Authenticator code</label>
          <input
            id="authenticator-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
          />
          <p role="status">{result.message}</p>
          <button className="button button-primary" disabled={pending}>
            {pending ? "Confirming…" : "Confirm authenticator"}
          </button>
        </form>
      ) : (
        <button
          className="button button-primary"
          disabled={starting}
          onClick={() =>
            start(async () => {
              try {
                setSetup(
                  await (hasAuthenticator
                    ? enrollBackupAuthenticator()
                    : enrollAuthenticator()),
                );
              } catch {
                setSetup({
                  message: "Setup could not be loaded. Please try again.",
                });
              }
            })
          }
        >
          {starting
            ? "Preparing…"
            : hasAuthenticator
              ? "Add backup authenticator"
              : "Set up authenticator"}
        </button>
      )}
    </>
  );
}
