-- Only in the populated disposable replay database, after history comparison.
INSERT INTO "Operation"(id,"workspaceId","siteId","userId","securityVersion","sessionId",kind,provider,period,route,"idempotencyKey","inputHash","tariffVersion","reservedCost","expiresAt","attemptState")
SELECT 'plan-'||n,'migration-workspace','migration-site','migration-owner',0,'fixture','GENERATION','AZURE','2026-11','plan','plan-'||n,'hash','fixture',0.3,now()+interval '1 day',
 CASE WHEN n=6001 THEN 'INTENT' ELSE 'NONE' END FROM generate_series(1,6001) n;
UPDATE "Operation" SET status='CANCELLED' WHERE id LIKE 'plan-%' AND length(id)>5 AND right(id,1) IN ('2','4','6','8','0');

INSERT INTO lyraseo_kernel.test_environment(database_oid) SELECT oid FROM pg_database WHERE datname=current_database();
INSERT INTO "Workspace"(id,name) SELECT 'plan-w'||n,'plan fixture' FROM generate_series(1,3) n;
INSERT INTO "Site"(id,"workspaceId",origin,"verifiedAt") SELECT 'plan-s'||n,'plan-w'||n,'https://example.com',now() FROM generate_series(1,3) n;
INSERT INTO "Membership"("workspaceId","userId",role) SELECT 'plan-w'||n,'migration-owner','OWNER' FROM generate_series(1,3) n;
INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion","createdAt")
 SELECT 'plan-a'||n,'plan-w'||n,'plan-s'||n,'migration-owner',0,'plan','h','[]','CONTROLLED_RAW_TEST_V1','{}','fixture',now()-interval '1 hour' FROM generate_series(1,3) n;
INSERT INTO "WorkDispatch"("workspaceId","siteId","userId","admittedSecurityVersion","auditId","targetKind",capability,profile,eligibility,"admittedAt","expiresAt",disposition,"nextAttemptAt","claimToken","leaseUntil","deliveredAt")
SELECT "workspaceId","siteId","userId",0,id,'AUDIT_RAW','audits',profile,'CONTROLLED_TEST',"createdAt",
 CASE WHEN id='plan-a1' THEN now()-interval '1 minute' ELSE now()+interval '1 hour' END,
 CASE WHEN id='plan-a3' THEN 'DELIVERED' ELSE 'PENDING' END, now()-interval '5 minutes',
 CASE WHEN id='plan-a2' THEN gen_random_uuid() END, CASE WHEN id='plan-a2' THEN now()-interval '1 minute' END,
 CASE WHEN id='plan-a3' THEN now()-interval '10 minutes' END
 FROM "AuditRun" WHERE id LIKE 'plan-a%';
ANALYZE "WorkDispatch";
