/** Unknown infrastructure errors must not masquerade as expired credentials. */
export function signInDestination(error: unknown): string | null {
  const code = error instanceof Error ? error.message : "";
  if (code === "MFA_REQUIRED") return "/sign-in?mfa=1";
  return [
    "UNAUTHENTICATED",
    "SESSION_EXPIRED",
    "FRESH_AUTH_REQUIRED",
    "FORBIDDEN",
  ].includes(code)
    ? "/sign-in"
    : null;
}
