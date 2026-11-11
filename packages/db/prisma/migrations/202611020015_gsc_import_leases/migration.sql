CREATE TABLE "SearchImport" (
 "id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,
 "property" TEXT NOT NULL,"startDate" TEXT NOT NULL,"endDate" TEXT NOT NULL,"shape" TEXT NOT NULL,
 "generation" INTEGER NOT NULL,"status" TEXT NOT NULL CHECK ("status" IN ('running','complete','failed')),
 "attempt" TEXT NOT NULL,"leaseUntil" TIMESTAMP(3) NOT NULL,"failure" TEXT,
 "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"completedAt" TIMESTAMP(3),
 FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE
);
CREATE INDEX "SearchImport_workspaceId_siteId_status_idx" ON "SearchImport"("workspaceId","siteId","status");
ALTER TABLE "SearchImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SearchImport" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON "SearchImport" USING ("workspaceId"=current_setting('app.workspace_id',true)) WITH CHECK ("workspaceId"=current_setting('app.workspace_id',true));
REVOKE ALL ON "SearchImport" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON "SearchImport" FROM %I',r); END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_runtime') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON "SearchImport" TO lyraseo_runtime; END IF;
END $$;
