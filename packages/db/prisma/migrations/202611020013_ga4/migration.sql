CREATE TABLE "AnalyticsOAuthState" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"userId" TEXT NOT NULL,"sessionId" TEXT NOT NULL,"securityVersion" INTEGER NOT NULL,"verifier" TEXT NOT NULL,"expiresAt" TIMESTAMP(3) NOT NULL,"consumedAt" TIMESTAMP(3),FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE);
CREATE INDEX "AnalyticsOAuthState_workspaceId_siteId_idx" ON "AnalyticsOAuthState"("workspaceId","siteId");
CREATE TABLE "AnalyticsConnection" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL UNIQUE,UNIQUE("workspaceId","siteId"),"encryptedRefreshToken" TEXT NOT NULL,"property" TEXT,"streamId" TEXT,"timeZone" TEXT,"status" TEXT NOT NULL DEFAULT 'connected',"catalog" JSONB NOT NULL DEFAULT '[]',"generation" INTEGER NOT NULL DEFAULT 0,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE);
CREATE TABLE "AnalyticsImport" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"property" TEXT NOT NULL,"streamId" TEXT NOT NULL,"timeZone" TEXT NOT NULL,"origin" TEXT NOT NULL,"startDate" TEXT NOT NULL,"endDate" TEXT NOT NULL,"shape" TEXT NOT NULL,"generation" INTEGER NOT NULL,"status" TEXT NOT NULL,"failure" TEXT,"rows" JSONB NOT NULL DEFAULT '[]',"diagnostics" JSONB NOT NULL DEFAULT '{}',"startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"importedAt" TIMESTAMP(3),"leaseUntil" TIMESTAMP(3) NOT NULL,"attempt" TEXT NOT NULL,FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE,CHECK("status" IN ('running','failed','complete','partial','no_data')),CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)<=10000));
CREATE INDEX "AnalyticsImport_workspaceId_siteId_startedAt_idx" ON "AnalyticsImport"("workspaceId","siteId","startedAt");
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['AnalyticsOAuthState','AnalyticsConnection','AnalyticsImport'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY workspace_scope ON %I USING ("workspaceId"=current_setting(''app.workspace_id'',true)) WITH CHECK ("workspaceId"=current_setting(''app.workspace_id'',true))',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
 END LOOP; END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_runtime') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON "AnalyticsOAuthState","AnalyticsConnection","AnalyticsImport" TO lyraseo_runtime; END IF;
END $$;
