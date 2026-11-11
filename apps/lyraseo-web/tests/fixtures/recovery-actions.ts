// Synthetic component-test actions; no provider or database is contacted.
export async function enrollAuthenticator() {
  throw new Error("Primary setup must not be used for a backup");
}
export async function enrollBackupAuthenticator() {
  return {
    message:
      "Set up this backup on a separate device or app, then enter its current code to confirm it.",
    factorId: "fixture-backup",
    qrCode:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/><path d="M10 10h25v25H10z M65 10h25v25H65z M10 65h25v25H10z M45 45h10v10H45z M65 65h10v10H65z M80 80h10v10H80z" fill="black"/></svg>',
    manualKey: "FIXTURE-ONLY-KEY",
  };
}
export async function confirmAuthenticator() {
  return {
    message:
      "The authenticator could not be confirmed. Enter a current code or sign in again.",
  };
}
