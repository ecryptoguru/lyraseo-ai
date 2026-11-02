CREATE TABLE "ContentDraft" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"kind" TEXT NOT NULL CHECK("kind" IN ('brief','draft')),"revision" INTEGER NOT NULL DEFAULT 1,"snapshot" JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE("workspaceId","id"),FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE);
CREATE TABLE "ContentRevision" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"draftId" TEXT NOT NULL,"revision" INTEGER NOT NULL,"content" JSONB NOT NULL,"userId" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE("draftId","revision"),FOREIGN KEY("workspaceId","draftId") REFERENCES "ContentDraft"("workspaceId","id") ON DELETE CASCADE);
CREATE TABLE "EvidenceReport" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"title" TEXT NOT NULL,"snapshot" JSONB NOT NULL,"pdf" BYTEA NOT NULL,"csv" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE);
CREATE INDEX "ContentDraft_workspaceId_siteId_createdAt_idx" ON "ContentDraft"("workspaceId","siteId","createdAt");
CREATE INDEX "EvidenceReport_workspaceId_siteId_createdAt_idx" ON "EvidenceReport"("workspaceId","siteId","createdAt");
DO $$ DECLARE t text; r text; BEGIN
FOREACH t IN ARRAY ARRAY['ContentDraft','ContentRevision','EvidenceReport'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY workspace_scope ON %I USING ("workspaceId"=current_setting(''app.workspace_id'',true)) WITH CHECK ("workspaceId"=current_setting(''app.workspace_id'',true))',t);
EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
END LOOP; END LOOP;
IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_runtime') THEN
GRANT SELECT,INSERT,UPDATE ON "ContentDraft" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "ContentRevision","EvidenceReport" TO lyraseo_runtime;
END IF; END $$;
