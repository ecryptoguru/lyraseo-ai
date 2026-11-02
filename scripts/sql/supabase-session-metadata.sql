-- Provider setup only: run as the project operator, outside Prisma product migrations.
-- No tokens, provider writes, definer privileges or browser access.
CREATE SCHEMA IF NOT EXISTS lyraseo_private;
REVOKE ALL ON SCHEMA lyraseo_private FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE VIEW lyraseo_private.session_metadata
WITH (security_invoker=true,security_barrier=true) AS
SELECT id,user_id,
       created_at AT TIME ZONE 'UTC' AS created_at,
       refreshed_at,
       not_after AT TIME ZONE 'UTC' AS not_after
FROM auth.sessions;
REVOKE ALL ON lyraseo_private.session_metadata FROM PUBLIC,anon,authenticated,lyraseo_runtime,lyraseo_migrator;
GRANT USAGE ON SCHEMA lyraseo_private TO lyraseo_identity;
GRANT SELECT ON lyraseo_private.session_metadata TO lyraseo_identity;
GRANT SELECT (id,user_id,created_at,refreshed_at,not_after) ON auth.sessions TO lyraseo_identity;
