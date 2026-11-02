import { expect, it } from "vitest";
import { signInDestination } from "../../apps/lyraseo-web/src/server/auth/failures";
it("routes expired sessions and MFA challenges back to the appropriate sign-in step", () => {
  expect(signInDestination(new Error("SESSION_EXPIRED"))).toBe("/sign-in");
  expect(signInDestination(new Error("MFA_REQUIRED"))).toBe("/sign-in?mfa=1");
});
it("keeps infrastructure and configuration failures out of sign-in loops", () => {
  for (const error of [
    new Error("connection refused"),
    new Error("AUTH_POLICY_UNVERIFIED"),
    new Error("AUTH_UNAVAILABLE"),
    null,
  ])
    expect(signInDestination(error)).toBeNull();
});
