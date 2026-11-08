BEGIN;
ALTER TABLE public."ContentRevision" ADD COLUMN "historyExpiresAt" timestamp(3) GENERATED ALWAYS AS ("createdAt"+interval '90 days') STORED NOT NULL;
CREATE INDEX "ContentRevision_history_expiry" ON public."ContentRevision"("workspaceId","draftId","historyExpiresAt");
-- Default-off, scoped LOCAL_TEST_ONLY history cleanup. No raw-source, financial,
-- authored-head, report, context, identity or processor erasure is implied.
DO $$ DECLARE r record; BEGIN
 SELECT * INTO r FROM pg_roles WHERE rolname='lyraseo_history_owner';
 IF NOT FOUND OR r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolbypassrls OR
    r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR
    EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) OR
    EXISTS(SELECT FROM pg_database WHERE datdba=r.oid) OR
    EXISTS(SELECT FROM pg_namespace WHERE nspowner=r.oid) OR
    EXISTS(SELECT FROM pg_class WHERE relowner=r.oid)
 THEN RAISE EXCEPTION 'UNSAFE_HISTORY_ROLE'; END IF;
END $$;
DO $$ DECLARE r record;BEGIN
 SELECT * INTO r FROM pg_roles WHERE rolname='lyraseo_artifact_maintenance';
 IF NOT FOUND OR NOT r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR
 EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) OR EXISTS(SELECT FROM pg_database WHERE datdba=r.oid) OR
 EXISTS(SELECT FROM pg_namespace WHERE nspowner=r.oid) OR EXISTS(SELECT FROM pg_class WHERE relowner=r.oid) THEN RAISE EXCEPTION 'UNSAFE_HISTORY_MAINTENANCE';END IF;
END $$;
CREATE SCHEMA lyraseo_history;
REVOKE ALL ON SCHEMA lyraseo_history FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_history TO lyraseo_history_owner,lyraseo_artifact_maintenance;
GRANT USAGE ON SCHEMA public,lyraseo_kernel TO lyraseo_history_owner;
GRANT EXECUTE ON FUNCTION lyraseo_kernel.is_test_database() TO lyraseo_history_owner;
GRANT SELECT ON lyraseo_kernel.test_environment TO lyraseo_history_owner;
CREATE POLICY history_test_read ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_history_owner USING(true);
CREATE TABLE lyraseo_history.environment (
 workspace_id text NOT NULL,site_id text NOT NULL,incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
 database_oid oid NOT NULL,postmaster_started_at timestamptz NOT NULL,
 policy_version text NOT NULL CHECK(policy_version='HISTORY_EXPIRY_LOCAL_V1'),
 enabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,site_id),UNIQUE(incarnation),
 FOREIGN KEY(workspace_id,site_id) REFERENCES public."Site"("workspaceId",id)
);
CREATE FUNCTION lyraseo_history.scope_allows(w text,s text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT session_user='lyraseo_artifact_maintenance' AND lyraseo_kernel.is_test_database() AND EXISTS(
 SELECT FROM lyraseo_history.environment e WHERE e.workspace_id=w AND e.site_id=s AND e.enabled AND
 e.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND
 e.postmaster_started_at=pg_postmaster_start_time() AND e.policy_version='HISTORY_EXPIRY_LOCAL_V1')
$$;
ALTER TABLE lyraseo_history.environment ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_history.environment FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_environment ON lyraseo_history.environment FOR SELECT TO lyraseo_history_owner USING(true);
GRANT SELECT ON lyraseo_history.environment TO lyraseo_history_owner;
CREATE TABLE lyraseo_history.plan (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,site_id text NOT NULL,incarnation uuid NOT NULL,
 policy_version text NOT NULL DEFAULT 'HISTORY_EXPIRY_LOCAL_V1' CHECK(policy_version='HISTORY_EXPIRY_LOCAL_V1'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array' AND jsonb_array_length(manifest) BETWEEN 1 AND 100),
 manifest_hash text NOT NULL CHECK(manifest_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 paused boolean NOT NULL DEFAULT false,
 FOREIGN KEY(workspace_id,site_id) REFERENCES lyraseo_history.environment(workspace_id,site_id)
);
CREATE TABLE lyraseo_history.receipt (
 plan_id uuid NOT NULL REFERENCES lyraseo_history.plan(id),kind text NOT NULL,source_id text NOT NULL,
 source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),outcome text NOT NULL CHECK(outcome IN ('REMOVED','UNAVAILABLE','CHANGED_OR_RETAINED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(plan_id,kind,source_id)
);
CREATE FUNCTION lyraseo_history.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN RAISE EXCEPTION 'IMMUTABLE_HISTORY_RECEIPT'; END $$;
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON lyraseo_history.receipt FOR EACH ROW EXECUTE FUNCTION lyraseo_history.immutable();
CREATE FUNCTION lyraseo_history.plan_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN IF TG_OP='DELETE' OR to_jsonb(OLD)-'paused' IS DISTINCT FROM to_jsonb(NEW)-'paused' THEN RAISE EXCEPTION 'IMMUTABLE_HISTORY_PLAN'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_plan BEFORE UPDATE OR DELETE ON lyraseo_history.plan FOR EACH ROW EXECUTE FUNCTION lyraseo_history.plan_identity();
ALTER TABLE lyraseo_history.plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_history.plan FORCE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_history.receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_history.receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_owner ON lyraseo_history.plan TO lyraseo_history_owner
 USING(lyraseo_history.scope_allows(workspace_id,site_id)) WITH CHECK(lyraseo_history.scope_allows(workspace_id,site_id));
CREATE POLICY receipt_owner ON lyraseo_history.receipt TO lyraseo_history_owner
 USING(EXISTS(SELECT FROM lyraseo_history.plan p WHERE p.id=plan_id)) WITH CHECK(EXISTS(SELECT FROM lyraseo_history.plan p WHERE p.id=plan_id));
GRANT SELECT,INSERT,UPDATE(paused) ON lyraseo_history.plan TO lyraseo_history_owner;
GRANT SELECT,INSERT ON lyraseo_history.receipt TO lyraseo_history_owner;
GRANT SELECT ON public."Site",public."ContentDraft",public."ContentRevisionPin" TO lyraseo_history_owner;
CREATE POLICY history_read ON public."Site" FOR SELECT TO lyraseo_history_owner USING(lyraseo_history.scope_allows("workspaceId",id));
CREATE POLICY history_read ON public."ContentDraft" FOR SELECT TO lyraseo_history_owner USING(lyraseo_history.scope_allows("workspaceId","siteId"));
CREATE POLICY history_pin ON public."ContentRevisionPin" FOR SELECT TO lyraseo_history_owner USING(EXISTS(SELECT FROM public."ContentDraft" d WHERE d.id="draftId" AND d."workspaceId"="ContentRevisionPin"."workspaceId"));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['SearchSnapshot','SearchImport','AnalyticsImport'] LOOP
  EXECUTE format('GRANT SELECT,DELETE ON public.%I TO lyraseo_history_owner',t);
  EXECUTE format('CREATE POLICY history_scope ON public.%I TO lyraseo_history_owner USING(lyraseo_history.scope_allows("workspaceId","siteId")) WITH CHECK(false)',t);
 END LOOP;
END $$;
GRANT SELECT,UPDATE(content) ON public."ContentRevision" TO lyraseo_history_owner;
CREATE POLICY history_scope ON public."ContentRevision" TO lyraseo_history_owner
 USING(EXISTS(SELECT FROM public."ContentDraft" d WHERE d.id="draftId" AND d."workspaceId"="ContentRevision"."workspaceId")) WITH CHECK(EXISTS(SELECT FROM public."ContentDraft" d WHERE d.id="draftId" AND d."workspaceId"="ContentRevision"."workspaceId"));
CREATE FUNCTION lyraseo_history.revision_payload_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
 IF current_user<>'lyraseo_history_owner' OR NEW.content IS DISTINCT FROM 'null'::jsonb OR
    (TG_WHEN='BEFORE' AND to_jsonb(OLD)-ARRAY['content','historyExpiresAt'] IS DISTINCT FROM to_jsonb(NEW)-ARRAY['content','historyExpiresAt']) OR
    (TG_WHEN='AFTER' AND to_jsonb(OLD)-'content' IS DISTINCT FROM to_jsonb(NEW)-'content')
 THEN RAISE EXCEPTION 'IMMUTABLE_AUTHORED_HISTORY'; END IF; RETURN NEW; END $$;
CREATE TRIGGER history_payload_transition BEFORE UPDATE ON public."ContentRevision" FOR EACH ROW EXECUTE FUNCTION lyraseo_history.revision_payload_guard();
CREATE TRIGGER history_payload_postimage AFTER UPDATE ON public."ContentRevision" FOR EACH ROW EXECUTE FUNCTION lyraseo_history.revision_payload_guard();
-- Row locks require UPDATE privilege on at least one column. It cannot authorize
-- an update: the purpose RLS policies above have WITH CHECK(false).
GRANT UPDATE(id) ON public."Site",public."ContentDraft",public."ContentRevision",public."SearchSnapshot",public."SearchImport",public."AnalyticsImport" TO lyraseo_history_owner;
CREATE FUNCTION lyraseo_history.candidates(w text,s text,n integer DEFAULT 100) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE result jsonb; BEGIN
 IF NOT lyraseo_history.scope_allows(w,s) THEN RAISE EXCEPTION 'HISTORY_SCOPE_UNAVAILABLE'; END IF;
 IF n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_HISTORY_LIMIT'; END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY kind,id),'[]') INTO result FROM (
  SELECT kind,id,jsonb_build_object('kind',kind,'id',id,'deadline',to_char(deadline,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'fingerprint',encode(sha256(convert_to(body::text,'UTF8')),'hex')) value FROM (
   SELECT 'REVISION' kind,r.id,r."historyExpiresAt" deadline,to_jsonb(r) body FROM public."ContentRevision" r
    JOIN public."ContentDraft" d ON d.id=r."draftId" AND d."workspaceId"=r."workspaceId"
    WHERE d."workspaceId"=w AND d."siteId"=s AND r.content IS DISTINCT FROM 'null'::jsonb AND r.revision<>d.revision AND r."historyExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC'
    AND NOT EXISTS(SELECT FROM public."ContentRevisionPin" p WHERE (p."workspaceId",p."draftId",p.revision)=(r."workspaceId",r."draftId",r.revision))
   UNION ALL SELECT 'SEARCH',r.id,r."resultExpiresAt",to_jsonb(r) FROM public."SearchSnapshot" r WHERE r."workspaceId"=w AND r."siteId"=s AND r."resultExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC'
   UNION ALL SELECT 'SEARCH_IMPORT',r.id,r."resultExpiresAt",to_jsonb(r) FROM public."SearchImport" r WHERE r."workspaceId"=w AND r."siteId"=s AND r."resultExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' AND r.status<>'running'
   UNION ALL SELECT 'ANALYTICS',r.id,r."resultExpiresAt",to_jsonb(r) FROM public."AnalyticsImport" r WHERE r."workspaceId"=w AND r."siteId"=s AND r."resultExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' AND r.status<>'running'
  ) eligible ORDER BY kind,id LIMIT n
 ) bounded;
 RETURN result; END $$;
CREATE FUNCTION lyraseo_history.record_plan(w text,s text,manifest_ jsonb,hash_ text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE actual jsonb;p lyraseo_history.plan; BEGIN
 IF NOT lyraseo_history.scope_allows(w,s) THEN RAISE EXCEPTION 'HISTORY_SCOPE_UNAVAILABLE'; END IF;
 PERFORM id FROM public."Site" WHERE "workspaceId"=w AND id=s FOR SHARE;
 IF manifest_ IS NULL OR jsonb_typeof(manifest_)<>'array' OR jsonb_array_length(manifest_) NOT BETWEEN 1 AND 100 OR
  encode(sha256(convert_to(manifest_::text,'UTF8')),'hex') IS DISTINCT FROM hash_ THEN RAISE EXCEPTION 'INVALID_HISTORY_MANIFEST'; END IF;
 actual:=lyraseo_history.candidates(w,s,jsonb_array_length(manifest_));
 IF actual IS DISTINCT FROM manifest_ THEN RAISE EXCEPTION 'HISTORY_PREVIEW_CHANGED'; END IF;
 INSERT INTO lyraseo_history.plan(workspace_id,site_id,incarnation,manifest,manifest_hash,expires_at)
 SELECT w,s,e.incarnation,actual,hash_,clock_timestamp()+interval '1 hour' FROM lyraseo_history.environment e WHERE e.workspace_id=w AND e.site_id=s RETURNING * INTO STRICT p;
 RETURN jsonb_build_object('id',p.id,'hash',p.manifest_hash,'count',jsonb_array_length(p.manifest),'expiresAt',p.expires_at); END $$;
CREATE FUNCTION lyraseo_history.apply_plan(w text,s text,plan_ uuid,hash_ text,n integer DEFAULT 100) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE p lyraseo_history.plan; item jsonb;body jsonb;kind_ text;id_ text;table_ text;eligible boolean;removed integer;outcome_ text;done integer:=0;
 BEGIN
 IF NOT lyraseo_history.scope_allows(w,s) THEN RAISE EXCEPTION 'HISTORY_SCOPE_UNAVAILABLE'; END IF;
 IF n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_HISTORY_LIMIT'; END IF;
 PERFORM id FROM public."Site" WHERE "workspaceId"=w AND id=s FOR SHARE;
 SELECT * INTO p FROM lyraseo_history.plan WHERE id=plan_ AND workspace_id=w AND site_id=s FOR UPDATE;
 IF NOT FOUND OR p.manifest_hash IS DISTINCT FROM hash_ THEN RAISE EXCEPTION 'HISTORY_PLAN_UNAVAILABLE'; END IF;
 IF p.paused OR p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'HISTORY_PLAN_PAUSED_OR_EXPIRED'; END IF;
 IF NOT EXISTS(SELECT FROM lyraseo_history.environment e WHERE e.workspace_id=w AND e.site_id=s AND e.incarnation=p.incarnation) THEN RAISE EXCEPTION 'HISTORY_INCARCATION_CHANGED'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p.manifest) WHERE NOT EXISTS(SELECT FROM lyraseo_history.receipt r WHERE r.plan_id=p.id AND r.kind=value->>'kind' AND r.source_id=value->>'id') LIMIT n LOOP
  kind_:=item->>'kind';id_:=item->>'id';eligible:=false;body:=NULL;
  IF kind_='REVISION' THEN
   PERFORM d.id FROM public."ContentDraft" d JOIN public."ContentRevision" r ON r."workspaceId"=d."workspaceId" AND r."draftId"=d.id WHERE r.id=id_ AND d."workspaceId"=w AND d."siteId"=s FOR UPDATE OF d;
   SELECT to_jsonb(r),r.revision<>d.revision AND r."historyExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' AND
    NOT EXISTS(SELECT FROM public."ContentRevisionPin" pin WHERE (pin."workspaceId",pin."draftId",pin.revision)=(r."workspaceId",r."draftId",r.revision)) INTO body,eligible
    FROM public."ContentRevision" r JOIN public."ContentDraft" d ON d.id=r."draftId" AND d."workspaceId"=r."workspaceId" WHERE r.id=id_ AND d."workspaceId"=w AND d."siteId"=s FOR UPDATE OF r;
   table_:='ContentRevision';
  ELSE
   table_:=CASE kind_ WHEN 'SEARCH' THEN 'SearchSnapshot' WHEN 'SEARCH_IMPORT' THEN 'SearchImport' WHEN 'ANALYTICS' THEN 'AnalyticsImport' ELSE NULL END;
   IF table_ IS NULL THEN RAISE EXCEPTION 'INVALID_HISTORY_MANIFEST'; END IF;
   EXECUTE format('SELECT to_jsonb(r),r."resultExpiresAt"<=clock_timestamp() AT TIME ZONE ''UTC'' %s FROM public.%I r WHERE r.id=$1 AND r."workspaceId"=$2 AND r."siteId"=$3 FOR UPDATE',CASE WHEN kind_='SEARCH' THEN '' ELSE 'AND r.status<>''running''' END,table_) INTO body,eligible USING id_,w,s;
  END IF;
  outcome_:=CASE WHEN body IS NULL THEN 'UNAVAILABLE' ELSE 'CHANGED_OR_RETAINED' END;
  IF eligible AND encode(sha256(convert_to(body::text,'UTF8')),'hex')=item->>'fingerprint' THEN
   IF kind_='REVISION' THEN
    UPDATE public."ContentRevision" SET content='null'::jsonb WHERE id=id_ AND "workspaceId"=w;
   ELSE
    EXECUTE format('DELETE FROM public.%I WHERE id=$1 AND "workspaceId"=$2',table_) USING id_,w;
   END IF;
   GET DIAGNOSTICS removed=ROW_COUNT;
   IF removed<>1 THEN RAISE EXCEPTION 'HISTORY_DELETE_RACE'; END IF;
   outcome_:='REMOVED';
  END IF;
  INSERT INTO lyraseo_history.receipt(plan_id,kind,source_id,source_hash,outcome) VALUES(p.id,kind_,id_,item->>'fingerprint',outcome_);
  done:=done+1;
 END LOOP;
 RETURN jsonb_build_object('processed',done,'receipts',(SELECT count(*) FROM lyraseo_history.receipt WHERE plan_id=p.id),'remaining',jsonb_array_length(p.manifest)-(SELECT count(*) FROM lyraseo_history.receipt WHERE plan_id=p.id));
 END $$;
CREATE FUNCTION lyraseo_history.pause_plan(w text,s text,plan_ uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT lyraseo_history.scope_allows(w,s) THEN RAISE EXCEPTION 'HISTORY_SCOPE_UNAVAILABLE'; END IF;
 PERFORM id FROM public."Site" WHERE "workspaceId"=w AND id=s FOR SHARE;
 UPDATE lyraseo_history.plan SET paused=true WHERE id=plan_ AND workspace_id=w AND site_id=s;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_PLAN_UNAVAILABLE'; END IF;
 END $$;
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lyraseo_history' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_history_owner',f.name);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.name);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION lyraseo_history.candidates(text,text,integer),lyraseo_history.record_plan(text,text,jsonb,text),lyraseo_history.apply_plan(text,text,uuid,text,integer),lyraseo_history.pause_plan(text,text,uuid) TO lyraseo_artifact_maintenance;
REVOKE ALL ON ALL TABLES IN SCHEMA lyraseo_history FROM PUBLIC,lyraseo_runtime,lyraseo_dispatch,lyraseo_identity,lyraseo_artifact_maintenance;
-- Tombstone-first local deletion admission. No worker/finance lease is changed.
DO $$ DECLARE r record; BEGIN
 SELECT * INTO r FROM pg_roles WHERE rolname='lyraseo_deletion_owner';
 IF NOT FOUND OR r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR
 EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) OR EXISTS(SELECT FROM pg_database WHERE datdba=r.oid) OR
 EXISTS(SELECT FROM pg_namespace WHERE nspowner=r.oid) OR EXISTS(SELECT FROM pg_class WHERE relowner=r.oid) THEN RAISE EXCEPTION 'UNSAFE_DELETION_ROLE'; END IF;
END $$;
CREATE SCHEMA lyraseo_deletion;
REVOKE ALL ON SCHEMA lyraseo_deletion FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_deletion TO lyraseo_deletion_owner,lyraseo_runtime,lyraseo_artifact_maintenance;
GRANT USAGE ON SCHEMA public,lyraseo_kernel,lyraseo_history TO lyraseo_deletion_owner;
GRANT EXECUTE ON FUNCTION lyraseo_kernel.is_test_database(),lyraseo_history.scope_allows(text,text) TO lyraseo_deletion_owner;
GRANT SELECT ON lyraseo_kernel.test_environment,lyraseo_history.environment TO lyraseo_deletion_owner;
CREATE POLICY deletion_test ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_deletion_owner USING(true);
CREATE POLICY deletion_environment ON lyraseo_history.environment FOR SELECT TO lyraseo_deletion_owner USING(true);
CREATE TABLE lyraseo_deletion.scope_case (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,workspace_id text NOT NULL,site_id text NOT NULL,incarnation uuid NOT NULL,
 actor_id text NOT NULL,actor_security_version integer NOT NULL,
 policy_version text NOT NULL DEFAULT 'SITE_DELETION_LOCAL_V1' CHECK(policy_version='SITE_DELETION_LOCAL_V1'),
 journal_partition uuid NOT NULL,journal_sequence bigint NOT NULL CHECK(journal_sequence>0),journal_hash text NOT NULL CHECK(journal_hash~'^[a-f0-9]{64}$'),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),deadline timestamptz NOT NULL,record_expires_at timestamptz NOT NULL,
 receipt_hash text NOT NULL CHECK(receipt_hash~'^[a-f0-9]{64}$'),
 UNIQUE(workspace_id,site_id,incarnation),
 FOREIGN KEY(workspace_id,site_id) REFERENCES public."Site"("workspaceId",id)
);
CREATE TABLE lyraseo_deletion.task (
 case_id uuid NOT NULL REFERENCES lyraseo_deletion.scope_case(id),kind text NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','COMPLETE','NEEDS_ADAPTER')),
 fence integer NOT NULL DEFAULT 0,attempts integer NOT NULL DEFAULT 0,
 next_retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 result jsonb,PRIMARY KEY(case_id,kind),
 CHECK(kind IN ('IMPORTS','CREDENTIALS','AUTHORED_PAYLOAD','AUDIT_PAYLOAD','ARTIFACTS','VISIBILITY_PAYLOAD','KEYWORD_DATA','HANDOFF_DATA','TEAM_DATA','PROCESSORS','BACKUPS','FINANCIAL_IDENTITY'))
);
CREATE TABLE lyraseo_deletion.event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),case_id uuid NOT NULL REFERENCES lyraseo_deletion.scope_case(id),kind text NOT NULL,
 fence integer NOT NULL,result jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(case_id,kind,fence)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['scope_case','task','event'] LOOP
  EXECUTE format('ALTER TABLE lyraseo_deletion.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE lyraseo_deletion.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY deletion_owner ON lyraseo_deletion.%I TO lyraseo_deletion_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON lyraseo_deletion.scope_case,lyraseo_deletion.event TO lyraseo_deletion_owner;
GRANT UPDATE(id) ON lyraseo_deletion.scope_case TO lyraseo_deletion_owner;
GRANT SELECT,INSERT,UPDATE ON lyraseo_deletion.task TO lyraseo_deletion_owner;
CREATE TRIGGER immutable_case BEFORE UPDATE OR DELETE ON lyraseo_deletion.scope_case FOR EACH ROW EXECUTE FUNCTION lyraseo_history.immutable();
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON lyraseo_deletion.event FOR EACH ROW EXECUTE FUNCTION lyraseo_history.immutable();
GRANT EXECUTE ON FUNCTION lyraseo_history.immutable() TO lyraseo_deletion_owner;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['Workspace','Site','Membership','ProductUser','StaffGrant','SiteGrant','ApiToken','GoogleConnection','AnalyticsConnection','GoogleOAuthState','AnalyticsOAuthState','SearchSnapshot','SearchImport','AnalyticsImport','ContentDraft','ContentRevision','ContentRevisionPin','EvidenceReport','PageIdentity','PageJournal','SiteContextRevision','SiteVerificationChallenge'] LOOP
  EXECUTE format('GRANT SELECT ON public.%I TO lyraseo_deletion_owner',t);
  EXECUTE format('CREATE POLICY deletion_owner ON public.%I TO lyraseo_deletion_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT UPDATE("deletedAt") ON public."Site" TO lyraseo_deletion_owner;
GRANT UPDATE(id) ON public."Workspace",public."ProductUser" TO lyraseo_deletion_owner;
GRANT UPDATE("revokedAt") ON public."ApiToken",public."SiteVerificationChallenge" TO lyraseo_deletion_owner;
GRANT DELETE ON public."SiteGrant",public."GoogleConnection",public."AnalyticsConnection",public."GoogleOAuthState",public."AnalyticsOAuthState",public."SearchSnapshot",public."SearchImport",public."AnalyticsImport",public."PageJournal",public."PageIdentity",public."ContentDraft",public."ContentRevision",public."ContentRevisionPin",public."EvidenceReport",public."SiteContextRevision" TO lyraseo_deletion_owner;
-- Existing context immutability remains absolute except for already-tombstoned
-- scope deletion through this non-login purpose identity.
CREATE OR REPLACE FUNCTION public.site_context_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
 IF TG_OP='DELETE' AND current_user='lyraseo_deletion_owner' AND EXISTS(SELECT FROM public."Site" s WHERE s."workspaceId"=OLD."workspaceId" AND s.id=OLD."siteId" AND s."deletedAt" IS NOT NULL) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'IMMUTABLE_SITE_CONTEXT'; END $$;
CREATE FUNCTION lyraseo_deletion.manager(w text,s text,epoch integer) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT session_user='lyraseo_runtime' AND w=current_setting('app.workspace_id',true) AND lyraseo_kernel.is_test_database() AND
 EXISTS(SELECT FROM public."Membership" m JOIN public."ProductUser" u ON u.id=m."userId" JOIN public."Workspace" ws ON ws.id=m."workspaceId"
 JOIN public."Site" st ON st."workspaceId"=ws.id WHERE m."workspaceId"=w AND st.id=s AND m."userId"=current_setting('app.actor_id',true)
 AND m.role IN ('OWNER','ADMIN') AND NOT u.suspended AND u."securityVersion"=epoch AND ws."deletedAt" IS NULL) AND
 EXISTS(SELECT FROM lyraseo_history.environment e WHERE e.workspace_id=w AND e.site_id=s AND e.enabled AND e.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND e.postmaster_started_at=pg_postmaster_start_time())
$$;
CREATE FUNCTION lyraseo_deletion.identity(w text,s text,epoch integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE result jsonb; BEGIN
 IF NOT lyraseo_deletion.manager(w,s,epoch) THEN RAISE EXCEPTION 'DELETION_SCOPE_UNAVAILABLE'; END IF;
 SELECT jsonb_build_object('incarnation',e.incarnation,'deleted',st."deletedAt" IS NOT NULL,'origin',st.origin)
 INTO result FROM lyraseo_history.environment e JOIN public."Site" st ON (st."workspaceId",st.id)=(e.workspace_id,e.site_id) WHERE e.workspace_id=w AND e.site_id=s;
 RETURN result; END $$;
-- Optional agency31 extension. No membership, other-site input, shared branding
-- or already-incurred operation is removed by this exact-site retirement.
CREATE FUNCTION lyraseo_deletion.retire_team(w text,s text,case_ uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE c lyraseo_deletion.scope_case;stamp timestamp:=clock_timestamp() AT TIME ZONE 'UTC';r record;revision_ integer;invites_ integer;pages_ integer:=0;issues_ integer:=0;items_ integer;
 BEGIN
 IF to_regclass('public."WorkspaceAccessEvent"') IS NULL THEN RETURN jsonb_build_object('available',false);END IF;
 SELECT * INTO STRICT c FROM lyraseo_deletion.scope_case WHERE id=case_ AND workspace_id=w AND site_id=s;
 IF NOT EXISTS(SELECT FROM public."Site" WHERE "workspaceId"=w AND id=s AND "deletedAt" IS NOT NULL) THEN RAISE EXCEPTION 'DELETION_SCOPE_NOT_TOMBSTONED';END IF;
 IF EXISTS(SELECT FROM public."WorkspaceAccessEvent" WHERE id='deletion-'||case_::text) THEN RETURN jsonb_build_object('available',true,'alreadyRetired',true);END IF;
 UPDATE public."WorkspaceInvitation" i SET "revokedAt"=stamp WHERE i."workspaceId"=w AND i."acceptedAt" IS NULL AND i."revokedAt" IS NULL AND EXISTS(SELECT FROM public."WorkspaceInvitationSite" x WHERE x."workspaceId"=w AND x."invitationId"=i.id AND x."siteId"=s);
 GET DIAGNOSTICS invites_=ROW_COUNT;
 FOR r IN SELECT id,revision FROM public."PageIdentity" WHERE "workspaceId"=w AND "siteId"=s AND "assignedTo" IS NOT NULL ORDER BY id FOR UPDATE LOOP
  UPDATE public."PageIdentity" SET "assignedTo"=NULL,revision=revision+1 WHERE id=r.id;
  INSERT INTO public."PageJournal"(id,"workspaceId","siteId","pageId",revision,action,note,"userId","idempotencyKey","inputHash","assigneeUserId") VALUES(gen_random_uuid()::text,w,s,r.id,r.revision+1,'access-revoked','Site deletion revoked assignment',c.actor_id,'delete-site:'||case_::text,encode(sha256(convert_to(jsonb_build_array(case_,r.id)::text,'UTF8')),'hex'),NULL);
  pages_:=pages_+1;
 END LOOP;
 FOR r IN SELECT id,revision FROM public."IssueAssignment" WHERE "workspaceId"=w AND "siteId"=s AND "assigneeUserId" IS NOT NULL ORDER BY id FOR UPDATE LOOP
  UPDATE public."IssueAssignment" SET "assigneeUserId"=NULL,revision=revision+1,"updatedAt"=stamp WHERE id=r.id;
  INSERT INTO public."IssueAssignmentEvent"(id,"workspaceId","siteId","assignmentId",revision,"actorId","assigneeUserId","idempotencyKey","inputHash") VALUES(gen_random_uuid()::text,w,s,r.id,r.revision+1,c.actor_id,NULL,'delete-site:'||case_::text||':'||r.id,encode(sha256(convert_to(jsonb_build_array(case_,r.id)::text,'UTF8')),'hex'));
  issues_:=issues_+1;
 END LOOP;
 UPDATE public."AgencyBatchItem" i SET status='REJECTED',"errorCode"='SITE_DELETED' WHERE i."workspaceId"=w AND i."siteId"=s AND i."operationId" IS NULL AND NOT EXISTS(SELECT FROM public."OperationQuote" q WHERE q.id=i."quoteId" AND q."workspaceId"=w AND q."siteId"=s AND q."userId"=i."userId" AND q."consumedOperationId" IS NOT NULL);
 GET DIAGNOSTICS items_=ROW_COUNT;
 UPDATE public."Workspace" SET "accessRevision"="accessRevision"+1 WHERE id=w RETURNING "accessRevision" INTO revision_;
 INSERT INTO public."WorkspaceAccessEvent"(id,"workspaceId","actorId",action,"siteId","accessRevision") VALUES('deletion-'||case_::text,w,c.actor_id,'revoke',s,revision_);
 RETURN jsonb_build_object('available',true,'revokedInvitations',invites_,'clearedPages',pages_,'clearedIssues',issues_,'rejectedUncommittedItems',items_,'accessRevision',revision_);
 END $$;
CREATE FUNCTION lyraseo_deletion.erase_team(w text,s text,case_ uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE c lyraseo_deletion.scope_case;r record;count_ integer;issues_ integer;events_ integer;links_ integer;invites_ integer;scrubbed_ integer:=0;blocked_ integer:=0;request_ jsonb;preview_ jsonb;deadline_ timestamp;retained_ integer;
 BEGIN
 IF to_regclass('public."WorkspaceAccessEvent"') IS NULL THEN RETURN jsonb_build_object('available',false);END IF;
 SELECT * INTO STRICT c FROM lyraseo_deletion.scope_case WHERE id=case_ AND workspace_id=w AND site_id=s;
 PERFORM lyraseo_deletion.retire_team(w,s,case_);
 DELETE FROM public."IssueAssignmentEvent" WHERE "workspaceId"=w AND "siteId"=s;GET DIAGNOSTICS events_=ROW_COUNT;
 DELETE FROM public."IssueAssignment" WHERE "workspaceId"=w AND "siteId"=s;GET DIAGNOSTICS issues_=ROW_COUNT;
 -- Delete only this site's invitation links. A shared invitation is retired,
 -- while its other-site references remain available to the workspace manager.
 FOR r IN SELECT DISTINCT "invitationId" id FROM public."WorkspaceInvitationSite" WHERE "workspaceId"=w AND "siteId"=s LOOP
  DELETE FROM public."WorkspaceInvitationSite" WHERE "workspaceId"=w AND "siteId"=s AND "invitationId"=r.id;
  IF NOT EXISTS(SELECT FROM public."WorkspaceInvitationSite" WHERE "workspaceId"=w AND "invitationId"=r.id) THEN DELETE FROM public."WorkspaceInvitation" WHERE "workspaceId"=w AND id=r.id;END IF;
 END LOOP;
 FOR r IN SELECT b.id,b."requestInput",b.preview FROM public."AgencyBatchQuote" b WHERE b."workspaceId"=w AND EXISTS(SELECT FROM public."AgencyBatchItem" i WHERE i."workspaceId"=w AND i."siteId"=s AND i."batchQuoteId"=b.id) ORDER BY b.id FOR UPDATE LOOP
  IF jsonb_typeof(r."requestInput") IS DISTINCT FROM 'object' OR r."requestInput"-ARRAY['workspaceId','items']<>'{}'::jsonb OR r."requestInput"->>'workspaceId' IS DISTINCT FROM w OR jsonb_typeof(r."requestInput"->'items') IS DISTINCT FROM 'array' OR jsonb_typeof(r.preview) IS DISTINCT FROM 'object' OR jsonb_typeof(r.preview->'items') IS DISTINCT FROM 'array' OR
   r.preview-ARRAY['batchQuoteId','expiresAt','inputHash','items','totalsByProvider','combinedMaximum','currency','budgetOwnerId','unavailable']<>'{}'::jsonb THEN blocked_:=blocked_+1;CONTINUE;END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(r."requestInput"->'items') x(item) WHERE jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'siteId') IS DISTINCT FROM 'string' OR item-ARRAY['siteId','kind','input']<>'{}'::jsonb) OR
   EXISTS(SELECT FROM jsonb_array_elements(r.preview->'items') x(item) WHERE jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'siteId') IS DISTINCT FROM 'string' OR item-ARRAY['siteId','ordinal','quoteId','maximumCost','provider','tariffVersion','status','errorCode']<>'{}'::jsonb) THEN blocked_:=blocked_+1;CONTINUE;END IF;
  SELECT coalesce(jsonb_agg(CASE WHEN item->>'siteId'=s THEN jsonb_build_object('siteId',s,'kind',item->'kind','input',NULL) ELSE item END ORDER BY ord),'[]') INTO request_ FROM jsonb_array_elements(r."requestInput"->'items') WITH ORDINALITY x(item,ord);
  SELECT coalesce(jsonb_agg(CASE WHEN item->>'siteId'=s THEN item||jsonb_build_object('status','UNAVAILABLE','errorCode','SITE_DELETED') ELSE item END ORDER BY ord),'[]') INTO preview_ FROM jsonb_array_elements(r.preview->'items') WITH ORDINALITY x(item,ord);
  UPDATE public."AgencyBatchQuote" SET "requestInput"=jsonb_set("requestInput",'{items}',request_),preview=jsonb_set(preview,'{items}',preview_) WHERE id=r.id;
  scrubbed_:=scrubbed_+1;
 END LOOP;
 DELETE FROM public."WorkspaceAccessEvent" WHERE "workspaceId"=w AND "siteId"=s AND "createdAt"+interval '180 days'<=clock_timestamp() AT TIME ZONE 'UTC';
 SELECT count(*)::integer,min("createdAt"+interval '180 days') INTO retained_,deadline_ FROM public."WorkspaceAccessEvent" WHERE "workspaceId"=w AND "siteId"=s;
 RETURN jsonb_build_object('available',true,'complete',blocked_=0,'removedAssignments',issues_,'removedAssignmentEvents',events_,'scrubbedBatches',scrubbed_,'blockedUnknownBatchPayloads',blocked_,'retainedSecurityEvents',retained_,'securityRecordDeadline',deadline_,'securityAuthority','ACCESS_ACTION_180D_LOCAL','sharedBrandingPreserved',true);
 END $$;
-- No runtime GUC or client-supplied hash can establish durable journal/MFA authority.
-- Keep this historical signature fail-closed until an independent issuer is qualified.
CREATE FUNCTION lyraseo_deletion.accept_site(w text,s text,epoch integer,case_ uuid,request_ uuid,incarnation_ uuid,partition_ uuid,sequence_ bigint,hash_ text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN RAISE EXCEPTION 'DELETION_ADMISSION_UNQUALIFIED'; END $$;
CREATE FUNCTION lyraseo_deletion.status(w text,s text,case_ uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE c lyraseo_deletion.scope_case;BEGIN
 IF NOT lyraseo_history.scope_allows(w,s) THEN RAISE EXCEPTION 'DELETION_SCOPE_UNAVAILABLE'; END IF;
 SELECT * INTO c FROM lyraseo_deletion.scope_case WHERE id=case_ AND workspace_id=w AND site_id=s;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELETION_CASE_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('id',c.id,'accessBlocked',true,'acceptedAt',c.accepted_at,'deadline',c.deadline,'overdue',c.deadline<=clock_timestamp(),'allCopiesErased',false,
 'tasks',(SELECT jsonb_agg(jsonb_build_object('kind',kind,'state',state,'attempts',attempts,'result',result) ORDER BY kind) FROM lyraseo_deletion.task WHERE case_id=c.id));END $$;
CREATE FUNCTION lyraseo_deletion.sweep(w text,s text,case_ uuid,n integer DEFAULT 3) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE c lyraseo_deletion.scope_case;t lyraseo_deletion.task;
 BEGIN
 IF NOT lyraseo_history.scope_allows(w,s) THEN RAISE EXCEPTION 'DELETION_SCOPE_UNAVAILABLE'; END IF;
 IF n NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'INVALID_DELETION_LIMIT'; END IF;
 PERFORM id FROM public."Site" WHERE "workspaceId"=w AND id=s AND "deletedAt" IS NOT NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELETION_SCOPE_NOT_TOMBSTONED'; END IF;
 SELECT * INTO c FROM lyraseo_deletion.scope_case WHERE id=case_ AND workspace_id=w AND site_id=s FOR SHARE;
 IF NOT FOUND OR NOT EXISTS(SELECT FROM lyraseo_history.environment e WHERE e.workspace_id=w AND e.site_id=s AND e.incarnation=c.incarnation) THEN RAISE EXCEPTION 'DELETION_CASE_UNAVAILABLE'; END IF;
 FOR t IN SELECT * FROM lyraseo_deletion.task WHERE case_id=c.id AND state='PENDING' AND next_retry_at<=clock_timestamp() ORDER BY kind LIMIT n FOR UPDATE LOOP
  -- n bounds metadata rows only. No payload category is qualified for a
  -- whole-site transaction; do not dispatch private helpers from this loop.
  UPDATE lyraseo_deletion.task SET state='NEEDS_ADAPTER',attempts=attempts+1,fence=fence+1,
   result=jsonb_build_object('reason','BOUNDED_ERASURE_NOT_QUALIFIED')
   WHERE (case_id,kind)=(t.case_id,t.kind);
 END LOOP;
 RETURN jsonb_build_object('completedTasks',0,'allCopiesErased',false);END $$;
CREATE FUNCTION lyraseo_deletion.staff_projection(user_ text,epoch integer,w text DEFAULT NULL,s text DEFAULT NULL,n integer DEFAULT 25,after_ uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE rows_ jsonb;more_ boolean;next_ uuid;BEGIN
 IF session_user<>'lyraseo_staff_executor' OR NOT EXISTS(SELECT FROM public."StaffGrant" g JOIN public."ProductUser" u ON u.id=g."userId" WHERE u.id=user_ AND g.enabled AND NOT u.suspended AND u."securityVersion"=epoch) THEN RAISE EXCEPTION 'STAFF_UNAUTHORIZED';END IF;
 IF n NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'INVALID_PRIVACY_PROJECTION_LIMIT';END IF;
 WITH selected AS MATERIALIZED(SELECT c.* FROM lyraseo_deletion.scope_case c WHERE (w IS NULL OR c.workspace_id=w) AND (s IS NULL OR c.site_id=s) AND (after_ IS NULL OR c.id>after_) ORDER BY c.id LIMIT n+1),
 bounded AS(SELECT * FROM selected ORDER BY id LIMIT n)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'workspaceId',c.workspace_id,'siteId',c.site_id,'incarnation',c.incarnation,'acceptedAt',c.accepted_at,'deadline',c.deadline,'recordExpiresAt',c.record_expires_at,'overdue',c.deadline<=clock_timestamp(),'accessBlocked',true,'allCopiesErased',false,
  'taskCounts',(SELECT jsonb_build_object('pending',count(*) FILTER(WHERE state='PENDING'),'complete',count(*) FILTER(WHERE state='COMPLETE'),'needsAdapter',count(*) FILTER(WHERE state='NEEDS_ADAPTER')) FROM lyraseo_deletion.task WHERE case_id=c.id),
  'tasks',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'state',state,'attempts',attempts,'nextRetryAt',next_retry_at,'completedAt',completed_at,'reason',CASE WHEN result->>'reason' IN ('UNQUALIFIED_ERASURE_ADAPTER','BOUNDED_ERASURE_NOT_QUALIFIED') THEN result->>'reason' ELSE NULL END) ORDER BY kind),'[]') FROM lyraseo_deletion.task WHERE case_id=c.id)
 ) ORDER BY c.id),'[]'),(SELECT count(*)>n FROM selected),(SELECT id FROM bounded ORDER BY id DESC LIMIT 1) INTO rows_,more_,next_ FROM bounded c;
 RETURN jsonb_build_object('available',true,'profile','LOCAL_TEST_ONLY','rows',rows_,'nextCursor',CASE WHEN more_ THEN next_ ELSE NULL END,'allCopiesErased',false);
 END $$;
DO $$ DECLARE f record;name_ text;t text;BEGIN
 FOR f IN SELECT p.oid::regprocedure name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lyraseo_deletion' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_deletion_owner',f.name);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.name);END LOOP;
 IF to_regnamespace('lyraseo_handoff') IS NOT NULL THEN
  GRANT USAGE ON SCHEMA lyraseo_handoff TO lyraseo_deletion_owner;
  FOREACH name_ IN ARRAY ARRAY['lyraseo_handoff.retire_site(text,text)','lyraseo_handoff.erase_site(text,text)'] LOOP IF to_regprocedure(name_) IS NOT NULL THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lyraseo_deletion_owner',name_);END IF;END LOOP;
 END IF;
 FOREACH t IN ARRAY ARRAY['KeywordEnrichmentResult','KeywordSelection'] LOOP
  IF to_regclass(format('public.%I',t)) IS NOT NULL THEN
   EXECUTE format('GRANT SELECT,DELETE ON public.%I TO lyraseo_deletion_owner',t);
   EXECUTE format('CREATE POLICY deletion_owner ON public.%I TO lyraseo_deletion_owner USING(true) WITH CHECK(false)',t);
  END IF;
 END LOOP;
 IF to_regclass('public."WorkspaceAccessEvent"') IS NOT NULL THEN
  GRANT SELECT(id,"workspaceId","siteId","userId","consumedOperationId") ON public."OperationQuote" TO lyraseo_deletion_owner;
  CREATE POLICY deletion_financial_link_read ON public."OperationQuote" FOR SELECT TO lyraseo_deletion_owner USING(true);
  GRANT UPDATE("accessRevision") ON public."Workspace" TO lyraseo_deletion_owner;
  GRANT UPDATE(revision,"assignedTo") ON public."PageIdentity" TO lyraseo_deletion_owner;
  GRANT INSERT ON public."PageJournal" TO lyraseo_deletion_owner;
  FOREACH t IN ARRAY ARRAY['WorkspaceAccessEvent','WorkspaceInvitation','WorkspaceInvitationSite','IssueAssignment','IssueAssignmentEvent','AgencyBatchQuote','AgencyBatchItem'] LOOP
   EXECUTE format('GRANT SELECT ON public.%I TO lyraseo_deletion_owner',t);
   EXECUTE format('CREATE POLICY deletion_owner ON public.%I TO lyraseo_deletion_owner USING(true) WITH CHECK(true)',t);
  END LOOP;
  GRANT INSERT,DELETE ON public."WorkspaceAccessEvent" TO lyraseo_deletion_owner;
  GRANT UPDATE("revokedAt"),DELETE ON public."WorkspaceInvitation" TO lyraseo_deletion_owner;
  GRANT DELETE ON public."WorkspaceInvitationSite",public."IssueAssignment",public."IssueAssignmentEvent" TO lyraseo_deletion_owner;
  GRANT UPDATE("revision","assigneeUserId","updatedAt") ON public."IssueAssignment" TO lyraseo_deletion_owner;
  GRANT INSERT ON public."IssueAssignmentEvent" TO lyraseo_deletion_owner;
  GRANT UPDATE("requestInput",preview) ON public."AgencyBatchQuote" TO lyraseo_deletion_owner;
  GRANT UPDATE(status,"errorCode") ON public."AgencyBatchItem" TO lyraseo_deletion_owner;
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION lyraseo_deletion.identity(text,text,integer) TO lyraseo_runtime;
REVOKE ALL ON FUNCTION lyraseo_deletion.accept_site(text,text,integer,uuid,uuid,uuid,uuid,bigint,text) FROM PUBLIC,lyraseo_runtime,lyraseo_artifact_maintenance;
GRANT EXECUTE ON FUNCTION lyraseo_deletion.status(text,text,uuid),lyraseo_deletion.sweep(text,text,uuid,integer) TO lyraseo_artifact_maintenance;
REVOKE ALL ON ALL TABLES IN SCHEMA lyraseo_deletion FROM PUBLIC,lyraseo_runtime,lyraseo_artifact_maintenance,lyraseo_dispatch,lyraseo_identity;
COMMIT;
