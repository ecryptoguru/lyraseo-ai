BEGIN;
-- Fixture rehearsal only. Neither a qualified live adapter nor a paid transport.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM pg_roles WHERE rolname IN ('lyraseo_ledger_owner','lyraseo_ledger_fixture') LOOP
  IF r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
   OR (r.rolname='lyraseo_ledger_owner')=r.rolcanlogin
   OR EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   OR EXISTS(SELECT FROM pg_database WHERE datdba=r.oid)
   OR EXISTS(SELECT FROM pg_class WHERE relowner=r.oid)
   OR EXISTS(SELECT FROM pg_namespace WHERE nspowner=r.oid)
  THEN RAISE EXCEPTION 'UNSAFE_LEDGER_ROLE'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('lyraseo_ledger_owner','lyraseo_ledger_fixture'))<>2 THEN RAISE EXCEPTION 'LEDGER_ROLES_REQUIRED'; END IF;
END $$;
CREATE SCHEMA lyraseo_ledger;
REVOKE ALL ON SCHEMA lyraseo_ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_ledger,public,lyraseo_kernel TO lyraseo_ledger_owner;
GRANT USAGE ON SCHEMA lyraseo_ledger TO lyraseo_ledger_fixture;
ALTER DEFAULT PRIVILEGES FOR ROLE lyraseo_ledger_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER TABLE public."Operation" ADD COLUMN "ledgerMode" text NOT NULL DEFAULT 'LEGACY' CHECK("ledgerMode" IN ('LEGACY','FIXTURE'));
ALTER TABLE public."Operation" ADD COLUMN "ledgerVersion" integer NOT NULL DEFAULT 0;
ALTER TABLE public."Operation" ADD CONSTRAINT ledger_version CHECK(("ledgerMode"='LEGACY' AND "ledgerVersion"=0) OR ("ledgerMode"='FIXTURE' AND "ledgerVersion"=1));
CREATE TABLE lyraseo_ledger.environment (
 database_oid oid PRIMARY KEY,postmaster_started_at timestamptz NOT NULL,
 fixture_version text NOT NULL CHECK(fixture_version='SYNTHETIC_LEDGER_V1')
);
CREATE TABLE lyraseo_ledger.qualification (
 id text PRIMARY KEY,provider text NOT NULL CHECK(provider IN ('AZURE','PARALLEL','DATAFORSEO')),
 profile text NOT NULL,classification text NOT NULL CHECK(classification IN ('SYNTHETIC','UNKNOWN','DOCUMENTED')),
 live_enabled boolean NOT NULL DEFAULT false CHECK(NOT live_enabled),
 account_fingerprint text NOT NULL,contract_version text NOT NULL,contract jsonb NOT NULL,
 checked_at timestamptz NOT NULL,revoked_at timestamptz,
 UNIQUE(id,provider,account_fingerprint)
);
INSERT INTO lyraseo_ledger.qualification(id,provider,profile,classification,account_fingerprint,contract_version,contract,checked_at)
 SELECT 'fixture-v1-'||p,provider,p,'SYNTHETIC','synthetic-fixture-account:'||provider,'SYNTHETIC_LEDGER_V1',
 '{"currency":"USD","tariff":"SYNTHETIC_NOT_PROVIDER_PRICING","locale":"synthetic-en-IN","liveQualified":false}'::jsonb,TIMESTAMPTZ '2026-11-03T00:00:00Z'
 FROM (VALUES('azure-editorial','AZURE'),('azure-observation','AZURE'),('parallel-research','PARALLEL'),('chatgpt-standard','DATAFORSEO'),('gemini-standard','DATAFORSEO'),('keyword-batch','DATAFORSEO')) v(p,provider);
CREATE TABLE lyraseo_ledger.managed_operation (
 operation_id text PRIMARY KEY,workspace_id text NOT NULL,site_id text NOT NULL,user_id text NOT NULL,
 provider text NOT NULL,qualification_id text NOT NULL,account_fingerprint text NOT NULL,
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='array' AND jsonb_array_length(plan) BETWEEN 1 AND 10),
 plan_hash text NOT NULL,revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 plan_closed boolean NOT NULL DEFAULT false,paused boolean NOT NULL DEFAULT false,retry_consumed boolean NOT NULL DEFAULT false,
 effective_cost numeric(20,9),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,site_id,user_id,operation_id) REFERENCES public."Operation"("workspaceId","siteId","userId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 UNIQUE(operation_id,account_fingerprint),
 FOREIGN KEY(qualification_id,provider,account_fingerprint) REFERENCES lyraseo_ledger.qualification(id,provider,account_fingerprint)
);
-- Sticky owner/month/bucket stops: financial facts may still arrive and settle.
CREATE TABLE lyraseo_ledger.budget_pause (
 user_id text NOT NULL,period text NOT NULL,bucket text NOT NULL CHECK(bucket IN ('COMBINED','AZURE','PARALLEL','DATAFORSEO')),
 source_operation_id text NOT NULL REFERENCES lyraseo_ledger.managed_operation(operation_id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(reason IN ('QUOTE_BOUND','BUDGET')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,period,bucket)
);
CREATE TABLE lyraseo_ledger.attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),operation_id text NOT NULL REFERENCES lyraseo_ledger.managed_operation(operation_id) ON DELETE RESTRICT,
 account_fingerprint text NOT NULL,
 step text NOT NULL CHECK(step ~ '^[a-z][a-z0-9-]{0,63}$'),ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 1),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),correlation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 prepared_revision integer NOT NULL,submitted_fence integer NOT NULL,allocation numeric(20,9) NOT NULL CHECK(allocation>0),deadline timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'INTENT' CHECK(state IN ('INTENT','UNCERTAIN','ACCEPTED','RESOLVED')),
 accepted boolean,output_valid boolean,cost numeric(20,9) CHECK(cost>=0),cost_version integer NOT NULL DEFAULT 0,
 external_task_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(operation_id,step,ordinal),UNIQUE(operation_id,prepared_revision),UNIQUE(account_fingerprint,external_task_id),
 FOREIGN KEY(operation_id,account_fingerprint) REFERENCES lyraseo_ledger.managed_operation(operation_id,account_fingerprint) ON DELETE RESTRICT
);
CREATE TABLE lyraseo_ledger.attempt_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),attempt_id uuid NOT NULL REFERENCES lyraseo_ledger.attempt(id) ON DELETE RESTRICT,
 source_namespace text NOT NULL CHECK(source_namespace='SYNTHETIC_LEDGER_V1'),account_fingerprint text NOT NULL,
 source_key text NOT NULL CHECK(source_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
 kind text NOT NULL CHECK(kind IN ('ACCEPTED','UNCERTAIN','RESOLVED')),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=8192),payload_hash text NOT NULL,
 cost_provenance text NOT NULL CHECK(cost_provenance IN ('UNKNOWN','SYNTHETIC')),
 observed_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_namespace,account_fingerprint,source_key)
);
CREATE TABLE lyraseo_ledger.settlement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),operation_id text NOT NULL UNIQUE REFERENCES lyraseo_ledger.managed_operation(operation_id) ON DELETE RESTRICT,
 usage_receipt_id text NOT NULL UNIQUE REFERENCES public."UsageReceipt"(id) ON DELETE RESTRICT,
 evidence_hash text NOT NULL,attempt_event_ids uuid[] NOT NULL,classification text NOT NULL CHECK(classification='SYNTHETIC'),
 amount numeric(20,9) NOT NULL CHECK(amount>=0),accepted_output boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE lyraseo_ledger.adjustment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),settlement_id uuid NOT NULL REFERENCES lyraseo_ledger.settlement(id) ON DELETE RESTRICT,
 source_event_id uuid NOT NULL UNIQUE REFERENCES lyraseo_ledger.attempt_event(id) ON DELETE RESTRICT,
 revision integer NOT NULL,delta numeric(20,9) NOT NULL,effective_cost numeric(20,9) NOT NULL CHECK(effective_cost>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(settlement_id,revision)
);
CREATE TABLE lyraseo_ledger.reconciliation (
 operation_id text PRIMARY KEY REFERENCES lyraseo_ledger.managed_operation(operation_id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(reason IN ('UNCERTAIN','ACCEPTED_PENDING','COST_UNKNOWN','CORRECTION','OVERRUN','RESOLVED','EXHAUSTED','AGGREGATE_PENDING')),
 next_attempt_at timestamptz,lease_until timestamptz,fence integer NOT NULL DEFAULT 0,
 tries integer NOT NULL DEFAULT 0 CHECK(tries BETWEEN 0 AND 12),last_error text,
 resolved_event_id uuid REFERENCES lyraseo_ledger.attempt_event(id) ON DELETE RESTRICT
);
CREATE INDEX reconciliation_due ON lyraseo_ledger.reconciliation(next_attempt_at,operation_id) WHERE next_attempt_at IS NOT NULL;
CREATE FUNCTION lyraseo_ledger.fixture_guard() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF session_user<>'lyraseo_ledger_fixture' OR current_database() !~ '^lyraseo_ledger_[a-f0-9]{12}$'
 OR NOT lyraseo_kernel.is_test_database() OR NOT EXISTS(SELECT FROM lyraseo_ledger.environment e JOIN pg_database d ON d.oid=e.database_oid
 WHERE d.datname=current_database() AND e.postmaster_started_at=pg_postmaster_start_time() AND e.fixture_version='SYNTHETIC_LEDGER_V1')
 THEN RAISE EXCEPTION 'FIXTURE_LEDGER_UNAVAILABLE'; END IF;
END $$;
CREATE FUNCTION lyraseo_ledger.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' AND TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME IN ('KeywordSelection','KeywordEnrichmentResult') AND current_user='lyraseo_deletion_owner' THEN
  IF EXISTS(SELECT FROM public."Site" WHERE "workspaceId"=OLD."workspaceId" AND id=OLD."siteId" AND "deletedAt" IS NOT NULL) THEN RETURN OLD; END IF;
 END IF;
 RAISE EXCEPTION 'IMMUTABLE_LEDGER_EVIDENCE'; END $$;
CREATE TRIGGER budget_pause_immutable BEFORE UPDATE OR DELETE ON lyraseo_ledger.budget_pause FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.immutable();
CREATE TRIGGER event_immutable BEFORE UPDATE OR DELETE ON lyraseo_ledger.attempt_event FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.immutable();
CREATE TRIGGER settlement_immutable BEFORE UPDATE OR DELETE ON lyraseo_ledger.settlement FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.immutable();
CREATE TRIGGER adjustment_immutable BEFORE UPDATE OR DELETE ON lyraseo_ledger.adjustment FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.immutable();
CREATE FUNCTION lyraseo_ledger.qualification_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'IMMUTABLE_QUALIFICATION'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER qualification_immutable BEFORE UPDATE OR DELETE ON lyraseo_ledger.qualification FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.qualification_guard();
-- Marker guard and financial fence rely on current_user inside purpose definers,
-- never customer-settable app.* GUCs or the service's request parameters.
CREATE FUNCTION lyraseo_ledger.operation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW."ledgerMode"<>'LEGACY' OR NEW."ledgerVersion"<>0 THEN RAISE EXCEPTION 'MANAGED_LEDGER_REQUIRED'; END IF;
 ELSIF (OLD."ledgerMode"='FIXTURE' OR NEW."ledgerMode"='FIXTURE') AND current_user<>'lyraseo_ledger_owner' THEN RAISE EXCEPTION 'MANAGED_LEDGER_REQUIRED';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER managed_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON public."Operation" FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.operation_guard();
CREATE FUNCTION lyraseo_ledger.budget_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 -- Do not allow generic runtime money edits against an enrolled synthetic owner/period.
 IF session_user='lyraseo_runtime' AND EXISTS(SELECT FROM lyraseo_ledger.managed_operation m JOIN public."Operation" o ON o.id=m.operation_id
 WHERE o."userId"=OLD."userId" AND o.period=OLD.period) THEN RAISE EXCEPTION 'MANAGED_LEDGER_REQUIRED'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER managed_budget_guard BEFORE UPDATE OR DELETE ON public."BudgetPeriod" FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.budget_guard();
CREATE FUNCTION lyraseo_ledger.receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF session_user='lyraseo_runtime' AND EXISTS(SELECT FROM lyraseo_ledger.managed_operation WHERE operation_id=NEW."operationId") THEN RAISE EXCEPTION 'MANAGED_LEDGER_REQUIRED'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER managed_receipt_guard BEFORE INSERT ON public."UsageReceipt" FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.receipt_guard();
CREATE FUNCTION lyraseo_ledger.enroll_fixture(op_id text,steps jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; p text; profile text; total numeric; BEGIN
 -- EXECUTE remains installer-only. Administrator enrolls an already reserved fixture,
 -- never a customer ID supplied to a ledger service.
 IF current_database() !~ '^lyraseo_ledger_[a-f0-9]{12}$' OR NOT lyraseo_kernel.is_test_database() THEN RAISE EXCEPTION 'FIXTURE_LEDGER_UNAVAILABLE'; END IF;
 SELECT * INTO o FROM public."Operation" WHERE id=op_id FOR UPDATE;
 IF o.id IS NULL OR o."userId" !~ '^fixture-ledger-' OR o.route<>'fixture-ledger' OR o."tariffVersion"<>'synthetic-fixture-v1'
 OR o."attemptState"<>'NONE' OR o.status<>'RUNNING' OR o."cancelRequestedAt" IS NOT NULL OR o."leaseUntil"<=clock_timestamp() THEN RAISE EXCEPTION 'INVALID_FIXTURE_OPERATION'; END IF;
 IF jsonb_typeof(steps)<>'array' OR jsonb_array_length(steps) NOT BETWEEN 1 AND 10 OR EXISTS(SELECT FROM jsonb_array_elements(steps) x
 WHERE jsonb_typeof(x)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(x))<>2 OR NOT(x ?& ARRAY['step','maximum']) OR jsonb_typeof(x->'step')<>'string' OR jsonb_typeof(x->'maximum')<>'string' OR x->>'step' !~ '^[a-z][a-z0-9-]{0,63}$' OR x->>'maximum' !~ '^(0|[1-9][0-9]{0,10})(\.[0-9]{1,9})?$' OR (x->>'maximum')::numeric<=0)
 OR (SELECT count(DISTINCT x->>'step') FROM jsonb_array_elements(steps)x)<>jsonb_array_length(steps) THEN RAISE EXCEPTION 'INVALID_ATTEMPT_PLAN'; END IF;
 SELECT sum((x->>'maximum')::numeric) INTO total FROM jsonb_array_elements(steps)x;
 IF total>o."reservedCost" THEN RAISE EXCEPTION 'ATTEMPT_PLAN_EXCEEDS_RESERVATION'; END IF;
 profile:=CASE o.kind WHEN 'GENERATION' THEN 'azure-editorial' WHEN 'API_OBSERVATION' THEN 'azure-observation' WHEN 'RESEARCH' THEN 'parallel-research' WHEN 'CHATGPT_OBSERVATION' THEN 'chatgpt-standard' WHEN 'GEMINI_OBSERVATION' THEN 'gemini-standard' WHEN 'KEYWORD_ENRICHMENT' THEN 'keyword-batch' END;
 IF profile IS NULL THEN RAISE EXCEPTION 'UNSUPPORTED_PROFILE'; END IF;
 INSERT INTO lyraseo_ledger.managed_operation(operation_id,workspace_id,site_id,user_id,provider,qualification_id,account_fingerprint,plan,plan_hash)
 VALUES(o.id,o."workspaceId",o."siteId",o."userId",o.provider,'fixture-v1-'||profile,'synthetic-fixture-account:'||o.provider,steps,encode(sha256(convert_to(steps::text,'UTF8')),'hex'));
 UPDATE public."Operation" SET "ledgerMode"='FIXTURE',"ledgerVersion"=1 WHERE id=op_id;
 RETURN jsonb_build_object('operationId',op_id,'classification','SYNTHETIC','revision',0);
END $$;
CREATE FUNCTION lyraseo_ledger.prepare_attempt(op_id text,fence_ integer,step_ text,request_hash_ text,expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; m lyraseo_ledger.managed_operation; a lyraseo_ledger.attempt; prior lyraseo_ledger.attempt; allocation_ numeric; ordinal_ integer; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();
 SELECT * INTO o FROM public."Operation" WHERE id=op_id FOR UPDATE;
 SELECT * INTO m FROM lyraseo_ledger.managed_operation WHERE operation_id=op_id FOR UPDATE;
 SELECT * INTO a FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND prepared_revision=expected_revision;
 IF a.id IS NOT NULL THEN
  IF a.step IS DISTINCT FROM step_ OR a.request_hash IS DISTINCT FROM request_hash_ OR a.submitted_fence IS DISTINCT FROM fence_ THEN RAISE EXCEPTION 'LEDGER_CONFLICT'; END IF;
  RETURN jsonb_build_object('id',a.id,'state',a.state,'revision',m.revision,'replayed',true,'submissionGranted',false,'correlationId',a.correlation_id);
 END IF;
 SELECT * INTO a FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND step=step_ ORDER BY ordinal DESC LIMIT 1;
 IF expected_revision IS NULL OR fence_ IS NULL OR step_ IS NULL OR request_hash_ IS NULL OR m.operation_id IS NULL OR m.paused OR m.plan_closed OR m.revision<>expected_revision THEN RAISE EXCEPTION 'LEDGER_CONFLICT'; END IF;
 -- Same order as legacy release/settle: existing operation, owner advisory,
 -- then buckets. Admission takes this advisory before INSERTing a new operation;
 -- it never locks an existing operation afterward. No sibling lock is acquired.
 PERFORM pg_advisory_xact_lock(hashtextextended('budget:'||o."userId",0));
 PERFORM id FROM public."BudgetPeriod" WHERE "userId"=o."userId" AND period=o.period ORDER BY bucket FOR UPDATE;
 IF EXISTS(SELECT FROM lyraseo_ledger.budget_pause WHERE user_id=o."userId" AND period=o.period AND bucket IN ('COMBINED',o.provider)) THEN RAISE EXCEPTION 'BUDGET_PAUSED'; END IF;
 PERFORM 1 FROM public."Site" WHERE id=o."siteId" FOR SHARE;
 -- Recheck time and current scope after every potentially blocking lock.
 IF o.fence<>fence_ OR o."leaseUntil" IS NULL OR o."leaseUntil"<=clock_timestamp() OR o."cancelRequestedAt" IS NOT NULL OR o."expiresAt"<=clock_timestamp() OR o.status NOT IN ('RUNNING','WAITING_PROVIDER','RECONCILING') THEN RAISE EXCEPTION 'STALE_EXECUTION'; END IF;
 IF NOT EXISTS(SELECT FROM public."ProductUser" u JOIN public."Membership" mm ON mm."userId"=u.id AND mm."workspaceId"=o."workspaceId"
 JOIN public."Workspace" w ON w.id=mm."workspaceId" JOIN public."Site" s ON s.id=o."siteId" AND s."workspaceId"=w.id
 WHERE u.id=o."userId" AND NOT u.suspended AND u."securityVersion"=o."securityVersion" AND w."deletedAt" IS NULL AND s."deletedAt" IS NULL
 AND s."verifiedAt">clock_timestamp()-interval '30 days' AND (mm.role IN ('OWNER','ADMIN') OR (mm.role='EDITOR' AND EXISTS(SELECT FROM public."SiteGrant" g WHERE g."workspaceId"=w.id AND g."siteId"=s.id AND g."userId"=u.id))))
 OR NOT EXISTS(SELECT FROM lyraseo_ledger.qualification q WHERE q.id=m.qualification_id AND q.revoked_at IS NULL AND q.classification='SYNTHETIC' AND NOT q.live_enabled)
 THEN RAISE EXCEPTION 'EXECUTION_REVOKED'; END IF;
 SELECT (x->>'maximum')::numeric INTO allocation_ FROM jsonb_array_elements(m.plan)x WHERE x->>'step'=step_;
 IF allocation_ IS NULL OR request_hash_ !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_ATTEMPT'; END IF;
 ordinal_:=coalesce(a.ordinal+1,0);
 IF ordinal_>0 AND m.retry_consumed THEN RAISE EXCEPTION 'RETRY_NOT_ALLOWED'; END IF;
 IF a.id IS NOT NULL AND (a.ordinal<>0 OR a.state<>'RESOLVED' OR a.cost IS NULL OR a.output_valid IS DISTINCT FROM false) THEN RAISE EXCEPTION 'RETRY_NOT_ALLOWED'; END IF;
 IF coalesce((SELECT sum(CASE WHEN state='RESOLVED' THEN cost ELSE allocation END) FROM lyraseo_ledger.attempt WHERE operation_id=op_id),0)+allocation_+coalesce((SELECT sum((p->>'maximum')::numeric) FROM jsonb_array_elements(m.plan)p WHERE p->>'step'<>step_ AND NOT EXISTS(SELECT FROM lyraseo_ledger.attempt future_attempt WHERE future_attempt.operation_id=op_id AND future_attempt.step=p->>'step')),0)>o."reservedCost" THEN RAISE EXCEPTION 'ATTEMPT_EXPOSURE_EXCEEDS_RESERVATION'; END IF;
 INSERT INTO lyraseo_ledger.attempt(operation_id,account_fingerprint,step,ordinal,request_hash,prepared_revision,submitted_fence,allocation,deadline)
 VALUES(op_id,m.account_fingerprint,step_,ordinal_,request_hash_,expected_revision,fence_,allocation_,least(o."expiresAt",clock_timestamp()+interval '15 minutes')) RETURNING * INTO a;
 UPDATE lyraseo_ledger.managed_operation SET revision=revision+1,retry_consumed=retry_consumed OR ordinal_>0 WHERE operation_id=op_id RETURNING * INTO m;
 UPDATE public."Operation" SET "attemptState"='INTENT' WHERE id=op_id;
 INSERT INTO lyraseo_ledger.reconciliation(operation_id,reason,next_attempt_at) VALUES(op_id,'UNCERTAIN',o."leaseUntil")
 ON CONFLICT(operation_id) DO UPDATE SET reason='UNCERTAIN',next_attempt_at=least(lyraseo_ledger.reconciliation.next_attempt_at,EXCLUDED.next_attempt_at);
 RETURN jsonb_build_object('id',a.id,'state',a.state,'revision',m.revision,'correlationId',a.correlation_id,'replayed',false,'submissionGranted',true,'classification','SYNTHETIC');
END $$;
-- Shared exact budget movement used by legacy and managed settlement. INVOKER:
-- it acquires no authority and cannot bypass managed-row guards.
CREATE FUNCTION lyraseo_ledger.apply_budget_change(op_id text,amount_ numeric,accepted_ boolean,release_ boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; b record; observation boolean; BEGIN
 SELECT * INTO o FROM public."Operation" WHERE id=op_id FOR UPDATE;
 IF o.id IS NULL OR (o."ledgerMode"='FIXTURE' AND current_user<>'lyraseo_ledger_owner') THEN RAISE EXCEPTION 'MANAGED_LEDGER_REQUIRED'; END IF;
 IF amount_ IS NULL OR amount_::text !~ '^-?[0-9]{1,11}(\.[0-9]{1,9})?$' OR amount_<>round(amount_,9) OR (release_ AND amount_<0) OR (NOT release_ AND current_user<>'lyraseo_ledger_owner') THEN RAISE EXCEPTION 'INVALID_COST'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('budget:'||o."userId",0));
 PERFORM id FROM public."BudgetPeriod" WHERE "userId"=o."userId" AND period=o.period ORDER BY bucket FOR UPDATE;
 observation:=o.kind IN ('API_OBSERVATION','CHATGPT_OBSERVATION','GEMINI_OBSERVATION');
 IF (SELECT count(*) FROM public."BudgetPeriod" WHERE "userId"=o."userId" AND period=o.period AND (bucket IN ('COMBINED',o.provider) OR (release_ AND observation AND bucket=o.kind)))<>(CASE WHEN release_ AND observation THEN 3 ELSE 2 END) THEN RAISE EXCEPTION 'BUDGET_STATE_UNAVAILABLE'; END IF;
 FOR b IN SELECT id,bucket FROM public."BudgetPeriod" WHERE "userId"=o."userId" AND period=o.period
 AND (bucket IN ('COMBINED',o.provider) OR (release_ AND observation AND bucket=o.kind)) ORDER BY bucket LOOP
  UPDATE public."BudgetPeriod" SET reserved=reserved-CASE WHEN release_ THEN CASE WHEN b.bucket IN ('COMBINED',o.provider) THEN o."reservedCost" ELSE 1 END ELSE 0 END,
   spent=spent+CASE WHEN b.bucket IN ('COMBINED',o.provider) THEN amount_ WHEN accepted_ THEN 1 ELSE 0 END WHERE id=b.id;
 END LOOP;
END $$;
-- Called only after operation/managed locks and the existing owner-budget lock
-- acquired by apply_budget_change. Never lock or update sibling operations.
CREATE FUNCTION lyraseo_ledger.pause_overrun(op_id text,effective_cost_ numeric) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; BEGIN
 SELECT * INTO o FROM public."Operation" WHERE id=op_id;
 INSERT INTO lyraseo_ledger.budget_pause(user_id,period,bucket,source_operation_id,reason)
 SELECT o."userId",o.period,b.bucket,op_id,CASE WHEN b.bucket=o.provider AND effective_cost_>o."reservedCost" THEN 'QUOTE_BOUND' ELSE 'BUDGET' END
 FROM public."BudgetPeriod" b WHERE b."userId"=o."userId" AND b.period=o.period AND
 ((b.bucket='COMBINED' AND b.spent+b.reserved>b."limit") OR
  (b.bucket=o.provider AND (b.spent+b.reserved>b."limit" OR effective_cost_>o."reservedCost")))
 ON CONFLICT(user_id,period,bucket) DO NOTHING;
 RETURN EXISTS(SELECT FROM lyraseo_ledger.budget_pause WHERE user_id=o."userId" AND period=o.period AND bucket IN ('COMBINED',o.provider));
END $$;
-- The caller holds the operation lock, serializing its entire attempt set.
-- Every new financial fact invalidates stale reconciliation leases, but a final
-- answer cannot remove the action that still needs to close/settle the aggregate.
CREATE FUNCTION lyraseo_ledger.refresh_reconciliation(op_id text,event_id_ uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m lyraseo_ledger.managed_operation; reason_ text; due_ timestamptz; total_ numeric; BEGIN
 SELECT * INTO m FROM lyraseo_ledger.managed_operation WHERE operation_id=op_id;
 SELECT sum(cost) INTO total_ FROM lyraseo_ledger.attempt WHERE operation_id=op_id;
 IF EXISTS(SELECT FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND state IN ('INTENT','UNCERTAIN')) THEN reason_:='UNCERTAIN';
 ELSIF EXISTS(SELECT FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND cost IS NULL) THEN reason_:='COST_UNKNOWN';
 ELSIF EXISTS(SELECT FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND state<>'RESOLVED') THEN reason_:='ACCEPTED_PENDING';
 ELSIF m.effective_cost IS NULL THEN reason_:='AGGREGATE_PENDING';
 ELSIF total_ IS DISTINCT FROM m.effective_cost THEN reason_:='CORRECTION';
 ELSIF m.paused THEN reason_:='OVERRUN';
 ELSE reason_:='RESOLVED'; END IF;
 due_:=CASE WHEN reason_ IN ('RESOLVED','OVERRUN') THEN NULL ELSE clock_timestamp()+interval '15 seconds' END;
 INSERT INTO lyraseo_ledger.reconciliation(operation_id,reason,next_attempt_at,resolved_event_id)
 VALUES(op_id,reason_,due_,event_id_)
 ON CONFLICT(operation_id) DO UPDATE SET reason=EXCLUDED.reason,
 next_attempt_at=CASE WHEN EXCLUDED.next_attempt_at IS NULL THEN NULL ELSE least(lyraseo_ledger.reconciliation.next_attempt_at,EXCLUDED.next_attempt_at) END,
 resolved_event_id=coalesce(event_id_,lyraseo_ledger.reconciliation.resolved_event_id),lease_until=NULL,
 fence=lyraseo_ledger.reconciliation.fence+1,
 tries=CASE WHEN event_id_ IS NOT NULL AND lyraseo_ledger.reconciliation.tries=12 AND reason_ IN ('AGGREGATE_PENDING','CORRECTION') THEN 0 ELSE lyraseo_ledger.reconciliation.tries END;
END $$;

CREATE FUNCTION lyraseo_ledger.record_evidence(attempt_id_ uuid,key_ text,data_ jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a lyraseo_ledger.attempt; m lyraseo_ledger.managed_operation; e lyraseo_ledger.attempt_event; op_id text; kind_ text; cost_ numeric; version_ integer; task_ text; accepted_ boolean; valid_ boolean; stamp timestamptz; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();
 SELECT operation_id INTO op_id FROM lyraseo_ledger.attempt WHERE id=attempt_id_;
 PERFORM id FROM public."Operation" WHERE id=op_id FOR UPDATE;
 SELECT * INTO m FROM lyraseo_ledger.managed_operation WHERE operation_id=op_id FOR UPDATE;
 SELECT * INTO a FROM lyraseo_ledger.attempt WHERE id=attempt_id_ FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'ATTEMPT_UNAVAILABLE'; END IF;
 SELECT * INTO e FROM lyraseo_ledger.attempt_event WHERE source_namespace='SYNTHETIC_LEDGER_V1' AND account_fingerprint=m.account_fingerprint AND source_key=key_;
 IF e.id IS NOT NULL THEN
  IF e.attempt_id<>attempt_id_ OR e.payload IS DISTINCT FROM data_ THEN RAISE EXCEPTION 'EVENT_CONFLICT'; END IF;
  RETURN jsonb_build_object('eventId',e.id,'revision',m.revision,'replayed',true);
 END IF;
 IF data_ IS NULL OR jsonb_typeof(data_)<>'object' OR octet_length(data_::text)>8192 OR EXISTS(SELECT FROM jsonb_object_keys(data_)k WHERE k NOT IN ('kind','accepted','outputValid','cost','costVersion','observedAt','taskId','usage'))
 OR key_ IS NULL OR key_ !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'INVALID_EVENT'; END IF;
 kind_:=data_->>'kind';task_:=data_->>'taskId';
 IF kind_ IS NULL OR kind_ NOT IN ('ACCEPTED','UNCERTAIN','RESOLVED') OR jsonb_typeof(data_->'observedAt') IS DISTINCT FROM 'string'
 OR (task_ IS NOT NULL AND task_ !~ '^[A-Za-z0-9._:-]{1,128}$') THEN RAISE EXCEPTION 'INVALID_EVENT'; END IF;
 stamp:=(data_->>'observedAt')::timestamptz;
 IF stamp>clock_timestamp()+interval '30 seconds' OR stamp<a.created_at-interval '30 seconds' THEN RAISE EXCEPTION 'INVALID_EVENT_TIME'; END IF;
 IF data_ ? 'usage' AND (jsonb_typeof(data_->'usage')<>'object' OR EXISTS(SELECT FROM jsonb_each(data_->'usage')u WHERE u.key NOT IN ('inputTokens','outputTokens','cachedTokens','reasoningTokens','webSearchRequests','searchRequests','extractedUrls','postedTasks') OR jsonb_typeof(u.value)<>'number' OR u.value::text !~ '^[0-9]{1,9}$')) THEN RAISE EXCEPTION 'INVALID_USAGE'; END IF;
 IF kind_='RESOLVED' OR (kind_='ACCEPTED' AND data_ ? 'cost') THEN
  IF (kind_='RESOLVED' AND (jsonb_typeof(data_->'accepted') IS DISTINCT FROM 'boolean' OR jsonb_typeof(data_->'outputValid') IS DISTINCT FROM 'boolean'))
   OR (kind_='ACCEPTED' AND data_ ?| ARRAY['accepted','outputValid']) OR jsonb_typeof(data_->'cost') IS DISTINCT FROM 'string' OR data_->>'cost' !~ '^(0|[1-9][0-9]{0,10})(\.[0-9]{1,9})?$'
   OR jsonb_typeof(data_->'costVersion') IS DISTINCT FROM 'number' OR data_->>'costVersion' !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'INVALID_RESOLUTION'; END IF;
  cost_:=(data_->>'cost')::numeric;version_:=(data_->>'costVersion')::integer;accepted_:=CASE WHEN kind_='ACCEPTED' THEN true ELSE (data_->>'accepted')::boolean END;valid_:=(data_->>'outputValid')::boolean;
  IF version_<>a.cost_version+1 OR (a.accepted IS TRUE AND NOT accepted_) OR (valid_ AND NOT accepted_) OR (a.state='RESOLVED' AND (a.accepted IS DISTINCT FROM accepted_ OR a.output_valid IS DISTINCT FROM valid_)) THEN RAISE EXCEPTION 'CONTRADICTORY_EVIDENCE'; END IF;
 ELSE
  IF data_ ?| ARRAY['accepted','outputValid','cost','costVersion'] THEN RAISE EXCEPTION 'INVALID_EVENT'; END IF;
  IF a.state='RESOLVED' THEN RAISE EXCEPTION 'ATTEMPT_ALREADY_RESOLVED'; END IF;
 END IF;
 IF a.external_task_id IS NOT NULL AND task_ IS NOT NULL AND task_<>a.external_task_id THEN RAISE EXCEPTION 'TASK_ID_CONFLICT'; END IF;
 INSERT INTO lyraseo_ledger.attempt_event(attempt_id,source_namespace,account_fingerprint,source_key,kind,payload,payload_hash,cost_provenance,observed_at)
 VALUES(a.id,'SYNTHETIC_LEDGER_V1',m.account_fingerprint,key_,kind_,data_,encode(sha256(convert_to(data_::text,'UTF8')),'hex'),CASE WHEN cost_ IS NULL THEN 'UNKNOWN' ELSE 'SYNTHETIC' END,stamp) RETURNING * INTO e;
 UPDATE lyraseo_ledger.attempt SET state=CASE WHEN kind_='RESOLVED' THEN 'RESOLVED' WHEN kind_='ACCEPTED' OR accepted IS TRUE THEN 'ACCEPTED' ELSE 'UNCERTAIN' END,
 accepted=CASE WHEN kind_='ACCEPTED' THEN true WHEN kind_='RESOLVED' THEN accepted_ ELSE accepted END,
 output_valid=CASE WHEN kind_='RESOLVED' THEN valid_ ELSE output_valid END,cost=coalesce(cost_,cost),
 cost_version=coalesce(version_,cost_version),external_task_id=coalesce(external_task_id,task_) WHERE id=a.id;
 UPDATE lyraseo_ledger.managed_operation SET revision=revision+1 WHERE operation_id=op_id RETURNING * INTO m;
 UPDATE public."Operation" SET "attemptState"=CASE WHEN EXISTS(SELECT FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND accepted IS TRUE) THEN 'ACCEPTED' ELSE 'INTENT' END,
 status=CASE WHEN "settledAt" IS NULL THEN 'RECONCILING' ELSE status END WHERE id=op_id;
 PERFORM lyraseo_ledger.refresh_reconciliation(op_id,e.id);
 RETURN jsonb_build_object('eventId',e.id,'revision',m.revision,'classification','SYNTHETIC');
END $$;
CREATE FUNCTION lyraseo_ledger.close_plan(op_id text,expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m lyraseo_ledger.managed_operation; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();PERFORM id FROM public."Operation" WHERE id=op_id FOR UPDATE;
 SELECT * INTO m FROM lyraseo_ledger.managed_operation WHERE operation_id=op_id FOR UPDATE;
 IF expected_revision IS NULL OR m.operation_id IS NULL OR m.revision<>expected_revision THEN RAISE EXCEPTION 'LEDGER_CONFLICT'; END IF;
 IF NOT m.plan_closed THEN UPDATE lyraseo_ledger.managed_operation SET plan_closed=true,revision=revision+1 WHERE operation_id=op_id RETURNING * INTO m; END IF;
 RETURN jsonb_build_object('revision',m.revision,'planClosed',true);
END $$;
CREATE FUNCTION lyraseo_ledger.snapshot(op_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m lyraseo_ledger.managed_operation; hash_ text; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();SELECT * INTO m FROM lyraseo_ledger.managed_operation WHERE operation_id=op_id;
 IF m.operation_id IS NULL THEN RAISE EXCEPTION 'LEDGER_UNAVAILABLE'; END IF;
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(e.id,e.payload_hash) ORDER BY e.id)::text,'[]'),'UTF8')),'hex') INTO hash_
 FROM lyraseo_ledger.attempt_event e JOIN lyraseo_ledger.attempt a ON a.id=e.attempt_id WHERE a.operation_id=op_id;
 RETURN jsonb_build_object('operationId',op_id,'revision',m.revision,'evidenceHash',hash_,'planClosed',m.plan_closed,'paused',m.paused OR EXISTS(SELECT FROM lyraseo_ledger.budget_pause p JOIN public."Operation" o ON o.id=op_id WHERE p.user_id=o."userId" AND p.period=o.period AND p.bucket IN ('COMBINED',o.provider)),'settled',m.effective_cost IS NOT NULL,'effectiveCost',m.effective_cost::text,'classification','SYNTHETIC');
END $$;
CREATE FUNCTION lyraseo_ledger.settle(op_id text,expected_revision integer,evidence_hash_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; m lyraseo_ledger.managed_operation; saved lyraseo_ledger.settlement; s jsonb; amount_ numeric; valid_ boolean; ids uuid[]; receipt_ text; paused_ boolean; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();SELECT * INTO o FROM public."Operation" WHERE id=op_id FOR UPDATE;
 SELECT * INTO m FROM lyraseo_ledger.managed_operation WHERE operation_id=op_id FOR UPDATE;
 IF m.operation_id IS NULL THEN RAISE EXCEPTION 'LEDGER_UNAVAILABLE'; END IF;
 SELECT * INTO saved FROM lyraseo_ledger.settlement WHERE operation_id=op_id;
 IF saved.id IS NOT NULL THEN
  IF saved.evidence_hash<>evidence_hash_ THEN RAISE EXCEPTION 'SETTLEMENT_CONFLICT'; END IF;
  RETURN jsonb_build_object('settlementId',saved.id,'amount',saved.amount::text,'classification','SYNTHETIC');
 END IF;
 IF NOT m.plan_closed THEN RAISE EXCEPTION 'PLAN_OPEN'; END IF;
 s:=lyraseo_ledger.snapshot(op_id);
 IF expected_revision IS NULL OR evidence_hash_ IS NULL OR m.revision<>expected_revision OR s->>'evidenceHash'<>evidence_hash_ THEN RAISE EXCEPTION 'LEDGER_CONFLICT'; END IF;
 PERFORM id FROM lyraseo_ledger.attempt WHERE operation_id=op_id ORDER BY id FOR UPDATE;
 IF NOT EXISTS(SELECT FROM lyraseo_ledger.attempt WHERE operation_id=op_id) OR EXISTS(SELECT FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND (state<>'RESOLVED' OR cost IS NULL)) THEN RAISE EXCEPTION 'EXPOSURE_UNRESOLVED'; END IF;
 SELECT sum(cost) INTO amount_ FROM lyraseo_ledger.attempt WHERE operation_id=op_id;
 SELECT coalesce(bool_and(coalesce(a.output_valid,false)),false) INTO valid_ FROM jsonb_array_elements(m.plan)p LEFT JOIN LATERAL
 (SELECT output_valid FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND step=p->>'step' ORDER BY ordinal DESC LIMIT 1)a ON true;
 SELECT array_agg(e.id ORDER BY e.id) INTO ids FROM lyraseo_ledger.attempt_event e JOIN lyraseo_ledger.attempt a ON a.id=e.attempt_id WHERE a.operation_id=op_id;
 PERFORM lyraseo_ledger.apply_budget_change(op_id,amount_,valid_,true);
 paused_:=lyraseo_ledger.pause_overrun(op_id,amount_);
 receipt_:=gen_random_uuid()::text;
 INSERT INTO public."UsageReceipt"(id,"operationId","workspaceId","userId",provider,"receiptId",amount,"acceptedOutput")
 VALUES(receipt_,op_id,o."workspaceId",o."userId",o.provider,'application-synthetic-settlement:'||receipt_,amount_,valid_);
 INSERT INTO lyraseo_ledger.settlement(operation_id,usage_receipt_id,evidence_hash,attempt_event_ids,classification,amount,accepted_output)
 VALUES(op_id,receipt_,evidence_hash_,ids,'SYNTHETIC',amount_,valid_) RETURNING * INTO saved;
 UPDATE lyraseo_ledger.managed_operation SET effective_cost=amount_,revision=revision+1,paused=paused OR paused_ WHERE operation_id=op_id;
 UPDATE public."Operation" SET "actualCost"=amount_,"settledAt"=clock_timestamp(),"leaseUntil"=NULL,"leaseOwner"=NULL,
 status=CASE WHEN paused_ THEN 'RECONCILING' WHEN "cancelRequestedAt" IS NOT NULL THEN 'CANCELLED' WHEN valid_ THEN 'COMPLETED' ELSE 'FAILED' END WHERE id=op_id;
 PERFORM lyraseo_ledger.refresh_reconciliation(op_id);
 RETURN jsonb_build_object('settlementId',saved.id,'amount',amount_::text,'classification','SYNTHETIC');
END $$;
CREATE FUNCTION lyraseo_ledger.apply_adjustment(op_id text,expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; m lyraseo_ledger.managed_operation; saved lyraseo_ledger.settlement; prior lyraseo_ledger.adjustment; source_ uuid; amount_ numeric; delta_ numeric; overrun boolean; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();SELECT * INTO o FROM public."Operation" WHERE id=op_id FOR UPDATE;
 SELECT * INTO m FROM lyraseo_ledger.managed_operation WHERE operation_id=op_id FOR UPDATE;
 SELECT * INTO saved FROM lyraseo_ledger.settlement WHERE operation_id=op_id;
 SELECT * INTO prior FROM lyraseo_ledger.adjustment WHERE settlement_id=saved.id AND revision=expected_revision;
 IF prior.id IS NOT NULL THEN RETURN jsonb_build_object('adjustmentId',prior.id,'effectiveCost',prior.effective_cost::text,'replayed',true); END IF;
 IF expected_revision IS NULL OR m.operation_id IS NULL OR saved.id IS NULL OR m.revision<>expected_revision THEN RAISE EXCEPTION 'LEDGER_CONFLICT'; END IF;
 IF EXISTS(SELECT FROM lyraseo_ledger.attempt WHERE operation_id=op_id AND (state<>'RESOLVED' OR cost IS NULL)) THEN RAISE EXCEPTION 'EXPOSURE_UNRESOLVED'; END IF;
 SELECT sum(cost) INTO amount_ FROM lyraseo_ledger.attempt WHERE operation_id=op_id;
 delta_:=amount_-m.effective_cost;
 SELECT e.id INTO source_ FROM lyraseo_ledger.attempt_event e JOIN lyraseo_ledger.attempt a ON a.id=e.attempt_id
 WHERE a.operation_id=op_id AND e.kind='RESOLVED' AND NOT e.id=ANY(saved.attempt_event_ids)
 AND NOT EXISTS(SELECT FROM lyraseo_ledger.adjustment x WHERE x.source_event_id=e.id) ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1;
 IF source_ IS NULL THEN RAISE EXCEPTION 'CORRECTION_EVIDENCE_REQUIRED'; END IF;
 PERFORM lyraseo_ledger.apply_budget_change(op_id,delta_,false,false);
 overrun:=lyraseo_ledger.pause_overrun(op_id,amount_);
 INSERT INTO lyraseo_ledger.adjustment(settlement_id,source_event_id,revision,delta,effective_cost) VALUES(saved.id,source_,expected_revision,delta_,amount_) RETURNING * INTO prior;
 UPDATE lyraseo_ledger.managed_operation SET effective_cost=amount_,revision=revision+1,paused=paused OR overrun WHERE operation_id=op_id;
 PERFORM lyraseo_ledger.refresh_reconciliation(op_id);
 IF overrun THEN UPDATE public."Operation" SET status='RECONCILING' WHERE id=op_id; END IF;
 RETURN jsonb_build_object('adjustmentId',prior.id,'delta',delta_::text,'effectiveCost',amount_::text,'paused',overrun,'classification','SYNTHETIC');
END $$;
CREATE FUNCTION lyraseo_ledger.claim_reconciliation(limit_ integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result_ jsonb; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();IF limit_ IS NULL OR limit_ NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_LIMIT'; END IF;
 UPDATE lyraseo_ledger.reconciliation SET reason='EXHAUSTED',next_attempt_at=NULL,lease_until=NULL WHERE tries>=12 AND lease_until<=clock_timestamp();
 -- Discovery locks only due rows, commits before caller records financial facts.
 WITH due AS(SELECT operation_id FROM lyraseo_ledger.reconciliation WHERE next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND tries<12 ORDER BY next_attempt_at,operation_id FOR UPDATE SKIP LOCKED LIMIT limit_),
 claimed AS(UPDATE lyraseo_ledger.reconciliation r SET fence=fence+1,tries=tries+1,lease_until=clock_timestamp()+interval '60 seconds' FROM due WHERE r.operation_id=due.operation_id RETURNING r.*)
 SELECT coalesce(jsonb_agg(jsonb_build_object('operationId',operation_id,'fence',fence,'tries',tries,'reason',reason)),'[]') INTO result_ FROM claimed;
 RETURN result_;
END $$;
CREATE FUNCTION lyraseo_ledger.finish_reconciliation(op_id text,fence_ integer,error_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r lyraseo_ledger.reconciliation; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();
 IF error_ IS NULL OR fence_ IS NULL OR error_ NOT IN ('PROVIDER_PENDING','QUOTA','SCHEMA_CHANGED','UNSUPPORTED','UNAVAILABLE') THEN RAISE EXCEPTION 'INVALID_RECONCILIATION_OUTCOME'; END IF;
 SELECT * INTO r FROM lyraseo_ledger.reconciliation WHERE operation_id=op_id FOR UPDATE;
 IF r.operation_id IS NULL OR r.fence<>fence_ OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'STALE_RECONCILIATION'; END IF;
 UPDATE lyraseo_ledger.reconciliation SET last_error=error_,lease_until=NULL,reason=CASE WHEN tries>=12 THEN 'EXHAUSTED' ELSE reason END,
 next_attempt_at=CASE WHEN tries>=12 THEN NULL ELSE clock_timestamp()+least(interval '5 minutes',interval '15 seconds'*power(2,least(tries,5))) END WHERE operation_id=op_id;
 RETURN jsonb_build_object('operationId',op_id,'status',CASE WHEN r.tries>=12 THEN 'EXHAUSTED' ELSE 'RECONCILING' END);
END $$;

CREATE FUNCTION lyraseo_ledger.cancel(op_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; m lyraseo_ledger.managed_operation; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();SELECT * INTO o FROM public."Operation" WHERE id=op_id FOR UPDATE;
 SELECT * INTO m FROM lyraseo_ledger.managed_operation WHERE operation_id=op_id FOR UPDATE;
 IF m.operation_id IS NULL THEN RAISE EXCEPTION 'LEDGER_UNAVAILABLE'; END IF;
 IF o."cancelRequestedAt" IS NOT NULL OR o."settledAt" IS NOT NULL THEN RETURN jsonb_build_object('status',o.status,'replayed',true); END IF;
 IF NOT EXISTS(SELECT FROM lyraseo_ledger.attempt WHERE operation_id=op_id) THEN
  PERFORM lyraseo_ledger.apply_budget_change(op_id,0,false,true);
  UPDATE public."Operation" SET "cancelRequestedAt"=clock_timestamp(),status='CANCELLED',"leaseUntil"=NULL,"leaseOwner"=NULL WHERE id=op_id;
 ELSE
  UPDATE public."Operation" SET "cancelRequestedAt"=clock_timestamp(),status='RECONCILING' WHERE id=op_id;
 END IF;
 UPDATE lyraseo_ledger.managed_operation SET plan_closed=true,revision=revision+1 WHERE operation_id=op_id;
 RETURN jsonb_build_object('operationId',op_id,'cancelled',true,'classification','SYNTHETIC');
END $$;

CREATE TABLE public."KeywordSelection" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"workspaceId" text NOT NULL,"siteId" text NOT NULL,"createdBy" text NOT NULL,
 "idempotencyKey" text NOT NULL CHECK(length("idempotencyKey") BETWEEN 1 AND 128),"requestHash" text NOT NULL CHECK("requestHash" ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=32768),"sourceSnapshotId" text NOT NULL,
 status text NOT NULL DEFAULT 'UNQUALIFIED' CHECK(status='UNQUALIFIED'),"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),"resultExpiresAt" timestamptz NOT NULL,
 UNIQUE("workspaceId","siteId",id),UNIQUE("workspaceId","siteId","createdBy","idempotencyKey"),
 FOREIGN KEY("workspaceId","siteId") REFERENCES public."Site"("workspaceId",id) ON DELETE RESTRICT,
 FOREIGN KEY("createdBy") REFERENCES public."ProductUser"(id) ON DELETE RESTRICT
);
CREATE TABLE public."KeywordEnrichmentResult" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"workspaceId" text NOT NULL,"siteId" text NOT NULL,"selectionId" uuid NOT NULL UNIQUE,
 "operationId" text NOT NULL UNIQUE REFERENCES public."Operation"(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='SYNTHETIC'),currency text CHECK(currency ~ '^[A-Z]{3}$'),method text NOT NULL CHECK(method='OFFLINE_FIXTURE'),market jsonb NOT NULL,
 "collectedAt" timestamptz NOT NULL,"recordedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),"resultExpiresAt" timestamptz NOT NULL,
 rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows) BETWEEN 1 AND 20),
 UNIQUE("workspaceId","siteId","selectionId"),
 FOREIGN KEY("workspaceId","siteId","selectionId") REFERENCES public."KeywordSelection"("workspaceId","siteId",id) ON DELETE RESTRICT
);
CREATE INDEX keyword_selection_scope ON public."KeywordSelection"("workspaceId","siteId","createdAt",id);
CREATE TRIGGER keyword_selection_immutable BEFORE UPDATE OR DELETE ON public."KeywordSelection" FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.immutable();
CREATE TRIGGER keyword_result_immutable BEFORE UPDATE OR DELETE ON public."KeywordEnrichmentResult" FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.immutable();
ALTER TABLE public."KeywordSelection" ENABLE ROW LEVEL SECURITY;ALTER TABLE public."KeywordSelection" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."KeywordEnrichmentResult" ENABLE ROW LEVEL SECURITY;ALTER TABLE public."KeywordEnrichmentResult" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON public."KeywordSelection" TO lyraseo_runtime USING("workspaceId"=current_setting('app.workspace_id',true)) WITH CHECK("workspaceId"=current_setting('app.workspace_id',true) AND "createdBy"=current_setting('app.actor_id',true));
CREATE POLICY workspace_scope ON public."KeywordEnrichmentResult" TO lyraseo_runtime USING("workspaceId"=current_setting('app.workspace_id',true));
CREATE POLICY ledger_owner ON public."KeywordSelection" TO lyraseo_ledger_owner USING(true);
CREATE POLICY ledger_owner ON public."KeywordEnrichmentResult" TO lyraseo_ledger_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public."KeywordSelection" TO lyraseo_runtime;
GRANT SELECT ON public."KeywordEnrichmentResult" TO lyraseo_runtime;
GRANT SELECT ON public."KeywordSelection",public."KeywordEnrichmentResult" TO lyraseo_ledger_owner;
GRANT INSERT ON public."KeywordEnrichmentResult" TO lyraseo_ledger_owner;
CREATE FUNCTION lyraseo_ledger.save_keyword_fixture(selection_id_ uuid,op_id text,rows_ jsonb,collected_at_ timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; q public."KeywordSelection"; saved public."KeywordEnrichmentResult"; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();SELECT * INTO o FROM public."Operation" WHERE id=op_id FOR UPDATE;
 SELECT * INTO q FROM public."KeywordSelection" WHERE id=selection_id_;
 IF q.id IS NULL OR o.id IS NULL OR o.kind<>'KEYWORD_ENRICHMENT' OR o.provider<>'DATAFORSEO' OR o."ledgerMode"<>'FIXTURE'
 OR (o."workspaceId",o."siteId",o."userId") IS DISTINCT FROM (q."workspaceId",q."siteId",q."createdBy") OR o."requestInput"->>'requestHash' IS DISTINCT FROM q."requestHash"
 OR o.status<>'COMPLETED' OR o."cancelRequestedAt" IS NOT NULL OR q."resultExpiresAt"<=clock_timestamp()
 OR NOT EXISTS(SELECT FROM lyraseo_ledger.settlement s WHERE s.operation_id=op_id AND s.accepted_output AND s.classification='SYNTHETIC')
 OR NOT EXISTS(SELECT FROM public."ProductUser" u JOIN public."Membership" m ON m."userId"=u.id JOIN public."Workspace" w ON w.id=m."workspaceId" JOIN public."Site" s ON s."workspaceId"=w.id
 WHERE u.id=o."userId" AND NOT u.suspended AND u."securityVersion"=o."securityVersion" AND w.id=o."workspaceId" AND w."deletedAt" IS NULL AND s.id=o."siteId" AND s."deletedAt" IS NULL
 AND (m.role IN ('OWNER','ADMIN') OR (m.role='EDITOR' AND EXISTS(SELECT FROM public."SiteGrant" g WHERE g."workspaceId"=w.id AND g."siteId"=s.id AND g."userId"=u.id))))
 THEN RAISE EXCEPTION 'KEYWORD_OUTPUT_UNAVAILABLE'; END IF;
 IF rows_ IS NULL OR jsonb_typeof(rows_)<>'array' OR jsonb_array_length(rows_)<>jsonb_array_length(q.request->'keywords') OR octet_length(rows_::text)>32768
 OR collected_at_ IS NULL OR collected_at_>clock_timestamp()+interval '30 seconds' OR collected_at_<o."createdAt"
 OR EXISTS(SELECT FROM jsonb_array_elements(rows_)WITH ORDINALITY r(value,n) WHERE jsonb_typeof(value)<>'object' OR NOT(value ?& ARRAY['keyword','searchVolume','cpc','competition']) OR value->>'keyword' IS DISTINCT FROM q.request->'keywords'->>(n::int-1)
 OR EXISTS(SELECT FROM jsonb_object_keys(value)k WHERE k NOT IN ('keyword','searchVolume','cpc','competition'))
 OR (value->'searchVolume'<>'null'::jsonb AND (jsonb_typeof(value->'searchVolume')<>'number' OR value->>'searchVolume' !~ '^[0-9]{1,12}$'))
 OR (value->'cpc'<>'null'::jsonb AND (jsonb_typeof(value->'cpc')<>'string' OR value->>'cpc' !~ '^(0|[1-9][0-9]{0,10})(\.[0-9]{1,9})?$'))
 OR (value->'competition'<>'null'::jsonb AND value->>'competition' NOT IN ('LOW','MEDIUM','HIGH')))
 THEN RAISE EXCEPTION 'INVALID_KEYWORD_RESULT'; END IF;
 SELECT * INTO saved FROM public."KeywordEnrichmentResult" WHERE "selectionId"=q.id;
 IF saved.id IS NOT NULL THEN IF saved.rows IS DISTINCT FROM rows_ OR saved."operationId"<>op_id OR saved."collectedAt"<>collected_at_ THEN RAISE EXCEPTION 'CONFLICT'; END IF;RETURN jsonb_build_object('id',saved.id,'replayed',true); END IF;
 INSERT INTO public."KeywordEnrichmentResult"("workspaceId","siteId","selectionId","operationId",source,currency,method,market,"collectedAt","resultExpiresAt",rows)
 VALUES(q."workspaceId",q."siteId",q.id,op_id,'SYNTHETIC','USD','OFFLINE_FIXTURE',q.request->'market',collected_at_,q."resultExpiresAt",rows_) RETURNING * INTO saved;
 RETURN jsonb_build_object('id',saved.id,'classification','SYNTHETIC');
END $$;

-- No grant to enrollment; no fixture/customer login can install its own authority.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['environment','qualification','managed_operation','budget_pause','attempt','attempt_event','settlement','adjustment','reconciliation'] LOOP
  EXECUTE format('ALTER TABLE lyraseo_ledger.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE lyraseo_ledger.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY ledger_owner ON lyraseo_ledger.%I TO lyraseo_ledger_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON lyraseo_ledger.%I TO lyraseo_ledger_owner',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['Operation','BudgetPeriod','UsageReceipt','Site','Workspace','ProductUser','Membership','SiteGrant'] LOOP
  EXECUTE format('CREATE POLICY ledger_owner ON public.%I TO lyraseo_ledger_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('GRANT SELECT ON public.%I TO lyraseo_ledger_owner',t);
 END LOOP;
END $$;
GRANT UPDATE(id) ON public."Site" TO lyraseo_ledger_owner;
GRANT UPDATE ON public."Operation",public."BudgetPeriod" TO lyraseo_ledger_owner;
GRANT INSERT ON public."UsageReceipt" TO lyraseo_ledger_owner;
CREATE POLICY ledger_owner ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_ledger_owner USING(true);
GRANT SELECT ON lyraseo_kernel.test_environment TO lyraseo_ledger_owner;
GRANT EXECUTE ON FUNCTION lyraseo_kernel.is_test_database() TO lyraseo_ledger_owner;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='lyraseo_ledger'::regnamespace LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_ledger_owner',f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA lyraseo_ledger FROM PUBLIC;
REVOKE ALL ON public."KeywordSelection",public."KeywordEnrichmentResult" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA lyraseo_ledger FROM %I',r);
   EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lyraseo_ledger FROM %I',r);
   EXECUTE format('REVOKE ALL ON SCHEMA lyraseo_ledger FROM %I',r);
   EXECUTE format('REVOKE ALL ON public."KeywordSelection",public."KeywordEnrichmentResult" FROM %I',r);
  END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA lyraseo_ledger TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_ledger.apply_budget_change(text,numeric,boolean,boolean) TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_ledger.prepare_attempt(text,integer,text,text,integer),lyraseo_ledger.record_evidence(uuid,text,jsonb),lyraseo_ledger.snapshot(text),lyraseo_ledger.close_plan(text,integer),lyraseo_ledger.settle(text,integer,text),lyraseo_ledger.apply_adjustment(text,integer),lyraseo_ledger.claim_reconciliation(integer),lyraseo_ledger.finish_reconciliation(text,integer,text),lyraseo_ledger.cancel(text),lyraseo_ledger.save_keyword_fixture(uuid,text,jsonb,timestamptz) TO lyraseo_ledger_fixture;
COMMIT;
