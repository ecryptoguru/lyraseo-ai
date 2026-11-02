import { expect, it } from "vitest";
// @ts-expect-error Plain Node operator script, intentionally independent of the app bundle.
import { preflightConfig } from "../../scripts/auth-preflight.mjs";
const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://lyraseo-test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-test-key",
  APP_ORIGIN: "http://127.0.0.1:3000",
  DATABASE_URL:
    "postgresql://runtime.lyraseo-test:test@aws-1-ap-south-1.pooler.supabase.com/postgres",
  AUTH_DATABASE_URL:
    "postgresql://identity.lyraseo-test:test@aws-1-ap-south-1.pooler.supabase.com/postgres",
  PILOT_ALLOWED_EMAILS: "founder@example.com",
};
it("validates all prerequisites without leaking database secrets", () => {
  expect(preflightConfig(env)).toEqual({
    provider: env.NEXT_PUBLIC_SUPABASE_URL,
    key: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  expect(() => preflightConfig({})).toThrow("Missing configuration");
});
it("rejects unsafe origins, mixed projects and shared roles", () => {
  for (const override of [
    { NEXT_PUBLIC_SUPABASE_URL: "http://example.com" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://name:secret@example.com" },
    { APP_ORIGIN: "http://remote.example" },
    { AUTH_DATABASE_URL: env.DATABASE_URL },
    { AUTH_DATABASE_URL: "postgresql://identity:test@other.example/postgres" },
    { PILOT_ALLOWED_EMAILS: "," },
    {
      AUTH_DATABASE_URL:
        "postgresql://identity.other:test@aws-1-ap-south-1.pooler.supabase.com/postgres",
    },
  ])
    expect(() => preflightConfig({ ...env, ...override })).toThrow();
});
