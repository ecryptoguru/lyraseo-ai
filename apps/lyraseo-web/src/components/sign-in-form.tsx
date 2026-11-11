"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  signIn,
  verifyMfa,
  googleSignIn,
  mfaChoices,
  type SignInState,
} from "@/app/sign-in/actions";
const initial: SignInState = { message: "", stage: "email" };
export function SignInForm({ mfa = false }: { mfa?: boolean }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(
    signIn,
    {
      ...initial,
      stage: mfa ? "mfa" : "email",
    },
  );
  const [factor, factorAction, factorPending] = useActionState<
    SignInState,
    FormData
  >(verifyMfa, {
    ...initial,
    stage: "mfa",
  });
  const [google, googleAction, googlePending] = useActionState(googleSignIn, {
    message: "",
  });
  const [choices, setChoices] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const [reload, setReload] = useState(0);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.stage === "mfa") {
      let active = true;
      void mfaChoices()
        .then((items) => {
          if (active) setChoices(items);
        })
        .catch(() => {
          if (active) setChoices([]);
        });
      return () => {
        active = false;
      };
    }
  }, [state.stage, reload]);
  if (state.stage === "mfa")
    return (
      <form
        action={factorAction}
        className="auth-form"
        onReset={(event) => {
          // React resets the whole form after an action. Keep the chosen factor
          // for a retry while discarding the code that was just submitted.
          event.preventDefault();
          if (codeInput.current) codeInput.current.value = "";
        }}
      >
        <label htmlFor="factorId">Authenticator</label>
        <select id="factorId" name="factorId" required>
          <option value="">Choose your authenticator</option>
          {(choices ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <label htmlFor="mfa">Authenticator code</label>
        <input
          id="mfa"
          ref={codeInput}
          name="mfa"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
        <p role="status">
          {choices === null
            ? "Loading your authenticators…"
            : !choices.length
              ? "No verified authenticator is available, or the list could not be loaded. Retry or sign in again."
              : factor.message || state.message}
        </p>
        {choices?.length === 0 && (
          <>
            <p>
              New staff should enroll and verify an authenticator before a staff
              grant is assigned. If a staff grant is already assigned and no
              factor is available, contact your administrator. Self-service
              factor reset is not available.
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setChoices(null);
                setReload((value) => value + 1);
              }}
            >
              Retry loading authenticators
            </button>
          </>
        )}
        <a href="/sign-in">Start sign-in again</a>
        <details>
          <summary>Lost access to your usual authenticator?</summary>
          <p>
            Choose an already enrolled backup authenticator above and enter its
            current code. If you have lost every enrolled authenticator,
            self-service factor recovery is not currently available.
          </p>
        </details>
        <button
          className="button button-primary"
          disabled={factorPending || !choices?.length}
        >
          {factorPending ? "Verifying…" : "Verify code"}
        </button>
      </form>
    );
  return (
    <>
      <form action={googleAction}>
        <button
          className="button button-secondary"
          type="submit"
          disabled={googlePending}
        >
          {googlePending ? "Connecting to Google…" : "Continue with Google"}
        </button>
        <p role="status">{google.message}</p>
      </form>
      <form action={action} className="auth-form">
        <label htmlFor="email">Invited email address</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={state.email}
          maxLength={254}
          required
        />
        {state.stage === "code" && (
          <>
            <label htmlFor="code">Email code</label>
            <input
              id="code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6,10}"
              maxLength={10}
              required
            />
          </>
        )}
        <p role="status">{state.message}</p>
        <button className="button button-primary" disabled={pending}>
          {pending
            ? "Please wait…"
            : state.stage === "code"
              ? "Verify email code"
              : "Send email code"}
        </button>
      </form>
      {state.stage === "code" && (
        <a href="/sign-in">Use another address or request a new code</a>
      )}
    </>
  );
}
