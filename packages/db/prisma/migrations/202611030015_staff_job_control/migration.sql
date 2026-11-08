-- Target-scoped local rehearsal only. A production issuer must be qualified before
-- these functions can perform transitions outside the sealed test database.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ DECLARE r pg_roles; BEGIN
 SELECT * INTO r FROM pg_roles WHERE rolname='lyraseo_staff_job_owner';
 IF NOT FOUND OR r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
 OR EXISTS(SELECT FROM pg_database WHERE datdba=r.oid)
 OR EXISTS(SELECT FROM pg_namespace WHERE nspowner=r.oid)
 OR EXISTS(SELECT FROM pg_proc WHERE proowner=r.oid)
 OR EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN('r','p','v','m') AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 THEN RAISE EXCEPTION 'UNSAFE_STAFF_JOB_ROLE'; END IF;
END $$;
GRANT USAGE,CREATE ON SCHEMA lyraseo_billing TO lyraseo_staff_job_owner;
GRANT USAGE ON SCHEMA public,lyraseo_kernel TO lyraseo_staff_job_owner;
GRANT EXECUTE ON FUNCTION lyraseo_billing.actor_valid(jsonb,boolean,text,boolean),lyraseo_billing.rate_staff(text,text,integer) TO lyraseo_staff_job_owner;
GRANT SELECT ON lyraseo_billing.staff_epoch,lyraseo_billing.staff_capability TO lyraseo_staff_job_owner;
GRANT SELECT,INSERT ON lyraseo_billing.step_up TO lyraseo_staff_job_owner;
GRANT UPDATE(consumed_at,request_hash,result) ON lyraseo_billing.step_up TO lyraseo_staff_job_owner;
GRANT INSERT ON lyraseo_billing.staff_receipt TO lyraseo_staff_job_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON lyraseo_billing.staff_rate TO lyraseo_staff_job_owner;
CREATE POLICY job_control ON lyraseo_billing.staff_epoch FOR SELECT TO lyraseo_staff_job_owner USING(true);
CREATE POLICY job_control ON lyraseo_billing.staff_capability FOR SELECT TO lyraseo_staff_job_owner USING(true);
CREATE POLICY job_control ON lyraseo_billing.step_up TO lyraseo_staff_job_owner USING(true) WITH CHECK(true);
CREATE POLICY job_control ON lyraseo_billing.staff_receipt FOR INSERT TO lyraseo_staff_job_owner WITH CHECK(true);
CREATE POLICY job_control ON lyraseo_billing.staff_rate TO lyraseo_staff_job_owner USING(true) WITH CHECK(true);
GRANT SELECT(id,suspended,"securityVersion") ON public."ProductUser" TO lyraseo_staff_job_owner;
GRANT UPDATE(id) ON public."ProductUser" TO lyraseo_staff_job_owner;
GRANT SELECT("sessionId","userId","securityVersion","createdAt","refreshedAt") ON public."ProductSession" TO lyraseo_staff_job_owner;
GRANT UPDATE("sessionId") ON public."ProductSession" TO lyraseo_staff_job_owner;
GRANT SELECT(id,"deletedAt") ON public."Workspace" TO lyraseo_staff_job_owner;
GRANT UPDATE(id) ON public."Workspace" TO lyraseo_staff_job_owner;
CREATE POLICY job_control_read ON public."Workspace" FOR SELECT TO lyraseo_staff_job_owner USING(true);
CREATE POLICY job_control_lock ON public."Workspace" FOR UPDATE TO lyraseo_staff_job_owner USING(true) WITH CHECK(false);
GRANT SELECT("workspaceId",id,"verifiedAt","deletedAt") ON public."Site" TO lyraseo_staff_job_owner;
GRANT SELECT("workspaceId","userId",role) ON public."Membership" TO lyraseo_staff_job_owner;
CREATE POLICY job_control_read ON public."Site" FOR SELECT TO lyraseo_staff_job_owner USING(true);
CREATE POLICY job_control_read ON public."Membership" FOR SELECT TO lyraseo_staff_job_owner USING(true);
GRANT SELECT(id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,"reservedCost",status,"expiresAt","cancelRequestedAt","leaseUntil",fence,"attemptState","providerTaskId","settledAt","actualCost") ON public."Operation" TO lyraseo_staff_job_owner;
GRANT SELECT("userId",period,bucket,"limit",spent,reserved) ON public."BudgetPeriod" TO lyraseo_staff_job_owner;
CREATE POLICY job_control_read ON public."Operation" FOR SELECT TO lyraseo_staff_job_owner USING(true);
CREATE POLICY job_control_read ON public."BudgetPeriod" FOR SELECT TO lyraseo_staff_job_owner USING(true);
ALTER TABLE lyraseo_billing.staff_capability DROP CONSTRAINT staff_capability_action_check;
ALTER TABLE lyraseo_billing.staff_capability ADD CONSTRAINT staff_capability_action_check CHECK(action IN('billing:reconcile','policy:pause','recovery:manage','support:search','privacy:read','jobs:manage'));
-- A request identifier acquires durable server-authenticated principal ownership
-- before the browser may persist it or submit any executable preparation.
CREATE TABLE lyraseo_billing.job_allocation (
 id uuid PRIMARY KEY, staff_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(id,staff_id)
);
ALTER TABLE lyraseo_billing.job_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_billing.job_allocation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON lyraseo_billing.job_allocation FROM PUBLIC,lyraseo_runtime,lyraseo_staff_executor;
GRANT SELECT,INSERT ON lyraseo_billing.job_allocation TO lyraseo_staff_job_owner;
CREATE POLICY job_control ON lyraseo_billing.job_allocation TO lyraseo_staff_job_owner USING(true) WITH CHECK(true);
CREATE TABLE lyraseo_billing.job_request (
 id uuid PRIMARY KEY, staff_id text NOT NULL, session_id text NOT NULL, security_version integer NOT NULL,
 action text NOT NULL, target text NOT NULL, expected_fence integer NOT NULL, request_hash text NOT NULL,
 token_hash text NOT NULL REFERENCES lyraseo_billing.step_up(token_hash), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(id,staff_id) REFERENCES lyraseo_billing.job_allocation(id,staff_id)
);
ALTER TABLE lyraseo_billing.job_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_billing.job_request FORCE ROW LEVEL SECURITY;
REVOKE ALL ON lyraseo_billing.job_request FROM PUBLIC,lyraseo_runtime,lyraseo_staff_executor;
GRANT SELECT,INSERT,UPDATE(token_hash) ON lyraseo_billing.job_request TO lyraseo_staff_job_owner;
CREATE POLICY job_control ON lyraseo_billing.job_request TO lyraseo_staff_job_owner USING(true) WITH CHECK(true);
-- A tombstone seals an abandoned or never-prepared request before the browser
-- releases its reference. It uses the same request lock as prepare/execute.
CREATE TABLE lyraseo_billing.closed_job_request (
 id uuid PRIMARY KEY, staff_id text NOT NULL, session_id text NOT NULL,
 security_version integer NOT NULL, closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(id,staff_id) REFERENCES lyraseo_billing.job_allocation(id,staff_id)
);
ALTER TABLE lyraseo_billing.closed_job_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_billing.closed_job_request FORCE ROW LEVEL SECURITY;
REVOKE ALL ON lyraseo_billing.closed_job_request FROM PUBLIC,lyraseo_runtime,lyraseo_staff_executor;
GRANT SELECT,INSERT ON lyraseo_billing.closed_job_request TO lyraseo_staff_job_owner;
CREATE POLICY job_control ON lyraseo_billing.closed_job_request TO lyraseo_staff_job_owner USING(true) WITH CHECK(true);
CREATE TABLE lyraseo_billing.job_test_session (
 database_oid oid NOT NULL, postmaster_started_at timestamptz NOT NULL,
 user_id text NOT NULL, session_id text NOT NULL, security_version integer NOT NULL,
 expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(database_oid,postmaster_started_at,user_id,session_id)
);
ALTER TABLE lyraseo_billing.job_test_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_billing.job_test_session FORCE ROW LEVEL SECURITY;
REVOKE ALL ON lyraseo_billing.job_test_session FROM PUBLIC,lyraseo_runtime,lyraseo_staff_executor,lyraseo_staff_job_owner;
GRANT SELECT,UPDATE(user_id) ON lyraseo_billing.job_test_session TO lyraseo_staff_job_owner;
CREATE POLICY job_test_lock ON lyraseo_billing.job_test_session FOR UPDATE TO lyraseo_staff_job_owner USING(true) WITH CHECK(false);
CREATE POLICY job_test_read ON lyraseo_billing.job_test_session FOR SELECT TO lyraseo_staff_job_owner USING(true);
GRANT SELECT ON lyraseo_kernel.test_environment TO lyraseo_staff_job_owner;
CREATE POLICY job_test_read ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_staff_job_owner USING(true);
GRANT SELECT("workspaceId","siteId","userId") ON public."SiteGrant" TO lyraseo_staff_job_owner;
GRANT UPDATE("userId") ON public."Membership",public."SiteGrant" TO lyraseo_staff_job_owner;
GRANT UPDATE(id) ON public."Site" TO lyraseo_staff_job_owner;
CREATE POLICY job_control_read ON public."SiteGrant" FOR SELECT TO lyraseo_staff_job_owner USING(true);
CREATE POLICY job_control_lock ON public."SiteGrant" FOR UPDATE TO lyraseo_staff_job_owner USING(true) WITH CHECK(false);
CREATE POLICY job_control_lock ON public."Membership" FOR UPDATE TO lyraseo_staff_job_owner USING(true) WITH CHECK(false);
CREATE POLICY job_control_lock ON public."Site" FOR UPDATE TO lyraseo_staff_job_owner USING(true) WITH CHECK(false);
GRANT UPDATE(status,"cancelRequestedAt","settledAt","leaseOwner","leaseUntil",fence) ON public."Operation" TO lyraseo_staff_job_owner;
GRANT UPDATE(reserved) ON public."BudgetPeriod" TO lyraseo_staff_job_owner;
CREATE POLICY job_control_update ON public."Operation" FOR UPDATE TO lyraseo_staff_job_owner USING(true) WITH CHECK(true);
CREATE POLICY job_control_update ON public."BudgetPeriod" FOR UPDATE TO lyraseo_staff_job_owner USING(true) WITH CHECK(true);

CREATE FUNCTION lyraseo_billing.job_test_proof(uid text,sid text,ver integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$ BEGIN
 PERFORM 1 FROM lyraseo_billing.job_test_session p JOIN lyraseo_kernel.test_environment e ON (p.database_oid,p.postmaster_started_at)=(e.database_oid,e.postmaster_started_at) JOIN pg_database d ON d.oid=e.database_oid
 WHERE d.datname=current_database() AND e.postmaster_started_at=pg_postmaster_start_time()
 AND (p.user_id,p.session_id,p.security_version)=(uid,sid,ver) AND NOT p.revoked AND p.expires_at>clock_timestamp() FOR SHARE OF p;
 RETURN FOUND;
END $$;
CREATE FUNCTION lyraseo_billing.issue_job_step_up(a jsonb,action_name text,target_id text,token text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$ BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 IF action_name IS NULL OR action_name NOT IN('jobs:retry','jobs:cancel') OR target_id IS NULL OR target_id!~'^[A-Za-z0-9_-]{1,128}$' OR token IS NULL OR length(token) NOT BETWEEN 32 AND 256 THEN RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 PERFORM lyraseo_billing.rate_staff(a->>'userId','step-up',20);
 INSERT INTO lyraseo_billing.step_up(token_hash,user_id,session_id,security_version,action,target,grant_revision,capability_revision,authenticated_at,mfa_at,expires_at)
 VALUES(encode(sha256(convert_to(token,'UTF8')),'hex'),a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer,action_name,target_id,
 (SELECT revision FROM lyraseo_billing.staff_epoch WHERE user_id=a->>'userId'),(SELECT revision FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND action='jobs:manage'),
 (a->>'authenticatedAt')::timestamptz,(a->>'mfaAuthenticatedAt')::timestamptz,clock_timestamp()+interval '2 minutes');
END $$;
CREATE FUNCTION lyraseo_billing.perform_staff_job_action(a jsonb,action_name text,target_id text,token_hash_value text,expected_fence integer,reason_text text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE g lyraseo_billing.step_up; op record; b record; n integer; action_result jsonb; old_state jsonb; fp text; BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 IF action_name IS NULL OR action_name NOT IN('jobs:retry','jobs:cancel') OR target_id IS NULL OR target_id!~'^[A-Za-z0-9_-]{1,128}$' OR token_hash_value IS NULL OR expected_fence IS NULL OR expected_fence<0 OR reason_text IS NULL OR length(reason_text)>500 OR length(btrim(reason_text)) NOT BETWEEN 12 AND 500 THEN RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 SELECT * INTO g FROM lyraseo_billing.step_up WHERE token_hash=token_hash_value FOR UPDATE;
 IF NOT FOUND OR g.user_id<>a->>'userId' OR g.session_id<>a->>'sessionId' OR g.security_version<>(a->>'securityVersion')::integer OR g.action<>action_name OR g.target<>target_id THEN RAISE EXCEPTION 'STEP_UP_REQUIRED'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(expected_fence,reason_text)::text,'UTF8')),'hex');
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 IF (g.consumed_at IS NULL AND g.expires_at<=clock_timestamp()) OR g.grant_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_epoch WHERE user_id=a->>'userId') OR g.capability_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND action='jobs:manage') THEN RAISE EXCEPTION 'STAFF_AUTHORITY_CHANGED'; END IF;
 IF g.consumed_at IS NOT NULL THEN
  IF g.request_hash IS DISTINCT FROM fp THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  PERFORM lyraseo_billing.rate_staff(a->>'userId','job-replay',20);
  INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason,new_state) VALUES(a->>'userId',action_name,target_id,'REPLAY','IDEMPOTENT_REPLAY',g.result);
  RETURN g.result;
 END IF;
 SELECT id,"workspaceId","siteId","userId","sessionId","securityVersion",kind,provider,period,"reservedCost",status,"expiresAt","cancelRequestedAt","leaseUntil",fence,"attemptState","providerTaskId","settledAt","actualCost" INTO op FROM public."Operation" WHERE id=target_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- Follow the same operation then budget order as cancellation/settlement.
 PERFORM pg_advisory_xact_lock(hashtextextended('budget:'||op."userId",0));
 PERFORM 1 FROM public."BudgetPeriod" WHERE "userId"=op."userId" AND period=op.period ORDER BY bucket FOR UPDATE;
 PERFORM 1 FROM public."ProductUser" WHERE id=op."userId" FOR SHARE;
 PERFORM 1 FROM public."ProductSession" WHERE "sessionId"=op."sessionId" FOR SHARE;
 PERFORM 1 FROM public."Workspace" WHERE id=op."workspaceId" FOR SHARE;
 PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(op."workspaceId",op."siteId") FOR SHARE;
 PERFORM 1 FROM public."Membership" WHERE ("workspaceId","userId")=(op."workspaceId",op."userId") FOR SHARE;
 PERFORM 1 FROM public."SiteGrant" WHERE ("workspaceId","siteId","userId")=(op."workspaceId",op."siteId",op."userId") FOR SHARE;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF g.expires_at<=clock_timestamp() OR g.grant_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_epoch WHERE user_id=a->>'userId') OR g.capability_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND action='jobs:manage') THEN RAISE EXCEPTION 'STAFF_AUTHORITY_CHANGED'; END IF;
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) OR NOT lyraseo_billing.job_test_proof(op."userId",op."sessionId",op."securityVersion") THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 IF op.fence<>expected_fence THEN RAISE EXCEPTION 'JOB_CONFLICT'; END IF;
 IF NOT EXISTS(SELECT FROM public."ProductUser" u JOIN public."ProductSession" ps ON (ps."userId",ps."securityVersion")=(u.id,u."securityVersion") JOIN public."Workspace" w ON w.id=op."workspaceId" JOIN public."Site" s ON (s."workspaceId",s.id)=(w.id,op."siteId") JOIN public."Membership" m ON (m."workspaceId",m."userId")=(w.id,u.id)
 WHERE u.id=op."userId" AND NOT u.suspended AND u."securityVersion"=op."securityVersion" AND ps."sessionId"=op."sessionId" AND (ps."createdAt" AT TIME ZONE 'UTC')>clock_timestamp()-interval '30 days' AND (ps."refreshedAt" AT TIME ZONE 'UTC')>clock_timestamp()-interval '7 days' AND w."deletedAt" IS NULL AND s."deletedAt" IS NULL AND s."verifiedAt" AT TIME ZONE 'UTC' BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()+interval '30 seconds'
 AND (m.role IN('OWNER','ADMIN') OR (m.role='EDITOR' AND EXISTS(SELECT FROM public."SiteGrant" x WHERE (x."workspaceId",x."siteId",x."userId")=(w.id,s.id,u.id))))) THEN RAISE EXCEPTION 'SPONSOR_AUTHORITY_CHANGED'; END IF;
 IF op.status IN('COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED') OR op."settledAt" IS NOT NULL OR op."actualCost" IS NOT NULL THEN RAISE EXCEPTION 'JOB_TERMINAL'; END IF;
 old_state:=jsonb_build_object('status',op.status,'fence',op.fence,'attemptState',op."attemptState");
 IF action_name='jobs:retry' THEN
  IF op."attemptState"<>'NONE' OR op."providerTaskId" IS NOT NULL THEN RAISE EXCEPTION 'RECONCILIATION_REQUIRED'; END IF;
  IF op.status<>'RUNNING' OR op."leaseUntil" IS NULL OR (op."leaseUntil" AT TIME ZONE 'UTC')>clock_timestamp() OR op."cancelRequestedAt" IS NOT NULL OR (op."expiresAt" AT TIME ZONE 'UTC')<=clock_timestamp() OR op.period<>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') THEN RAISE EXCEPTION 'JOB_NOT_RETRYABLE'; END IF;
 ELSE
  IF op."attemptState"<>'NONE' OR op."providerTaskId" IS NOT NULL OR op.status IN('WAITING_PROVIDER','RECONCILING') THEN
   UPDATE public."Operation" SET status='RECONCILING',"cancelRequestedAt"=coalesce("cancelRequestedAt",clock_timestamp() AT TIME ZONE 'UTC') WHERE id=op.id;
   action_result:=jsonb_build_object('id',op.id,'status','RECONCILING','fence',op.fence,'reconciliationRequired',true,'delivery','UNAVAILABLE');
  END IF;
 END IF;
 IF action_result IS NULL THEN
  IF action_name='jobs:cancel' AND (op."leaseUntil" AT TIME ZONE 'UTC')>clock_timestamp() THEN RAISE EXCEPTION 'JOB_LEASE_ACTIVE'; END IF;
  IF op."reservedCost"<=0 OR NOT ((op.kind='RESEARCH' AND op.provider='PARALLEL') OR (op.kind IN('CHATGPT_OBSERVATION','GEMINI_OBSERVATION') AND op.provider='DATAFORSEO') OR (op.kind IN('GENERATION','API_OBSERVATION') AND op.provider='AZURE')) THEN RAISE EXCEPTION 'BUDGET_STATE_INVALID'; END IF;
  -- Every reservation must remain backed. Only retry requires current ceiling compliance.
  SELECT count(*) INTO n FROM public."BudgetPeriod" WHERE "userId"=op."userId" AND period=op.period AND bucket IN ('COMBINED',op.provider) AND reserved>=op."reservedCost" AND (action_name='jobs:cancel' OR spent+reserved<="limit");
  IF n<>2 OR (op.kind IN('API_OBSERVATION','CHATGPT_OBSERVATION','GEMINI_OBSERVATION') AND NOT EXISTS(SELECT FROM public."BudgetPeriod" WHERE "userId"=op."userId" AND period=op.period AND bucket=op.kind AND reserved>=1 AND (action_name='jobs:cancel' OR spent+reserved<="limit"))) THEN RAISE EXCEPTION 'BUDGET_STATE_INVALID'; END IF;
  IF action_name='jobs:cancel' THEN
   UPDATE public."BudgetPeriod" SET reserved=reserved-CASE WHEN bucket=op.kind THEN 1 ELSE op."reservedCost" END WHERE "userId"=op."userId" AND period=op.period AND (bucket IN('COMBINED',op.provider) OR (bucket=op.kind AND op.kind IN('API_OBSERVATION','CHATGPT_OBSERVATION','GEMINI_OBSERVATION')));
   UPDATE public."Operation" SET status='CANCELLED',"cancelRequestedAt"=clock_timestamp() AT TIME ZONE 'UTC',"settledAt"=clock_timestamp() AT TIME ZONE 'UTC',"leaseOwner"=NULL,"leaseUntil"=NULL,fence=fence+1 WHERE id=op.id;
   action_result:=jsonb_build_object('id',op.id,'status','CANCELLED','fence',op.fence+1,'reconciliationRequired',false,'delivery','UNAVAILABLE');
  ELSE
   UPDATE public."Operation" SET status='QUEUED',"leaseOwner"=NULL,"leaseUntil"=NULL,fence=fence+1 WHERE id=op.id;
   action_result:=jsonb_build_object('id',op.id,'status','QUEUED','fence',op.fence+1,'reconciliationRequired',false,'delivery','UNAVAILABLE');
  END IF;
 END IF;
 -- Revalidate after all waits and before committing the transition and receipt.
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF g.expires_at<=clock_timestamp() OR NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) OR NOT lyraseo_billing.job_test_proof(op."userId",op."sessionId",op."securityVersion") THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 IF NOT EXISTS(SELECT FROM public."ProductSession" ps JOIN public."Site" s ON (s."workspaceId",s.id)=(op."workspaceId",op."siteId") WHERE ps."sessionId"=op."sessionId" AND ps."userId"=op."userId" AND ps."securityVersion"=op."securityVersion" AND (ps."createdAt" AT TIME ZONE 'UTC')>clock_timestamp()-interval '30 days' AND (ps."refreshedAt" AT TIME ZONE 'UTC')>clock_timestamp()-interval '7 days' AND s."verifiedAt" AT TIME ZONE 'UTC' BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()+interval '30 seconds') THEN RAISE EXCEPTION 'SPONSOR_AUTHORITY_CHANGED'; END IF;
 IF action_name='jobs:retry' AND ((op."expiresAt" AT TIME ZONE 'UTC')<=clock_timestamp() OR op.period<>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM')) THEN RAISE EXCEPTION 'JOB_NOT_RETRYABLE'; END IF;
 UPDATE lyraseo_billing.step_up SET consumed_at=clock_timestamp(),request_hash=fp,result=action_result WHERE token_hash=g.token_hash;
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason,old_state,new_state) VALUES(a->>'userId',action_name,target_id,'ALLOWED',reason_text,old_state,action_result);
 RETURN action_result;
END $$;
CREATE FUNCTION lyraseo_billing.assert_job_allocation(uid text,requested_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE owner_id text; BEGIN
 SELECT staff_id INTO owner_id FROM lyraseo_billing.job_allocation WHERE id=requested_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'REQUEST_NOT_ALLOCATED'; END IF;
 IF owner_id IS DISTINCT FROM uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
END $$;
CREATE FUNCTION lyraseo_billing.allocate_job_request(a jsonb,requested_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$ BEGIN
 IF session_user<>'lyraseo_staff_executor' OR requested_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 PERFORM lyraseo_billing.rate_staff(a->>'userId','job-allocation',20);
 PERFORM pg_advisory_xact_lock(hashtextextended('staff-job-request:'||requested_id::text,0));
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT FROM lyraseo_billing.job_allocation WHERE id=requested_id) THEN
  PERFORM lyraseo_billing.assert_job_allocation(a->>'userId',requested_id);
 ELSE
  INSERT INTO lyraseo_billing.job_allocation(id,staff_id) VALUES(requested_id,a->>'userId');
  INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,outcome,reason,request_id) VALUES(a->>'userId','jobs:allocate','ALLOCATED','JOB_REQUEST_ALLOCATED',requested_id);
 END IF;
 RETURN jsonb_build_object('state','ALLOCATED');
END $$;
-- Only the fixed wrappers may call the internal hash-based executor. Raw tokens
-- never leave trusted Node or enter browser storage.
CREATE FUNCTION lyraseo_billing.prepare_job_request(a jsonb,action_name text,target_id text,token text,expected_fence integer,reason_text text,request_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE r lyraseo_billing.job_request; g lyraseo_billing.step_up; fp text; BEGIN
 IF session_user<>'lyraseo_staff_executor' OR request_id IS NULL OR expected_fence IS NULL OR expected_fence<0 OR reason_text IS NULL OR length(reason_text)>500 OR length(btrim(reason_text)) NOT BETWEEN 12 AND 500 THEN RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(expected_fence,reason_text)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('staff-job-request:'||request_id::text,0));
 PERFORM lyraseo_billing.assert_job_allocation(a->>'userId',request_id);
 IF EXISTS(SELECT FROM lyraseo_billing.closed_job_request WHERE id=request_id) THEN RAISE EXCEPTION 'REQUEST_CLOSED'; END IF;
 SELECT * INTO r FROM lyraseo_billing.job_request WHERE id=request_id FOR UPDATE;
 IF FOUND THEN
  IF (r.staff_id,r.session_id,r.security_version,r.action,r.target,r.expected_fence,r.request_hash) IS DISTINCT FROM (a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer,action_name,target_id,expected_fence,fp) THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  SELECT * INTO g FROM lyraseo_billing.step_up WHERE token_hash=r.token_hash FOR UPDATE;
  PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
  IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
  IF g.consumed_at IS NOT NULL OR g.expires_at>clock_timestamp() THEN RETURN; END IF;
 END IF;
 PERFORM lyraseo_billing.issue_job_step_up(a,action_name,target_id,token);
 INSERT INTO lyraseo_billing.job_request(id,staff_id,session_id,security_version,action,target,expected_fence,request_hash,token_hash)
 VALUES(request_id,a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer,action_name,target_id,expected_fence,fp,encode(sha256(convert_to(token,'UTF8')),'hex'))
 ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash;
END $$;
CREATE FUNCTION lyraseo_billing.execute_job_request(a jsonb,action_name text,target_id text,expected_fence integer,reason_text text,request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE r lyraseo_billing.job_request; fp text; BEGIN
 IF session_user<>'lyraseo_staff_executor' OR request_id IS NULL OR expected_fence IS NULL OR expected_fence<0 OR reason_text IS NULL OR length(reason_text)>500 OR length(btrim(reason_text)) NOT BETWEEN 12 AND 500 THEN RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(expected_fence,reason_text)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('staff-job-request:'||request_id::text,0));
 PERFORM lyraseo_billing.assert_job_allocation(a->>'userId',request_id);
 IF EXISTS(SELECT FROM lyraseo_billing.closed_job_request WHERE id=request_id) THEN RAISE EXCEPTION 'REQUEST_CLOSED'; END IF;
 SELECT * INTO r FROM lyraseo_billing.job_request WHERE id=request_id FOR UPDATE;
 IF NOT FOUND OR (r.staff_id,r.session_id,r.security_version,r.action,r.target,r.expected_fence,r.request_hash) IS DISTINCT FROM (a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer,action_name,target_id,expected_fence,fp) THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
 RETURN lyraseo_billing.perform_staff_job_action(a,action_name,target_id,r.token_hash,expected_fence,reason_text);
END $$;
CREATE FUNCTION lyraseo_billing.job_request_status(a jsonb,request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE r lyraseo_billing.job_request; g lyraseo_billing.step_up; BEGIN
 IF session_user<>'lyraseo_staff_executor' OR request_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 PERFORM lyraseo_billing.rate_staff(a->>'userId','job-status',20);
 PERFORM pg_advisory_xact_lock(hashtextextended('staff-job-request:'||request_id::text,0));
 PERFORM lyraseo_billing.assert_job_allocation(a->>'userId',request_id);
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT FROM lyraseo_billing.closed_job_request WHERE id=request_id AND staff_id=a->>'userId') THEN RETURN jsonb_build_object('state','CLOSED'); END IF;
 SELECT * INTO r FROM lyraseo_billing.job_request WHERE id=request_id FOR SHARE;
 IF NOT FOUND THEN
  PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
  IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
  RETURN jsonb_build_object('state','PENDING');
 END IF;
 IF r.staff_id IS DISTINCT FROM a->>'userId' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO g FROM lyraseo_billing.step_up WHERE token_hash=r.token_hash FOR SHARE;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 IF g.grant_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_epoch WHERE user_id=a->>'userId') OR g.capability_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND action='jobs:manage') THEN RAISE EXCEPTION 'STAFF_AUTHORITY_CHANGED'; END IF;
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(a->>'userId','jobs:status',r.target,'READ','JOB_REQUEST_STATUS');
 IF g.consumed_at IS NULL THEN RETURN jsonb_build_object('state','PENDING'); END IF;
 RETURN jsonb_build_object('state','COMPLETE','result',g.result);
END $$;
-- Close only after serializing with prepare and execute. A completed action is
-- returned unchanged; absent or unconsumed requests are permanently fenced.
CREATE FUNCTION lyraseo_billing.resolve_job_request(a jsonb,request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE r lyraseo_billing.job_request; g lyraseo_billing.step_up; c lyraseo_billing.closed_job_request; BEGIN
 IF session_user<>'lyraseo_staff_executor' OR request_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 PERFORM lyraseo_billing.rate_staff(a->>'userId','job-resolution',20);
 PERFORM pg_advisory_xact_lock(hashtextextended('staff-job-request:'||request_id::text,0));
 PERFORM lyraseo_billing.assert_job_allocation(a->>'userId',request_id);
 SELECT * INTO c FROM lyraseo_billing.closed_job_request WHERE id=request_id;
 IF FOUND THEN
  IF c.staff_id IS DISTINCT FROM a->>'userId' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
  IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
  RETURN jsonb_build_object('state','CLOSED');
 END IF;
 SELECT * INTO r FROM lyraseo_billing.job_request WHERE id=request_id FOR UPDATE;
 IF FOUND THEN
  IF r.staff_id IS DISTINCT FROM a->>'userId' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO g FROM lyraseo_billing.step_up WHERE token_hash=r.token_hash FOR UPDATE;
 END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 IF NOT lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer) THEN RAISE EXCEPTION 'ISSUER_REVALIDATION_UNAVAILABLE'; END IF;
 IF g.consumed_at IS NOT NULL THEN
  INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason,new_state) VALUES(a->>'userId','jobs:resolve',r.target,'READ','JOB_REQUEST_COMPLETED',g.result);
  RETURN jsonb_build_object('state','COMPLETE','result',g.result);
 END IF;
 INSERT INTO lyraseo_billing.closed_job_request(id,staff_id,session_id,security_version) VALUES(request_id,a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer);
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(a->>'userId','jobs:resolve',r.target,'CLOSED','JOB_REQUEST_ABANDONED');
 RETURN jsonb_build_object('state','CLOSED');
END $$;
-- Report only whether this session can enter the sealed local rehearsal. The
-- target transition still rechecks the separate sponsor proof after locking.
CREATE FUNCTION lyraseo_billing.staff_job_availability(a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$ BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'jobs:manage',true);
 RETURN jsonb_build_object('available',lyraseo_billing.job_test_proof(a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer),'profile','LOCAL_REHEARSAL');
END $$;
-- Denials are recorded in their own transaction by the trusted caller because
-- the failed action transaction rolls back. No raw input or provider data is stored.
CREATE FUNCTION lyraseo_billing.staff_job_denied(a jsonb,action_name text,target_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$ BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 IF action_name IS NULL OR action_name NOT IN('jobs:retry','jobs:cancel') OR target_id IS NULL OR target_id!~'^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true);
 PERFORM lyraseo_billing.rate_staff(a->>'userId','denied',20);
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(a->>'userId',action_name,target_id,'DENIED','ACTION_REJECTED');
END $$;
ALTER FUNCTION lyraseo_billing.assert_job_allocation(text,uuid) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.allocate_job_request(jsonb,uuid) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.resolve_job_request(jsonb,uuid) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.job_request_status(jsonb,uuid) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.prepare_job_request(jsonb,text,text,text,integer,text,uuid) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.execute_job_request(jsonb,text,text,integer,text,uuid) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.perform_staff_job_action(jsonb,text,text,text,integer,text) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.staff_job_availability(jsonb) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.staff_job_denied(jsonb,text,text) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.job_test_proof(text,text,integer) OWNER TO lyraseo_staff_job_owner;
ALTER FUNCTION lyraseo_billing.issue_job_step_up(jsonb,text,text,text) OWNER TO lyraseo_staff_job_owner;
REVOKE ALL ON FUNCTION lyraseo_billing.assert_job_allocation(text,uuid),lyraseo_billing.allocate_job_request(jsonb,uuid),lyraseo_billing.resolve_job_request(jsonb,uuid),lyraseo_billing.job_request_status(jsonb,uuid),lyraseo_billing.prepare_job_request(jsonb,text,text,text,integer,text,uuid),lyraseo_billing.execute_job_request(jsonb,text,text,integer,text,uuid),lyraseo_billing.perform_staff_job_action(jsonb,text,text,text,integer,text),lyraseo_billing.staff_job_availability(jsonb),lyraseo_billing.staff_job_denied(jsonb,text,text),lyraseo_billing.job_test_proof(text,text,integer),lyraseo_billing.issue_job_step_up(jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_billing.allocate_job_request(jsonb,uuid),lyraseo_billing.resolve_job_request(jsonb,uuid),lyraseo_billing.job_request_status(jsonb,uuid),lyraseo_billing.prepare_job_request(jsonb,text,text,text,integer,text,uuid),lyraseo_billing.execute_job_request(jsonb,text,text,integer,text,uuid),lyraseo_billing.staff_job_availability(jsonb),lyraseo_billing.staff_job_denied(jsonb,text,text) TO lyraseo_staff_executor;
REVOKE CREATE ON SCHEMA lyraseo_billing FROM lyraseo_staff_job_owner;
COMMIT;
