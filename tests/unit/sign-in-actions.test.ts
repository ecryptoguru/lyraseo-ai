import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  throttle: vi.fn(),
  verifyOtp: vi.fn(),
  signInWithOtp: vi.fn(),
  signInWithOAuth: vi.fn(),
  resolveActor: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "http://localhost:3000" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({
    origin: "http://localhost:3000",
    allowedEmails: ["invited@example.com"],
  }),
}));
vi.mock("@/server/auth/server", () => ({
  authClient: async () => ({
    auth: {
      verifyOtp: mocks.verifyOtp,
      signInWithOtp: mocks.signInWithOtp,
      signInWithOAuth: mocks.signInWithOAuth,
    },
  }),
  identityDatabase: () => ({}),
  resolveActor: mocks.resolveActor,
}));
vi.mock("../../packages/db/src/identity", () => ({ throttle: mocks.throttle }));
import {
  signIn,
  googleSignIn,
} from "../../apps/lyraseo-web/src/app/sign-in/actions";
beforeEach(() => {
  vi.resetAllMocks();
});
const form = (email = "invited@example.com", code = "123456") => {
  const data = new FormData();
  data.set("email", email);
  if (code) data.set("code", code);
  return data;
};
it("preserves email and code entry after an invalid OTP", async () => {
  mocks.verifyOtp.mockResolvedValue({ error: new Error("invalid token") });
  const result = await signIn({ stage: "code", message: "" }, form());
  expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
  expect(result.stage).toBe("code");
  expect(result.email).toBe("invited@example.com");
});
it("enforces the global throttle before allocating per-address rows", async () => {
  mocks.throttle.mockRejectedValue(new Error("RATE_LIMITED"));
  await signIn({ stage: "email", message: "" }, form("random@example.com", ""));
  expect(mocks.throttle).toHaveBeenCalledTimes(1);
  expect(mocks.throttle.mock.calls[0]?.[1]).toBe("global-auth");
  expect(mocks.signInWithOtp).not.toHaveBeenCalled();
});
it("keeps uninvited address responses generic and never contacts the provider", async () => {
  const result = await signIn(
    { stage: "email", message: "" },
    form("unknown@example.com", ""),
  );
  expect(result.message).toContain("If this address");
  expect(mocks.signInWithOtp).not.toHaveBeenCalled();
});
it("returns a recoverable Google error for rate limits and provider failures", async () => {
  mocks.throttle.mockRejectedValueOnce(new Error("RATE_LIMITED"));
  expect((await googleSignIn()).message).toContain("email code");
  mocks.signInWithOAuth.mockRejectedValueOnce(new Error("network"));
  expect((await googleSignIn()).message).toContain("email code");
});
it("redirects after successful OAuth without swallowing the framework redirect", async () => {
  mocks.signInWithOAuth.mockResolvedValue({
    data: { url: "https://provider.example/authorize" },
    error: null,
  });
  await expect(googleSignIn()).rejects.toThrow(
    "REDIRECT:https://provider.example/authorize",
  );
});
