-- Pre-cutover operations include SQL-absent input, JSON literal null and
-- both settled/terminal and genuinely outstanding internal financial facts.
INSERT INTO "ProductUser"(id) VALUES ('migration-owner');
INSERT INTO "Workspace"(id,name) VALUES ('migration-workspace','Retained baseline');
INSERT INTO "Membership"("workspaceId","userId",role) VALUES ('migration-workspace','migration-owner','OWNER');
INSERT INTO "Site"(id,"workspaceId",origin,"verifiedAt")
 VALUES ('migration-site','migration-workspace','https://example.com',current_timestamp);
INSERT INTO "Operation"(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,route,
 "idempotencyKey","inputHash","requestInput","tariffVersion","reservedCost","actualCost",status,"expiresAt",
 "attemptState","providerTaskId",fence,"leaseOwner","leaseUntil","settledAt")
SELECT id,'migration-workspace','migration-site','migration-owner','baseline-session',0,'GENERATION','AZURE',
 '2026-11','/fixture',id,'hash',payload,'fixture-only',0.5,actual,status,now()+interval '1 day',attempt,task,fence,
 CASE WHEN status='RUNNING' THEN 'worker' END, CASE WHEN status='RUNNING' THEN now()+interval '2 minutes' END,
 CASE WHEN actual IS NOT NULL THEN now() END
FROM (VALUES
 ('absent','QUEUED','NONE',NULL::jsonb,NULL::text,0,NULL::numeric),
 ('json-null','QUEUED','NONE','null'::jsonb,NULL,0,NULL),
 ('active','RUNNING','NONE','{"retained":true}'::jsonb,NULL,3,NULL),
 ('intent','RUNNING','INTENT',NULL::jsonb,NULL,4,NULL),
 ('accepted','WAITING_PROVIDER','ACCEPTED','null'::jsonb,'task-accepted',5,NULL),
 ('ambiguous','RECONCILING','ACCEPTED',NULL::jsonb,NULL,6,NULL),
 ('overage','RECONCILING','ACCEPTED','{}'::jsonb,'task-overage',7,0.875),
 ('terminal','FAILED','ACCEPTED','{"retained":true}'::jsonb,'task-terminal',8,0.125)
) fixture(id,status,attempt,payload,task,fence,actual);
INSERT INTO "OutboxEvent"(id,"operationId","workspaceId","userId","deliveredAt",attempts)
 SELECT 'archive-'||id,id,"workspaceId","userId",CASE WHEN id IN ('active','accepted','overage','terminal') THEN now() END,
  CASE WHEN id IN ('active','accepted','overage','terminal') THEN 2 ELSE 0 END FROM "Operation" WHERE id<>'terminal';
INSERT INTO "UsageReceipt"(id,"operationId","workspaceId","userId",provider,"receiptId",amount,"acceptedOutput")
 SELECT 'receipt-'||id,id,"workspaceId","userId",provider,'fixture-'||id,"actualCost",id='overage' FROM "Operation" WHERE "settledAt" IS NOT NULL;
INSERT INTO "BudgetPeriod"(id,"userId",period,bucket,"limit",spent,reserved)
 VALUES ('combined','migration-owner','2026-11','COMBINED',10,1,3),('azure','migration-owner','2026-11','AZURE',8,1,3);
INSERT INTO "OperationQuote"(id,"userId","workspaceId","siteId",kind,provider,route,"inputHash","maximumCost","tariffVersion","securityVersion","expiresAt","consumedOperationId","requestInput")
 SELECT 'quote-'||id,"userId","workspaceId","siteId",kind,provider,route,"inputHash","reservedCost","tariffVersion","securityVersion","expiresAt",id,"requestInput" FROM "Operation" WHERE id='json-null';
-- Exercise grants from the old bootstrap, even in a newly provisioned cluster.
GRANT SELECT,INSERT,UPDATE ON "Operation","OutboxEvent","UsageReceipt" TO lyraseo_runtime;
