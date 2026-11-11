GRANT USAGE ON SCHEMA public TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "Workspace","Membership","Site","SiteGrant" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "AuditRun" TO lyraseo_runtime;
GRANT SELECT ON "AuditPage" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "ContentDraft" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "ContentRevision" TO lyraseo_runtime;
-- BEGIN REPORT PAYLOAD PRIVILEGE GUARD
-- A table revoke does not remove independent column ACLs. Remove both, including
-- PUBLIC. Unexpected effective inherited access fails closed without role changes.
REVOKE SELECT ON "EvidenceReport" FROM PUBLIC;
REVOKE SELECT(snapshot,pdf,csv) ON "EvidenceReport" FROM PUBLIC;
DO $report_acl$ DECLARE principal text; BEGIN
 FOREACH principal IN ARRAY ARRAY['lyraseo_runtime','lyraseo_identity','lyraseo_dispatch','lyraseo_operator','lyraseo_artifact_maintenance','anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=principal) THEN
   EXECUTE format('REVOKE SELECT ON public."EvidenceReport" FROM %I',principal);
   EXECUTE format('REVOKE SELECT(snapshot,pdf,csv) ON public."EvidenceReport" FROM %I',principal);
  END IF;
 END LOOP;
 FOREACH principal IN ARRAY ARRAY['lyraseo_runtime','lyraseo_identity','lyraseo_dispatch','lyraseo_operator','lyraseo_artifact_maintenance','anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=principal) AND
   (has_column_privilege(principal,'public."EvidenceReport"','snapshot','SELECT') OR
    has_column_privilege(principal,'public."EvidenceReport"','pdf','SELECT') OR
    has_column_privilege(principal,'public."EvidenceReport"','csv','SELECT') OR EXISTS(
     SELECT FROM pg_roles reachable WHERE
      (pg_has_role(principal,reachable.rolname::text,'USAGE') OR pg_has_role(principal,reachable.rolname::text,'SET')) AND
      (has_column_privilege(reachable.rolname::text,'public."EvidenceReport"','snapshot','SELECT') OR
       has_column_privilege(reachable.rolname::text,'public."EvidenceReport"','pdf','SELECT') OR
       has_column_privilege(reachable.rolname::text,'public."EvidenceReport"','csv','SELECT'))))
  THEN RAISE EXCEPTION 'UNSAFE_REPORT_PAYLOAD_PRIVILEGE: %',principal; END IF;
 END LOOP;
END $report_acl$;
-- END REPORT PAYLOAD PRIVILEGE GUARD
GRANT INSERT ON "EvidenceReport" TO lyraseo_runtime;
GRANT SELECT(id,"workspaceId","siteId",title,"createdAt") ON "EvidenceReport" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "VisibilityPanel" TO lyraseo_runtime;
GRANT INSERT ON "VisibilityRun" TO lyraseo_runtime;
GRANT SELECT(id,"workspaceId","siteId","panelId",profile,"rawExpiresAt","createdAt") ON "VisibilityRun" TO lyraseo_runtime;
-- Prefix20 predates these columns; full-head bootstrap keeps both grants.
DO $visibility_columns$ DECLARE column_ text; BEGIN
 FOREACH column_ IN ARRAY ARRAY['resultExpiresAt','storageFormat'] LOOP
  IF EXISTS(SELECT FROM pg_attribute WHERE attrelid='public."VisibilityRun"'::regclass AND attname=column_ AND NOT attisdropped) THEN
   EXECUTE format('GRANT SELECT(%I) ON public."VisibilityRun" TO lyraseo_runtime',column_);
  END IF;
 END LOOP;
END $visibility_columns$;
GRANT SELECT ON "ProductUser" TO lyraseo_runtime;
GRANT SELECT ON "ProviderIdentity","StaffGrant" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "OperationQuote","StepUpGrant","BudgetPeriod","Operation" TO lyraseo_runtime;
