INSERT INTO lyraseo_kernel.test_environment(database_oid,postmaster_started_at)
  SELECT oid,pg_catalog.pg_postmaster_start_time() FROM pg_database WHERE datname=current_database()
  ON CONFLICT(database_oid) DO UPDATE SET postmaster_started_at=EXCLUDED.postmaster_started_at;
GRANT USAGE ON SCHEMA public TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "Workspace","Membership","Site","SiteGrant" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "AuditRun" TO lyraseo_runtime;
GRANT SELECT ON "AuditPage" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "IssueAction","SiteContextRevision" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "SiteVerificationChallenge" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "AnalyticsOAuthState","AnalyticsConnection","AnalyticsImport" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "GoogleOAuthState","GoogleConnection","SearchSnapshot","SearchImport" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "ContentDraft" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "ContentRevision","EvidenceReport" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "VisibilityPanel" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "VisibilityRun" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "ApiToken" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "ApiThrottle" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "PageIdentity","PageJournal" TO lyraseo_runtime;
GRANT UPDATE("revision","assignedTo") ON "PageIdentity" TO lyraseo_runtime;
GRANT SELECT ON "ProductUser" TO lyraseo_runtime;
GRANT SELECT ON "ProviderIdentity","StaffGrant" TO lyraseo_runtime;
GRANT SELECT,INSERT,UPDATE ON "OperationQuote","StepUpGrant","BudgetPeriod","Operation" TO lyraseo_runtime;
GRANT SELECT,INSERT ON "UsageReceipt" TO lyraseo_runtime;

GRANT USAGE ON SCHEMA public TO lyraseo_identity;
GRANT SELECT,INSERT ON "ProductUser","ProviderIdentity" TO lyraseo_identity;
GRANT SELECT,INSERT,UPDATE,DELETE ON "AuthThrottle","ProductSession" TO lyraseo_identity;