-- Local, explicitly enrolled legacy answer-field transition. No hosted qualification.
DO $$
DECLARE r record;
BEGIN
 SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname='lyraseo_legacy_visibility_owner';
 IF r IS NULL OR r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba=r.oid)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc f WHERE f.proowner=r.oid)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o' AND d.classid<>'pg_proc'::regclass)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 THEN RAISE EXCEPTION 'UNSAFE_LEGACY_VISIBILITY_OWNER'; END IF;
END $$;
-- Ordinary paths must not mutate a legacy run outside the fixed transition.
DO $$ DECLARE grantee text; BEGIN
 FOREACH grantee IN ARRAY ARRAY['lyraseo_runtime','lyraseo_artifact_maintenance','lyraseo_kernel_owner','lyraseo_expiry_owner'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=grantee) OR
     has_table_privilege(grantee,'public."VisibilityRun"','UPDATE,DELETE,TRUNCATE,TRIGGER') OR
     has_any_column_privilege(grantee,'public."VisibilityRun"','UPDATE') OR
     (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public."VisibilityRun"'::regclass)=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=grantee)
  THEN RAISE EXCEPTION 'UNSAFE_LEGACY_MUTATION_GRANT'; END IF;
 END LOOP;
END $$;
CREATE SCHEMA lyraseo_legacy_visibility;
REVOKE ALL ON SCHEMA lyraseo_legacy_visibility FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA lyraseo_legacy_visibility TO lyraseo_legacy_visibility_owner;
GRANT USAGE ON SCHEMA lyraseo_legacy_visibility TO lyraseo_artifact_maintenance,lyraseo_runtime;
GRANT USAGE ON SCHEMA public,lyraseo_kernel,lyraseo_observation TO lyraseo_legacy_visibility_owner;
GRANT EXECUTE ON FUNCTION lyraseo_observation.scope_guard(text,integer,text,boolean) TO lyraseo_legacy_visibility_owner;
GRANT SELECT(id,"securityVersion",suspended),UPDATE(id) ON public."ProductUser" TO lyraseo_legacy_visibility_owner;
GRANT SELECT("workspaceId","userId",role),UPDATE("userId") ON public."Membership" TO lyraseo_legacy_visibility_owner;
GRANT SELECT("workspaceId","siteId","userId"),UPDATE("userId") ON public."SiteGrant" TO lyraseo_legacy_visibility_owner;
CREATE POLICY legacy_identity_lock ON public."ProductUser" TO lyraseo_legacy_visibility_owner USING(true) WITH CHECK(false);
CREATE POLICY legacy_member_lock ON public."Membership" TO lyraseo_legacy_visibility_owner USING(true) WITH CHECK(false);
CREATE POLICY legacy_grant_lock ON public."SiteGrant" TO lyraseo_legacy_visibility_owner USING(true) WITH CHECK(false);
REVOKE SELECT ON public."VisibilityRun" FROM lyraseo_runtime;
REVOKE SELECT("rawAnswers",provenance,slots,cohort) ON public."VisibilityRun" FROM lyraseo_runtime;
GRANT SELECT(id,"workspaceId","siteId","panelId",profile,"rawExpiresAt","createdAt","resultExpiresAt","storageFormat") ON public."VisibilityRun" TO lyraseo_runtime;
CREATE POLICY legacy_environment ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_legacy_visibility_owner USING (true);
GRANT SELECT ON lyraseo_kernel.test_environment TO lyraseo_legacy_visibility_owner;
GRANT EXECUTE ON FUNCTION lyraseo_kernel.is_test_database() TO lyraseo_legacy_visibility_owner;
CREATE TABLE lyraseo_legacy_visibility.scope (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, site_id text NOT NULL,
 database_oid oid NOT NULL, postmaster_started_at timestamptz NOT NULL,
 policy text NOT NULL DEFAULT 'LEGACY_STORED_DEADLINE_V1', enrolled_by text NOT NULL DEFAULT session_user, enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,site_id)
);
CREATE TABLE lyraseo_legacy_visibility.enrollment (
 scope_id uuid NOT NULL, run_id text NOT NULL, panel_id text NOT NULL, original_deadline timestamp(3) NOT NULL,
 row_hash text NOT NULL, enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,run_id)
);
CREATE TABLE lyraseo_legacy_visibility.plan (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_id uuid NOT NULL, manifest_hash text NOT NULL,
 paused boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE lyraseo_legacy_visibility.item (
 plan_id uuid NOT NULL, run_id text NOT NULL, row_hash text NOT NULL, PRIMARY KEY(plan_id,run_id)
);
-- Optional admin-only test clock affects eligibility in owned local fixtures only.
CREATE TABLE lyraseo_legacy_visibility.fixture_clock (
 scope_id uuid PRIMARY KEY, database_oid oid NOT NULL, postmaster_started_at timestamptz NOT NULL,
 eligibility_at timestamp(3) NOT NULL, provenance text NOT NULL CHECK(provenance='ADMIN_LOCAL_FIXTURE_V1')
);
CREATE TABLE lyraseo_legacy_visibility.retry (
 scope_id uuid NOT NULL, run_id text NOT NULL, attempts integer NOT NULL, next_retry_at timestamptz NOT NULL,
 PRIMARY KEY(scope_id,run_id)
);
CREATE TABLE lyraseo_legacy_visibility.authorization (
 transaction_id bigint NOT NULL, scope_id uuid NOT NULL, run_id text NOT NULL, plan_id uuid NOT NULL, plan_hash text NOT NULL, actor text NOT NULL, old_hash text NOT NULL,
 consumed boolean NOT NULL DEFAULT false, PRIMARY KEY(transaction_id,run_id)
);
CREATE TABLE lyraseo_legacy_visibility.event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_id uuid NOT NULL, plan_id uuid NOT NULL, run_id text NOT NULL,
 panel_id text NOT NULL, policy text NOT NULL, original_deadline timestamp(3) NOT NULL,
 database_oid oid NOT NULL, postmaster_started_at timestamptz NOT NULL, actor text NOT NULL,
 decided_at timestamptz NOT NULL, eligibility_at timestamp(3) NOT NULL, eligibility_clock text NOT NULL, plan_hash text NOT NULL, before_row_hash text NOT NULL,
 before_raw_hash text NOT NULL, before_raw_length bigint NOT NULL, after_raw_hash text NOT NULL,
 before_protected_hash text NOT NULL, after_protected_hash text NOT NULL, hash_contract text NOT NULL,
 UNIQUE(scope_id,run_id)
);
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['scope','enrollment','plan','item','retry','authorization','event','fixture_clock'] LOOP
 EXECUTE format('ALTER TABLE lyraseo_legacy_visibility.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE lyraseo_legacy_visibility.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY purpose_owner ON lyraseo_legacy_visibility.%I TO lyraseo_legacy_visibility_owner USING (true) WITH CHECK (true)',n);
 EXECUTE format('REVOKE ALL ON lyraseo_legacy_visibility.%I FROM PUBLIC,lyraseo_artifact_maintenance,lyraseo_runtime',n);
END LOOP; END $$;
GRANT SELECT,INSERT ON lyraseo_legacy_visibility.scope,lyraseo_legacy_visibility.enrollment,lyraseo_legacy_visibility.plan,lyraseo_legacy_visibility.item,lyraseo_legacy_visibility.retry,lyraseo_legacy_visibility.authorization,lyraseo_legacy_visibility.event TO lyraseo_legacy_visibility_owner;
GRANT SELECT ON lyraseo_legacy_visibility.fixture_clock TO lyraseo_legacy_visibility_owner;
GRANT UPDATE(paused) ON lyraseo_legacy_visibility.plan TO lyraseo_legacy_visibility_owner;
GRANT UPDATE(consumed) ON lyraseo_legacy_visibility.authorization TO lyraseo_legacy_visibility_owner;
GRANT UPDATE(attempts,next_retry_at) ON lyraseo_legacy_visibility.retry TO lyraseo_legacy_visibility_owner;
CREATE POLICY legacy_scope_workspace ON public."Workspace" TO lyraseo_legacy_visibility_owner USING (true) WITH CHECK (false);
CREATE POLICY legacy_scope_site ON public."Site" TO lyraseo_legacy_visibility_owner USING (true) WITH CHECK (false);
CREATE POLICY legacy_scope_run ON public."VisibilityRun" TO lyraseo_legacy_visibility_owner USING (true) WITH CHECK (true);
CREATE POLICY legacy_scope_panel ON public."VisibilityPanel" FOR SELECT TO lyraseo_legacy_visibility_owner USING (true);
GRANT DELETE ON lyraseo_legacy_visibility.retry TO lyraseo_legacy_visibility_owner;
GRANT SELECT ON public."Workspace",public."Site",public."VisibilityRun",public."VisibilityPanel" TO lyraseo_legacy_visibility_owner;
GRANT UPDATE(id) ON public."Workspace",public."Site" TO lyraseo_legacy_visibility_owner;
GRANT UPDATE("rawAnswers") ON public."VisibilityRun" TO lyraseo_legacy_visibility_owner;

-- Hashes describe PostgreSQL's UTF-8 jsonb text, not provider wire bytes.
CREATE FUNCTION lyraseo_legacy_visibility.hash_json(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('LEGACY_JSONB_PG17_V1:', 'UTF8') || CASE WHEN v IS NULL THEN convert_to('SQLNULL','UTF8') ELSE convert_to('JSONB','UTF8') || int8send(octet_length(convert_to(v::text,'UTF8'))::bigint) || convert_to(v::text,'UTF8') END),'hex')
$$;
CREATE FUNCTION lyraseo_legacy_visibility.bounded_row(r public."VisibilityRun") RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF r.id IS NULL OR octet_length(r.id)>256 OR octet_length(r."workspaceId")>256 OR octet_length(r."siteId")>256 OR octet_length(r."panelId")>256 OR octet_length(r.profile)>128 OR octet_length(r.cohort)>256 THEN RETURN false; END IF;
 IF coalesce(pg_column_size(r."rawAnswers"),0)>1048576 OR pg_column_size(r.slots)>1048576 OR pg_column_size(r.provenance)>65536 THEN RETURN false; END IF;
 IF coalesce(octet_length(r."rawAnswers"::text),0)>1048576 OR octet_length(r.slots::text)>1048576 OR octet_length(r.provenance::text)>65536 THEN RETURN false; END IF;
 RETURN true;
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.scope_id(w text,s text) RETURNS uuid LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE x uuid;
BEGIN
 IF w IS NULL OR s IS NULL OR octet_length(w) NOT BETWEEN 1 AND 256 OR octet_length(s) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 IF (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000 THEN RAISE EXCEPTION 'LEGACY_TIMEOUT_REQUIRED'; END IF;
 IF session_user <> 'lyraseo_artifact_maintenance' OR current_database() !~ '^lyraseo_legacy_[a-f0-9]{12}$' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 OR NOT lyraseo_kernel.is_test_database() THEN RAISE EXCEPTION 'LEGACY_FORBIDDEN'; END IF;
 SELECT id INTO x FROM lyraseo_legacy_visibility.scope WHERE workspace_id=w AND site_id=s
 AND database_oid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
 AND postmaster_started_at=pg_catalog.pg_postmaster_start_time() AND policy='LEGACY_STORED_DEADLINE_V1';
 IF x IS NULL THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 RETURN x;
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.enroll_scope(w text,s text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x uuid;
BEGIN
 IF w IS NULL OR s IS NULL OR octet_length(w) NOT BETWEEN 1 AND 256 OR octet_length(s) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 IF session_user <> 'postgres' OR current_database() !~ '^lyraseo_legacy_[a-f0-9]{12}$' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 OR NOT lyraseo_kernel.is_test_database() THEN RAISE EXCEPTION 'LEGACY_FORBIDDEN'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 PERFORM 1 FROM public."Site" WHERE "workspaceId"=w AND id=s FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 INSERT INTO lyraseo_legacy_visibility.scope(workspace_id,site_id,database_oid,postmaster_started_at)
 VALUES(w,s,(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()),pg_catalog.pg_postmaster_start_time()) RETURNING id INTO x;
 RETURN x;
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.enroll_row(w text,s text,rid text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x uuid; r public."VisibilityRun";
BEGIN
 IF w IS NULL OR s IS NULL OR octet_length(w) NOT BETWEEN 1 AND 256 OR octet_length(s) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 IF session_user <> 'postgres' OR current_database() !~ '^lyraseo_legacy_[a-f0-9]{12}$' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 OR NOT lyraseo_kernel.is_test_database() THEN RAISE EXCEPTION 'LEGACY_FORBIDDEN'; END IF;
 IF rid IS NULL OR octet_length(rid)>256 THEN RAISE EXCEPTION 'LEGACY_ROW_OVERSIZE'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 PERFORM 1 FROM public."Site" WHERE "workspaceId"=w AND id=s FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 SELECT id INTO x FROM lyraseo_legacy_visibility.scope WHERE workspace_id=w AND site_id=s AND database_oid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) AND postmaster_started_at=pg_catalog.pg_postmaster_start_time();
 IF x IS NULL THEN RAISE EXCEPTION 'LEGACY_SCOPE_INVALID'; END IF;
 SELECT * INTO r FROM public."VisibilityRun" WHERE "workspaceId"=w AND "siteId"=s AND id=rid FOR UPDATE;
 IF NOT FOUND OR r."storageFormat" IS NOT NULL THEN RAISE EXCEPTION 'LEGACY_ROW_INVALID'; END IF;
 IF NOT lyraseo_legacy_visibility.bounded_row(r) THEN RAISE EXCEPTION 'LEGACY_ROW_OVERSIZE'; END IF;
 INSERT INTO lyraseo_legacy_visibility.enrollment(scope_id,run_id,panel_id,original_deadline,row_hash)
 VALUES(x,r.id,r."panelId",r."rawExpiresAt",lyraseo_legacy_visibility.hash_json(to_jsonb(r)));
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.classify(r public."VisibilityRun",p public."VisibilityPanel") RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE o timestamptz; rights timestamptz; obs text; rt text; a jsonb; b jsonb; z jsonb; e jsonb; k text; i integer; n integer;
BEGIN
 IF r."storageFormat" IS NOT NULL THEN RETURN 'private'; END IF;
 IF NOT lyraseo_legacy_visibility.bounded_row(r) THEN RETURN 'blocked-size'; END IF;
 IF r."rawAnswers" IS NULL THEN RETURN 'not-retained-unverified'; END IF;
 IF jsonb_typeof(r."rawAnswers") IS DISTINCT FROM 'array' THEN RETURN 'blocked-raw-shape'; END IF;
 IF octet_length(r."rawAnswers"::text)>1048576 OR octet_length(r.slots::text)>1048576 OR octet_length(r.provenance::text)>65536 OR octet_length(p.prompts::text)>65536 OR octet_length(p.brands::text)>65536 THEN RETURN 'blocked-size'; END IF;
 IF pg_column_size(r.slots)>1048576 OR octet_length(r.slots::text)>1048576 OR pg_column_size(p.prompts)>65536 OR pg_column_size(p.brands)>65536 THEN RETURN 'blocked-size';
 ELSIF jsonb_typeof(r.slots) IS DISTINCT FROM 'array' OR jsonb_typeof(p.prompts) IS DISTINCT FROM 'array' OR jsonb_typeof(p.brands) IS DISTINCT FROM 'array' OR jsonb_typeof(r.provenance) IS DISTINCT FROM 'object' THEN RETURN 'blocked-shape'; END IF;
 n:=jsonb_array_length(r."rawAnswers");
 IF n<1 OR n>100 OR n<>jsonb_array_length(r.slots) OR n<>jsonb_array_length(p.prompts) THEN RETURN 'blocked-count'; END IF;
 IF r."panelId" IS DISTINCT FROM p.id OR (r."workspaceId",r."siteId") IS DISTINCT FROM (p."workspaceId",p."siteId") OR p."reviewedAt" IS NULL OR NOT isfinite(r."createdAt") OR NOT isfinite(r."rawExpiresAt") THEN RETURN 'blocked-clock'; END IF;
 IF r.profile NOT IN ('azure-sol-api','consumer-chatgpt','consumer-gemini') OR r.provenance->>'profile' IS DISTINCT FROM r.profile OR r.provenance->>'provider' IS DISTINCT FROM (CASE WHEN r.profile='azure-sol-api' THEN 'azure' ELSE 'dataforseo' END) OR jsonb_typeof(r.provenance->'synthetic') IS DISTINCT FROM 'boolean' OR r.provenance->'rawAnswerRights' IS DISTINCT FROM 'true'::jsonb OR r.provenance->>'extractionVersion' IS DISTINCT FROM 'unicode-phrase-v1' OR r.provenance->'requestedLocale' IS DISTINCT FROM '{"language":"en","market":"IN"}'::jsonb OR jsonb_typeof(r.provenance->'confirmedLocale') IS DISTINCT FROM 'object' OR r.cohort !~ '^[a-f0-9]{64}$' THEN RETURN 'blocked-provenance'; END IF;
 FOR k IN SELECT jsonb_object_keys(r.provenance) LOOP
  IF k NOT IN ('profile','provider','model','modelVersion','retrievalMode','observedAt','synthetic','rawAnswerRights','rawRightsUntil','requestedLocale','confirmedLocale','extractionVersion','clockContract','representation','producerClass') THEN RETURN 'blocked-provenance'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['model','modelVersion','retrievalMode'] LOOP IF jsonb_typeof(r.provenance->k) IS DISTINCT FROM 'string' OR length(r.provenance->>k) NOT BETWEEN 1 AND 128 THEN RETURN 'blocked-provenance'; END IF; END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(r.provenance->'confirmedLocale') q WHERE q NOT IN ('language','market')) OR coalesce(jsonb_typeof(r.provenance->'confirmedLocale'->'language'),'missing') NOT IN ('string','null') OR coalesce(jsonb_typeof(r.provenance->'confirmedLocale'->'market'),'missing') NOT IN ('string','null') THEN RETURN 'blocked-provenance'; END IF;
 FOREACH k IN ARRAY ARRAY['clockContract','representation','producerClass'] LOOP IF r.provenance ? k AND (jsonb_typeof(r.provenance->k) IS DISTINCT FROM 'string' OR length(r.provenance->>k)>128) THEN RETURN 'blocked-provenance'; END IF; END LOOP;
 obs:=r.provenance->>'observedAt'; rt:=r.provenance->>'rawRightsUntil';
 IF jsonb_typeof(r.provenance->'observedAt') IS DISTINCT FROM 'string' OR obs !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' THEN RETURN 'blocked-clock'; END IF;
 IF r.provenance ? 'rawRightsUntil' AND (jsonb_typeof(r.provenance->'rawRightsUntil') IS DISTINCT FROM 'string' OR rt !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$') THEN RETURN 'blocked-clock'; END IF;
 BEGIN o:=obs::timestamptz; IF rt IS NOT NULL THEN rights:=rt::timestamptz; END IF; EXCEPTION WHEN OTHERS THEN RETURN 'blocked-clock'; END;
 IF (o AT TIME ZONE 'UTC') IS DISTINCT FROM r."createdAt" OR o>clock_timestamp() OR r."rawExpiresAt">(o AT TIME ZONE 'UTC')+interval '90 days' OR (rights IS NOT NULL AND r."rawExpiresAt">(rights AT TIME ZONE 'UTC')) THEN RETURN 'blocked-clock'; END IF;
 FOR i IN 0..n-1 LOOP
  a:=r."rawAnswers"->i; b:=r.slots->i;
  IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RETURN 'blocked-slot'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(a) q WHERE q NOT IN ('promptId','state','body','annotations','providerTaskId','completedAt','failureReason')) OR EXISTS(SELECT 1 FROM jsonb_object_keys(b) q WHERE q NOT IN ('promptId','state','providerTaskId','completedAt','failureReason','extraction')) THEN RETURN 'blocked-slot'; END IF;
  IF jsonb_typeof(a->'promptId') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'state') IS DISTINCT FROM 'string' OR length(a->>'promptId') NOT BETWEEN 1 AND 256 OR jsonb_typeof(a->'providerTaskId') IS DISTINCT FROM 'string' OR length(a->>'providerTaskId') NOT BETWEEN 1 AND 256 OR jsonb_typeof(a->'completedAt') IS DISTINCT FROM 'string' OR length(a->>'completedAt') NOT BETWEEN 1 AND 40 OR (a->>'state') NOT IN ('successful','ambiguous','failed','unsupported','no-answer') OR (a->>'promptId',a->>'state',a->>'providerTaskId',a->>'completedAt',a->>'failureReason') IS DISTINCT FROM (b->>'promptId',b->>'state',b->>'providerTaskId',b->>'completedAt',b->>'failureReason') THEN RETURN 'blocked-slot'; END IF;
  IF (a->>'completedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' THEN RETURN 'blocked-slot'; END IF;
  BEGIN PERFORM (a->>'completedAt')::timestamptz; EXCEPTION WHEN OTHERS THEN RETURN 'blocked-slot'; END;
  IF a ? 'failureReason' AND (jsonb_typeof(a->'failureReason') IS DISTINCT FROM 'string' OR length(a->>'failureReason')>256) THEN RETURN 'blocked-slot'; END IF;
  IF a ? 'body' AND (jsonb_typeof(a->'body') IS DISTINCT FROM 'string' OR length(a->>'body')>100000) THEN RETURN 'blocked-slot'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p.prompts) q WHERE q->>'id'=a->>'promptId')<>1 OR (SELECT count(*) FROM jsonb_array_elements(r."rawAnswers") q WHERE q->>'promptId'=a->>'promptId')<>1 THEN RETURN 'blocked-panel'; END IF;
  IF jsonb_typeof(a->'annotations') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'annotations')>256 OR jsonb_typeof(b->'extraction') IS DISTINCT FROM 'object' THEN RETURN 'blocked-slot'; END IF;
  IF a->>'state' IN ('successful','ambiguous') THEN
   IF jsonb_typeof(a->'body') IS DISTINCT FROM 'string' OR length(btrim(a->>'body'))=0 OR length(a->>'body')>100000 OR (r.profile<>'azure-sol-api' AND r.provenance->'confirmedLocale' IS DISTINCT FROM '{"language":"en","market":"IN"}'::jsonb) THEN RETURN 'blocked-slot'; END IF;
  ELSE
   IF jsonb_typeof(a->'failureReason') IS DISTINCT FROM 'string' OR length(a->>'failureReason') NOT BETWEEN 1 AND 256 OR b->'extraction' <> '{}'::jsonb THEN RETURN 'blocked-slot'; END IF;
  END IF;
  FOR z IN SELECT value FROM jsonb_array_elements(a->'annotations') LOOP
   IF jsonb_typeof(z) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(z) q WHERE q NOT IN ('url','start','end')) OR jsonb_typeof(z->'url') IS DISTINCT FROM 'string' OR length(z->>'url')>2048 OR jsonb_typeof(z->'start') IS DISTINCT FROM 'number' OR jsonb_typeof(z->'end') IS DISTINCT FROM 'number' OR (z->>'start') !~ '^(0|[1-9][0-9]{0,7})$' OR (z->>'end') !~ '^(0|[1-9][0-9]{0,7})$' THEN RETURN 'blocked-annotation'; END IF;
   IF (z->>'end')::integer <= (z->>'start')::integer THEN RETURN 'blocked-annotation'; END IF;
  END LOOP;
  FOR k,e IN SELECT key,value FROM jsonb_each(b->'extraction') LOOP
   IF (SELECT count(*) FROM jsonb_array_elements(p.brands) q WHERE q->>'id'=k)<>1 OR jsonb_typeof(e) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>4 OR EXISTS(SELECT 1 FROM jsonb_object_keys(e) q WHERE q NOT IN ('mention','citation','recommendation','reason')) OR jsonb_typeof(e->'mention') NOT IN ('boolean','null') OR jsonb_typeof(e->'citation') NOT IN ('boolean','null') OR jsonb_typeof(e->'recommendation') NOT IN ('boolean','null') OR (e->>'reason' IS NOT NULL AND e->>'reason' NOT IN ('Shared alias requires review','Recommendation requires evidence-based adjudication')) THEN RETURN 'blocked-extraction'; END IF;
  END LOOP;
  IF a->>'state' IN ('successful','ambiguous') AND (SELECT count(*) FROM jsonb_object_keys(b->'extraction'))<>jsonb_array_length(p.brands) THEN RETURN 'blocked-extraction'; END IF;
 END LOOP;
 RETURN 'valid';
EXCEPTION WHEN OTHERS THEN RETURN 'blocked-invalid';
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.guard_run() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE fenced boolean; a lyraseo_legacy_visibility.authorization;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW."storageFormat" IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM public."Workspace" WHERE id=NEW."workspaceId" FOR SHARE;
  PERFORM 1 FROM public."Site" WHERE "workspaceId"=NEW."workspaceId" AND id=NEW."siteId" FOR UPDATE;
  SELECT EXISTS(SELECT 1 FROM lyraseo_legacy_visibility.scope WHERE workspace_id=NEW."workspaceId" AND site_id=NEW."siteId") INTO fenced;
  IF fenced THEN RAISE EXCEPTION 'LEGACY_SCOPE_FENCED'; END IF;
  RETURN NEW;
 END IF;
 IF OLD."storageFormat" IS NOT NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 SELECT EXISTS(SELECT 1 FROM lyraseo_legacy_visibility.scope WHERE workspace_id=OLD."workspaceId" AND site_id=OLD."siteId") INTO fenced;
 IF NOT fenced THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LEGACY_SCOPE_FENCED'; END IF;
 SELECT * INTO a FROM lyraseo_legacy_visibility.authorization WHERE transaction_id=txid_current() AND run_id=OLD.id AND NOT consumed FOR UPDATE;
 IF a.run_id IS NULL OR a.actor IS DISTINCT FROM session_user OR NOT EXISTS(SELECT 1 FROM lyraseo_legacy_visibility.plan pl JOIN lyraseo_legacy_visibility.scope sc ON sc.id=pl.scope_id JOIN lyraseo_legacy_visibility.item i ON i.plan_id=pl.id AND i.run_id=OLD.id WHERE pl.id=a.plan_id AND pl.manifest_hash=a.plan_hash AND pl.scope_id=a.scope_id AND sc.workspace_id=OLD."workspaceId" AND sc.site_id=OLD."siteId" AND i.row_hash=a.old_hash AND NOT pl.paused) OR a.old_hash IS DISTINCT FROM lyraseo_legacy_visibility.hash_json(to_jsonb(OLD)) OR jsonb_typeof(OLD."rawAnswers") IS DISTINCT FROM 'array' OR NEW."rawAnswers" IS NOT NULL OR (to_jsonb(NEW)-ARRAY['rawAnswers','resultExpiresAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['rawAnswers','resultExpiresAt']) THEN RAISE EXCEPTION 'LEGACY_IMMUTABLE'; END IF;
 UPDATE lyraseo_legacy_visibility.authorization SET consumed=true WHERE transaction_id=a.transaction_id AND run_id=a.run_id;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_visibility_fence BEFORE INSERT OR UPDATE OR DELETE ON public."VisibilityRun" FOR EACH ROW EXECUTE FUNCTION lyraseo_legacy_visibility.guard_run();
CREATE FUNCTION lyraseo_legacy_visibility.verify_transition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e lyraseo_legacy_visibility.event; actual public."VisibilityRun"; a lyraseo_legacy_visibility.authorization;
BEGIN
 IF OLD."storageFormat" IS NOT NULL OR OLD."rawAnswers" IS NULL OR NEW."rawAnswers" IS NOT NULL THEN RETURN NULL; END IF;
 SELECT * INTO a FROM lyraseo_legacy_visibility.authorization WHERE transaction_id=txid_current() AND run_id=OLD.id AND consumed;
 IF a.run_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO e FROM lyraseo_legacy_visibility.event WHERE run_id=OLD.id AND plan_id=a.plan_id;
 SELECT * INTO actual FROM public."VisibilityRun" WHERE id=OLD.id;
 IF e.id IS NULL OR actual.id IS NULL OR actual."rawAnswers" IS NOT NULL OR (to_jsonb(actual)-'rawAnswers') IS DISTINCT FROM (to_jsonb(OLD)-'rawAnswers') OR e.before_row_hash IS DISTINCT FROM a.old_hash OR e.before_protected_hash IS DISTINCT FROM lyraseo_legacy_visibility.hash_json(to_jsonb(OLD)-'rawAnswers') OR e.after_protected_hash IS DISTINCT FROM lyraseo_legacy_visibility.hash_json(to_jsonb(actual)-'rawAnswers') THEN RAISE EXCEPTION 'LEGACY_TRANSITION_INCOMPLETE'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_visibility_verify AFTER UPDATE ON public."VisibilityRun" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lyraseo_legacy_visibility.verify_transition();
CREATE FUNCTION lyraseo_legacy_visibility.create_plan(w text,s text,ids text[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x uuid; r public."VisibilityRun"; en lyraseo_legacy_visibility.enrollment; rid text; manifest jsonb:='[]'::jsonb; h text; pid uuid;
BEGIN
 x:=lyraseo_legacy_visibility.scope_id(w,s);
 IF ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM unnest(ids) q WHERE q IS NULL OR length(q) NOT BETWEEN 1 AND 256) OR (SELECT count(DISTINCT q) FROM unnest(ids) q)<>cardinality(ids) THEN RAISE EXCEPTION 'LEGACY_MANIFEST_INVALID'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE;
 PERFORM 1 FROM public."Site" WHERE "workspaceId"=w AND id=s FOR UPDATE;
 FOR rid IN SELECT unnest(ids) ORDER BY 1 LOOP
  SELECT * INTO r FROM public."VisibilityRun" WHERE "workspaceId"=w AND "siteId"=s AND id=rid FOR UPDATE;
  SELECT * INTO en FROM lyraseo_legacy_visibility.enrollment WHERE scope_id=x AND run_id=rid;
  IF r.id IS NULL OR en.run_id IS NULL OR NOT lyraseo_legacy_visibility.bounded_row(r) OR en.row_hash IS DISTINCT FROM lyraseo_legacy_visibility.hash_json(to_jsonb(r)) THEN RAISE EXCEPTION 'LEGACY_SNAPSHOT_CHANGED'; END IF;
  manifest:=manifest || jsonb_build_array(jsonb_build_array(rid,en.row_hash));
 END LOOP;
 h:=lyraseo_legacy_visibility.hash_json(jsonb_build_array('LEGACY_PLAN_V1',x,w,s,manifest));
 INSERT INTO lyraseo_legacy_visibility.plan(scope_id,manifest_hash) VALUES(x,h) RETURNING id INTO pid;
 INSERT INTO lyraseo_legacy_visibility.item(plan_id,run_id,row_hash) SELECT pid,v->>0,v->>1 FROM jsonb_array_elements(manifest) v;
 RETURN jsonb_build_object('id',pid,'hash',h);
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.execute_one(w text,s text,pid uuid,h text,rid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x uuid; r public."VisibilityRun"; post public."VisibilityRun"; p public."VisibilityPanel"; pl lyraseo_legacy_visibility.plan; en lyraseo_legacy_visibility.enrollment; it lyraseo_legacy_visibility.item; ev lyraseo_legacy_visibility.event; c text; old_hash text; before_protected jsonb; after_protected jsonb; eligibility timestamp(3); clock_kind text;
BEGIN
 x:=lyraseo_legacy_visibility.scope_id(w,s);
 -- Scope and immutable plan identity are checked before every mutation or target lock.
 IF NOT EXISTS(SELECT 1 FROM lyraseo_legacy_visibility.plan WHERE id=pid AND scope_id=x AND manifest_hash=h) OR NOT EXISTS(SELECT 1 FROM lyraseo_legacy_visibility.item WHERE plan_id=pid AND run_id=rid) THEN RAISE EXCEPTION 'LEGACY_PLAN_INVALID'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE;
 PERFORM 1 FROM public."Site" WHERE "workspaceId"=w AND id=s FOR UPDATE;
 IF EXISTS(SELECT 1 FROM lyraseo_legacy_visibility.retry WHERE scope_id=x AND run_id=rid AND next_retry_at>clock_timestamp()) THEN RETURN jsonb_build_object('state','backoff'); END IF;
 SELECT * INTO r FROM public."VisibilityRun" WHERE "workspaceId"=w AND "siteId"=s AND id=rid FOR UPDATE SKIP LOCKED;
 SELECT * INTO pl FROM lyraseo_legacy_visibility.plan WHERE id=pid AND scope_id=x AND manifest_hash=h FOR SHARE;
 IF pl.id IS NULL OR pl.paused THEN RAISE EXCEPTION 'LEGACY_PLAN_PAUSED'; END IF;
 IF r.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM public."VisibilityRun" WHERE "workspaceId"=w AND "siteId"=s AND id=rid) THEN
   INSERT INTO lyraseo_legacy_visibility.retry(scope_id,run_id,attempts,next_retry_at) VALUES(x,rid,1,clock_timestamp()+interval '2 seconds')
   ON CONFLICT(scope_id,run_id) DO UPDATE SET attempts=least(lyraseo_legacy_visibility.retry.attempts+1,8), next_retry_at=clock_timestamp()+make_interval(secs=>least(300,power(2,least(lyraseo_legacy_visibility.retry.attempts+1,8))::integer));
   RETURN jsonb_build_object('state','busy');
  END IF;
  RETURN jsonb_build_object('state','blocked-missing');
 END IF;
 SELECT * INTO it FROM lyraseo_legacy_visibility.item WHERE plan_id=pid AND run_id=rid;
 SELECT * INTO en FROM lyraseo_legacy_visibility.enrollment WHERE scope_id=x AND run_id=rid;
 SELECT * INTO ev FROM lyraseo_legacy_visibility.event WHERE scope_id=x AND run_id=rid;
 IF NOT lyraseo_legacy_visibility.bounded_row(r) THEN RETURN jsonb_build_object('state','blocked-size'); END IF;
 IF ev.id IS NOT NULL AND r.id IS NOT NULL AND r."rawAnswers" IS NULL AND ev.before_row_hash=en.row_hash AND ev.after_protected_hash=lyraseo_legacy_visibility.hash_json(to_jsonb(r)-'rawAnswers') THEN RETURN jsonb_build_object('state','erased'); END IF;
 IF r.id IS NULL OR it.run_id IS NULL OR en.run_id IS NULL OR it.row_hash IS DISTINCT FROM en.row_hash OR en.row_hash IS DISTINCT FROM lyraseo_legacy_visibility.hash_json(to_jsonb(r)) OR en.original_deadline IS DISTINCT FROM r."rawExpiresAt" OR en.panel_id IS DISTINCT FROM r."panelId" THEN RETURN jsonb_build_object('state','blocked-snapshot'); END IF;
 SELECT * INTO p FROM public."VisibilityPanel" WHERE ("workspaceId","siteId",id)=(w,s,r."panelId");
 c:=lyraseo_legacy_visibility.classify(r,p);
 IF c<>'valid' THEN RETURN jsonb_build_object('state',c); END IF;
 SELECT eligibility_at INTO eligibility FROM lyraseo_legacy_visibility.fixture_clock WHERE scope_id=x AND database_oid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) AND postmaster_started_at=pg_catalog.pg_postmaster_start_time() AND provenance='ADMIN_LOCAL_FIXTURE_V1';
 IF FOUND THEN clock_kind:='ADMIN_LOCAL_FIXTURE_V1'; ELSE eligibility:=clock_timestamp() AT TIME ZONE 'UTC'; clock_kind:='DATABASE_CLOCK_V1'; END IF;
 IF r."rawExpiresAt">eligibility THEN RETURN jsonb_build_object('state','not-due'); END IF;
 old_hash:=lyraseo_legacy_visibility.hash_json(to_jsonb(r)); before_protected:=to_jsonb(r)-'rawAnswers';
 INSERT INTO lyraseo_legacy_visibility.authorization(transaction_id,scope_id,run_id,plan_id,plan_hash,actor,old_hash) VALUES(txid_current(),x,rid,pid,h,session_user,old_hash);
 UPDATE public."VisibilityRun" SET "rawAnswers"=NULL WHERE id=rid AND "workspaceId"=w AND "siteId"=s;
 SELECT * INTO post FROM public."VisibilityRun" WHERE id=rid AND "workspaceId"=w AND "siteId"=s;
 after_protected:=to_jsonb(post)-'rawAnswers';
 IF post.id IS NULL OR post."rawAnswers" IS NOT NULL OR after_protected IS DISTINCT FROM before_protected OR NOT EXISTS(SELECT 1 FROM lyraseo_legacy_visibility.authorization WHERE transaction_id=txid_current() AND run_id=rid AND plan_id=pid AND consumed) THEN RAISE EXCEPTION 'LEGACY_POSTIMAGE_INVALID'; END IF;
 INSERT INTO lyraseo_legacy_visibility.event(scope_id,plan_id,run_id,panel_id,policy,original_deadline,database_oid,postmaster_started_at,actor,decided_at,eligibility_at,eligibility_clock,plan_hash,before_row_hash,before_raw_hash,before_raw_length,after_raw_hash,before_protected_hash,after_protected_hash,hash_contract)
 VALUES(x,pid,rid,r."panelId",'LEGACY_STORED_DEADLINE_V1',r."rawExpiresAt",(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()),pg_catalog.pg_postmaster_start_time(),session_user,clock_timestamp(),eligibility,clock_kind,h,old_hash,lyraseo_legacy_visibility.hash_json(r."rawAnswers"),octet_length(convert_to(r."rawAnswers"::text,'UTF8')),lyraseo_legacy_visibility.hash_json(NULL),lyraseo_legacy_visibility.hash_json(before_protected),lyraseo_legacy_visibility.hash_json(after_protected),'LEGACY_JSONB_PG17_V1');
 DELETE FROM lyraseo_legacy_visibility.retry WHERE scope_id=x AND run_id=rid;
 RETURN jsonb_build_object('state','erased');
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.pause(w text,s text,pid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x uuid; pl lyraseo_legacy_visibility.plan;
BEGIN
 x:=lyraseo_legacy_visibility.scope_id(w,s);
 SELECT * INTO pl FROM lyraseo_legacy_visibility.plan WHERE id=pid AND scope_id=x AND manifest_hash=h FOR UPDATE;
 IF pl.id IS NULL THEN RAISE EXCEPTION 'LEGACY_PLAN_INVALID'; END IF;
 UPDATE lyraseo_legacy_visibility.plan SET paused=true WHERE id=pid;
 RETURN jsonb_build_object('paused',true);
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.preview(w text,s text,lim integer,cursor_ text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x uuid; q record; vals jsonb:='[]'::jsonb; state_ text; last_ text; n integer:=0; current_hash text;
BEGIN
 x:=lyraseo_legacy_visibility.scope_id(w,s);
 IF lim IS NULL OR lim NOT BETWEEN 1 AND 100 OR (cursor_ IS NOT NULL AND length(cursor_)>256) THEN RAISE EXCEPTION 'LEGACY_LIMIT_INVALID'; END IF;
 FOR q IN SELECT v AS run,p AS panel,e.row_hash AS enrolled_hash,ev.id AS event_id,ev.after_protected_hash AS event_protected FROM public."VisibilityRun" v LEFT JOIN public."VisibilityPanel" p ON (p."workspaceId",p."siteId",p.id)=(v."workspaceId",v."siteId",v."panelId") LEFT JOIN lyraseo_legacy_visibility.enrollment e ON e.scope_id=x AND e.run_id=v.id LEFT JOIN lyraseo_legacy_visibility.event ev ON ev.scope_id=x AND ev.run_id=v.id WHERE v."workspaceId"=w AND v."siteId"=s AND octet_length(v.id)<=256 AND (cursor_ IS NULL OR v.id>cursor_) ORDER BY v.id LIMIT lim LOOP
  IF NOT lyraseo_legacy_visibility.bounded_row(q.run) THEN
   vals:=vals || jsonb_build_array(jsonb_build_object('runId',(q.run).id,'rowHash',NULL,'state','blocked-size','otherFieldResidual','unclassified'));
   n:=n+1; last_:=(q.run).id; CONTINUE;
  END IF;
  current_hash:=lyraseo_legacy_visibility.hash_json(to_jsonb(q.run));
  IF q.event_id IS NOT NULL AND (q.run)."rawAnswers" IS NULL AND q.event_protected=lyraseo_legacy_visibility.hash_json(to_jsonb(q.run)-'rawAnswers') THEN state_:='erased';
  ELSIF q.enrolled_hash IS NULL THEN state_:='not-enrolled';
  ELSIF q.enrolled_hash IS DISTINCT FROM current_hash THEN state_:='blocked-snapshot';
  ELSE state_:=lyraseo_legacy_visibility.classify(q.run,q.panel); IF state_='valid' THEN IF (q.run)."rawExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN state_:='eligible'; ELSE state_:='not-due'; END IF; END IF; END IF;
  vals:=vals || jsonb_build_array(jsonb_build_object('runId',(q.run).id,'rowHash',current_hash,'state',state_,'otherFieldResidual','unclassified'));
  n:=n+1; last_:=(q.run).id;
 END LOOP;
 RETURN jsonb_build_object('items',vals,'nextCursor',CASE WHEN n=lim THEN last_ ELSE NULL END,'fenced',true,'policy','LEGACY_STORED_DEADLINE_V1','residualScope','other-fields-unclassified','oversizedIdentifiers',EXISTS(SELECT 1 FROM public."VisibilityRun" WHERE "workspaceId"=w AND "siteId"=s AND octet_length(id)>256));
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.status(w text,s text,pid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x uuid; pl lyraseo_legacy_visibility.plan; total integer; complete integer; waiting integer; unverified integer;
BEGIN
 x:=lyraseo_legacy_visibility.scope_id(w,s);
 SELECT * INTO pl FROM lyraseo_legacy_visibility.plan WHERE id=pid AND scope_id=x AND manifest_hash=h;
 IF pl.id IS NULL THEN RAISE EXCEPTION 'LEGACY_PLAN_INVALID'; END IF;
 SELECT count(*),count(*) FILTER(WHERE ev.id IS NOT NULL AND v.id IS NOT NULL AND v."rawAnswers" IS NULL AND ev.after_protected_hash=lyraseo_legacy_visibility.hash_json(to_jsonb(v)-'rawAnswers')),count(*) FILTER(WHERE retry.next_retry_at>clock_timestamp()),count(*) FILTER(WHERE ev.id IS NOT NULL AND (v.id IS NULL OR v."rawAnswers" IS NOT NULL OR ev.after_protected_hash IS DISTINCT FROM lyraseo_legacy_visibility.hash_json(to_jsonb(v)-'rawAnswers'))) INTO total,complete,waiting,unverified FROM lyraseo_legacy_visibility.item i LEFT JOIN lyraseo_legacy_visibility.event ev ON ev.scope_id=x AND ev.run_id=i.run_id LEFT JOIN public."VisibilityRun" v ON v."workspaceId"=w AND v."siteId"=s AND v.id=i.run_id LEFT JOIN lyraseo_legacy_visibility.retry retry ON retry.scope_id=x AND retry.run_id=i.run_id WHERE i.plan_id=pid;
 RETURN jsonb_build_object('paused',pl.paused,'total',total,'completed',complete,'backoff',waiting,'unverified',unverified,'unresolved',total-complete,'otherFieldResidual','unclassified');
END $$;
CREATE FUNCTION lyraseo_legacy_visibility.next_items(w text,s text,pid uuid,h text,lim integer,cursor_ text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x uuid; pl lyraseo_legacy_visibility.plan; ids jsonb; last_ text; n integer;
BEGIN
 x:=lyraseo_legacy_visibility.scope_id(w,s);
 IF lim IS NULL OR lim NOT BETWEEN 1 AND 100 OR (cursor_ IS NOT NULL AND length(cursor_)>256) THEN RAISE EXCEPTION 'LEGACY_LIMIT_INVALID'; END IF;
 SELECT * INTO pl FROM lyraseo_legacy_visibility.plan WHERE id=pid AND scope_id=x AND manifest_hash=h;
 IF pl.id IS NULL THEN RAISE EXCEPTION 'LEGACY_PLAN_INVALID'; END IF;
 SELECT coalesce(jsonb_agg(run_id ORDER BY run_id),'[]'::jsonb),max(run_id),count(*) INTO ids,last_,n FROM (SELECT i.run_id FROM lyraseo_legacy_visibility.item i LEFT JOIN lyraseo_legacy_visibility.event e ON e.scope_id=x AND e.run_id=i.run_id LEFT JOIN lyraseo_legacy_visibility.retry r ON r.scope_id=x AND r.run_id=i.run_id WHERE i.plan_id=pid AND e.id IS NULL AND (r.next_retry_at IS NULL OR r.next_retry_at<=clock_timestamp()) AND (cursor_ IS NULL OR i.run_id>cursor_) ORDER BY i.run_id LIMIT lim) q;
 RETURN jsonb_build_object('items',ids,'nextCursor',CASE WHEN n=lim THEN last_ ELSE NULL END,'paused',pl.paused);
END $$;
-- The authenticated application supplies Actor; GUCs are scope context, not identity proof.
-- Locks acquired by scope_guard and the target remain held until the outer transaction commits.
CREATE FUNCTION lyraseo_legacy_visibility.read_detail(s text,rid text,epoch integer,session_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."VisibilityRun"; p public."VisibilityPanel"; ev lyraseo_legacy_visibility.event; state_ text;
BEGIN
 PERFORM lyraseo_observation.scope_guard(s,epoch,session_,false);
 SELECT * INTO r FROM public."VisibilityRun" WHERE "workspaceId"=current_setting('app.workspace_id',true) AND "siteId"=s AND id=rid FOR SHARE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF r."resultExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN RETURN jsonb_build_object('state','result-expired'); END IF;
 IF r."storageFormat" IS NOT NULL THEN RETURN jsonb_build_object('state','private'); END IF;
 IF NOT lyraseo_legacy_visibility.bounded_row(r) THEN RETURN jsonb_build_object('state','classification-blocked','rawAnswers',NULL,'otherFieldResidual','unclassified'); END IF;
 IF r."rawAnswers" IS NULL THEN
  SELECT e.* INTO ev FROM lyraseo_legacy_visibility.event e JOIN lyraseo_legacy_visibility.scope sc ON sc.id=e.scope_id WHERE e.run_id=rid AND sc.workspace_id=r."workspaceId" AND sc.site_id=s;
  IF ev.id IS NOT NULL AND ev.after_protected_hash=lyraseo_legacy_visibility.hash_json(to_jsonb(r)-'rawAnswers') THEN state_:='raw-erased'; ELSE state_:='not-retained-unverified'; END IF;
  RETURN jsonb_build_object('state',state_,'rawAnswers',NULL,'otherFieldResidual','unclassified');
 END IF;
 SELECT * INTO p FROM public."VisibilityPanel" WHERE ("workspaceId","siteId",id)=(r."workspaceId",s,r."panelId");
 state_:=lyraseo_legacy_visibility.classify(r,p);
 IF state_<>'valid' THEN RETURN jsonb_build_object('state','classification-blocked','rawAnswers',NULL,'otherFieldResidual','unclassified'); END IF;
 IF r."rawExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN RETURN jsonb_build_object('state','raw-expired','rawAnswers',NULL,'otherFieldResidual','unclassified'); END IF;
 RETURN jsonb_build_object('state','retained','rawAnswers',r."rawAnswers",'representation','parsed-legacy-json','originalProviderWire',false,'otherFieldResidual','unclassified');
END $$;
-- Expose only measurement values and known provenance scalars: input-derived task
-- and failure strings can contain answers, including after rawAnswers is cleared.
CREATE FUNCTION lyraseo_legacy_visibility.read_projection(s text,rid text,epoch integer,session_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."VisibilityRun"; p public."VisibilityPanel"; a jsonb; v jsonb; k text; metric jsonb; ex jsonb; projected jsonb:='[]'::jsonb; safe boolean:=true; provider_ text;
BEGIN
 PERFORM lyraseo_observation.scope_guard(s,epoch,session_,false);
 SELECT * INTO r FROM public."VisibilityRun" WHERE "workspaceId"=current_setting('app.workspace_id',true) AND "siteId"=s AND id=rid FOR SHARE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF r."resultExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
 SELECT * INTO p FROM public."VisibilityPanel" WHERE ("workspaceId","siteId",id)=(r."workspaceId",s,r."panelId");
 IF r.provenance->>'provider' IN ('azure','dataforseo') THEN provider_:=r.provenance->>'provider'; ELSE provider_:='Unclassified'; END IF;
 IF pg_column_size(r.slots)>1048576 OR octet_length(r.slots::text)>1048576 OR pg_column_size(p.prompts)>65536 OR pg_column_size(p.brands)>65536 THEN safe:=false;
 ELSIF jsonb_typeof(r.slots) IS DISTINCT FROM 'array' OR jsonb_typeof(p.prompts) IS DISTINCT FROM 'array' OR jsonb_typeof(p.brands) IS DISTINCT FROM 'array' THEN safe:=false;
 ELSIF jsonb_array_length(r.slots)>100 OR jsonb_array_length(r.slots)<>jsonb_array_length(p.prompts) THEN safe:=false;
 ELSE
  FOR a IN SELECT value FROM jsonb_array_elements(r.slots) LOOP
   IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR jsonb_typeof(a->'promptId') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'state') IS DISTINCT FROM 'string' OR (SELECT count(*) FROM jsonb_array_elements(p.prompts) q WHERE q->>'id'=a->>'promptId')<>1 OR (SELECT count(*) FROM jsonb_array_elements(r.slots) q WHERE q->>'promptId'=a->>'promptId')<>1 OR a->>'state' NOT IN ('successful','ambiguous','failed','unsupported','no-answer') OR jsonb_typeof(a->'extraction') IS DISTINCT FROM 'object' THEN safe:=false; EXIT; END IF;
   ex:='{}'::jsonb;
   FOR k,v IN SELECT key,value FROM jsonb_each(a->'extraction') LOOP
    IF (SELECT count(*) FROM jsonb_array_elements(p.brands) q WHERE q->>'id'=k)<>1 OR jsonb_typeof(v) IS DISTINCT FROM 'object' THEN safe:=false; EXIT; END IF;
    IF coalesce(jsonb_typeof(v->'mention'),'missing') NOT IN ('boolean','null') OR coalesce(jsonb_typeof(v->'citation'),'missing') NOT IN ('boolean','null') OR coalesce(jsonb_typeof(v->'recommendation'),'missing') NOT IN ('boolean','null') THEN safe:=false; EXIT; END IF;
    metric:=jsonb_build_object('mention',CASE WHEN jsonb_typeof(v->'mention')='boolean' THEN v->'mention' ELSE 'null'::jsonb END,'citation',CASE WHEN jsonb_typeof(v->'citation')='boolean' THEN v->'citation' ELSE 'null'::jsonb END,'recommendation',CASE WHEN jsonb_typeof(v->'recommendation')='boolean' THEN v->'recommendation' ELSE 'null'::jsonb END,'reason',CASE WHEN v->>'reason' IN ('Shared alias requires review','Recommendation requires evidence-based adjudication') THEN v->>'reason' ELSE NULL END);
    ex:=ex || jsonb_build_object(k,metric);
   END LOOP;
   IF NOT safe OR (a->>'state' IN ('successful','ambiguous') AND (SELECT count(*) FROM jsonb_object_keys(a->'extraction'))<>jsonb_array_length(p.brands)) OR (a->>'state' NOT IN ('successful','ambiguous') AND a->'extraction'<>'{}'::jsonb) THEN safe:=false; EXIT; END IF;
   projected:=projected || jsonb_build_array(jsonb_build_object('promptId',a->>'promptId','state',a->>'state','extraction',ex));
  END LOOP;
 END IF;
 RETURN jsonb_build_object('cohort',CASE WHEN octet_length(r.cohort)=64 THEN CASE WHEN r.cohort ~ '^[a-f0-9]{64}$' THEN r.cohort ELSE NULL END ELSE NULL END,'measurementSafe',safe,'slots',CASE WHEN safe THEN projected ELSE '[]'::jsonb END,'provenance',jsonb_build_object('profile',r.profile,'provider',provider_,'model','Withheld','synthetic',CASE WHEN jsonb_typeof(r.provenance->'synthetic')='boolean' THEN r.provenance->'synthetic' ELSE 'null'::jsonb END,'extractionVersion',CASE WHEN r.provenance->>'extractionVersion'='unicode-phrase-v1' THEN 'unicode-phrase-v1' ELSE NULL END));
END $$;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lyraseo_legacy_visibility' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_legacy_visibility_owner',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION lyraseo_legacy_visibility.enroll_scope(text,text),lyraseo_legacy_visibility.enroll_row(text,text,text) TO postgres;
GRANT EXECUTE ON FUNCTION lyraseo_legacy_visibility.create_plan(text,text,text[]),lyraseo_legacy_visibility.execute_one(text,text,uuid,text,text),lyraseo_legacy_visibility.pause(text,text,uuid,text) TO lyraseo_artifact_maintenance;
REVOKE CREATE ON SCHEMA lyraseo_legacy_visibility FROM lyraseo_legacy_visibility_owner;


GRANT EXECUTE ON FUNCTION lyraseo_legacy_visibility.preview(text,text,integer,text),lyraseo_legacy_visibility.status(text,text,uuid,text),lyraseo_legacy_visibility.next_items(text,text,uuid,text,integer,text) TO lyraseo_artifact_maintenance;
GRANT EXECUTE ON FUNCTION lyraseo_legacy_visibility.read_detail(text,text,integer,text) TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_legacy_visibility.read_projection(text,text,integer,text) TO lyraseo_runtime;

DO $$ BEGIN
 IF has_column_privilege('lyraseo_runtime','public."VisibilityRun"','rawAnswers','SELECT') OR has_column_privilege('lyraseo_runtime','public."VisibilityRun"','slots','SELECT') OR has_column_privilege('lyraseo_runtime','public."VisibilityRun"','provenance','SELECT') OR has_column_privilege('lyraseo_runtime','public."VisibilityRun"','cohort','SELECT') OR has_table_privilege('lyraseo_artifact_maintenance','public."VisibilityRun"','SELECT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege('lyraseo_artifact_maintenance','public."VisibilityRun"','SELECT,UPDATE') THEN RAISE EXCEPTION 'UNSAFE_LEGACY_READ_GRANT'; END IF;
END $$;
