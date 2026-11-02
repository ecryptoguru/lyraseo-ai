CREATE TABLE "GoogleOAuthState" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"userId" TEXT NOT NULL,"sessionId" TEXT NOT NULL,"securityVersion" INTEGER NOT NULL,"verifier" TEXT NOT NULL,"expiresAt" TIMESTAMP(3) NOT NULL,"consumedAt" TIMESTAMP(3),FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE);
CREATE INDEX "GoogleOAuthState_workspaceId_siteId_idx" ON "GoogleOAuthState"("workspaceId","siteId");
CREATE TABLE "GoogleConnection" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL UNIQUE,UNIQUE("workspaceId","siteId"),"encryptedRefreshToken" TEXT NOT NULL,"property" TEXT,"generation" INTEGER NOT NULL DEFAULT 0,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE);
CREATE TABLE "SearchSnapshot" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"property" TEXT NOT NULL,"startDate" TEXT NOT NULL,"endDate" TEXT NOT NULL,"shape" TEXT NOT NULL,"status" TEXT NOT NULL,"rows" JSONB NOT NULL,"importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE,UNIQUE("workspaceId","siteId","property","startDate","endDate","shape"),CHECK("shape" IN ('page','query','date','query,page')),CHECK("status" IN ('complete','partial')),CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)<=100000));
CREATE INDEX "SearchSnapshot_workspaceId_siteId_importedAt_idx" ON "SearchSnapshot"("workspaceId","siteId","importedAt");
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['GoogleOAuthState','GoogleConnection','SearchSnapshot'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY workspace_scope ON %I USING ("workspaceId"=current_setting(''app.workspace_id'',true)) WITH CHECK ("workspaceId"=current_setting(''app.workspace_id'',true))',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
 END LOOP; END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_runtime') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON "GoogleOAuthState","GoogleConnection","SearchSnapshot" TO lyraseo_runtime; END IF;
END $$;
