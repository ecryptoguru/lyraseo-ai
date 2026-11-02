import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createDatabase } from "@lyraseo/db";
import { provisionIdentity, acceptSessionHistory } from "@lyraseo/db/identity";
import { withActor, type Actor } from "@lyraseo/db/context";
import { type SessionEvidence } from "./policy";
import { resolveVerifiedActor } from "./actor";
import { authSettings } from "./settings";
let product: ReturnType<typeof createDatabase> | undefined,
  identity: ReturnType<typeof createDatabase> | undefined;
export function database() {
  if (!authSettings()) throw new Error("AUTH_UNAVAILABLE");
  return (product ??= createDatabase(process.env.DATABASE_URL!));
}
export function identityDatabase() {
  if (!authSettings()) throw new Error("AUTH_UNAVAILABLE");
  return (identity ??= createDatabase(process.env.AUTH_DATABASE_URL!));
}
export async function authClient() {
  const settings = authSettings();
  if (!settings) throw new Error("AUTH_UNAVAILABLE");
  const jar = await cookies();
  return createServerClient(settings.url, settings.key, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (values) => {
        try {
          for (const { name, value, options } of values)
            jar.set(name, value, {
              ...options,
              httpOnly: true,
              sameSite: "lax",
              secure: settings.origin.startsWith("https:"),
            });
        } catch {
          /* Server components cannot write cookies; proxy performs refresh. */
        }
      },
    },
  });
}
export async function resolveActor(): Promise<Actor> {
  const settings = authSettings();
  if (!settings) throw new Error("AUTH_UNAVAILABLE");
  const client = await authClient();
  return resolveVerifiedActor(
    {
      currentUser: async () => {
        const {
          data: { user },
          error,
        } = await client.auth.getUser();
        return error || !user?.email
          ? null
          : {
              id: user.id,
              email: user.email,
              confirmed: Boolean(user.email_confirmed_at),
              totpEnrolled:
                user.factors?.some(
                  (f) => f.status === "verified" && f.factor_type === "totp",
                ) ?? false,
            };
      },
      verifiedClaims: async () => {
        const { data, error } = await client.auth.getClaims();
        return error || !data ? null : (data.claims as Record<string, unknown>);
      },
      session: async (id, subject) => {
        try {
          const rows = await identityDatabase().$queryRaw<
            NonNullable<SessionEvidence["session"]>[]
          >`SELECT id::text,user_id::text,created_at,refreshed_at,not_after FROM lyraseo_private.session_metadata WHERE id=${id}::uuid AND user_id=${subject}::uuid`;
          return rows[0] ?? null;
        } catch {
          throw new Error("AUTH_POLICY_UNVERIFIED");
        }
      },
      account: (subject) => provisionIdentity(identityDatabase(), subject),
      history: (actor, session) =>
        acceptSessionHistory(identityDatabase(), {
          sessionId: actor.sessionId,
          userId: actor.userId,
          securityVersion: actor.securityVersion,
          createdAt: session.created_at,
          refreshedAt: session.refreshed_at ?? session.created_at,
          authenticatedAt: new Date(actor.authenticatedAt),
        }),
      staff: async (actor) =>
        (
          await withActor(database(), actor, "", (tx) =>
            tx.staffGrant.findUnique({ where: { userId: actor.userId } }),
          )
        )?.enabled ?? false,
    },
    settings.url,
    settings.allowedEmails,
  );
}
