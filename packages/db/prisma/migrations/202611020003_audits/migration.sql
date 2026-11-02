CREATE TABLE "AuditRun" (
 "id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"siteId" TEXT NOT NULL,"userId" TEXT NOT NULL,"securityVersion" INTEGER NOT NULL,
 "idempotencyKey" TEXT NOT NULL,"inputHash" TEXT NOT NULL,"manifest" JSONB NOT NULL,"profile" TEXT NOT NULL,"declarations" JSONB NOT NULL,
 "methodologyVersion" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'QUEUED',"fence" INTEGER NOT NULL DEFAULT 0,"leaseOwner" TEXT,"leaseUntil" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"completedAt" TIMESTAMP(3),"evaluation" JSONB,
 UNIQUE("workspaceId","id"),UNIQUE("workspaceId","siteId","userId","idempotencyKey"),
 FOREIGN KEY("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE RESTRICT,
 FOREIGN KEY("userId") REFERENCES "ProductUser"("id") ON DELETE RESTRICT,
 CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED'))
);
CREATE UNIQUE INDEX audit_one_active ON "AuditRun"("workspaceId","siteId") WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX "AuditRun_workspaceId_siteId_createdAt_id_idx" ON "AuditRun"("workspaceId","siteId","createdAt","id");
CREATE TABLE "AuditPage" (
 "id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"auditId" TEXT NOT NULL,"requestedUrl" TEXT NOT NULL,"evidence" JSONB NOT NULL,"provenance" JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("auditId","requestedUrl"),FOREIGN KEY("workspaceId","auditId") REFERENCES "AuditRun"("workspaceId","id") ON DELETE RESTRICT
);
CREATE TABLE "IssueAction" (
 "id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"auditId" TEXT NOT NULL,"userId" TEXT NOT NULL,"ruleId" TEXT NOT NULL,"scopeKey" TEXT NOT NULL,"disposition" TEXT NOT NULL,"reason" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("workspaceId","auditId") REFERENCES "AuditRun"("workspaceId","id") ON DELETE RESTRICT,
 CHECK(disposition IN ('REVIEWED','DISMISSED','OPEN'))
);
CREATE INDEX "IssueAction_workspaceId_auditId_createdAt_idx" ON "IssueAction"("workspaceId","auditId","createdAt");
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['AuditRun','AuditPage','IssueAction'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY workspace_scope ON %I USING ("workspaceId"=current_setting(''app.workspace_id'',true)) WITH CHECK ("workspaceId"=current_setting(''app.workspace_id'',true))',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
 END LOOP; END LOOP;
END $$;
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME <> 'AuditRun' THEN RAISE EXCEPTION 'IMMUTABLE_AUDIT'; END IF;
 IF OLD.status IN ('COMPLETED','FAILED') OR
 ROW(NEW."workspaceId",NEW."siteId",NEW."userId",NEW."securityVersion",NEW."idempotencyKey",NEW."inputHash",NEW.manifest,NEW.profile,NEW.declarations,NEW."methodologyVersion",NEW."createdAt") IS DISTINCT FROM
 ROW(OLD."workspaceId",OLD."siteId",OLD."userId",OLD."securityVersion",OLD."idempotencyKey",OLD."inputHash",OLD.manifest,OLD.profile,OLD.declarations,OLD."methodologyVersion",OLD."createdAt")
 THEN RAISE EXCEPTION 'IMMUTABLE_AUDIT'; END IF; RETURN NEW; END $$;
CREATE TRIGGER audit_run_immutable BEFORE UPDATE ON "AuditRun" FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_page_immutable BEFORE UPDATE OR DELETE ON "AuditPage" FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER issue_action_immutable BEFORE UPDATE OR DELETE ON "IssueAction" FOR EACH ROW EXECUTE FUNCTION audit_immutable();
