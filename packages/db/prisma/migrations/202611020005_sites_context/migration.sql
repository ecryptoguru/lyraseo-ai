CREATE TABLE "SiteVerificationChallenge" (
 "id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"tokenHash" TEXT NOT NULL,"issuedBy" TEXT NOT NULL,"securityVersion" INTEGER NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"consumedAt" TIMESTAMP(3),"revokedAt" TIMESTAMP(3),
 FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE RESTRICT,
 FOREIGN KEY("issuedBy") REFERENCES "ProductUser"("id") ON DELETE RESTRICT,
 CHECK(length("tokenHash")=64)
);
CREATE INDEX "SiteVerificationChallenge_workspaceId_siteId_createdAt_idx" ON "SiteVerificationChallenge"("workspaceId","siteId","createdAt");
CREATE TABLE "SiteContextRevision" (
 "id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"revision" INTEGER NOT NULL,"content" JSONB NOT NULL,"reviewedBy" TEXT NOT NULL,"reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("workspaceId","siteId","revision"),CHECK(revision>0),CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=65536),
 FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE RESTRICT,
 FOREIGN KEY("reviewedBy") REFERENCES "ProductUser"("id") ON DELETE RESTRICT
);
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['SiteVerificationChallenge','SiteContextRevision'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY workspace_scope ON %I USING ("workspaceId"=current_setting(''app.workspace_id'',true)) WITH CHECK ("workspaceId"=current_setting(''app.workspace_id'',true))',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
 END LOOP; END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_runtime') THEN
 GRANT SELECT,INSERT,UPDATE ON "SiteVerificationChallenge" TO lyraseo_runtime;
 GRANT SELECT,INSERT ON "SiteContextRevision" TO lyraseo_runtime;
 END IF;
END $$;
CREATE FUNCTION site_context_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_SITE_CONTEXT'; END $$;
CREATE TRIGGER site_context_immutable BEFORE UPDATE OR DELETE ON "SiteContextRevision" FOR EACH ROW EXECUTE FUNCTION site_context_immutable();
