-- Workspaces admit one free local audit at a time. Site scope remains on every row.
CREATE UNIQUE INDEX audit_one_active_workspace ON "AuditRun"("workspaceId") WHERE status IN ('QUEUED','RUNNING');
-- Retention cleanup may remove evidence with a privileged maintenance credential.
-- Restricted runtime still has no DELETE privilege; updates remain immutable.
DROP TRIGGER audit_page_immutable ON "AuditPage";
CREATE TRIGGER audit_page_immutable BEFORE UPDATE ON "AuditPage" FOR EACH ROW EXECUTE FUNCTION audit_immutable();
