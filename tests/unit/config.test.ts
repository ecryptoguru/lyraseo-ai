import { expect, it } from "vitest";
import { readConfig } from "../../apps/lyraseo-web/src/server/config";
it("allows zero-credential local fixtures with no live capabilities", () => {
  const c = readConfig({ NODE_ENV: "development" });
  expect(c.fixtureMode).toBe(true);
  expect(c.capabilities.audit).toBe(false);
  expect(c.capabilities.auth).toBe(false);
});
it("disables fixture mode on a hosted deployment", () => {
  expect(
    readConfig({
      NODE_ENV: "production",
      VERCEL: "1",
      ALLOW_LOCAL_FIXTURES: "true",
    }).fixtureMode,
  ).toBe(false);
});
it("does not expose any secret in public capability configuration", () => {
  const c = readConfig({
    NODE_ENV: "development",
    AZURE_OPENAI_API_KEY: "hidden-value",
  });
  expect(JSON.stringify(c)).not.toContain("hidden-value");
});
it("fails closed without complete authentication configuration", () => {
  expect(
    readConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://sample.supabase.co" })
      .capabilities.auth,
  ).toBe(false);
});
it("does not advertise an implemented auth adapter merely because keys exist", () => {
  const c = readConfig({
    NEXT_PUBLIC_SUPABASE_URL: "https://sample.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-example",
    DATABASE_URL: "postgresql://local",
  });
  expect(c.capabilities.auth).toBe(false);
});
