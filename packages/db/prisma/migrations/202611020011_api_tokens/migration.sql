CREATE TABLE "ApiToken" (
 "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
 "createdBy" TEXT NOT NULL REFERENCES "ProductUser"("id") ON DELETE CASCADE,
 "name" TEXT NOT NULL CHECK(length("name") BETWEEN 1 AND 80), "tokenHash" TEXT NOT NULL UNIQUE,
 "securityVersion" INTEGER NOT NULL, "accessPolicyHash" TEXT NOT NULL,
 "siteIds" TEXT[] NOT NULL CHECK(cardinality("siteIds") BETWEEN 1 AND 20),
 "scopes" TEXT[] NOT NULL CHECK(cardinality("scopes") BETWEEN 1 AND 3 AND "scopes" <@ ARRAY['sites:read','audits:read','search:read']::TEXT[]),
 "requestKey" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
 CHECK("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+INTERVAL '90 days'),
 UNIQUE("createdBy","workspaceId","requestKey")
);
CREATE INDEX "ApiToken_createdBy_workspaceId_createdAt_idx" ON "ApiToken"("createdBy","workspaceId","createdAt");
ALTER TABLE "ApiToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY token_read ON "ApiToken" FOR SELECT USING ("createdBy"=current_setting('app.actor_id',true) OR "tokenHash"=current_setting('app.token_hash',true));
CREATE POLICY token_insert ON "ApiToken" FOR INSERT WITH CHECK ("createdBy"=current_setting('app.actor_id',true) AND "workspaceId"=current_setting('app.workspace_id',true));
CREATE POLICY token_update ON "ApiToken" FOR UPDATE USING ("createdBy"=current_setting('app.actor_id',true) AND "workspaceId"=current_setting('app.workspace_id',true)) WITH CHECK ("createdBy"=current_setting('app.actor_id',true) AND "workspaceId"=current_setting('app.workspace_id',true));
CREATE TABLE "ApiThrottle"("key" TEXT PRIMARY KEY,"count" INTEGER NOT NULL,"expiresAt" TIMESTAMP(3) NOT NULL);
REVOKE ALL ON "ApiToken","ApiThrottle" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON "ApiToken","ApiThrottle" FROM %I',r); END IF; END LOOP;
IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_runtime') THEN GRANT SELECT,INSERT,UPDATE ON "ApiToken" TO lyraseo_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "ApiThrottle" TO lyraseo_runtime; END IF; END $$;
