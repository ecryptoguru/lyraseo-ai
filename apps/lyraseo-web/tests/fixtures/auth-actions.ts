// Browser-only contract doubles. Never imported by application routes.
let attempts = 0;
export async function signIn(_state: unknown, form: FormData) {
  return {
    stage: "code",
    email: String(form.get("email")),
    message: form.get("code")
      ? "Check your code and try again."
      : "Check your email for a code.",
  };
}
export async function googleSignIn() {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { message: "Google sign-in is unavailable. Use an email code." };
}
export async function verifyMfa() {
  return { stage: "mfa", message: "Try a current code." };
}
export async function mfaChoices() {
  if (++attempts === 1) throw new Error("Temporary network failure");
  return [{ id: "backup", name: "Backup authenticator" }];
}
