INSERT INTO "AuditRun"(id,"workspaceId","siteId","userId","securityVersion","idempotencyKey","inputHash",manifest,profile,declarations,"methodologyVersion",status,fence,"leaseOwner","leaseUntil",evaluation)
SELECT id,'migration-workspace','migration-site','migration-owner',0,id,'hash','["https://example.com/"]',
 'LOCAL_RAW_V1','{}',method,status,fence,lease,lease_until,result
FROM (VALUES ('old-audit','readiness-v1','COMPLETED',4,NULL::text,NULL::timestamp,'{"historical":true}'::jsonb),
 ('current-audit','readiness-v2','RUNNING',5,'local-worker',now()::timestamp-interval '1 minute',NULL::jsonb))
 fixture(id,method,status,fence,lease,lease_until,result);
INSERT INTO "AuditPage"(id,"auditId","workspaceId","requestedUrl",evidence,provenance)
 VALUES ('immutable-page','old-audit','migration-workspace','https://example.com/','{"raw":true}','{"method":"fixture"}');
