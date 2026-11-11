-- Populated 017 installation. All values are synthetic; no immutable trigger is disabled.
INSERT INTO lyraseo_kernel.test_environment(database_oid,postmaster_started_at)
SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database();
INSERT INTO "Workspace"(id,name) VALUES ('controlled-workspace','Controlled fixture');
INSERT INTO "Membership"("workspaceId","userId",role) VALUES ('controlled-workspace','migration-owner','OWNER');
INSERT INTO "Site"(id,"workspaceId",origin,"verifiedAt") VALUES ('controlled-site','controlled-workspace','https://controlled.invalid',now());
INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion",status,fence,"leaseOwner","leaseUntil")
VALUES ('active-controlled','controlled-workspace','controlled-site','migration-owner',0,'controlled','hash','["https://example.com/known"]','CONTROLLED_RAW_TEST_V1','{}','readiness-v2','RUNNING',1,'worker',now()+interval '5 minutes');
INSERT INTO "WorkDispatch"("workspaceId","siteId","userId","admittedSecurityVersion","auditId","targetKind",capability,profile,eligibility,"admittedAt","expiresAt",disposition,"nextAttemptAt","claimToken","leaseUntil")
SELECT "workspaceId","siteId","userId",0,id,'AUDIT_RAW','audits',profile,'CONTROLLED_TEST',"createdAt","createdAt"+interval '1 hour','PENDING',now(),gen_random_uuid(),now()+interval '5 minutes' FROM "AuditRun" WHERE id='active-controlled';
INSERT INTO "AuditPage"(id,"auditId","workspaceId","requestedUrl",evidence,provenance)
SELECT 'clock-'||k,'active-controlled','controlled-workspace','https://example.com/'||k,'{"jsonLd":["private"]}',jsonb_build_object('acquiredAt',v,'rawHtml','private')
FROM (VALUES('known','2024-10-31T12:13:14.456Z'),('future','2999-01-01T00:00:00Z'),('invalid','2025-02-30T00:00:00Z'),('offset','2024-11-30T12:00:00+23:20')) f(k,v);
INSERT INTO "SearchSnapshot"(id,"workspaceId","siteId",property,"startDate","endDate",shape,status,rows,"importedAt")
VALUES('old-gsc','migration-workspace','migration-site','https://example.com/','2024-10-30','2024-10-31','page','complete','[{"clicks":3}]','2024-10-31 12:13:14.456');
INSERT INTO "SearchImport"(id,"workspaceId","siteId",property,"startDate","endDate",shape,generation,status,attempt,"leaseUntil","startedAt")
VALUES('old-import','migration-workspace','migration-site','https://example.com/','2024-10-30','2024-10-31','page',1,'complete','attempt',now(),'2024-10-31 12:13:14.456');
INSERT INTO "AnalyticsImport"(id,"workspaceId","siteId",property,"streamId","timeZone",origin,"startDate","endDate",shape,generation,status,"startedAt","importedAt","leaseUntil",attempt)
VALUES('old-ga4','migration-workspace','migration-site','property','stream','UTC','https://example.com','2024-10-30','2024-10-31','landing-organic-session-v1',1,'complete','2024-10-30','2024-10-31 12:13:14.456',now(),'attempt');
INSERT INTO "VisibilityPanel"(id,"workspaceId","siteId",version,prompts,brands,"createdBy") VALUES ('panel','migration-workspace','migration-site',1,'[]','[]','migration-owner');
INSERT INTO "VisibilityRun"(id,"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt")
VALUES('old-answer','migration-workspace','migration-site','panel','azure-sol-api','fixture','{}','[]','[{"body":"private answer"}]','2025-01-29','2024-10-31 12:13:14.456');
INSERT INTO "ContentDraft"(id,"workspaceId","siteId",kind,snapshot,"createdAt")
VALUES('old-draft','migration-workspace','migration-site','draft','{"historical":true}','2024-10-31');
INSERT INTO "ContentRevision"(id,"workspaceId","draftId",revision,content,"userId","createdAt")
VALUES('old-head','migration-workspace','old-draft',1,'{"body":"Original authored body"}','migration-owner','2024-10-31');
INSERT INTO "EvidenceReport"(id,"workspaceId","siteId",title,snapshot,pdf,csv)
VALUES('old-report','migration-workspace','migration-site','Original artifact','{"format":"saved-evidence-v2","historical":true}',decode('255044462d206f6c64','hex'),'immutable,old');
