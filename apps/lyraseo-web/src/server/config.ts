import { authSettings } from "./auth/settings";
type Environment = Record<string, string | undefined>;
/** Safe capability metadata only. Never return provider credentials. */
export function readConfig(env: Environment = process.env) {
  const fixtureMode =
    env.VERCEL !== "1" &&
    (env.NODE_ENV === "development" || env.ALLOW_LOCAL_FIXTURES === "true");
  const authConfigured = Boolean(
    env.NEXT_PUBLIC_SUPABASE_URL &&
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    env.DATABASE_URL,
  );
  return {
    fixtureMode,
    configuration: { authConfigured },
    capabilities: {
      auth: Boolean(authSettings(env)),
      audit: false,
      generation: false,
      research: false,
      observations: false,
    },
    phase: "private-pilot" as const,
  };
}
