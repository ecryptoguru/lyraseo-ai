BEGIN;
-- Scope is immutable. Serialize each fixture transition with the established
-- Workspace -> Site -> ProductUser -> destination/intent lock order. This
-- remains fixture-only: no production admission or egress capability is added.
CREATE FUNCTION lyraseo_handoff.lock_fixture_scope(id_ uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE w text; s text; u text;
BEGIN
 SELECT workspace_id,site_id,created_by INTO w,s,u
 FROM lyraseo_handoff.intent WHERE id=id_ AND mode='FIXTURE';
 IF w IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STALE_HANDOFF'; END IF;
 PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(w,s) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STALE_HANDOFF'; END IF;
 PERFORM 1 FROM public."ProductUser" WHERE id=u FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STALE_HANDOFF'; END IF;
END $$;
ALTER FUNCTION lyraseo_handoff.lock_fixture_scope(uuid) OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.lock_fixture_scope(uuid) FROM PUBLIC;

ALTER FUNCTION lyraseo_handoff.fixture_claim(uuid) RENAME TO fixture_claim_inner;
ALTER FUNCTION lyraseo_handoff.fixture_before_socket(uuid,integer) RENAME TO fixture_before_socket_inner;
ALTER FUNCTION lyraseo_handoff.fixture_finish(uuid,integer,text,integer,text,bigint,text) RENAME TO fixture_finish_inner;

CREATE FUNCTION lyraseo_handoff.fixture_claim(id_ uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM lyraseo_handoff.fixture_guard();
 PERFORM lyraseo_handoff.lock_fixture_scope(id_);
 RETURN lyraseo_handoff.fixture_claim_inner(id_);
END $$;
CREATE FUNCTION lyraseo_handoff.fixture_before_socket(id_ uuid,fence_ integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM lyraseo_handoff.fixture_guard();
 PERFORM lyraseo_handoff.lock_fixture_scope(id_);
 RETURN lyraseo_handoff.fixture_before_socket_inner(id_,fence_);
END $$;
CREATE FUNCTION lyraseo_handoff.fixture_finish(id_ uuid,fence_ integer,outcome_ text,status_ integer,code_ text,remote_ bigint DEFAULT NULL,editor_ text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM lyraseo_handoff.fixture_guard();
 PERFORM lyraseo_handoff.lock_fixture_scope(id_);
 RETURN lyraseo_handoff.fixture_finish_inner(id_,fence_,outcome_,status_,code_,remote_,editor_);
END $$;
ALTER FUNCTION lyraseo_handoff.fixture_claim(uuid) OWNER TO lyraseo_handoff_owner;
ALTER FUNCTION lyraseo_handoff.fixture_before_socket(uuid,integer) OWNER TO lyraseo_handoff_owner;
ALTER FUNCTION lyraseo_handoff.fixture_finish(uuid,integer,text,integer,text,bigint,text) OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.fixture_claim(uuid),lyraseo_handoff.fixture_before_socket(uuid,integer),lyraseo_handoff.fixture_finish(uuid,integer,text,integer,text,bigint,text),lyraseo_handoff.fixture_claim_inner(uuid),lyraseo_handoff.fixture_before_socket_inner(uuid,integer),lyraseo_handoff.fixture_finish_inner(uuid,integer,text,integer,text,bigint,text) FROM PUBLIC;
-- Preserve explicit local-fixture grants across upgrade, without leaving a way
-- to call the pre-lock inner functions directly. Never create or enroll a role.
DO $$
DECLARE old_ regprocedure; wrapped_ regprocedure;
BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_handoff_fixture') THEN
  FOR old_,wrapped_ IN VALUES
   ('lyraseo_handoff.fixture_claim_inner(uuid)'::regprocedure,'lyraseo_handoff.fixture_claim(uuid)'::regprocedure),
   ('lyraseo_handoff.fixture_before_socket_inner(uuid,integer)'::regprocedure,'lyraseo_handoff.fixture_before_socket(uuid,integer)'::regprocedure),
   ('lyraseo_handoff.fixture_finish_inner(uuid,integer,text,integer,text,bigint,text)'::regprocedure,'lyraseo_handoff.fixture_finish(uuid,integer,text,integer,text,bigint,text)'::regprocedure)
  LOOP
   IF has_function_privilege('lyraseo_handoff_fixture',old_,'EXECUTE') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lyraseo_handoff_fixture',wrapped_);
   END IF;
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM lyraseo_handoff_fixture',old_);
  END LOOP;
 END IF;
END $$;

-- WORK IN PROGRESS: not a migration or a deployable artifact.
-- A distinct relation carries only fixture intent IDs; runtime admission for
-- quarantined customer intents stays disabled pending a reviewed binding.
CREATE TABLE lyraseo_handoff.dispatch_policy (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO lyraseo_handoff.dispatch_policy(id) VALUES(true);
CREATE TABLE lyraseo_handoff.dispatch_policy_history (
 revision integer PRIMARY KEY, enabled boolean NOT NULL, operator_id text NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE lyraseo_handoff.egress_hour (
 workspace_id text NOT NULL, site_id text NOT NULL, bucket timestamptz NOT NULL,
 used integer NOT NULL CHECK(used BETWEEN 1 AND 60), PRIMARY KEY(workspace_id,site_id,bucket),
 FOREIGN KEY(workspace_id,site_id) REFERENCES public."Site"("workspaceId",id) ON DELETE CASCADE
);
ALTER TABLE lyraseo_handoff.egress_hour ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_handoff.egress_hour FORCE ROW LEVEL SECURITY;
CREATE POLICY purpose_owner ON lyraseo_handoff.egress_hour TO lyraseo_handoff_owner USING(true) WITH CHECK(true);
REVOKE ALL ON lyraseo_handoff.egress_hour FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON lyraseo_handoff.egress_hour TO lyraseo_handoff_owner;
CREATE TABLE lyraseo_handoff.dispatch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), intent_id uuid NOT NULL UNIQUE REFERENCES lyraseo_handoff.intent(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN('PENDING','DELIVERED','DONE','SUPPRESSED')) DEFAULT 'PENDING',
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0), next_due timestamptz,
 claim_token uuid, lease_until timestamptz, delivered_at timestamptz,
 CHECK((claim_token IS NULL)=(lease_until IS NULL)),
 CHECK(claim_token IS NULL OR state='PENDING'),
 CHECK((state IN('PENDING','DELIVERED'))=(next_due IS NOT NULL)),
 CHECK(state<>'DELIVERED' OR delivered_at IS NOT NULL)
);
CREATE INDEX handoff_dispatch_due ON lyraseo_handoff.dispatch(next_due,id) WHERE state IN('PENDING','DELIVERED');
ALTER TABLE lyraseo_handoff.dispatch_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_handoff.dispatch_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY purpose_owner ON lyraseo_handoff.dispatch_policy TO lyraseo_handoff_owner USING(true) WITH CHECK(true);
ALTER TABLE lyraseo_handoff.dispatch_policy_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_handoff.dispatch_policy_history FORCE ROW LEVEL SECURITY;
CREATE POLICY purpose_owner ON lyraseo_handoff.dispatch_policy_history TO lyraseo_handoff_owner USING(true) WITH CHECK(true);
ALTER TABLE lyraseo_handoff.dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_handoff.dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY purpose_owner ON lyraseo_handoff.dispatch TO lyraseo_handoff_owner USING(true) WITH CHECK(true);
REVOKE ALL ON lyraseo_handoff.dispatch_policy,lyraseo_handoff.dispatch_policy_history,lyraseo_handoff.dispatch FROM PUBLIC;
GRANT SELECT,UPDATE ON lyraseo_handoff.dispatch_policy TO lyraseo_handoff_owner;
GRANT SELECT,INSERT ON lyraseo_handoff.dispatch_policy_history TO lyraseo_handoff_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON lyraseo_handoff.dispatch TO lyraseo_handoff_owner;
CREATE FUNCTION lyraseo_handoff.enqueue_fixture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.mode='FIXTURE' THEN INSERT INTO lyraseo_handoff.dispatch(intent_id,next_due) VALUES(NEW.id,NEW.next_due_at); END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION lyraseo_handoff.enqueue_fixture() OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.enqueue_fixture() FROM PUBLIC;
CREATE TRIGGER enqueue_fixture AFTER INSERT ON lyraseo_handoff.intent FOR EACH ROW EXECUTE FUNCTION lyraseo_handoff.enqueue_fixture();
-- Migrated fixture rows only; never promote a quarantined customer intent.
INSERT INTO lyraseo_handoff.dispatch(intent_id,next_due)
 SELECT id,next_due_at FROM lyraseo_handoff.intent WHERE mode='FIXTURE' AND state IN('PREPARED','RETRY') ON CONFLICT(intent_id) DO NOTHING;
GRANT USAGE ON SCHEMA lyraseo_kernel TO lyraseo_handoff_owner;
GRANT EXECUTE ON FUNCTION lyraseo_kernel.is_test_database() TO lyraseo_handoff_owner;
GRANT SELECT ON lyraseo_kernel.test_environment TO lyraseo_handoff_owner;
CREATE POLICY handoff_test_database_read ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_handoff_owner USING(true);
GRANT SELECT ON public."RuntimePolicy" TO lyraseo_handoff_owner;
CREATE POLICY handoff_policy_read ON public."RuntimePolicy" FOR SELECT TO lyraseo_handoff_owner USING(true);
CREATE FUNCTION lyraseo_handoff.qualified() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT lyraseo_kernel.is_test_database()
 AND EXISTS(SELECT FROM lyraseo_handoff.fixture_environment e JOIN pg_database d ON d.oid=e.database_oid
  WHERE d.datname=current_database() AND e.postmaster_started_at=pg_postmaster_start_time())
 AND (SELECT enabled FROM lyraseo_handoff.dispatch_policy WHERE id)
 AND EXISTS(SELECT FROM public."RuntimePolicy" WHERE key='global' AND enabled)
$$;
-- Hold policy rows through each short transition; an operator kill switch that
-- wins these locks cannot be passed by a stale pre-socket read.
GRANT UPDATE(key) ON public."RuntimePolicy" TO lyraseo_handoff_owner;
CREATE POLICY handoff_policy_lock ON public."RuntimePolicy" FOR UPDATE TO lyraseo_handoff_owner USING(true) WITH CHECK(false);
CREATE FUNCTION lyraseo_handoff.lock_qualification() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public."RuntimePolicy" WHERE key='global' FOR SHARE;
 PERFORM 1 FROM lyraseo_handoff.dispatch_policy WHERE id FOR SHARE;
 IF NOT lyraseo_handoff.qualified() THEN RAISE EXCEPTION 'PAUSED'; END IF;
END $$;
ALTER FUNCTION lyraseo_handoff.lock_qualification() OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.lock_qualification() FROM PUBLIC;
CREATE FUNCTION lyraseo_handoff.change_fixture_policy(expected integer,enabled_ boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE revision_ integer;
BEGIN
 IF session_user<>'lyraseo_operator' OR NOT lyraseo_kernel.is_test_database()
 OR NOT EXISTS(SELECT FROM lyraseo_handoff.fixture_environment e JOIN pg_database d ON d.oid=e.database_oid WHERE d.datname=current_database() AND e.postmaster_started_at=pg_postmaster_start_time()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 UPDATE lyraseo_handoff.dispatch_policy SET enabled=enabled_,revision=revision+1,changed_at=clock_timestamp() WHERE id AND revision=expected RETURNING revision INTO revision_;
 IF revision_ IS NULL THEN RAISE EXCEPTION 'POLICY_CONFLICT'; END IF;
 INSERT INTO lyraseo_handoff.dispatch_policy_history VALUES(revision_,enabled_,session_user,clock_timestamp());
 RETURN revision_;
END $$;
CREATE FUNCTION lyraseo_handoff.read_fixture_policy() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result_ jsonb;
BEGIN
 IF session_user<>'lyraseo_operator' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT jsonb_build_object('enabled',enabled,'revision',revision,'changedAt',changed_at,'qualified',lyraseo_handoff.qualified()) INTO result_ FROM lyraseo_handoff.dispatch_policy WHERE id;
 RETURN result_;
END $$;
ALTER FUNCTION lyraseo_handoff.read_fixture_policy() OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.read_fixture_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_handoff.read_fixture_policy() TO lyraseo_operator;
ALTER FUNCTION lyraseo_handoff.qualified() OWNER TO lyraseo_handoff_owner;
ALTER FUNCTION lyraseo_handoff.change_fixture_policy(integer,boolean) OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.qualified(),lyraseo_handoff.change_fixture_policy(integer,boolean) FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_handoff TO lyraseo_operator,lyraseo_dispatch,lyraseo_kernel_owner;
GRANT EXECUTE ON FUNCTION lyraseo_handoff.change_fixture_policy(integer,boolean) TO lyraseo_operator;
CREATE FUNCTION lyraseo_handoff.valid_fixture(i lyraseo_handoff.intent) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT i.mode='FIXTURE' AND i.state IN('PREPARED','RETRY','SENDING')
 AND lyraseo_handoff.permission(i.workspace_id,i.site_id,i.created_by,i.security_version)
 AND EXISTS(SELECT FROM public."Site" s WHERE(s."workspaceId",s.id)=(i.workspace_id,i.site_id) AND s."verifiedAt" AT TIME ZONE 'UTC' BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp())
 AND EXISTS(SELECT FROM lyraseo_handoff.destination d WHERE d.id=i.destination_id AND d.status='CONFIGURED' AND d.generation=i.destination_generation)
$$;
ALTER FUNCTION lyraseo_handoff.valid_fixture(lyraseo_handoff.intent) OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.valid_fixture(lyraseo_handoff.intent) FROM PUBLIC;
CREATE FUNCTION lyraseo_handoff.resolve_delivery(work_id uuid, gen integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF session_user<>'lyraseo_dispatch' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN EXISTS(SELECT FROM lyraseo_handoff.dispatch d WHERE d.id=work_id AND d.generation=gen);
END $$;
ALTER FUNCTION lyraseo_handoff.resolve_delivery(uuid,integer) OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.resolve_delivery(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_handoff.resolve_delivery(uuid,integer) TO lyraseo_dispatch;
GRANT SELECT(id) ON public."WorkDispatch" TO lyraseo_handoff_owner;
CREATE POLICY handoff_dispatch_id_read ON public."WorkDispatch" FOR SELECT TO lyraseo_handoff_owner USING(true);
CREATE OR REPLACE FUNCTION lyraseo_handoff.resolve_delivery(work_id uuid, gen integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE found_ boolean;
BEGIN
 IF session_user<>'lyraseo_dispatch' OR gen IS NULL OR gen<1 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT EXISTS(SELECT FROM lyraseo_handoff.dispatch d WHERE d.id=work_id) INTO found_;
 IF found_ AND EXISTS(SELECT FROM public."WorkDispatch" WHERE id=work_id) THEN RAISE EXCEPTION 'AMBIGUOUS_WORK_ID'; END IF;
 RETURN found_;
END $$;
-- The dispatch login has no grant on these fixture methods; the signed step
-- definer is the only caller using this additional identity.
CREATE OR REPLACE FUNCTION lyraseo_handoff.fixture_guard() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF session_user NOT IN('lyraseo_handoff_fixture','lyraseo_dispatch') OR current_database()!~'^lyraseo_handoff_[a-f0-9]{12}$'
 OR NOT EXISTS(SELECT FROM lyraseo_handoff.fixture_environment e JOIN pg_database d ON d.oid=e.database_oid WHERE d.datname=current_database() AND e.postmaster_started_at=pg_postmaster_start_time())
 OR (session_user='lyraseo_dispatch' AND NOT lyraseo_handoff.qualified()) THEN RAISE EXCEPTION 'FIXTURE_ONLY'; END IF;
END $$;
-- Share the kernel's principal/request replay namespace across audit and handoff
-- actions. The service login gets no table privileges.
GRANT SELECT,INSERT ON public."InternalRequest" TO lyraseo_handoff_owner;
GRANT UPDATE(state,"ownerToken",fence,"leaseUntil","completedAt",result) ON public."InternalRequest" TO lyraseo_handoff_owner;
CREATE POLICY handoff_request ON public."InternalRequest" TO lyraseo_handoff_owner USING(true) WITH CHECK(true);
CREATE TABLE lyraseo_handoff.dispatch_attempt (
 request_id uuid PRIMARY KEY, principal text NOT NULL DEFAULT 'lyraseo_dispatch' CHECK(principal='lyraseo_dispatch'),
 fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
 dispatch_id uuid NOT NULL REFERENCES lyraseo_handoff.dispatch(id) ON DELETE CASCADE,
 generation integer NOT NULL, intent_id uuid NOT NULL REFERENCES lyraseo_handoff.intent(id) ON DELETE CASCADE,
 global_revision integer NOT NULL, policy_revision integer NOT NULL, request_fence integer NOT NULL, request_token uuid NOT NULL, fence integer NOT NULL, proof_hash bytea NOT NULL CHECK(octet_length(proof_hash)=32),
 deadline timestamptz NOT NULL, result jsonb,
 FOREIGN KEY(principal,request_id) REFERENCES public."InternalRequest"("servicePrincipalId","requestId") ON DELETE CASCADE,
 CHECK(result IS NULL OR jsonb_typeof(result)='object')
);
CREATE INDEX handoff_live_attempt_by_intent ON lyraseo_handoff.dispatch_attempt(intent_id,deadline) WHERE result IS NULL;
ALTER TABLE lyraseo_handoff.dispatch_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_handoff.dispatch_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY purpose_owner ON lyraseo_handoff.dispatch_attempt TO lyraseo_handoff_owner USING(true) WITH CHECK(true);
REVOKE ALL ON lyraseo_handoff.dispatch_attempt FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON lyraseo_handoff.dispatch_attempt TO lyraseo_handoff_owner;
CREATE FUNCTION lyraseo_handoff.admit_step(rid uuid,audience text,path text,raw_ text,issued timestamptz,expires timestamptz,handler_deadline timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE body jsonb; digest bytea; old_ lyraseo_handoff.dispatch_attempt; request_ public."InternalRequest"; token_ uuid:=gen_random_uuid(); d lyraseo_handoff.dispatch; scope_ lyraseo_handoff.intent; used_ integer; bucket_ timestamptz; claim_ jsonb; proof_ text:=gen_random_uuid()::text||gen_random_uuid()::text; work_ uuid; gen_ integer;
BEGIN
 IF session_user<>'lyraseo_dispatch' OR audience IS DISTINCT FROM 'lyraseo-kernel-a' OR path IS DISTINCT FROM '/api/internal/runtime/step' OR rid IS NULL OR raw_ IS NULL OR octet_length(raw_)>1024
 OR issued IS NULL OR expires IS NULL OR handler_deadline IS NULL OR NOT isfinite(issued) OR NOT isfinite(expires) OR NOT isfinite(handler_deadline)
 OR expires<=issued OR expires-issued>interval '60 seconds' OR issued>clock_timestamp()+interval '30 seconds' OR expires<=clock_timestamp() OR handler_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 body:=raw_::jsonb;
 IF jsonb_typeof(body)<>'object' OR body-ARRAY['version','workId','generation']<>'{}' OR body->'version'<>'1'::jsonb OR jsonb_typeof(body->'workId')<>'string' OR jsonb_typeof(body->'generation')<>'number' OR body->>'generation'!~'^[1-9][0-9]{0,9}$' THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 work_:=(body->>'workId')::uuid;gen_:=(body->>'generation')::integer;
 digest:=sha256(convert_to(jsonb_build_array('v1',audience,'POST',path,encode(sha256(convert_to(raw_,'UTF8')),'hex'),extract(epoch from issued),extract(epoch from expires))::text,'UTF8'));
 PERFORM pg_advisory_xact_lock(hashtextextended('handoff-request:'||rid::text,0));
 INSERT INTO public."InternalRequest"("servicePrincipalId","requestId",fingerprint,"issuedAt","expiresAt",state,"ownerToken",fence,"leaseUntil")
 VALUES(session_user,rid,digest,issued,expires,'ACTIVE',token_,1,least(expires,handler_deadline,clock_timestamp()+interval '25 seconds')) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT request_ FROM public."InternalRequest" WHERE ("servicePrincipalId","requestId")=(session_user,rid) FOR UPDATE;
 -- The unique-key insertion or row lock may have waited beyond either
 -- authoritative deadline. Recheck before completed or active replay.
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF handler_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'HANDLER_DEADLINE'; END IF;
 IF request_.fingerprint<>digest THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
 IF request_.state='COMPLETE' THEN RETURN request_.result; END IF;
 IF request_."ownerToken"<>token_ THEN
  RETURN jsonb_build_object('disposition',CASE WHEN request_."leaseUntil">clock_timestamp() THEN 'IN_PROGRESS' ELSE 'STALE' END);
 END IF;
 -- Only a new attempt needs enough time for its bounded HTTP request. Exact,
 -- already-completed replays returned above perform no new work.
 IF expires<=clock_timestamp()+interval '11 seconds' OR handler_deadline<=clock_timestamp()+interval '11 seconds' THEN RAISE EXCEPTION 'RETRY_FRESH'; END IF;
 PERFORM lyraseo_handoff.lock_qualification();
 SELECT * INTO d FROM lyraseo_handoff.dispatch WHERE id=work_ AND generation=gen_ AND state='DELIVERED';
 IF d.id IS NULL OR EXISTS(SELECT FROM public."WorkDispatch" WHERE id=work_) THEN
  UPDATE public."InternalRequest" SET state='COMPLETE',"completedAt"=clock_timestamp(),"ownerToken"=NULL,"leaseUntil"=NULL,result='{"disposition":"STALE"}' WHERE ("servicePrincipalId","requestId","ownerToken")=(session_user,rid,token_) AND "expiresAt">clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_REQUEST'; END IF;
  RETURN '{"disposition":"STALE"}';
 END IF;
 -- Resource controls are infrastructure egress counters, never AI spend.
 -- Acquire the tenant/site scope before the advisory site lock and quota row;
 -- deletion acquires the same scope before cascading quota rows.
 SELECT * INTO scope_ FROM lyraseo_handoff.intent WHERE id=d.intent_id;
 PERFORM lyraseo_handoff.lock_fixture_scope(d.intent_id);
 PERFORM pg_advisory_xact_lock(hashtextextended('handoff-site:'||length(scope_.workspace_id)::text||':'||scope_.workspace_id||scope_.site_id,0));
 IF EXISTS(SELECT FROM lyraseo_handoff.dispatch_attempt a JOIN lyraseo_handoff.intent i ON i.id=a.intent_id
   WHERE (i.workspace_id,i.site_id)=(scope_.workspace_id,scope_.site_id) AND a.result IS NULL AND a.deadline>clock_timestamp()) THEN
  UPDATE public."InternalRequest" SET state='COMPLETE',"completedAt"=clock_timestamp(),"ownerToken"=NULL,"leaseUntil"=NULL,result='{"disposition":"IN_PROGRESS"}' WHERE ("servicePrincipalId","requestId","ownerToken")=(session_user,rid,token_);
  RETURN '{"disposition":"IN_PROGRESS"}';
 END IF;
 bucket_:=to_timestamp(floor(extract(epoch FROM clock_timestamp())/3600)*3600);
 DELETE FROM lyraseo_handoff.egress_hour WHERE (workspace_id,site_id)=(scope_.workspace_id,scope_.site_id) AND bucket<bucket_-interval '24 hours';
 INSERT INTO lyraseo_handoff.egress_hour(workspace_id,site_id,bucket,used) VALUES(scope_.workspace_id,scope_.site_id,bucket_,1)
 ON CONFLICT(workspace_id,site_id,bucket) DO UPDATE SET used=lyraseo_handoff.egress_hour.used+1 WHERE lyraseo_handoff.egress_hour.used<60 RETURNING used INTO used_;
 IF used_ IS NULL THEN
  UPDATE public."InternalRequest" SET state='COMPLETE',"completedAt"=clock_timestamp(),"ownerToken"=NULL,"leaseUntil"=NULL,result='{"disposition":"IN_PROGRESS"}' WHERE ("servicePrincipalId","requestId","ownerToken")=(session_user,rid,token_);
  RETURN '{"disposition":"IN_PROGRESS"}';
 END IF;
 -- Fixture claim obtains the matching tenant/site/user/destination/intent locks
 -- and commits the WP SENDING barrier before a proof is returned.
 claim_:=lyraseo_handoff.fixture_claim(d.intent_id);
 IF claim_ IS NULL THEN
  DELETE FROM lyraseo_handoff.egress_hour WHERE (workspace_id,site_id,bucket,used)=(scope_.workspace_id,scope_.site_id,bucket_,1);
  IF NOT FOUND THEN UPDATE lyraseo_handoff.egress_hour SET used=used-1 WHERE (workspace_id,site_id,bucket)=(scope_.workspace_id,scope_.site_id,bucket_); END IF;
  UPDATE public."InternalRequest" SET state='COMPLETE',"completedAt"=clock_timestamp(),"ownerToken"=NULL,"leaseUntil"=NULL,result='{"disposition":"STALE"}' WHERE ("servicePrincipalId","requestId","ownerToken")=(session_user,rid,token_) AND "expiresAt">clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_REQUEST'; END IF;
  RETURN '{"disposition":"STALE"}';
 END IF;
 SELECT * INTO d FROM lyraseo_handoff.dispatch WHERE id=work_ FOR UPDATE;
 IF d.id IS NULL OR d.generation<>gen_ OR d.state<>'DELIVERED' OR NOT lyraseo_handoff.qualified() OR expires<=clock_timestamp()+interval '11 seconds' OR handler_deadline<=clock_timestamp()+interval '11 seconds' THEN RAISE EXCEPTION 'STALE_TARGET'; END IF;
 INSERT INTO lyraseo_handoff.dispatch_attempt(request_id,fingerprint,dispatch_id,generation,intent_id,global_revision,policy_revision,request_fence,request_token,fence,proof_hash,deadline)
 VALUES(rid,digest,d.id,d.generation,d.intent_id,(SELECT revision FROM public."RuntimePolicy" WHERE key='global'),(SELECT revision FROM lyraseo_handoff.dispatch_policy WHERE id),request_.fence,request_."ownerToken",(claim_->>'fence')::integer,sha256(convert_to(proof_,'UTF8')),least(expires,handler_deadline,clock_timestamp()+interval '25 seconds'));
 UPDATE lyraseo_handoff.dispatch SET next_due=clock_timestamp()+interval '31 seconds' WHERE id=d.id;
 RETURN jsonb_build_object('disposition','ADMITTED','proof',proof_,'kind',claim_->>'kind');
END $$;
CREATE FUNCTION lyraseo_handoff.check_step(rid uuid,proof_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a lyraseo_handoff.dispatch_attempt; d lyraseo_handoff.dispatch; binding_ jsonb;
BEGIN
 IF session_user<>'lyraseo_dispatch' OR proof_ IS NULL OR length(proof_)>128 THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 PERFORM lyraseo_handoff.lock_qualification();
 SELECT * INTO a FROM lyraseo_handoff.dispatch_attempt WHERE request_id=rid AND proof_hash=sha256(convert_to(proof_,'UTF8')) AND result IS NULL AND deadline>clock_timestamp();
 IF a.request_id IS NULL THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 SELECT * INTO d FROM lyraseo_handoff.dispatch WHERE id=a.dispatch_id AND generation=a.generation AND state='DELIVERED';
 IF d.id IS NULL THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 binding_:=lyraseo_handoff.fixture_before_socket(a.intent_id,a.fence);
 -- The scope locks may have blocked past proof expiration or queue fencing.
 IF NOT lyraseo_handoff.qualified() OR NOT EXISTS(SELECT FROM lyraseo_handoff.dispatch_attempt x JOIN lyraseo_handoff.dispatch q ON q.id=x.dispatch_id
 WHERE x.request_id=rid AND x.proof_hash=sha256(convert_to(proof_,'UTF8')) AND x.result IS NULL AND x.deadline>clock_timestamp()
 AND q.generation=x.generation AND q.state='DELIVERED' AND EXISTS(SELECT FROM public."InternalRequest" r WHERE(r."servicePrincipalId",r."requestId",r.state,r.fence,r."ownerToken")=(session_user,rid,'ACTIVE',x.request_fence,x.request_token) AND least(r."leaseUntil",r."expiresAt")>clock_timestamp()) AND x.global_revision=(SELECT revision FROM public."RuntimePolicy" WHERE key='global') AND x.policy_revision=(SELECT revision FROM lyraseo_handoff.dispatch_policy WHERE id)) THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 RETURN binding_;
END $$;
CREATE FUNCTION lyraseo_handoff.finish_step(rid uuid,proof_ text,outcome_ text,status_ integer,code_ text,remote_ bigint,editor_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a lyraseo_handoff.dispatch_attempt; final_ jsonb; state_ text; due_ timestamptz;
BEGIN
 IF session_user<>'lyraseo_dispatch' OR proof_ IS NULL THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 PERFORM lyraseo_handoff.lock_qualification();
 SELECT * INTO a FROM lyraseo_handoff.dispatch_attempt WHERE request_id=rid AND proof_hash=sha256(convert_to(proof_,'UTF8')) AND result IS NULL;
 IF a.request_id IS NULL THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 -- Acquire the common scope and target write locks before the attempt lock;
 -- parallel completions cannot deadlock while upgrading shared target locks.
 PERFORM lyraseo_handoff.lock_fixture_scope(a.intent_id);
 PERFORM 1 FROM lyraseo_handoff.destination WHERE id=(SELECT destination_id FROM lyraseo_handoff.intent WHERE id=a.intent_id) FOR UPDATE;
 PERFORM 1 FROM lyraseo_handoff.intent WHERE id=a.intent_id FOR UPDATE;
 PERFORM lyraseo_handoff.check_step(rid,proof_);
 SELECT * INTO a FROM lyraseo_handoff.dispatch_attempt WHERE request_id=rid AND proof_hash=sha256(convert_to(proof_,'UTF8')) AND result IS NULL AND deadline>clock_timestamp() FOR UPDATE;
 IF a.request_id IS NULL THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 final_:=lyraseo_handoff.fixture_finish(a.intent_id,a.fence,outcome_,status_,code_,remote_,editor_);
 state_:=final_->>'state';
 SELECT next_due_at INTO due_ FROM lyraseo_handoff.intent WHERE id=a.intent_id;
 UPDATE lyraseo_handoff.dispatch SET state=CASE WHEN state_='RETRY' THEN 'PENDING' ELSE 'DONE' END,
 generation=generation+CASE WHEN state_='RETRY' THEN 1 ELSE 0 END,
 next_due=CASE WHEN state_='RETRY' THEN due_ END,delivered_at=NULL,claim_token=NULL,lease_until=NULL
 WHERE id=a.dispatch_id AND generation=a.generation AND state='DELIVERED';
 IF NOT FOUND OR a.deadline<=clock_timestamp() OR NOT lyraseo_handoff.qualified() THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 UPDATE public."InternalRequest" SET state='COMPLETE',"completedAt"=clock_timestamp(),"ownerToken"=NULL,"leaseUntil"=NULL,result='{"disposition":"COMPLETED"}'
 WHERE ("servicePrincipalId","requestId",state,fence,"ownerToken")=(session_user,rid,'ACTIVE',a.request_fence,a.request_token)
 AND least("leaseUntil","expiresAt",a.deadline)>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 UPDATE lyraseo_handoff.dispatch_attempt SET result='{"disposition":"COMPLETED"}' WHERE request_id=rid;
 RETURN '{"disposition":"COMPLETED"}';
END $$;
DO $$ DECLARE f regprocedure; BEGIN
 FOREACH f IN ARRAY ARRAY['lyraseo_handoff.admit_step(uuid,text,text,text,timestamptz,timestamptz,timestamptz)'::regprocedure,'lyraseo_handoff.check_step(uuid,text)'::regprocedure,'lyraseo_handoff.finish_step(uuid,text,text,integer,text,bigint,text)'::regprocedure] LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_handoff_owner',f);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lyraseo_dispatch',f);
 END LOOP;
END $$;
CREATE FUNCTION lyraseo_handoff.apply_control(path text,body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_variable
DECLARE lim integer; refs jsonb; r record; intent_ lyraseo_handoff.intent; count_ integer:=0; reopened_ integer:=0; suppressed_ integer:=0; retry_ integer;
BEGIN
 IF session_user<>'lyraseo_dispatch' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF path IN('/api/internal/runtime/dispatch','/api/internal/runtime/recover') THEN
  IF jsonb_typeof(body)<>'object' OR body-'limit'<>'{}' OR jsonb_typeof(body->'limit')<>'number' OR body->>'limit'!~'^([1-9]|1[0-9]|20)$' THEN RAISE EXCEPTION 'INVALID_LIMIT'; END IF;
  lim:=(body->>'limit')::integer;
  IF NOT lyraseo_handoff.qualified() THEN RETURN '{"disposition":"PAUSED","refs":[]}'; END IF;
  IF path='/api/internal/runtime/dispatch' THEN
   WITH due AS MATERIALIZED (
    SELECT d.id,d.next_due FROM lyraseo_handoff.dispatch d JOIN lyraseo_handoff.intent i ON i.id=d.intent_id
    WHERE d.state='PENDING' AND d.next_due<=clock_timestamp() AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp())
    AND i.state IN('PREPARED','RETRY') AND lyraseo_handoff.valid_fixture(i)
    ORDER BY d.next_due,d.id LIMIT lim FOR UPDATE OF d SKIP LOCKED
   ), changed AS (
    UPDATE lyraseo_handoff.dispatch d SET claim_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '30 seconds'
    FROM due WHERE d.id=due.id RETURNING d.id,d.generation,d.claim_token,due.next_due
   ) SELECT coalesce(jsonb_agg(jsonb_build_object('workId',id,'generation',generation,'claimToken',claim_token) ORDER BY next_due,id),'[]'::jsonb) INTO refs FROM changed;
   RETURN jsonb_build_object('disposition','OK','refs',refs);
  END IF;
  -- Bound discovery first, then acquire all target scopes in a stable total
  -- order, including when concurrent sweeps select overlapping batches.
  FOR r IN SELECT due.id,due.intent_id FROM (
   SELECT d.id,d.intent_id FROM lyraseo_handoff.dispatch d
   WHERE (d.state='PENDING' AND d.lease_until IS NOT NULL AND d.lease_until<=clock_timestamp()) OR (d.state='DELIVERED' AND d.next_due<=clock_timestamp())
   ORDER BY d.next_due,d.id LIMIT lim
  ) due JOIN lyraseo_handoff.intent i ON i.id=due.intent_id
  -- Destination rows are the exclusive locks held across iterations. Creator
  -- must come after destination so overlapping batches acquire them in one
  -- total order even when multiple actors share a destination.
  ORDER BY i.workspace_id,i.site_id,i.destination_id,i.created_by,i.id LOOP
   -- Match admission/finish: scope first, then queue. Recheck after waiting.
   PERFORM lyraseo_handoff.lock_fixture_scope(r.intent_id);
   PERFORM 1 FROM lyraseo_handoff.destination WHERE id=(SELECT destination_id FROM lyraseo_handoff.intent WHERE id=r.intent_id) FOR UPDATE;
   PERFORM 1 FROM lyraseo_handoff.intent WHERE id=r.intent_id FOR UPDATE;
   PERFORM 1 FROM lyraseo_handoff.dispatch d WHERE d.id=r.id AND ((d.state='PENDING' AND d.lease_until IS NOT NULL AND d.lease_until<=clock_timestamp()) OR (d.state='DELIVERED' AND d.next_due<=clock_timestamp())) FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   SELECT * INTO intent_ FROM lyraseo_handoff.intent WHERE id=r.intent_id;
   IF intent_.state='SENDING' AND intent_.lease_until<=clock_timestamp() THEN PERFORM lyraseo_handoff.fixture_claim(intent_.id); SELECT * INTO intent_ FROM lyraseo_handoff.intent WHERE id=intent_.id; END IF;
   IF intent_.state='SENDING' AND intent_.lease_until>clock_timestamp() THEN
    UPDATE lyraseo_handoff.dispatch SET next_due=intent_.lease_until+interval '1 second' WHERE id=r.id;
   ELSIF intent_.state IN('PREPARED','RETRY') AND lyraseo_handoff.valid_fixture(intent_) THEN
    UPDATE lyraseo_handoff.dispatch SET state='PENDING',generation=generation+1,next_due=greatest(clock_timestamp(),intent_.next_due_at),claim_token=NULL,lease_until=NULL,delivered_at=NULL WHERE id=r.id;
    reopened_:=reopened_+1;
   ELSE
    UPDATE lyraseo_handoff.dispatch SET state='SUPPRESSED',next_due=NULL,claim_token=NULL,lease_until=NULL,delivered_at=NULL WHERE id=r.id;
    suppressed_:=suppressed_+1;
   END IF;
  END LOOP;
  RETURN jsonb_build_object('disposition','OK','reopened',reopened_,'suppressed',suppressed_,'reconciliation',0);
 END IF;
 IF path NOT IN('/api/internal/runtime/dispatch/ack','/api/internal/runtime/dispatch/defer') OR jsonb_typeof(body)<>'object' OR body-ARRAY['workId','generation','claimToken','retrySeconds']<>'{}' OR NOT(body ?& ARRAY['workId','generation','claimToken']) OR jsonb_typeof(body->'generation')<>'number' OR body->>'generation'!~'^[1-9][0-9]{0,9}$' OR jsonb_typeof(body->'workId')<>'string' OR jsonb_typeof(body->'claimToken')<>'string' THEN RAISE EXCEPTION 'INVALID_REFERENCE'; END IF;
 IF path='/api/internal/runtime/dispatch/defer' THEN
  IF jsonb_typeof(body->'retrySeconds')<>'number' OR body->>'retrySeconds'!~'^[1-9][0-9]{0,2}$' OR (body->>'retrySeconds')::integer>300 THEN RAISE EXCEPTION 'INVALID_RETRY'; END IF;
  retry_:=(body->>'retrySeconds')::integer;
 ELSIF body ? 'retrySeconds' THEN RAISE EXCEPTION 'INVALID_REFERENCE'; END IF;
 IF NOT lyraseo_handoff.qualified() THEN RETURN '{"disposition":"PAUSED"}'; END IF;
 PERFORM 1 FROM lyraseo_handoff.dispatch WHERE id=(body->>'workId')::uuid FOR UPDATE;
 UPDATE lyraseo_handoff.dispatch d SET state=CASE WHEN retry_ IS NULL THEN 'DELIVERED' ELSE 'PENDING' END,
 delivered_at=CASE WHEN retry_ IS NULL THEN clock_timestamp() END,next_due=clock_timestamp()+make_interval(secs=>coalesce(retry_,120)),claim_token=NULL,lease_until=NULL
 FROM lyraseo_handoff.intent i WHERE i.id=d.intent_id AND d.id=(body->>'workId')::uuid AND d.generation=(body->>'generation')::integer
 AND d.claim_token=(body->>'claimToken')::uuid AND d.lease_until>clock_timestamp() AND d.state='PENDING' AND i.state IN('PREPARED','RETRY') AND lyraseo_handoff.valid_fixture(i);
 IF NOT FOUND THEN RETURN '{"disposition":"STALE"}'; END IF;
 RETURN jsonb_build_object('disposition',CASE WHEN retry_ IS NULL THEN 'DELIVERED' ELSE 'DEFERRED' END);
END $$;
ALTER FUNCTION lyraseo_handoff.apply_control(text,jsonb) OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.apply_control(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_handoff.apply_control(text,jsonb) TO lyraseo_kernel_owner;
CREATE FUNCTION lyraseo_handoff.has_work(work_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE found_ boolean;
BEGIN
 IF session_user<>'lyraseo_dispatch' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT EXISTS(SELECT FROM lyraseo_handoff.dispatch WHERE id=work_id) INTO found_;
 IF found_ AND EXISTS(SELECT FROM public."WorkDispatch" WHERE id=work_id) THEN RAISE EXCEPTION 'AMBIGUOUS_WORK_ID'; END IF;
 RETURN found_;
END $$;
ALTER FUNCTION lyraseo_handoff.has_work(uuid) OWNER TO lyraseo_handoff_owner;
REVOKE ALL ON FUNCTION lyraseo_handoff.has_work(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_handoff.has_work(uuid) TO lyraseo_kernel_owner;
ALTER FUNCTION lyraseo_kernel.apply_command(text,jsonb) RENAME TO apply_audit_command;
CREATE FUNCTION lyraseo_kernel.apply_command(path text,body jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE audit_ jsonb; handoff_ jsonb;
BEGIN
 IF path IN('/api/internal/runtime/dispatch/ack','/api/internal/runtime/dispatch/defer') AND body ? 'workId' AND lyraseo_handoff.has_work((body->>'workId')::uuid) THEN
  RETURN lyraseo_handoff.apply_control(path,body);
 END IF;
 -- Target scopes must be acquired before audit WorkDispatch locks. Once the
 -- audit sweep begins this transaction takes no further handoff scope locks.
 IF path='/api/internal/runtime/recover' THEN
  handoff_:=lyraseo_handoff.apply_control(path,body);
  audit_:=lyraseo_kernel.apply_audit_command(path,body);
  IF handoff_->>'disposition'='OK' THEN
   RETURN jsonb_build_object('disposition','OK','reopened',coalesce((audit_->>'reopened')::integer,0)+(handoff_->>'reopened')::integer,
    'suppressed',coalesce((audit_->>'suppressed')::integer,0)+(handoff_->>'suppressed')::integer,'reconciliation',coalesce((audit_->>'reconciliation')::integer,0));
  END IF;
  RETURN audit_;
 END IF;
 audit_:=lyraseo_kernel.apply_audit_command(path,body);
 IF path='/api/internal/runtime/dispatch' AND (audit_->>'disposition'='PAUSED' OR (audit_->>'disposition'='OK' AND jsonb_array_length(audit_->'refs')=0)) THEN
  handoff_:=lyraseo_handoff.apply_control(path,body);
  IF handoff_->>'disposition'='OK' THEN RETURN handoff_; END IF;
 END IF;
 RETURN audit_;
END $$;
ALTER FUNCTION lyraseo_kernel.apply_command(text,jsonb) OWNER TO lyraseo_kernel_owner;
REVOKE ALL ON FUNCTION lyraseo_kernel.apply_command(text,jsonb) FROM PUBLIC;

COMMIT;
