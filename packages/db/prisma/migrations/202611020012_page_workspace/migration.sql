ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_workspaceId_siteId_id_key" UNIQUE("workspaceId","siteId","id");
CREATE TABLE "PageIdentity"("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"originalUrl" TEXT NOT NULL CHECK(length("originalUrl")<=2048),"normalizedUrl" TEXT NOT NULL CHECK(length("normalizedUrl")<=2048),"revision" INTEGER NOT NULL DEFAULT 1 CHECK("revision">0),"assignedTo" TEXT REFERENCES "ProductUser"(id),"createdBy" TEXT NOT NULL REFERENCES "ProductUser"(id),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE("workspaceId","siteId","normalizedUrl"),UNIQUE("workspaceId","siteId","id"),FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE CASCADE);
CREATE TABLE "PageJournal"("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"pageId" TEXT NOT NULL,"revision" INTEGER NOT NULL CHECK("revision">1),"action" TEXT NOT NULL CHECK("action" IN ('change','claim','unassign')),"note" TEXT NOT NULL CHECK(length("note")<=4000 AND octet_length("note")<=16000),"userId" TEXT NOT NULL REFERENCES "ProductUser"(id),"idempotencyKey" TEXT NOT NULL CHECK(length("idempotencyKey") BETWEEN 1 AND 128),"inputHash" TEXT NOT NULL,"contentDraftId" TEXT,"contentDraftRevision" INTEGER,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE("pageId","revision"),UNIQUE("workspaceId","pageId","userId","idempotencyKey"),FOREIGN KEY("workspaceId","siteId","pageId") REFERENCES "PageIdentity"("workspaceId","siteId","id") ON DELETE CASCADE,FOREIGN KEY("workspaceId","siteId","contentDraftId") REFERENCES "ContentDraft"("workspaceId","siteId","id"),FOREIGN KEY("contentDraftId","contentDraftRevision") REFERENCES "ContentRevision"("draftId","revision"),CHECK(("contentDraftId" IS NULL)=("contentDraftRevision" IS NULL)));
CREATE INDEX "PageIdentity_workspaceId_siteId_createdAt_id_idx" ON "PageIdentity"("workspaceId","siteId","createdAt","id");
CREATE INDEX "PageJournal_workspaceId_siteId_pageId_revision_idx" ON "PageJournal"("workspaceId","siteId","pageId","revision");
DO $$ DECLARE t text; r text; BEGIN
FOREACH t IN ARRAY ARRAY['PageIdentity','PageJournal'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY workspace_scope ON %I USING ("workspaceId"=current_setting(''app.workspace_id'',true)) WITH CHECK ("workspaceId"=current_setting(''app.workspace_id'',true))',t);
EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF; END LOOP;
END LOOP;
IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_runtime') THEN
GRANT SELECT,INSERT ON "PageIdentity","PageJournal" TO lyraseo_runtime;
GRANT UPDATE("revision","assignedTo") ON "PageIdentity" TO lyraseo_runtime;
END IF; END $$;
