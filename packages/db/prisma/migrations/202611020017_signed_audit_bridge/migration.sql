BEGIN;
-- The service login has no product-table grants. Only the isolated NOLOGIN
-- owner of these fixed SQL operations can access the underlying rows.
CREATE SCHEMA lyraseo_audit;
REVOKE ALL ON SCHEMA lyraseo_audit FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_audit TO lyraseo_kernel_owner,lyraseo_runtime,lyraseo_dispatch;
CREATE TABLE lyraseo_audit.attempt (
  principal text NOT NULL, request_id uuid NOT NULL, request_fence integer NOT NULL,
  work_id uuid NOT NULL REFERENCES public."WorkDispatch"(id), generation integer NOT NULL,
  audit_id text NOT NULL REFERENCES public."AuditRun"(id), audit_fence integer NOT NULL,
  url text NOT NULL, proof_hash bytea NOT NULL CHECK(octet_length(proof_hash)=32), deadline timestamptz NOT NULL,
  PRIMARY KEY(principal, request_id), FOREIGN KEY(principal,request_id)
  REFERENCES public."InternalRequest"("servicePrincipalId","requestId") ON DELETE CASCADE
);
ALTER TABLE lyraseo_audit.attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_audit.attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY kernel ON lyraseo_audit.attempt TO lyraseo_kernel_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,DELETE ON lyraseo_audit.attempt TO lyraseo_kernel_owner;
GRANT SELECT(manifest,fence,"leaseOwner","methodologyVersion",declarations) ON public."AuditRun" TO lyraseo_kernel_owner;
GRANT SELECT(id,"auditId","requestedUrl",evidence,provenance) ON public."AuditPage" TO lyraseo_kernel_owner;
GRANT SELECT(origin) ON public."Site" TO lyraseo_kernel_owner;
GRANT UPDATE(status,fence,"leaseOwner","leaseUntil","completedAt",evaluation) ON public."AuditRun" TO lyraseo_kernel_owner;
GRANT INSERT(id,"workspaceId","auditId","requestedUrl",evidence,provenance) ON public."AuditPage" TO lyraseo_kernel_owner;
CREATE POLICY kernel_update ON public."AuditRun" FOR UPDATE TO lyraseo_kernel_owner USING(true) WITH CHECK(true);
CREATE POLICY kernel_page_read ON public."AuditPage" FOR SELECT TO lyraseo_kernel_owner USING(true);
CREATE POLICY kernel_page_insert ON public."AuditPage" FOR INSERT TO lyraseo_kernel_owner WITH CHECK(true);
-- PostgreSQL requires an UPDATE column privilege for SELECT ... FOR SHARE/UPDATE.
-- No fixed function updates these columns. Separate role-specific row policies
-- are needed for locking under FORCE RLS.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['Workspace','Site','ProductUser'] LOOP
   EXECUTE format('GRANT UPDATE(id) ON public.%I TO lyraseo_kernel_owner',t);
   EXECUTE format('CREATE POLICY kernel_lock ON public.%I FOR UPDATE TO lyraseo_kernel_owner USING(true) WITH CHECK(false)',t);
 END LOOP;
END $$;

CREATE FUNCTION lyraseo_audit.run_site_permission(w text,s text,u text) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT FROM public."Workspace" ws JOIN public."Site" st ON st."workspaceId"=ws.id
 JOIN public."Membership" m ON m."workspaceId"=ws.id AND m."userId"=u
 WHERE ws.id=w AND st.id=s AND ws."deletedAt" IS NULL AND st."deletedAt" IS NULL AND
 (m.role IN ('OWNER','ADMIN') OR (m.role='EDITOR' AND EXISTS(SELECT FROM public."SiteGrant" g
 WHERE (g."workspaceId",g."siteId",g."userId")=(w,s,u)))))
$$;
CREATE FUNCTION lyraseo_audit.web_can_run(s text) RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT session_user='lyraseo_runtime' AND lyraseo_audit.run_site_permission(current_setting('app.workspace_id',true),s,current_setting('app.actor_id',true))
$$;

-- Only the control metadata, manifest and frozen evaluation inputs are needed.
CREATE FUNCTION lyraseo_audit.read_target(id_ text) RETURNS public."AuditRun" LANGUAGE plpgsql STABLE
SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public."AuditRun";
BEGIN
 SELECT id,"workspaceId","siteId","userId","securityVersion",profile,status,"leaseUntil",manifest,fence,"leaseOwner","methodologyVersion",declarations
 INTO a.id,a."workspaceId",a."siteId",a."userId",a."securityVersion",a.profile,a.status,a."leaseUntil",a.manifest,a.fence,a."leaseOwner",a."methodologyVersion",a.declarations
 FROM public."AuditRun" WHERE id=id_;
 RETURN a;
END $$;

-- Internal guard. No login may invoke it with its own actor/profile descriptor.
CREATE FUNCTION lyraseo_audit.audit_transition_guard(w text,s text,id_ text,u text,epoch integer,
 profile_ text,action_ text,expected integer) RETURNS public."AuditRun" LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public."AuditRun"; verified timestamp; actor_version integer;
BEGIN
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR UPDATE;
 SELECT "verifiedAt" INTO verified FROM public."Site" WHERE ("workspaceId",id)=(w,s) FOR UPDATE;
 SELECT "securityVersion" INTO actor_version FROM public."ProductUser" WHERE id=u AND NOT suspended FOR SHARE;
 PERFORM 1 FROM public."AuditRun" WHERE ("workspaceId","siteId",id)=(w,s,id_) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 a:=lyraseo_audit.read_target(id_);
 IF a.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF actor_version IS DISTINCT FROM epoch OR epoch IS NULL OR NOT lyraseo_audit.run_site_permission(w,s,u)
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF action_='cancel' THEN
   IF a.status NOT IN ('QUEUED','RUNNING') THEN RAISE EXCEPTION 'AUDIT_TERMINAL'; END IF;
   RETURN a;
 END IF;
 IF (a."userId",a."securityVersion",a.profile) IS DISTINCT FROM (u,epoch,profile_) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF verified IS NULL OR verified AT TIME ZONE 'UTC' NOT BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()
 THEN RAISE EXCEPTION 'SITE_NOT_VERIFIED'; END IF;
 IF action_='claim' THEN
   IF a.status NOT IN ('QUEUED','RUNNING') THEN RAISE EXCEPTION 'AUDIT_TERMINAL'; END IF;
   IF a."leaseUntil" AT TIME ZONE 'UTC'>clock_timestamp() THEN RAISE EXCEPTION 'LEASE_BUSY'; END IF;
 ELSIF a.status<>'RUNNING' OR a.fence IS DISTINCT FROM expected OR a."leaseUntil" IS NULL OR a."leaseUntil" AT TIME ZONE 'UTC'<=clock_timestamp()
 THEN RAISE EXCEPTION 'STALE_LEASE'; END IF;
 RETURN a;
END $$;

-- JSONB prints its numeric values in decimal. Bound numeric contributions
-- one scalar at a time before rendering the whole document: an 8 KiB array
-- of compact exponents must not allocate a giant text value just to reject it.
CREATE FUNCTION lyraseo_audit.bounded_projection(document jsonb,max_bytes integer) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE scalar_ jsonb; numeric_bytes integer:=0;
BEGIN
 FOR scalar_ IN SELECT * FROM jsonb_path_query(document,'strict $.** ? (@.type() == "number")') LOOP
   numeric_bytes:=numeric_bytes+octet_length(scalar_::text);
   IF numeric_bytes>max_bytes THEN RAISE EXCEPTION 'EVIDENCE_TOO_LARGE'; END IF;
 END LOOP;
 IF octet_length(document::text)>max_bytes THEN RAISE EXCEPTION 'EVIDENCE_TOO_LARGE'; END IF;
 RETURN document;
END $$;

CREATE FUNCTION lyraseo_audit.write_transition(a public."AuditRun", action_ text, owner_ text, data_ json) RETURNS text LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE ev jsonb; prov jsonb; url text; old public."AuditPage"; page_id text;
BEGIN
 IF action_='claim' THEN
   IF owner_ IS NULL OR length(owner_) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'INVALID_LEASE_OWNER'; END IF;
   UPDATE public."AuditRun" SET status='RUNNING',fence=fence+1,"leaseOwner"=owner_,"leaseUntil"=(clock_timestamp()+interval '90 seconds') AT TIME ZONE 'UTC' WHERE id=a.id;
 ELSIF action_='checkpoint' THEN
   -- Charge the exact UTF-8 submitted by the adapter, including whitespace
   -- inside strings. Separately allow up to 2x these caps for JSONB's public
   -- text representation (separator formatting and numeric normalization).
   IF octet_length((data_->'evidence')::text)>262144 OR octet_length((data_->'provenance')::text)>33554432
   THEN RAISE EXCEPTION 'EVIDENCE_TOO_LARGE'; END IF;
   ev:=lyraseo_audit.bounded_projection((data_->'evidence')::jsonb,524288);
   prov:=lyraseo_audit.bounded_projection((data_->'provenance')::jsonb,67108864);
   url:=ev->>'requestedUrl';
   IF jsonb_typeof(ev) IS DISTINCT FROM 'object' OR jsonb_typeof(prov) IS DISTINCT FROM 'object' OR
      url IS NULL OR NOT(a.manifest ? url) OR prov->>'requestedUrl' IS DISTINCT FROM url OR prov->>'channel' IS DISTINCT FROM 'raw-http'
   THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
   IF a.profile='CONTROLLED_RAW_TEST_V1' AND (
      jsonb_typeof(ev->'acquired') IS DISTINCT FROM 'boolean' OR ev->'headComplete' IS DISTINCT FROM 'false'::jsonb OR ev->'bodyComplete' IS DISTINCT FROM 'false'::jsonb
      OR ev->'headingLevels' IS DISTINCT FROM '[]'::jsonb OR ev->'h1Texts' IS DISTINCT FROM '[]'::jsonb OR (ev ? 'jsonLdComplete' AND ev->'jsonLdComplete'<>'false'::jsonb)
      OR ev ?| ARRAY['visibleText','mainText','populatedSections','articleDates','headingTexts','pageType','indexingIntent','intendedCanonical','intentionallyExcluded','mainMediaNames','logoNames']
      OR (ev->'metadata') ? 'rendered' OR jsonb_typeof(prov->'robotsPolicy') IS DISTINCT FROM 'object'
      OR (ev->'acquired'='true'::jsonb AND (jsonb_typeof(prov->'rawHtml') IS DISTINCT FROM 'string' OR length(prov->>'rawHtml')=0
         OR prov->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(prov->>'rawHtml','UTF8')),'hex'))))
   THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
   IF octet_length(prov->>'rawHtml')>5242880 THEN RAISE EXCEPTION 'EVIDENCE_TOO_LARGE'; END IF;
   SELECT id,evidence,provenance INTO old.id,old.evidence,old.provenance FROM public."AuditPage" WHERE ("auditId","requestedUrl")=(a.id,url);
   IF FOUND THEN
     IF old.evidence<>ev OR old.provenance<>prov THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
     RETURN old.id;
   END IF;
   page_id:=gen_random_uuid()::text;
   INSERT INTO public."AuditPage"(id,"workspaceId","auditId","requestedUrl",evidence,provenance)
     VALUES(page_id,a."workspaceId",a.id,url,ev,prov);
   -- The bridge owns a fixed non-renewable proof; only local browser claims renew.
   IF a.profile='LOCAL_RAW_V1' THEN UPDATE public."AuditRun" SET "leaseUntil"=(clock_timestamp()+interval '90 seconds') AT TIME ZONE 'UTC' WHERE id=a.id; END IF;
   RETURN page_id;
 ELSIF action_='finish' THEN
   IF json_typeof(data_) IS DISTINCT FROM 'object' OR EXISTS(SELECT FROM jsonb_array_elements_text(a.manifest) m(url)
     WHERE NOT EXISTS(SELECT FROM public."AuditPage" p WHERE (p."auditId",p."requestedUrl")=(a.id,m.url)))
   THEN RAISE EXCEPTION 'AUDIT_INCOMPLETE'; END IF;
   UPDATE public."AuditRun" SET status='COMPLETED',evaluation=data_::jsonb,"completedAt"=clock_timestamp() AT TIME ZONE 'UTC',"leaseUntil"=NULL,"leaseOwner"=NULL WHERE id=a.id;
 ELSIF action_='yield' THEN
   UPDATE public."AuditRun" SET status='QUEUED',fence=fence+1,"leaseUntil"=NULL,"leaseOwner"=NULL WHERE id=a.id;
 ELSIF action_ IN ('fail','cancel') THEN
   UPDATE public."AuditRun" SET status='FAILED',fence=fence+CASE WHEN action_='cancel' THEN 1 ELSE 0 END,
     "completedAt"=clock_timestamp() AT TIME ZONE 'UTC',"leaseUntil"=NULL,"leaseOwner"=NULL WHERE id=a.id;
 ELSE RAISE EXCEPTION 'INVALID_ACTION'; END IF;
 RETURN a.id;
END $$;

CREATE FUNCTION lyraseo_audit.web_transition(s text,id_ text,epoch integer,action_ text,expected integer,owner_ text,data_ json)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public."AuditRun";
BEGIN
 IF session_user<>'lyraseo_runtime' OR action_ NOT IN ('claim','checkpoint','finish','cancel','fail','yield','prepare')
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 a:=lyraseo_audit.audit_transition_guard(current_setting('app.workspace_id',true),s,id_,current_setting('app.actor_id',true),epoch,'LOCAL_RAW_V1',action_,expected);
 IF action_='prepare' THEN RETURN a.id; END IF;
 RETURN lyraseo_audit.write_transition(a,action_,owner_,data_);
END $$;

-- A discovery remains target-lock-free. Once B starts a step it pushes the
-- delivered recovery time past the audit lease; an expired service-owned
-- RUNNING lease is valid work, never a reason to suppress it.
CREATE FUNCTION lyraseo_audit.live_binding(d public."WorkDispatch") RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT d."targetKind"='AUDIT_RAW' AND d.eligibility='CONTROLLED_TEST' AND d.profile='CONTROLLED_RAW_TEST_V1'
 AND d.capability='audits' AND d."revokedAt" IS NULL AND d."expiresAt">clock_timestamp()
 AND lyraseo_audit.run_site_permission(d."workspaceId",d."siteId",d."userId")
 AND EXISTS(SELECT FROM public."AuditRun" a
 JOIN public."ProductUser" u ON (u.id,u."securityVersion")=(a."userId",a."securityVersion") AND NOT u.suspended
 JOIN public."Site" s ON (s."workspaceId",s.id)=(a."workspaceId",a."siteId")
 WHERE (a.id,a."workspaceId",a."siteId",a."userId",a."securityVersion",a.profile)
 =(d."auditId",d."workspaceId",d."siteId",d."userId",d."admittedSecurityVersion",d.profile)
 AND a.status IN ('QUEUED','RUNNING') AND s."verifiedAt" AT TIME ZONE 'UTC' BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()+interval '30 seconds')
$$;
CREATE OR REPLACE FUNCTION lyraseo_kernel.valid_target(d public."WorkDispatch") RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT lyraseo_audit.live_binding(d) AND EXISTS(SELECT FROM public."AuditRun" a WHERE a.id=d."auditId"
 AND ((a.status='QUEUED' AND a."leaseUntil" IS NULL) OR
 (a.status='RUNNING' AND a."leaseOwner"='lyraseo_dispatch' AND a."leaseUntil" AT TIME ZONE 'UTC'<=clock_timestamp())))
$$;

CREATE FUNCTION lyraseo_audit.next_page(a public."AuditRun") RETURNS text LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT m.url FROM jsonb_array_elements_text(a.manifest) WITH ORDINALITY m(url,idx)
 WHERE NOT EXISTS(SELECT FROM public."AuditPage" p WHERE (p."auditId",p."requestedUrl")=(a.id,m.url)) ORDER BY m.idx LIMIT 1
$$;
CREATE FUNCTION lyraseo_audit.admit_step(rid uuid, audience text, path text, raw_ text, issued timestamptz, expires timestamptz, handler_deadline timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public."InternalRequest"; d public."WorkDispatch"; a public."AuditRun"; body jsonb; digest bytea;
 token uuid:=gen_random_uuid(); proof text:=gen_random_uuid()::text||gen_random_uuid()::text;
 url text; gen integer; work uuid; org text;
BEGIN
 IF session_user<>'lyraseo_dispatch' OR audience IS DISTINCT FROM 'lyraseo-kernel-a'
 OR path IS DISTINCT FROM '/api/internal/runtime/step' OR raw_ IS NULL OR octet_length(raw_)>1024 OR rid IS NULL
 OR handler_deadline IS NULL OR NOT isfinite(handler_deadline) OR handler_deadline<=clock_timestamp()
 OR issued IS NULL OR expires IS NULL OR NOT isfinite(issued) OR NOT isfinite(expires) OR expires<=issued
 OR expires-issued>interval '60 seconds' OR issued>clock_timestamp()+interval '30 seconds' OR expires<=clock_timestamp()
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 body:=raw_::jsonb;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR body-ARRAY['version','workId','generation']<>'{}'
 OR body->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(body->'workId') IS DISTINCT FROM 'string'
 OR jsonb_typeof(body->'generation') IS DISTINCT FROM 'number' OR body->>'generation' !~ '^[1-9][0-9]{0,9}$'
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 gen:=(body->>'generation')::integer;work:=(body->>'workId')::uuid;
 digest:=sha256(convert_to(jsonb_build_array('v1',audience,'POST',path,encode(sha256(convert_to(raw_,'UTF8')),'hex'),
 extract(epoch from issued),extract(epoch from expires))::text,'UTF8'));
 INSERT INTO public."InternalRequest"("servicePrincipalId","requestId",fingerprint,"issuedAt","expiresAt",state,"ownerToken",fence,"leaseUntil")
 VALUES(session_user,rid,digest,issued,expires,'ACTIVE',token,1,clock_timestamp()+interval '90 seconds') ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT r FROM public."InternalRequest" WHERE ("servicePrincipalId","requestId")=(session_user,rid) FOR UPDATE;
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF handler_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'HANDLER_DEADLINE'; END IF;
 IF r.fingerprint<>digest THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
 IF r.state='COMPLETE' THEN RETURN r.result; END IF;
 IF r."ownerToken"<>token AND r."leaseUntil">clock_timestamp() THEN RETURN '{"disposition":"IN_PROGRESS"}'; END IF;
 IF expires<=clock_timestamp()+interval '46 seconds' THEN RAISE EXCEPTION 'RETRY_FRESH'; END IF;
 IF NOT lyraseo_kernel.approved() THEN RAISE EXCEPTION 'PAUSED'; END IF;
 SELECT * INTO d FROM public."WorkDispatch" WHERE id=work AND generation=gen AND eligibility='CONTROLLED_TEST';
 IF d.id IS NULL OR NOT lyraseo_audit.live_binding(d) OR d.disposition='SUPPRESSED' THEN RAISE EXCEPTION 'STALE_TARGET'; END IF;
 IF d.disposition<>'DELIVERED' THEN RAISE EXCEPTION 'RETRY_DELIVERY'; END IF;
 a:=lyraseo_audit.audit_transition_guard(d."workspaceId",d."siteId",d."auditId",d."userId",d."admittedSecurityVersion",d.profile,'claim',NULL);
 SELECT * INTO d FROM public."WorkDispatch" WHERE id=work FOR UPDATE;
 IF NOT lyraseo_audit.live_binding(d) OR d.disposition<>'DELIVERED' OR d.generation<>gen THEN RAISE EXCEPTION 'STALE_TARGET'; END IF;
 IF a."methodologyVersion"<>'readiness-v2' OR jsonb_typeof(a.manifest)<>'array' OR jsonb_array_length(a.manifest) NOT BETWEEN 1 AND 25
 OR (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(a.manifest) m(v))<>jsonb_array_length(a.manifest)
 THEN RAISE EXCEPTION 'STALE_TARGET'; END IF;
 SELECT origin INTO STRICT org FROM public."Site" WHERE id=a."siteId";
 url:=lyraseo_audit.next_page(a);
 IF url IS NULL OR NOT a.manifest ? (org||'/') OR EXISTS(SELECT FROM jsonb_array_elements_text(a.manifest) m(v) WHERE NOT starts_with(v,org||'/'))
 THEN RAISE EXCEPTION 'STALE_TARGET'; END IF;
 IF expires<=clock_timestamp()+interval '46 seconds' THEN RAISE EXCEPTION 'RETRY_FRESH'; END IF;
 IF handler_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'HANDLER_DEADLINE'; END IF;
 PERFORM lyraseo_audit.write_transition(a,'claim',session_user,NULL);
 UPDATE public."WorkDispatch" SET "nextAttemptAt"=clock_timestamp()+interval '91 seconds' WHERE id=work;
 IF r."ownerToken"<>token THEN
   UPDATE public."InternalRequest" SET fence=fence+1,"ownerToken"=token,"leaseUntil"=clock_timestamp()+interval '90 seconds'
   WHERE ("servicePrincipalId","requestId")=(session_user,rid) RETURNING * INTO r;
 END IF;
 DELETE FROM lyraseo_audit.attempt WHERE principal=session_user AND request_id=rid;
 INSERT INTO lyraseo_audit.attempt VALUES(session_user,rid,r.fence,work,gen,a.id,a.fence+1,url,sha256(convert_to(proof,'UTF8')),
 least(expires,r."leaseUntil",handler_deadline,clock_timestamp()+interval '45 seconds'));
 IF least(handler_deadline,expires,r."leaseUntil")<=clock_timestamp() THEN RAISE EXCEPTION 'HANDLER_DEADLINE'; END IF;
 RETURN jsonb_build_object('disposition','ADMITTED','proof',proof,'url',url,'origin',org,'manifest',a.manifest);
END $$;

CREATE FUNCTION lyraseo_audit.checked_attempt(rid uuid,proof text) RETURNS lyraseo_audit.attempt LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public."InternalRequest"; p lyraseo_audit.attempt; d public."WorkDispatch"; a public."AuditRun";
BEGIN
 IF session_user<>'lyraseo_dispatch' OR proof IS NULL OR length(proof)<>72 THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 SELECT * INTO r FROM public."InternalRequest" WHERE ("servicePrincipalId","requestId")=(session_user,rid) FOR UPDATE;
 SELECT * INTO p FROM lyraseo_audit.attempt WHERE (principal,request_id)=(session_user,rid);
 IF p.request_id IS NULL OR p.proof_hash<>sha256(convert_to(proof,'UTF8')) OR r.state<>'ACTIVE' OR r.fence<>p.request_fence
 OR NOT lyraseo_kernel.approved() THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 SELECT * INTO d FROM public."WorkDispatch" WHERE id=p.work_id;
 a:=lyraseo_audit.audit_transition_guard(d."workspaceId",d."siteId",p.audit_id,d."userId",d."admittedSecurityVersion",'CONTROLLED_RAW_TEST_V1','prepare',p.audit_fence);
 SELECT * INTO d FROM public."WorkDispatch" WHERE id=p.work_id FOR UPDATE;
 IF NOT lyraseo_audit.live_binding(d) OR d.disposition<>'DELIVERED' OR d.generation<>p.generation
 OR d."auditId"<>a.id OR a."leaseOwner" IS DISTINCT FROM session_user OR lyraseo_audit.next_page(a) IS DISTINCT FROM p.url
 OR least(r."expiresAt",r."leaseUntil",p.deadline,a."leaseUntil" AT TIME ZONE 'UTC')<=clock_timestamp()
 THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 RETURN p;
END $$;
CREATE FUNCTION lyraseo_audit.check_step(rid uuid,proof text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$ BEGIN PERFORM lyraseo_audit.checked_attempt(rid,proof); RETURN true; END $$;
CREATE FUNCTION lyraseo_audit.prepare_step(rid uuid,proof text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE p lyraseo_audit.attempt; a public."AuditRun"; pages jsonb; final boolean;
BEGIN
 p:=lyraseo_audit.checked_attempt(rid,proof);
 a:=lyraseo_audit.read_target(p.audit_id);
 SELECT count(*)+1=jsonb_array_length(a.manifest) INTO final FROM public."AuditPage" WHERE "auditId"=a.id;
 -- Defend the reader independently, including preexisting/admin fixture rows.
 -- A 25-page manifest returns at most 24 prior bounded evidence subdocuments.
 IF final THEN
   SELECT coalesce(jsonb_agg(lyraseo_audit.bounded_projection(evidence,524288) ORDER BY "requestedUrl"),'[]')
   INTO pages FROM public."AuditPage" WHERE "auditId"=a.id;
 END IF;
 RETURN jsonb_build_object('url',p.url,'manifest',a.manifest,'profile',a.profile,'methodologyVersion',a."methodologyVersion",
 'declarations',a.declarations,'origin',(SELECT origin FROM public."Site" WHERE id=a."siteId"),'priorEvidence',pages);
END $$;
CREATE FUNCTION lyraseo_audit.commit_step(rid uuid,proof text,receipt json,evaluation_ jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE p lyraseo_audit.attempt; a public."AuditRun"; outcome jsonb; done boolean;
BEGIN
 p:=lyraseo_audit.checked_attempt(rid,proof);
 a:=lyraseo_audit.read_target(p.audit_id);
 IF receipt->'evidence'->>'requestedUrl' IS DISTINCT FROM p.url THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
 PERFORM lyraseo_audit.write_transition(a,'checkpoint',NULL,receipt);
 done:=lyraseo_audit.next_page(a) IS NULL;
 IF done IS DISTINCT FROM (evaluation_ IS NOT NULL) THEN RAISE EXCEPTION 'AUDIT_INCOMPLETE'; END IF;
 IF done THEN
   IF evaluation_->>'profile' IS DISTINCT FROM a.profile OR evaluation_->>'methodologyVersion' IS DISTINCT FROM a."methodologyVersion"
   OR evaluation_->'manifest' IS DISTINCT FROM a.manifest OR jsonb_typeof(evaluation_->'rules') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
   PERFORM lyraseo_audit.write_transition(a,'finish',NULL,evaluation_::json);
   outcome:='{"disposition":"COMPLETED"}';
 ELSE
   PERFORM lyraseo_audit.write_transition(a,'yield',NULL,NULL);
   UPDATE public."WorkDispatch" SET generation=generation+1,disposition='PENDING',"nextAttemptAt"=clock_timestamp(),
     "deliveredAt"=NULL,"claimToken"=NULL,"leaseUntil"=NULL WHERE id=p.work_id;
   outcome:='{"disposition":"YIELDED"}';
 END IF;
 -- All writes above roll back if any authoritative lease, proof or delegation
 -- expired during validation/evaluation/SQL execution.
 UPDATE public."InternalRequest" SET state='COMPLETE',"completedAt"=clock_timestamp(),"leaseUntil"=NULL,"ownerToken"=NULL,result=outcome
 WHERE ("servicePrincipalId","requestId",fence,state)=(session_user,rid,p.request_fence,'ACTIVE')
 AND least("expiresAt","leaseUntil",p.deadline,a."leaseUntil" AT TIME ZONE 'UTC',
 (SELECT "expiresAt" FROM public."WorkDispatch" WHERE id=p.work_id),
 (SELECT "verifiedAt" AT TIME ZONE 'UTC'+interval '1 day' FROM public."Site" WHERE id=a."siteId"))>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 DELETE FROM lyraseo_audit.attempt WHERE (principal,request_id)=(session_user,rid);
 RETURN outcome;
END $$;

DO $$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='lyraseo_audit'::regnamespace LOOP
   EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_kernel_owner',fn);
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION lyraseo_audit.web_can_run(text),lyraseo_audit.web_transition(text,text,integer,text,integer,text,json) TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_audit.admit_step(uuid,text,text,text,timestamptz,timestamptz,timestamptz),
 lyraseo_audit.check_step(uuid,text),lyraseo_audit.prepare_step(uuid,text),lyraseo_audit.commit_step(uuid,text,json,jsonb) TO lyraseo_dispatch;
REVOKE UPDATE,DELETE,TRUNCATE ON public."AuditRun" FROM lyraseo_runtime;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public."AuditPage" FROM lyraseo_runtime;
-- Browser admission may only create untouched new local runs (including the
-- historical local-read profile); stop a direct insert from fabricating a final.
CREATE POLICY web_local_admission ON public."AuditRun" AS RESTRICTIVE FOR INSERT TO lyraseo_runtime
 WITH CHECK(profile='LOCAL_RAW_V1' AND status='QUEUED' AND fence=0 AND evaluation IS NULL AND "completedAt" IS NULL
 AND "leaseUntil" IS NULL AND "leaseOwner" IS NULL AND "userId"=current_setting('app.actor_id',true));
-- Unexpected inherited or column-level lifecycle authority fails this cutover.
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['AuditRun','AuditPage','WorkDispatch','InternalRequest','RuntimePolicy','UsageReceipt','ApiToken'] LOOP
   IF has_any_column_privilege('lyraseo_dispatch',format('public.%I',table_name),'SELECT,INSERT,UPDATE')
      OR has_table_privilege('lyraseo_dispatch',format('public.%I',table_name),'DELETE,TRUNCATE')
   THEN RAISE EXCEPTION 'UNEXPECTED_DISPATCH_PRIVILEGES'; END IF;
 END LOOP;
 IF has_any_column_privilege('lyraseo_runtime','public."AuditPage"','INSERT,UPDATE')
    OR has_any_column_privilege('lyraseo_runtime','public."AuditRun"','UPDATE')
    OR pg_has_role('lyraseo_dispatch','lyraseo_kernel_owner','MEMBER') OR pg_has_role('lyraseo_runtime','lyraseo_kernel_owner','MEMBER')
 THEN RAISE EXCEPTION 'UNEXPECTED_AUDIT_PRIVILEGES'; END IF;
END $$;
COMMIT;
