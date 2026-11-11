BEGIN;
-- LOCAL_TEST_ONLY_ACTIVE_STORE. No environment is enrolled by migration.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_legacy_inline_owner') THEN
  CREATE ROLE lyraseo_legacy_inline_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_legacy_inline_owner' AND
   (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) OR
   EXISTS(SELECT FROM pg_auth_members WHERE roleid='lyraseo_legacy_inline_owner'::regrole OR member='lyraseo_legacy_inline_owner'::regrole)
 THEN RAISE EXCEPTION 'UNSAFE_LEGACY_INLINE_ROLE'; END IF;
END $$;
CREATE SCHEMA lyraseo_legacy_inline;
REVOKE ALL ON SCHEMA lyraseo_legacy_inline FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_legacy_inline TO lyraseo_legacy_inline_owner,lyraseo_artifact_maintenance,lyraseo_runtime,lyraseo_kernel_owner;
GRANT USAGE ON SCHEMA public,lyraseo_kernel,lyraseo_audit TO lyraseo_legacy_inline_owner;
CREATE TABLE lyraseo_legacy_inline.environment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), database_oid oid NOT NULL, postmaster_started_at timestamptz NOT NULL,
 maintenance_login text NOT NULL CHECK(maintenance_login='lyraseo_artifact_maintenance'),
 workspace_id text NOT NULL,site_id text NOT NULL,policy_version text NOT NULL CHECK(policy_version='P2B2_INLINE_HTML_V1'),
 UNIQUE(database_oid,postmaster_started_at,workspace_id,site_id),
 FOREIGN KEY(workspace_id,site_id) REFERENCES public."Site"("workspaceId",id)
);
CREATE TABLE lyraseo_legacy_inline.plan (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES lyraseo_legacy_inline.environment(id),
 workspace_id text NOT NULL,site_id text NOT NULL,paused boolean NOT NULL DEFAULT false,
 cursor_id text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),next_retry_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE lyraseo_legacy_inline.event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),plan_id uuid NOT NULL REFERENCES lyraseo_legacy_inline.plan(id),
 workspace_id text NOT NULL,site_id text NOT NULL,page_id text NOT NULL UNIQUE,audit_id text NOT NULL,
 class text NOT NULL CHECK(class='AUDIT_PAGE_RAW_HTML'),field text NOT NULL CHECK(field='provenance.rawHtml'),
 policy text NOT NULL CHECK(policy='P2B2_INLINE_HTML_V1'),representation text NOT NULL CHECK(representation='legacy-inline-html-removed-v1'),
 old_hash text NOT NULL,new_hash text NOT NULL,old_bytes integer NOT NULL,new_bytes integer NOT NULL,
 fact_hash text NOT NULL,deadline timestamp NOT NULL,deadline_source text NOT NULL CHECK(deadline_source='AuditPageRetention.rawExpiresAt'),
 decision_at timestamptz NOT NULL DEFAULT clock_timestamp(),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK(old_hash ~ '^[a-f0-9]{64}$' AND new_hash ~ '^[a-f0-9]{64}$' AND fact_hash ~ '^[a-f0-9]{64}$'),
 CHECK(old_bytes>new_bytes AND new_bytes>0)
);
-- A private, one-use authorization, inaccessible to maintenance and product logins.
CREATE TABLE lyraseo_legacy_inline.permit(page_id text PRIMARY KEY,transaction_id xid8 NOT NULL,old_hash text NOT NULL,new_hash text NOT NULL);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['environment','plan','event','permit'] LOOP
  EXECUTE format('ALTER TABLE lyraseo_legacy_inline.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE lyraseo_legacy_inline.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY inline_owner ON lyraseo_legacy_inline.%I TO lyraseo_legacy_inline_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT SELECT ON lyraseo_legacy_inline.environment TO lyraseo_legacy_inline_owner;
GRANT SELECT,INSERT,UPDATE ON lyraseo_legacy_inline.plan TO lyraseo_legacy_inline_owner;
GRANT SELECT,INSERT ON lyraseo_legacy_inline.event TO lyraseo_legacy_inline_owner;
GRANT SELECT,INSERT,DELETE ON lyraseo_legacy_inline.permit TO lyraseo_legacy_inline_owner;
GRANT SELECT ON public."AuditRun",public."AuditPage",public."AuditPageRetention",lyraseo_kernel.test_environment TO lyraseo_legacy_inline_owner;
GRANT SELECT(id),UPDATE(id) ON public."Workspace" TO lyraseo_legacy_inline_owner;
GRANT SELECT(id,"workspaceId"),UPDATE(id) ON public."Site" TO lyraseo_legacy_inline_owner;
GRANT SELECT(id,"workspaceId","siteId","evidenceFormat") ON public."ContentDraft" TO lyraseo_legacy_inline_owner;
GRANT UPDATE(provenance) ON public."AuditPage" TO lyraseo_legacy_inline_owner;
-- Only the NOLOGIN purpose owner can take the identity row lock. Product runtime
-- receives EXECUTE, never direct UPDATE/locking privilege on ProductUser.
GRANT SELECT(id,"securityVersion",suspended),UPDATE(id) ON public."ProductUser" TO lyraseo_legacy_inline_owner;
GRANT SELECT("workspaceId","userId",role) ON public."Membership" TO lyraseo_legacy_inline_owner;
GRANT SELECT("workspaceId","siteId","userId") ON public."SiteGrant" TO lyraseo_legacy_inline_owner;
CREATE POLICY inline_issue_read ON public."Membership" FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
CREATE POLICY inline_issue_read ON public."SiteGrant" FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
CREATE POLICY inline_issue_identity ON public."ProductUser" TO lyraseo_legacy_inline_owner USING(id=current_setting('app.actor_id',true)) WITH CHECK(false);

CREATE POLICY inline_read ON public."Workspace" FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
CREATE POLICY inline_read ON public."Site" FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
CREATE POLICY inline_lock ON public."Workspace" FOR UPDATE TO lyraseo_legacy_inline_owner USING(true) WITH CHECK(true);
CREATE POLICY inline_lock ON public."Site" FOR UPDATE TO lyraseo_legacy_inline_owner USING(true) WITH CHECK(true);
CREATE POLICY inline_read ON public."AuditRun" FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
CREATE POLICY inline_read ON public."AuditPage" FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
CREATE POLICY inline_write ON public."AuditPage" FOR UPDATE TO lyraseo_legacy_inline_owner USING(true) WITH CHECK(true);
CREATE POLICY inline_read ON public."AuditPageRetention" FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
CREATE POLICY inline_read ON public."ContentDraft" FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
CREATE POLICY inline_read ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_legacy_inline_owner USING(true);
GRANT EXECUTE ON FUNCTION lyraseo_kernel.is_test_database(),lyraseo_audit.capture_clock(text,timestamp) TO lyraseo_legacy_inline_owner;

-- Uses the existing application-verified actor/workspace transaction boundary.
-- This function returns no evidence and creates no authorization token. Scope,
-- actor epoch/suspension and edit grant remain checked under the held locks.
CREATE FUNCTION lyraseo_legacy_inline.lock_issue_actor(w text,s text,epoch integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_id text:=current_setting('app.actor_id',true); actual_epoch integer; suspended_ boolean;
BEGIN
 IF w IS NULL OR s IS NULL OR epoch IS NULL OR epoch<0 OR
 length(w) NOT BETWEEN 1 AND 128 OR length(s) NOT BETWEEN 1 AND 128 OR
 actor_id IS NULL OR length(actor_id) NOT BETWEEN 1 AND 128 OR
 w IS DISTINCT FROM current_setting('app.workspace_id',true)
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM id FROM public."Workspace" WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM id FROM public."Site" WHERE "workspaceId"=w AND id=s FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT "securityVersion",suspended INTO actual_epoch,suspended_ FROM public."ProductUser" WHERE id=actor_id FOR SHARE;
 IF NOT FOUND OR suspended_ OR actual_epoch IS DISTINCT FROM epoch THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT FROM public."Membership" m WHERE m."workspaceId"=w AND m."userId"=actor_id AND
   (m.role IN ('OWNER','ADMIN') OR (m.role='EDITOR' AND EXISTS(SELECT FROM public."SiteGrant" g WHERE (g."workspaceId",g."siteId",g."userId")=(w,s,actor_id)))))
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN true;
END $$;

-- Domain includes PostgreSQL major and encoding; hashes cover exact UTF-8 jsonb::text bytes.
CREATE FUNCTION lyraseo_legacy_inline.hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('P2B2_INLINE_PG17_UTF8_JSONB_TEXT_V1' || chr(10) || v::text,'UTF8')),'hex')
$$;
CREATE FUNCTION lyraseo_legacy_inline.enrolled(w text,s text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT current_setting('server_version_num')::integer BETWEEN 170000 AND 179999 AND getdatabaseencoding()='UTF8' AND lyraseo_kernel.is_test_database() AND EXISTS(
 SELECT FROM lyraseo_legacy_inline.environment e WHERE (e.workspace_id,e.site_id)=(w,s) AND
 e.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND e.postmaster_started_at=pg_postmaster_start_time())
$$;
-- Stale enrollment still withholds unsafe product representations and fences writers;
-- maintenance authority itself is invalid after a restart and must be requalified.
CREATE FUNCTION lyraseo_legacy_inline.protected_scope(w text,s text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM lyraseo_legacy_inline.environment e WHERE (e.workspace_id,e.site_id)=(w,s) AND e.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()))
$$;
CREATE FUNCTION lyraseo_legacy_inline.checked(w text,s text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE eid uuid; BEGIN
 IF w IS NULL OR s IS NULL OR length(w) NOT BETWEEN 1 AND 128 OR length(s) NOT BETWEEN 1 AND 128 OR
 session_user<>'lyraseo_artifact_maintenance' OR NOT lyraseo_legacy_inline.enrolled(w,s) THEN RAISE EXCEPTION 'LEGACY_INLINE_SCOPE_DENIED'; END IF;
 SELECT id INTO STRICT eid FROM lyraseo_legacy_inline.environment WHERE (workspace_id,site_id)=(w,s) AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND postmaster_started_at=pg_postmaster_start_time() AND maintenance_login=session_user;
 RETURN eid;
END $$;
-- Enrollment locks the same rows as admission/checkpoint/finalization. No new inline
-- producer can commit after enrollment; an already-running writer settles first.
CREATE FUNCTION lyraseo_legacy_inline.enroll_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user<>'postgres' OR NOT lyraseo_kernel.is_test_database() OR NEW.database_oid IS DISTINCT FROM (SELECT oid FROM pg_database WHERE datname=current_database()) OR NEW.postmaster_started_at IS DISTINCT FROM pg_postmaster_start_time()
 THEN RAISE EXCEPTION 'LEGACY_INLINE_ENROLLMENT_DENIED'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=NEW.workspace_id FOR SHARE;
 PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(NEW.workspace_id,NEW.site_id) FOR UPDATE;
 RETURN NEW;
END $$;
CREATE TRIGGER inline_enrollment_fence BEFORE INSERT ON lyraseo_legacy_inline.environment FOR EACH ROW EXECUTE FUNCTION lyraseo_legacy_inline.enroll_fence();
CREATE FUNCTION lyraseo_legacy_inline.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_LEGACY_INLINE_RECEIPT'; END $$;
CREATE TRIGGER inline_environment_immutable BEFORE UPDATE OR DELETE ON lyraseo_legacy_inline.environment FOR EACH ROW EXECUTE FUNCTION lyraseo_legacy_inline.immutable();
CREATE TRIGGER inline_event_immutable BEFORE UPDATE OR DELETE ON lyraseo_legacy_inline.event FOR EACH ROW EXECUTE FUNCTION lyraseo_legacy_inline.immutable();

CREATE FUNCTION lyraseo_legacy_inline.fence_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w text;s text;format_ text; BEGIN
 IF TG_TABLE_NAME='AuditRun' THEN w:=NEW."workspaceId";s:=NEW."siteId";format_:=NEW."storageFormat";
 ELSE SELECT "workspaceId","siteId","storageFormat" INTO w,s,format_ FROM public."AuditRun" WHERE id=NEW."auditId" AND "workspaceId"=NEW."workspaceId"; END IF;
 IF format_ IS NULL THEN
  -- Always take the scope lock before testing enrollment: it may be committed while
  -- this producer waits. Workspace first prevents inversion with existing admissions.
  PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE;
  PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(w,s) FOR UPDATE;
  IF lyraseo_legacy_inline.protected_scope(w,s) THEN RAISE EXCEPTION 'LEGACY_INLINE_WRITER_FENCED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inline_run_fence BEFORE INSERT OR UPDATE ON public."AuditRun" FOR EACH ROW EXECUTE FUNCTION lyraseo_legacy_inline.fence_writer();
CREATE TRIGGER inline_page_fence BEFORE INSERT ON public."AuditPage" FOR EACH ROW EXECUTE FUNCTION lyraseo_legacy_inline.fence_writer();

-- Admission and every existing proof check take the original conflicting scope
-- locks before consulting the fence, before returning a target or prior evidence.
-- This also gates the fresh check immediately before each network dispatch.
ALTER FUNCTION lyraseo_audit.audit_transition_guard(text,text,text,text,integer,text,text,integer) RENAME TO audit_transition_guard_before_inline;
CREATE FUNCTION lyraseo_audit.audit_transition_guard(w text,s text,id_ text,u text,epoch integer,profile_ text,action_ text,expected integer)
RETURNS public."AuditRun" LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE checked_ public."AuditRun"; actor_version integer;
BEGIN
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR UPDATE;
 PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(w,s) FOR UPDATE;
 -- Bind current actor/scope before even resolving a caller-selected target.
 SELECT "securityVersion" INTO actor_version FROM public."ProductUser" WHERE id=u AND NOT suspended FOR SHARE;
 IF actor_version IS DISTINCT FROM epoch OR epoch IS NULL OR NOT lyraseo_audit.run_site_permission(w,s,u)
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 -- The existing guard also validates exact target ownership/profile and lease.
 -- It reads no page/evaluation payload; only a fully authorized result may reach
 -- the format/enrollment decision below.
 checked_:=lyraseo_audit.audit_transition_guard_before_inline(w,s,id_,u,epoch,profile_,action_,expected);
 IF EXISTS(SELECT FROM public."AuditRun" WHERE ("workspaceId","siteId",id)=(w,s,id_) AND "storageFormat" IS NULL) AND
 lyraseo_legacy_inline.protected_scope(w,s) THEN RAISE EXCEPTION 'LEGACY_INLINE_WRITER_FENCED'; END IF;
 RETURN checked_;
END $$;
ALTER FUNCTION lyraseo_audit.audit_transition_guard(text,text,text,text,integer,text,text,integer) OWNER TO lyraseo_kernel_owner;
REVOKE ALL ON FUNCTION lyraseo_audit.audit_transition_guard(text,text,text,text,integer,text,text,integer),lyraseo_audit.audit_transition_guard_before_inline(text,text,text,text,integer,text,text,integer) FROM PUBLIC;

-- Only the separate rawHtml copy is proven removable. Entire PageEvidence and the
-- receipt remainder are retained byte-for-byte as JSONB; their residual class is blocked.
CREATE FUNCTION lyraseo_legacy_inline.classify(p public."AuditPage",a public."AuditRun",c public."AuditPageRetention") RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF a."storageFormat" IS NOT NULL THEN RETURN 'already-compact'; END IF;
 IF a.status NOT IN ('COMPLETED','FAILED') OR a."leaseOwner" IS NOT NULL OR a."leaseUntil" IS NOT NULL THEN RETURN 'active-writer'; END IF;
 IF c."clockStatus" IS DISTINCT FROM 'known' OR c."capturedAt" IS NULL OR c."rawExpiresAt" IS NULL OR
 c."capturedAt" IS DISTINCT FROM lyraseo_audit.capture_clock(p.provenance->>'acquiredAt',p."createdAt") OR
 c."rawExpiresAt" IS DISTINCT FROM c."capturedAt"+interval '30 days' THEN RETURN 'clock-unknown'; END IF;
 IF NOT(p.provenance ? 'rawHtml') THEN RETURN 'already-compact'; END IF;
 IF a.profile NOT IN ('LOCAL_RAW_V1','CONTROLLED_RAW_TEST_V1') OR a."methodologyVersion"<>'readiness-v2' OR
 jsonb_typeof(p.provenance) IS DISTINCT FROM 'object' OR jsonb_typeof(p.provenance->'rawHtml') IS DISTINCT FROM 'string' OR
 (p.provenance-ARRAY['channel','robotsPolicy','requestedUrl','finalUrl','status','acquiredAt','headers','redirects','rawHtml','sha256','error'])<>'{}'::jsonb OR
 p.provenance->>'channel' IS DISTINCT FROM 'raw-http' OR p.provenance->>'requestedUrl' IS DISTINCT FROM p."requestedUrl" OR
 p.evidence->>'requestedUrl' IS DISTINCT FROM p."requestedUrl" OR NOT(a.manifest ? p."requestedUrl") OR
 octet_length(p.provenance::text)>67108864 OR octet_length(p.evidence::text)>524288 OR
 octet_length(p.provenance->>'rawHtml') NOT BETWEEN 1 AND 5242880 OR
 p.provenance->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(p.provenance->>'rawHtml','UTF8')),'hex')
 THEN RETURN 'unsafe-to-separate'; END IF;
 IF c."rawExpiresAt">clock_timestamp() AT TIME ZONE 'UTC' THEN RETURN 'not-due'; END IF;
 RETURN 'due-classified';
END $$;
CREATE FUNCTION lyraseo_legacy_inline.preview(w text,s text,limit_ integer,after_class_ text DEFAULT '',after_id_ text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE eid uuid;result_ jsonb; BEGIN
 eid:=lyraseo_legacy_inline.checked(w,s);
 IF limit_ IS NULL OR limit_ NOT BETWEEN 1 AND 100 OR after_class_ IS NULL OR after_id_ IS NULL OR length(after_id_)>128 OR
 after_class_ NOT IN ('','AUDIT_EVALUATION','AUDIT_PAGE_EVIDENCE_RESIDUAL','AUDIT_PAGE_RAW_HTML','CONTENT_DRAFT_SNAPSHOT') OR
 (after_class_='' AND after_id_<>'') THEN RAISE EXCEPTION 'INVALID_LEGACY_INLINE_LIMIT'; END IF;
 WITH raw_page_ids AS MATERIALIZED (
 SELECT p.id FROM public."AuditPage" p JOIN public."AuditRun" a ON (a."workspaceId",a.id)=(p."workspaceId",p."auditId")
 WHERE (a."workspaceId",a."siteId")=(w,s) AND (after_class_<'AUDIT_PAGE_RAW_HTML' OR (after_class_='AUDIT_PAGE_RAW_HTML' AND p.id>after_id_)) ORDER BY p.id LIMIT limit_),
 residual_page_ids AS MATERIALIZED (
 SELECT p.id FROM public."AuditPage" p JOIN public."AuditRun" a ON (a."workspaceId",a.id)=(p."workspaceId",p."auditId")
 WHERE (a."workspaceId",a."siteId")=(w,s) AND a."storageFormat" IS NULL AND (after_class_<'AUDIT_PAGE_EVIDENCE_RESIDUAL' OR (after_class_='AUDIT_PAGE_EVIDENCE_RESIDUAL' AND p.id>after_id_)) ORDER BY p.id LIMIT limit_),
 run_ids AS MATERIALIZED (SELECT id FROM public."AuditRun" WHERE ("workspaceId","siteId")=(w,s) AND "storageFormat" IS NULL AND evaluation IS NOT NULL AND
 (after_class_<'AUDIT_EVALUATION' OR (after_class_='AUDIT_EVALUATION' AND id>after_id_)) ORDER BY id LIMIT limit_),
 draft_ids AS MATERIALIZED (SELECT id FROM public."ContentDraft" WHERE ("workspaceId","siteId")=(w,s) AND "evidenceFormat" IS NULL AND
 (after_class_<'CONTENT_DRAFT_SNAPSHOT' OR (after_class_='CONTENT_DRAFT_SNAPSHOT' AND id>after_id_)) ORDER BY id LIMIT limit_)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'class',class_,'status',status_) ORDER BY class_,id),'[]'::jsonb) INTO result_ FROM (
 SELECT p.id,'AUDIT_PAGE_RAW_HTML'::text AS class_,CASE WHEN EXISTS(SELECT FROM lyraseo_legacy_inline.event e WHERE e.page_id=p.id) THEN 'transitioned' ELSE lyraseo_legacy_inline.classify(p,a,c) END AS status_ FROM public."AuditPage" p
 JOIN public."AuditRun" a ON (a."workspaceId",a.id)=(p."workspaceId",p."auditId")
 LEFT JOIN public."AuditPageRetention" c ON (c."workspaceId",c."auditId",c."pageId")=(p."workspaceId",p."auditId",p.id)
 WHERE (a."workspaceId",a."siteId")=(w,s) AND p.id IN (SELECT id FROM raw_page_ids)
 UNION ALL SELECT p.id,'AUDIT_PAGE_EVIDENCE_RESIDUAL','unsafe-to-separate' FROM public."AuditPage" p JOIN public."AuditRun" a ON (a."workspaceId",a.id)=(p."workspaceId",p."auditId") WHERE (a."workspaceId",a."siteId")=(w,s) AND p.id IN (SELECT id FROM residual_page_ids)
 UNION ALL SELECT id,'AUDIT_EVALUATION','unsafe-to-separate' FROM public."AuditRun" WHERE id IN (SELECT id FROM run_ids)
 UNION ALL SELECT id,'CONTENT_DRAFT_SNAPSHOT','unsafe-to-separate' FROM public."ContentDraft" WHERE id IN (SELECT id FROM draft_ids)
 ORDER BY class_,id LIMIT limit_) bounded;
 RETURN jsonb_build_object('scope','LOCAL_TEST_ONLY_ACTIVE_STORE','items',result_,'bounded',true,'limit',limit_,
 'next',CASE WHEN jsonb_array_length(result_)=limit_ THEN jsonb_build_object('class',result_->(limit_-1)->>'class','id',result_->(limit_-1)->>'id') ELSE NULL END);
END $$;
CREATE FUNCTION lyraseo_legacy_inline.make_plan(w text,s text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE eid uuid;pid uuid; BEGIN
 eid:=lyraseo_legacy_inline.checked(w,s);
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE;
 PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(w,s) FOR UPDATE;
 INSERT INTO lyraseo_legacy_inline.plan(environment_id,workspace_id,site_id) VALUES(eid,w,s) RETURNING id INTO pid; RETURN pid;
END $$;
CREATE FUNCTION lyraseo_legacy_inline.status(w text,s text,pid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE eid uuid;p lyraseo_legacy_inline.plan; BEGIN
 eid:=lyraseo_legacy_inline.checked(w,s);
 SELECT * INTO p FROM lyraseo_legacy_inline.plan WHERE id=pid AND environment_id=eid AND (workspace_id,site_id)=(w,s);
 IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_INLINE_PLAN_DENIED'; END IF;
 RETURN jsonb_build_object('id',p.id,'paused',p.paused,'nextRetryAt',p.next_retry_at,'transitioned',(SELECT count(*) FROM lyraseo_legacy_inline.event WHERE plan_id=p.id),
 'residualCounts',jsonb_build_object(
 'AUDIT_PAGE_EVIDENCE_RESIDUAL',(SELECT count(*) FROM public."AuditPage" x JOIN public."AuditRun" a ON (a."workspaceId",a.id)=(x."workspaceId",x."auditId") WHERE (a."workspaceId",a."siteId")=(w,s) AND a."storageFormat" IS NULL),
 'AUDIT_EVALUATION',(SELECT count(*) FROM public."AuditRun" WHERE ("workspaceId","siteId")=(w,s) AND "storageFormat" IS NULL AND evaluation IS NOT NULL),
 'CONTENT_DRAFT_SNAPSHOT',(SELECT count(*) FROM public."ContentDraft" WHERE ("workspaceId","siteId")=(w,s) AND "evidenceFormat" IS NULL)));

END $$;
CREATE FUNCTION lyraseo_legacy_inline.pause(w text,s text,pid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE eid uuid; BEGIN
 eid:=lyraseo_legacy_inline.checked(w,s);
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE;
 PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(w,s) FOR UPDATE;
 UPDATE lyraseo_legacy_inline.plan SET paused=true WHERE id=pid AND environment_id=eid AND (workspace_id,site_id)=(w,s);
 IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_INLINE_PLAN_DENIED'; END IF;
END $$;
CREATE FUNCTION lyraseo_legacy_inline.next(w text,s text,pid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE eid uuid;plan_ lyraseo_legacy_inline.plan;p public."AuditPage";a public."AuditRun";c public."AuditPageRetention";post_ jsonb;before_ jsonb;after_ jsonb;facts_ jsonb;rid uuid;scan_end text; BEGIN
 eid:=lyraseo_legacy_inline.checked(w,s);
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE;
 PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(w,s) FOR UPDATE;
 SELECT * INTO plan_ FROM lyraseo_legacy_inline.plan WHERE id=pid AND environment_id=eid AND (workspace_id,site_id)=(w,s) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_INLINE_PLAN_DENIED'; END IF;
 IF plan_.paused THEN RETURN jsonb_build_object('status','paused'); END IF;
 IF plan_.next_retry_at>clock_timestamp() THEN RETURN jsonb_build_object('status','backoff','nextRetryAt',plan_.next_retry_at); END IF;
 -- Same Site lock serializes every plan and old producer. No durable claim or external I/O.
 WITH candidates AS MATERIALIZED (
  SELECT p0.id FROM public."AuditPage" p0 JOIN public."AuditRun" a0 ON (a0."workspaceId",a0.id)=(p0."workspaceId",p0."auditId")
  WHERE (a0."workspaceId",a0."siteId")=(w,s) AND p0.id>plan_.cursor_id ORDER BY p0.id LIMIT 50
 ) SELECT max(id) INTO scan_end FROM candidates;
 IF scan_end IS NULL THEN
  UPDATE lyraseo_legacy_inline.plan SET cursor_id='',next_retry_at=clock_timestamp()+interval '30 seconds' WHERE id=pid;
  RETURN jsonb_build_object('status','pending','reason','SCAN_WRAPPED_RESIDUALS_REMAIN');
 END IF;
 SELECT p0.* INTO p FROM public."AuditPage" p0 JOIN public."AuditRun" a0 ON (a0."workspaceId",a0.id)=(p0."workspaceId",p0."auditId")
 JOIN public."AuditPageRetention" c0 ON (c0."workspaceId",c0."auditId",c0."pageId")=(p0."workspaceId",p0."auditId",p0.id)
 WHERE (a0."workspaceId",a0."siteId")=(w,s) AND p0.id>plan_.cursor_id AND p0.id<=scan_end AND lyraseo_legacy_inline.classify(p0,a0,c0)='due-classified'
 ORDER BY p0.id LIMIT 1 FOR UPDATE OF p0 SKIP LOCKED;
 IF NOT FOUND THEN
  UPDATE lyraseo_legacy_inline.plan SET cursor_id=scan_end,next_retry_at=clock_timestamp()+interval '30 seconds' WHERE id=pid;
  RETURN jsonb_build_object('status','pending','reason','NO_CLASSIFIED_UNLOCKED_ITEM','bounded',50);
 END IF;
 UPDATE lyraseo_legacy_inline.plan SET cursor_id=p.id WHERE id=pid;
 SELECT * INTO STRICT a FROM public."AuditRun" WHERE id=p."auditId" AND "workspaceId"=w;
 SELECT * INTO STRICT c FROM public."AuditPageRetention" WHERE "pageId"=p.id AND "workspaceId"=w AND "auditId"=a.id;
 IF lyraseo_legacy_inline.classify(p,a,c)<>'due-classified' THEN RAISE EXCEPTION 'LEGACY_INLINE_RECHECK_FAILED'; END IF;
 post_:=p.provenance-'rawHtml';
 before_:=jsonb_build_object('evidence',p.evidence,'provenance',p.provenance);
 after_:=jsonb_build_object('evidence',p.evidence,'provenance',post_);
 facts_:=jsonb_build_object('page',to_jsonb(p)-'provenance','receipt',post_,'audit',to_jsonb(a),'clock',to_jsonb(c));
 INSERT INTO lyraseo_legacy_inline.event(plan_id,workspace_id,site_id,page_id,audit_id,class,field,policy,representation,old_hash,new_hash,old_bytes,new_bytes,fact_hash,deadline,deadline_source)
 VALUES(pid,w,s,p.id,a.id,'AUDIT_PAGE_RAW_HTML','provenance.rawHtml','P2B2_INLINE_HTML_V1','legacy-inline-html-removed-v1',lyraseo_legacy_inline.hash(before_),lyraseo_legacy_inline.hash(after_),octet_length(before_::text),octet_length(after_::text),lyraseo_legacy_inline.hash(facts_),c."rawExpiresAt",'AuditPageRetention.rawExpiresAt') RETURNING id INTO rid;
 INSERT INTO lyraseo_legacy_inline.permit VALUES(p.id,pg_current_xact_id(),lyraseo_legacy_inline.hash(before_),lyraseo_legacy_inline.hash(after_));
 UPDATE public."AuditPage" SET provenance=post_ WHERE id=p.id;
 SELECT jsonb_build_object('evidence',evidence,'provenance',provenance) INTO after_ FROM public."AuditPage" WHERE id=p.id;
 IF lyraseo_legacy_inline.hash(after_) IS DISTINCT FROM (SELECT new_hash FROM lyraseo_legacy_inline.event WHERE id=rid) OR
 facts_ IS DISTINCT FROM (SELECT jsonb_build_object('page',to_jsonb(x)-'provenance','receipt',x.provenance,'audit',to_jsonb(a),'clock',to_jsonb(c)) FROM public."AuditPage" x WHERE x.id=p.id)
 THEN RAISE EXCEPTION 'LEGACY_INLINE_FACT_MISMATCH'; END IF;
 RETURN jsonb_build_object('status','transitioned','class','AUDIT_PAGE_RAW_HTML','id',p.id,'receipt',rid,'residual','AUDIT_PAGE_EVIDENCE_RESIDUAL');
END $$;

-- Deferred receipt check observes generated columns and any later statement in this transaction.
CREATE FUNCTION lyraseo_legacy_inline.verify_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."AuditPage";a public."AuditRun";c public."AuditPageRetention"; BEGIN
 SELECT * INTO STRICT p FROM public."AuditPage" WHERE id=NEW.page_id AND "workspaceId"=NEW.workspace_id;
 SELECT * INTO STRICT a FROM public."AuditRun" WHERE id=NEW.audit_id AND "workspaceId"=NEW.workspace_id AND "siteId"=NEW.site_id;
 SELECT * INTO STRICT c FROM public."AuditPageRetention" WHERE "pageId"=p.id AND "workspaceId"=p."workspaceId" AND "auditId"=a.id;
 IF p.provenance ? 'rawHtml' OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR
 NEW.new_hash IS DISTINCT FROM lyraseo_legacy_inline.hash(jsonb_build_object('evidence',p.evidence,'provenance',p.provenance)) OR
 NEW.fact_hash IS DISTINCT FROM lyraseo_legacy_inline.hash(jsonb_build_object('page',to_jsonb(p)-'provenance','receipt',p.provenance,'audit',to_jsonb(a),'clock',to_jsonb(c))) OR
 EXISTS(SELECT FROM lyraseo_legacy_inline.permit WHERE page_id=p.id)
 THEN RAISE EXCEPTION 'LEGACY_INLINE_DEFERRED_RECEIPT_MISMATCH'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inline_receipt_final AFTER INSERT ON lyraseo_legacy_inline.event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lyraseo_legacy_inline.verify_receipt();

-- Original immutability implementation is retained behind an exact one-use exception.
ALTER FUNCTION public.audit_immutable() RENAME TO audit_immutable_before_inline;
CREATE FUNCTION public.audit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='AuditPage' AND TG_OP='UPDATE' THEN
 IF current_user='lyraseo_legacy_inline_owner' AND
 session_user='lyraseo_artifact_maintenance' AND to_jsonb(NEW)-'provenance' IS NOT DISTINCT FROM to_jsonb(OLD)-'provenance' AND
 NEW.provenance IS NOT DISTINCT FROM OLD.provenance-'rawHtml' THEN
  DELETE FROM lyraseo_legacy_inline.permit WHERE page_id=OLD.id AND transaction_id=pg_current_xact_id() AND
  old_hash=lyraseo_legacy_inline.hash(jsonb_build_object('evidence',OLD.evidence,'provenance',OLD.provenance)) AND
  new_hash=lyraseo_legacy_inline.hash(jsonb_build_object('evidence',NEW.evidence,'provenance',NEW.provenance));
  IF FOUND THEN RETURN NEW; END IF;
 END IF;
 END IF;
 IF TG_TABLE_NAME<>'AuditRun' THEN RAISE EXCEPTION 'IMMUTABLE_AUDIT'; END IF;
 IF OLD.status IN ('COMPLETED','FAILED') OR
 ROW(NEW."workspaceId",NEW."siteId",NEW."userId",NEW."securityVersion",NEW."idempotencyKey",NEW."inputHash",NEW.manifest,NEW.profile,NEW.declarations,NEW."methodologyVersion",NEW."createdAt") IS DISTINCT FROM
 ROW(OLD."workspaceId",OLD."siteId",OLD."userId",OLD."securityVersion",OLD."idempotencyKey",OLD."inputHash",OLD.manifest,OLD.profile,OLD.declarations,OLD."methodologyVersion",OLD."createdAt")
 THEN RAISE EXCEPTION 'IMMUTABLE_AUDIT'; END IF; RETURN NEW;
END $$;
-- Triggers retain function OIDs after rename: explicitly replace them, never disable them.
DROP TRIGGER audit_run_immutable ON public."AuditRun";
DROP TRIGGER audit_page_immutable ON public."AuditPage";
DROP TRIGGER issue_action_immutable ON public."IssueAction";
CREATE TRIGGER audit_run_immutable BEFORE UPDATE ON public."AuditRun" FOR EACH ROW EXECUTE FUNCTION public.audit_immutable();
CREATE TRIGGER audit_page_immutable BEFORE UPDATE OR DELETE ON public."AuditPage" FOR EACH ROW EXECUTE FUNCTION public.audit_immutable();
CREATE TRIGGER issue_action_immutable BEFORE UPDATE OR DELETE ON public."IssueAction" FOR EACH ROW EXECUTE FUNCTION public.audit_immutable();

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lyraseo_legacy_inline' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_legacy_inline_owner',f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION lyraseo_legacy_inline.lock_issue_actor(text,text,integer) TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_legacy_inline.classify(public."AuditPage",public."AuditRun",public."AuditPageRetention"),lyraseo_legacy_inline.enrolled(text,text),lyraseo_legacy_inline.protected_scope(text,text) TO lyraseo_runtime,lyraseo_kernel_owner;
GRANT EXECUTE ON FUNCTION lyraseo_legacy_inline.preview(text,text,integer,text,text),lyraseo_legacy_inline.make_plan(text,text),lyraseo_legacy_inline.status(text,text,uuid),lyraseo_legacy_inline.pause(text,text,uuid),lyraseo_legacy_inline.next(text,text,uuid) TO lyraseo_artifact_maintenance;
REVOKE ALL ON FUNCTION public.audit_immutable(),public.audit_immutable_before_inline() FROM PUBLIC;
COMMIT;
