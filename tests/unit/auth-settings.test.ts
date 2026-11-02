import { expect, it } from "vitest";
import { authSettings } from "../../apps/lyraseo-web/src/server/auth/settings";
const ready = {
  LYRA_AUTH_ENABLED: "true",
  NEXT_PUBLIC_SUPABASE_URL: "https://pilot.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-test-key",
  APP_ORIGIN: "http://127.0.0.1:3000",
  DATABASE_URL: "postgresql://runtime",
  AUTH_DATABASE_URL: "postgresql://identity",
  PILOT_ALLOWED_EMAILS: "Founder@example.com",
};
it("requires explicit opt-in and every private prerequisite", () => {
  expect(authSettings(ready)?.allowedEmails).toEqual(["founder@example.com"]);
  for (const key of Object.keys(ready)) {
    expect(authSettings({ ...ready, [key]: undefined })).toBeNull();
  }
});
it("rejects insecure remote origins and malformed public configuration", () => {
  expect(
    authSettings({ ...ready, APP_ORIGIN: "http://example.com" }),
  ).toBeNull();
  expect(
    authSettings({ ...ready, APP_ORIGIN: "https://example.com/path" }),
  ).toBeNull();
  expect(
    authSettings({ ...ready, NEXT_PUBLIC_SUPABASE_URL: "http://supabase.co" }),
  ).toBeNull();
});
