export function authSettings(
  env: Record<string, string | undefined> = process.env,
) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL,
    key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    origin = env.APP_ORIGIN;
  if (
    env.LYRA_AUTH_ENABLED !== "true" ||
    !url ||
    !key ||
    !origin ||
    !env.DATABASE_URL ||
    !env.AUTH_DATABASE_URL ||
    !env.PILOT_ALLOWED_EMAILS
  )
    return null;
  try {
    const app = new URL(origin),
      provider = new URL(url);
    if (
      provider.protocol !== "https:" ||
      app.origin !== origin ||
      !(
        app.protocol === "https:" ||
        (["localhost", "127.0.0.1"].includes(app.hostname) &&
          app.protocol === "http:")
      )
    )
      return null;
  } catch {
    return null;
  }
  return {
    url,
    key,
    origin,
    allowedEmails: env.PILOT_ALLOWED_EMAILS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
