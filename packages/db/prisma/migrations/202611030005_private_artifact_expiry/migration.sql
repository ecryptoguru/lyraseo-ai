BEGIN;
-- Controlled LOCAL_TEST_ONLY expiry. Historical source and result clocks are untouched.
DO $$ DECLARE checked_role record; BEGIN
 FOR checked_role IN SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication
          FROM pg_roles WHERE rolname IN ('lyraseo_artifact_maintenance','lyraseo_expiry_owner') LOOP
  IF (checked_role.rolname='lyraseo_artifact_maintenance' AND NOT checked_role.rolcanlogin) OR
     (checked_role.rolname='lyraseo_expiry_owner' AND checked_role.rolcanlogin) OR checked_role.rolinherit OR checked_role.rolsuper OR
     checked_role.rolbypassrls OR checked_role.rolcreatedb OR checked_role.rolcreaterole OR checked_role.rolreplication THEN
   RAISE EXCEPTION 'UNSAFE_EXPIRY_ROLE';
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('lyraseo_artifact_maintenance','lyraseo_expiry_owner'))<>2 OR
    EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
           WHERE r.rolname IN ('lyraseo_artifact_maintenance','lyraseo_expiry_owner')) OR
    EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
           WHERE r.rolname IN ('lyraseo_artifact_maintenance','lyraseo_expiry_owner')) OR
    EXISTS(SELECT FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
           WHERE r.rolname IN ('lyraseo_artifact_maintenance','lyraseo_expiry_owner'))
 THEN RAISE EXCEPTION 'UNSAFE_EXPIRY_ROLE'; END IF;
END $$;

CREATE SCHEMA lyraseo_expiry;
REVOKE ALL ON SCHEMA lyraseo_expiry FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_expiry TO lyraseo_expiry_owner,lyraseo_artifact_maintenance;
GRANT USAGE ON SCHEMA lyraseo_origin,lyraseo_audit,lyraseo_kernel,lyraseo_observation,public TO lyraseo_expiry_owner;
CREATE POLICY expiry_read ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_expiry_owner USING(true);
GRANT SELECT ON lyraseo_kernel.test_environment TO lyraseo_expiry_owner;
GRANT EXECUTE ON FUNCTION lyraseo_kernel.is_test_database() TO lyraseo_expiry_owner;

CREATE TABLE lyraseo_expiry.environment (
 id uuid PRIMARY KEY, database_oid oid NOT NULL, postmaster_started_at timestamptz NOT NULL,
 maintenance_login text NOT NULL CHECK(maintenance_login='lyraseo_artifact_maintenance'),
 workspace_id text NOT NULL, site_id text NOT NULL, policy_version text NOT NULL CHECK(policy_version='P2B1_LOCAL_V1'),
 store_id uuid NOT NULL, namespace_id uuid NOT NULL, root_identity jsonb NOT NULL,
 enrollment_identity uuid NOT NULL UNIQUE, fixture_eligibility_at timestamp,
 fixture_provenance text CHECK(fixture_provenance IS NULL OR length(fixture_provenance) BETWEEN 16 AND 256),
 CHECK((fixture_eligibility_at IS NULL)=(fixture_provenance IS NULL)),
 UNIQUE(database_oid,postmaster_started_at,workspace_id,site_id)
);
CREATE TABLE lyraseo_expiry.absence_verifier (
 id uuid PRIMARY KEY, environment_id uuid NOT NULL REFERENCES lyraseo_expiry.environment(id),
 secret bytea NOT NULL CHECK(octet_length(secret)=32), database_oid oid NOT NULL,
 postmaster_started_at timestamptz NOT NULL
);
CREATE FUNCTION lyraseo_expiry.scope_allows(w text,s text DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT session_user='lyraseo_artifact_maintenance' AND lyraseo_kernel.is_test_database() AND EXISTS(
  SELECT FROM lyraseo_expiry.environment e WHERE e.workspace_id=w AND (s IS NULL OR e.site_id=s) AND
   e.maintenance_login=session_user AND e.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND
   e.postmaster_started_at=pg_postmaster_start_time() AND e.policy_version='P2B1_LOCAL_V1')
$$;
-- Enrollment is administrator-only. No maintenance login can inspect keys or fixture clocks.
ALTER TABLE lyraseo_expiry.environment ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_expiry.environment FORCE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_expiry.absence_verifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_expiry.absence_verifier FORCE ROW LEVEL SECURITY;
CREATE POLICY expiry_owner_read ON lyraseo_expiry.environment FOR SELECT TO lyraseo_expiry_owner USING(true);
CREATE POLICY expiry_owner_read ON lyraseo_expiry.absence_verifier FOR SELECT TO lyraseo_expiry_owner USING(true);
GRANT SELECT ON lyraseo_expiry.environment,lyraseo_expiry.absence_verifier TO lyraseo_expiry_owner;

CREATE TABLE public."ArtifactExpiryPlan" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "policyVersion" text NOT NULL CHECK("policyVersion"='P2B1_LOCAL_V1'),
 "workspaceId" text NOT NULL, "siteId" text NOT NULL, "environmentId" uuid NOT NULL,
 "databaseOid" oid NOT NULL, "postmasterStartedAt" timestamptz NOT NULL,
 "storeId" uuid NOT NULL, "namespaceId" uuid NOT NULL,
 "plannedAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "expiresAt" timestamptz NOT NULL,
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array' AND jsonb_array_length(manifest) BETWEEN 1 AND 100),
 "manifestHash" text NOT NULL CHECK("manifestHash" ~ '^[a-f0-9]{64}$'), paused boolean NOT NULL DEFAULT false,
 rotation integer NOT NULL DEFAULT 0 CHECK(rotation BETWEEN 0 AND 3),
 "classCursors" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof("classCursors")='object' AND "classCursors"-ARRAY['BLOB','PENDING_RECEIPT','SCRATCH','UNAVAILABLE']='{}'::jsonb),
 FOREIGN KEY("environmentId") REFERENCES lyraseo_expiry.environment(id)
);
CREATE TABLE public."ArtifactExpiryItem" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), class text NOT NULL CHECK(class IN ('BLOB','PENDING_RECEIPT','SCRATCH','UNAVAILABLE')),
 "logicalKey" text NOT NULL UNIQUE, "workspaceId" text NOT NULL, "siteId" text NOT NULL,
 "blobId" uuid, generation uuid, "ownerKind" text,
 deadline timestamp NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 origin text, version jsonb, "currentPlanId" uuid NOT NULL REFERENCES public."ArtifactExpiryPlan"(id),
 status text NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','CLAIMED','PENDING','COMPLETE')),
 "attemptSequence" bigint NOT NULL DEFAULT 0, token uuid, "workerTokenHash" text CHECK("workerTokenHash" ~ '^[a-f0-9]{64}$'), "leaseUntil" timestamptz,
 "nextRetryAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "completedAt" timestamptz,
 CHECK((class='BLOB')=("blobId" IS NOT NULL AND generation IS NOT NULL AND origin IS NOT NULL AND version IS NOT NULL)),
 CHECK((token IS NULL)=("leaseUntil" IS NULL) AND (token IS NULL)=("workerTokenHash" IS NULL)),
 CHECK(class<>'BLOB' OR "ownerKind" IN ('AUDIT_PAGE','VISIBILITY_SLOT'))
);
CREATE UNIQUE INDEX expiry_physical_carrier ON public."ArtifactExpiryItem"("blobId",generation) WHERE class='BLOB';
CREATE INDEX ON public."ArtifactExpiryItem"(status,"nextRetryAt",id);
CREATE INDEX ON public."ArtifactExpiryItem"("workspaceId","siteId",class,deadline,id);
CREATE TABLE public."ArtifactExpiryEvent" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "planId" uuid NOT NULL REFERENCES public."ArtifactExpiryPlan"(id),
 "itemId" uuid NOT NULL REFERENCES public."ArtifactExpiryItem"(id),
 sequence bigint NOT NULL, token uuid, outcome text NOT NULL CHECK(outcome IN ('CLAIMED','PENDING','COMPLETE','TRANSFERRED','RECONCILED')),
 reason text NOT NULL CHECK(reason IN ('DUE','BACKEND_UNAVAILABLE','ABSENCE_UNCERTAIN','LEASE_EXPIRED','REPLAN','VERIFIED_MARKER','VERIFIED_MISSING','TRANSIENT_REMOVED')),
 "proofDigest" text CHECK("proofDigest" ~ '^[a-f0-9]{64}$'), "proofAt" timestamptz,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON public."ArtifactExpiryEvent"("planId","itemId",sequence);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ArtifactExpiryPlan','ArtifactExpiryItem','ArtifactExpiryEvent'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY expiry_owner_all ON public.%I TO lyraseo_expiry_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,lyraseo_runtime,lyraseo_dispatch,lyraseo_identity,lyraseo_artifact_maintenance',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON public."ArtifactExpiryPlan",public."ArtifactExpiryItem" TO lyraseo_expiry_owner;
GRANT SELECT,INSERT ON public."ArtifactExpiryEvent" TO lyraseo_expiry_owner;

-- Existing FORCE-RLS relations get a separate, named maintenance-owner policy.
CREATE POLICY expiry_read ON lyraseo_origin.store_registration FOR SELECT TO lyraseo_expiry_owner USING(
 EXISTS(SELECT FROM lyraseo_expiry.environment e WHERE e.store_id=store_registration.id AND lyraseo_expiry.scope_allows(e.workspace_id,e.site_id)));
CREATE POLICY expiry_read ON lyraseo_origin.store_namespace FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows(workspace_id,NULL));
CREATE POLICY expiry_read ON lyraseo_origin.blob_store_binding FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows(workspace_id,NULL));
GRANT SELECT ON lyraseo_origin.store_registration,lyraseo_origin.store_namespace,lyraseo_origin.blob_store_binding TO lyraseo_expiry_owner;
CREATE POLICY expiry_read ON public."Workspace" FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows(id,NULL));
CREATE POLICY expiry_read ON public."Site" FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId",id));
CREATE POLICY expiry_read ON public."AuditRun" FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId","siteId"));
CREATE POLICY expiry_read ON public."VisibilityRecording" FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId","siteId"));
CREATE POLICY expiry_read ON public."VisibilityObservationSlot" FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId","siteId"));
CREATE POLICY expiry_read ON public."VisibilityRun" FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId","siteId"));
CREATE POLICY expiry_read ON public."AuditPageRetention" FOR SELECT TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId",NULL));
CREATE POLICY expiry_lock ON public."Workspace" FOR UPDATE TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows(id,NULL)) WITH CHECK(false);
CREATE POLICY expiry_lock ON public."Site" FOR UPDATE TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId",id)) WITH CHECK(false);
CREATE POLICY expiry_lock ON public."AuditRun" FOR UPDATE TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId","siteId")) WITH CHECK(false);
CREATE POLICY expiry_lock ON public."VisibilityRecording" FOR UPDATE TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId","siteId")) WITH CHECK(false);
CREATE POLICY expiry_owner_all ON public."ArtifactBlob" TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId","siteId")) WITH CHECK(lyraseo_expiry.scope_allows("workspaceId","siteId"));
CREATE POLICY expiry_owner_all ON public."ArtifactRef" TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId","siteId")) WITH CHECK(lyraseo_expiry.scope_allows("workspaceId","siteId"));
CREATE POLICY expiry_owner_all ON public."AuditEvaluationScratch" TO lyraseo_expiry_owner USING(lyraseo_expiry.scope_allows("workspaceId",NULL)) WITH CHECK(lyraseo_expiry.scope_allows("workspaceId",NULL));
CREATE POLICY expiry_owner_all ON lyraseo_audit.unavailable_observation TO lyraseo_expiry_owner USING(
 EXISTS(SELECT FROM public."AuditRun" a WHERE a.id=audit_id AND lyraseo_expiry.scope_allows(a."workspaceId",a."siteId"))) WITH CHECK(true);
GRANT SELECT ON public."Workspace",public."Site",public."AuditRun",public."VisibilityRecording",public."VisibilityObservationSlot",public."VisibilityRun",public."AuditPageRetention",public."ArtifactBlob",public."ArtifactRef",public."AuditEvaluationScratch",lyraseo_audit.unavailable_observation TO lyraseo_expiry_owner;
GRANT UPDATE(id) ON public."Workspace",public."Site",public."AuditRun",public."VisibilityRecording",public."ArtifactRef" TO lyraseo_expiry_owner;
GRANT UPDATE(state,"pendingReceipt") ON public."ArtifactBlob" TO lyraseo_expiry_owner;
GRANT UPDATE("pageId") ON public."AuditEvaluationScratch" TO lyraseo_expiry_owner;
GRANT UPDATE(work_id) ON lyraseo_audit.unavailable_observation TO lyraseo_expiry_owner;
GRANT DELETE ON public."ArtifactRef",public."AuditEvaluationScratch",lyraseo_audit.unavailable_observation TO lyraseo_expiry_owner;
GRANT EXECUTE ON FUNCTION lyraseo_origin.blob_descriptor(public."ArtifactBlob"),lyraseo_audit.version_descriptor(public."ArtifactBlob") TO lyraseo_expiry_owner;

-- An insert must wait behind expiry's blob lock and then re-evaluate READY.
CREATE FUNCTION lyraseo_expiry.ref_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b public."ArtifactBlob"; BEGIN
 SELECT * INTO b FROM public."ArtifactBlob" WHERE id=NEW."blobId" AND generation=NEW.generation FOR SHARE;
 IF b.id IS NULL OR b.state<>'READY' OR
    (b."workspaceId",b."siteId",b."ownerKind",b."capturedAt",b."expiresAt") IS DISTINCT FROM
    (NEW."workspaceId",NEW."siteId",NEW."ownerKind",NEW."capturedAt",NEW."expiresAt") THEN
  RAISE EXCEPTION 'INVALID_SOURCE_BINDING';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expiry_ref_insert BEFORE INSERT ON public."ArtifactRef" FOR EACH ROW EXECUTE FUNCTION lyraseo_expiry.ref_insert_guard();
CREATE FUNCTION lyraseo_expiry.audit_blob_monotone() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF OLD."ownerKind"='AUDIT_PAGE' AND
    ((OLD.state='ORPHAN' AND NEW.state NOT IN ('ORPHAN','DELETED')) OR
     (OLD.state='DELETED' AND NEW.state<>'DELETED')) THEN
  RAISE EXCEPTION 'IMMUTABLE_ARTIFACT_LIFECYCLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expiry_audit_blob_monotone BEFORE UPDATE ON public."ArtifactBlob" FOR EACH ROW EXECUTE FUNCTION lyraseo_expiry.audit_blob_monotone();

-- A fixture clock exists only in an admin-enrolled disposable database. It never
-- controls plan/lease lifetimes or proof freshness.
CREATE FUNCTION lyraseo_expiry.eligibility_now(e lyraseo_expiry.environment) RETURNS timestamp LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
BEGIN
 IF e.fixture_eligibility_at IS NOT NULL AND
    e.fixture_provenance IS NOT NULL AND lyraseo_kernel.is_test_database() THEN
  RETURN e.fixture_eligibility_at;
 END IF;
 RETURN clock_timestamp() AT TIME ZONE 'UTC';
END $$;
CREATE FUNCTION lyraseo_expiry.enrollment(w text,s text) RETURNS lyraseo_expiry.environment LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE e lyraseo_expiry.environment; BEGIN
 IF session_user<>'lyraseo_artifact_maintenance' OR NOT lyraseo_kernel.is_test_database() THEN RAISE EXCEPTION 'EXPIRY_FORBIDDEN'; END IF;
 SELECT * INTO e FROM lyraseo_expiry.environment x WHERE x.workspace_id=w AND x.site_id=s AND
 x.maintenance_login=session_user AND x.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND
 x.postmaster_started_at=pg_postmaster_start_time() AND x.policy_version='P2B1_LOCAL_V1';
 IF e.id IS NULL OR NOT EXISTS(SELECT FROM lyraseo_origin.store_registration r JOIN lyraseo_origin.store_namespace n ON n.store_id=r.id
   WHERE r.id=e.store_id AND n.id=e.namespace_id AND n.workspace_id=w AND r.root_identity=e.root_identity AND
   r.backend='POSIX_FD_V1' AND r.qualification='LOCAL_TEST_ONLY') THEN RAISE EXCEPTION 'EXPIRY_UNENROLLED'; END IF;
 RETURN e;
END $$;

CREATE FUNCTION lyraseo_expiry.candidates(e lyraseo_expiry.environment)
RETURNS TABLE(class text, logical_key text, target_id text, blob_id uuid, generation uuid,
 deadline timestamp, fingerprint text, origin text, version jsonb, owner_kind text,
 qualified boolean, reason text)
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT 'BLOB'::text, 'BLOB:'||b.id::text||':'||b.generation::text,
  CASE WHEN b."ownerKind"='AUDIT_PAGE' THEN b."auditId" ELSE b."recordingId"::text END,
  b.id,b.generation,b."expiresAt",
  encode(sha256(convert_to(jsonb_build_array(b.id,b.generation,b."workspaceId",b."siteId",b."ownerKind",b."auditId",b."recordingId",b."capturedAt",b."expiresAt",b."factHash",b."storageKey",b."storedHash",b."storedLength",lyraseo_origin.blob_descriptor(b))::text,'UTF8')),'hex'),
  lyraseo_origin.blob_descriptor(b),lyraseo_audit.version_descriptor(b),b."ownerKind",
  coalesce(x.store_id=e.store_id AND x.namespace_id=e.namespace_id AND lyraseo_origin.blob_descriptor(b) IS NOT NULL,false),
  CASE WHEN x.blob_id IS NULL THEN 'UNBOUND' WHEN x.store_id<>e.store_id OR x.namespace_id<>e.namespace_id THEN 'OTHER_STORE' ELSE 'DUE' END
 FROM public."ArtifactBlob" b LEFT JOIN lyraseo_origin.blob_store_binding x ON x.blob_id=b.id AND x.generation=b.generation
 WHERE (b."workspaceId",b."siteId")=(e.workspace_id,e.site_id) AND b."expiresAt"<=lyraseo_expiry.eligibility_now(e)
 AND b.state IN ('STAGED','READY','ORPHAN','DELETED') AND NOT EXISTS(
  SELECT FROM public."ArtifactExpiryItem" i JOIN public."ArtifactExpiryEvent" v ON v."itemId"=i.id
  WHERE i."blobId"=b.id AND i.generation=b.generation AND i.status='COMPLETE' AND v.outcome='COMPLETE' AND v."proofDigest" IS NOT NULL)
 UNION ALL
 SELECT 'PENDING_RECEIPT','PENDING:'||b.id::text||':'||b.generation::text,
  b."auditId",b.id,b.generation,b."expiresAt",
  encode(sha256(convert_to(jsonb_build_array(b.id,b.generation,b."auditId",b."expiresAt")::text,'UTF8')),'hex'),
  NULL,NULL,b."ownerKind",true,'DUE'
 FROM public."ArtifactBlob" b WHERE (b."workspaceId",b."siteId")=(e.workspace_id,e.site_id)
  AND b."ownerKind"='AUDIT_PAGE' AND b."pendingReceipt" IS NOT NULL AND b."expiresAt"<=lyraseo_expiry.eligibility_now(e)
 UNION ALL
 SELECT 'SCRATCH','SCRATCH:'||encode(sha256(convert_to(jsonb_build_array(s."workspaceId",s."auditId",s."pageId")::text,'UTF8')),'hex'),
  s."auditId",NULL,NULL,s."expiresAt",
  encode(sha256(convert_to(jsonb_build_array(s."workspaceId",s."auditId",s."pageId",s."expiresAt")::text,'UTF8')),'hex'),
  NULL,NULL,NULL,true,CASE WHEN a.status IN ('COMPLETED','FAILED') THEN 'TERMINAL' ELSE 'DUE' END
 FROM public."AuditEvaluationScratch" s JOIN public."AuditRun" a ON a.id=s."auditId"
 WHERE (a."workspaceId",a."siteId")=(e.workspace_id,e.site_id)
 AND (s."expiresAt"<=lyraseo_expiry.eligibility_now(e) OR a.status IN ('COMPLETED','FAILED'))
 UNION ALL
 SELECT 'UNAVAILABLE','UNAVAILABLE:'||encode(sha256(convert_to(jsonb_build_array(u.work_id,u.generation,u.url,u.audit_id)::text,'UTF8')),'hex'),
  u.audit_id,NULL,NULL,u.expires_at,
  encode(sha256(convert_to(jsonb_build_array(u.work_id,u.generation,u.url,u.audit_id,u.fact_hash,u.expires_at)::text,'UTF8')),'hex'),
  NULL,NULL,NULL,true,CASE WHEN a.status IN ('COMPLETED','FAILED') THEN 'TERMINAL' ELSE 'DUE' END
 FROM lyraseo_audit.unavailable_observation u JOIN public."AuditRun" a ON a.id=u.audit_id
 WHERE (a."workspaceId",a."siteId")=(e.workspace_id,e.site_id)
 AND (u.expires_at<=lyraseo_expiry.eligibility_now(e) OR a.status IN ('COMPLETED','FAILED'))
$$;

CREATE FUNCTION lyraseo_expiry.lock_target(e lyraseo_expiry.environment,k text,t text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM 1 FROM public."Workspace" WHERE id=e.workspace_id AND "deletedAt" IS NULL FOR SHARE SKIP LOCKED;
 IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
 PERFORM 1 FROM public."Site" WHERE id=e.site_id AND "workspaceId"=e.workspace_id AND "deletedAt" IS NULL FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
 IF k IN ('BLOB_AUDIT','PENDING_RECEIPT','SCRATCH','UNAVAILABLE') THEN
  PERFORM 1 FROM public."AuditRun" WHERE id=t AND "workspaceId"=e.workspace_id AND "siteId"=e.site_id FOR UPDATE SKIP LOCKED;
 ELSE
  PERFORM 1 FROM public."VisibilityRecording" WHERE id=t::uuid AND "workspaceId"=e.workspace_id AND "siteId"=e.site_id FOR UPDATE SKIP LOCKED;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
END $$;

CREATE FUNCTION lyraseo_expiry.preview(scope_ jsonb,lim integer,cursor_ text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e lyraseo_expiry.environment; items jsonb; manifest_ jsonb; next_ text; BEGIN
 IF lim IS NULL OR lim NOT BETWEEN 1 AND 100 OR scope_ - ARRAY['workspaceId','siteId'] <> '{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PREVIEW'; END IF;
 e:=lyraseo_expiry.enrollment(scope_->>'workspaceId',scope_->>'siteId');
 SELECT coalesce(jsonb_agg(jsonb_build_object('class',class,'id',logical_key,'deadline',deadline,'qualified',qualified,'reason',reason) ORDER BY logical_key),'[]'::jsonb),
        max(logical_key) INTO items,next_
 FROM (SELECT class,logical_key,deadline,qualified,reason FROM lyraseo_expiry.candidates(e)
       WHERE cursor_ IS NULL OR logical_key>cursor_ ORDER BY logical_key LIMIT lim) q;
 SELECT coalesce(jsonb_agg(jsonb_build_object('class',v->>'class','id',v->>'id') ORDER BY v->>'id'),'[]'::jsonb) INTO manifest_
 FROM jsonb_array_elements(items) v WHERE (v->>'qualified')::boolean;
 RETURN jsonb_build_object('items',items,'manifest',manifest_,'hash',encode(sha256(convert_to(manifest_::text,'UTF8')),'hex'),
  'nextCursor',next_,'databaseNow',clock_timestamp() AT TIME ZONE 'UTC','eligibilityNow',lyraseo_expiry.eligibility_now(e));
END $$;

CREATE FUNCTION lyraseo_expiry.record_plan(scope_ jsonb,manifest_ jsonb,expected_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e lyraseo_expiry.environment; p public."ArtifactExpiryPlan"; m jsonb; c record; old_ public."ArtifactExpiryItem"; n integer:=0; BEGIN
 IF jsonb_typeof(manifest_)<>'array' OR jsonb_array_length(manifest_) NOT BETWEEN 1 AND 100 OR
    expected_hash IS DISTINCT FROM encode(sha256(convert_to(manifest_::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'INVALID_MANIFEST'; END IF;
 e:=lyraseo_expiry.enrollment(scope_->>'workspaceId',scope_->>'siteId');
 IF scope_ - ARRAY['workspaceId','siteId'] <> '{}'::jsonb THEN RAISE EXCEPTION 'INVALID_SCOPE'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(manifest_) v WHERE v-ARRAY['class','id']<>'{}'::jsonb OR v->>'class' NOT IN ('BLOB','PENDING_RECEIPT','SCRATCH','UNAVAILABLE')) OR
    (SELECT count(DISTINCT v->>'id') FROM jsonb_array_elements(manifest_) v)<>jsonb_array_length(manifest_) THEN RAISE EXCEPTION 'INVALID_MANIFEST'; END IF;
 INSERT INTO public."ArtifactExpiryPlan"("policyVersion","workspaceId","siteId","environmentId","databaseOid","postmasterStartedAt","storeId","namespaceId","expiresAt",manifest,"manifestHash")
 VALUES('P2B1_LOCAL_V1',e.workspace_id,e.site_id,e.id,e.database_oid,e.postmaster_started_at,e.store_id,e.namespace_id,clock_timestamp()+interval '1 hour',manifest_,expected_hash) RETURNING * INTO p;
 FOR m IN SELECT value FROM jsonb_array_elements(manifest_) ORDER BY value->>'id' LOOP
  SELECT * INTO c FROM lyraseo_expiry.candidates(e) WHERE class=m->>'class' AND logical_key=m->>'id';
  IF NOT FOUND OR NOT c.qualified THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
  PERFORM lyraseo_expiry.lock_target(e,CASE WHEN c.class='BLOB' AND c.owner_kind='AUDIT_PAGE' THEN 'BLOB_AUDIT' ELSE c.class END,c.target_id);
  IF c.blob_id IS NOT NULL THEN
   PERFORM 1 FROM public."ArtifactBlob" WHERE id=c.blob_id AND generation=c.generation FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
   PERFORM 1 FROM public."ArtifactRef" WHERE "blobId"=c.blob_id AND generation=c.generation FOR UPDATE SKIP LOCKED;
   IF NOT FOUND AND EXISTS(SELECT FROM public."ArtifactRef" WHERE "blobId"=c.blob_id AND generation=c.generation) THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
  ELSIF c.class='SCRATCH' THEN
   PERFORM 1 FROM public."AuditEvaluationScratch" WHERE 'SCRATCH:'||encode(sha256(convert_to(jsonb_build_array("workspaceId","auditId","pageId")::text,'UTF8')),'hex')=c.logical_key FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
  ELSIF c.class='UNAVAILABLE' THEN
   PERFORM 1 FROM lyraseo_audit.unavailable_observation u WHERE 'UNAVAILABLE:'||encode(sha256(convert_to(jsonb_build_array(u.work_id,u.generation,u.url,u.audit_id)::text,'UTF8')),'hex')=c.logical_key FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
  END IF;
  SELECT * INTO c FROM lyraseo_expiry.candidates(e) WHERE class=m->>'class' AND logical_key=m->>'id';
  IF NOT FOUND OR NOT c.qualified THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
  SELECT * INTO old_ FROM public."ArtifactExpiryItem" WHERE "logicalKey"=c.logical_key FOR UPDATE;
  IF FOUND THEN
   IF old_.fingerprint<>c.fingerprint OR old_.deadline<>c.deadline OR old_.origin IS DISTINCT FROM c.origin OR
      old_.version IS DISTINCT FROM c.version OR old_."blobId" IS DISTINCT FROM c.blob_id OR old_.generation IS DISTINCT FROM c.generation OR
      (old_."leaseUntil" IS NOT NULL AND old_."leaseUntil">clock_timestamp()) THEN RAISE EXCEPTION 'EXPIRY_REPLAN_CONFLICT'; END IF;
   UPDATE public."ArtifactExpiryItem" SET "currentPlanId"=p.id,token=NULL,"workerTokenHash"=NULL,"leaseUntil"=NULL,
    status=CASE WHEN status IN ('CLAIMED','PENDING') THEN 'PENDING' ELSE status END,
    "nextRetryAt"=CASE WHEN status='PENDING' THEN greatest("nextRetryAt",clock_timestamp()) ELSE clock_timestamp() END WHERE id=old_.id;
   INSERT INTO public."ArtifactExpiryEvent"("planId","itemId",sequence,token,outcome,reason)
    VALUES(p.id,old_.id,old_."attemptSequence",old_.token,'TRANSFERRED','REPLAN');
  ELSE
   INSERT INTO public."ArtifactExpiryItem"(class,"logicalKey","workspaceId","siteId","blobId",generation,"ownerKind",deadline,fingerprint,origin,version,"currentPlanId")
   VALUES(c.class,c.logical_key,e.workspace_id,e.site_id,c.blob_id,c.generation,c.owner_kind,c.deadline,c.fingerprint,c.origin,c.version,p.id);
  END IF;
  n:=n+1;
 END LOOP;
 RETURN jsonb_build_object('planId',p.id,'hash',p."manifestHash",'count',n,'expiresAt',p."expiresAt");
END $$;

CREATE FUNCTION lyraseo_expiry.proof_prefix(p public."ArtifactExpiryPlan",i public."ArtifactExpiryItem",e lyraseo_expiry.environment) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT array_to_string(ARRAY['expiry-absence-v1',e.id::text,e.enrollment_identity::text,e.database_oid::text,
  extract(epoch FROM e.postmaster_started_at)::bigint::text,p.id::text,p."manifestHash",i.id::text,
  i.token::text,i."attemptSequence"::text,i.origin,
  encode(sha256(convert_to(i.version::text,'UTF8')),'hex')],chr(10))
$$;

CREATE FUNCTION lyraseo_expiry.claim(scope_ jsonb,plan_id uuid,item_id uuid,expected_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."ArtifactExpiryPlan"; i public."ArtifactExpiryItem"; e lyraseo_expiry.environment; c record;
 b public."ArtifactBlob"; f public."ArtifactRef"; related_ public."ArtifactExpiryItem"; related_plan public."ArtifactExpiryPlan"; prior text; affected integer; worker_cap uuid; BEGIN
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=plan_id;
 SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE id=item_id;
 IF p.id IS NULL OR scope_ IS DISTINCT FROM jsonb_build_object('workspaceId',p."workspaceId",'siteId',p."siteId") OR
    i.id IS NULL OR i."currentPlanId"<>p.id OR p."manifestHash" IS DISTINCT FROM expected_hash OR
    NOT p.manifest @> jsonb_build_array(jsonb_build_object('class',i.class,'id',i."logicalKey")) THEN RAISE EXCEPTION 'EXPIRY_PLAN_MISMATCH'; END IF;
 e:=lyraseo_expiry.enrollment(p."workspaceId",p."siteId");
 IF e.id<>p."environmentId" OR e.database_oid<>p."databaseOid" OR e.postmaster_started_at<>p."postmasterStartedAt" OR
    e.store_id<>p."storeId" OR e.namespace_id<>p."namespaceId" THEN RAISE EXCEPTION 'EXPIRY_ENROLLMENT_CHANGED'; END IF;
 -- A prior claim in this batch may have atomically settled the same receipt.
 -- This read-only path locks only the carrier and never goes on to take target locks.
 IF i.status='COMPLETE' THEN
  SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE id=item_id FOR SHARE;
  IF i.status<>'COMPLETE' OR i."currentPlanId"<>p.id OR
     NOT p.manifest @> jsonb_build_array(jsonb_build_object('class',i.class,'id',i."logicalKey")) THEN
   RAISE EXCEPTION 'EXPIRY_PLAN_MISMATCH';
  END IF;
  RETURN jsonb_build_object('itemId',i.id,'status','COMPLETE');
 END IF;
 IF p.paused OR p."expiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'EXPIRY_PLAN_INACTIVE'; END IF;
 SELECT * INTO c FROM lyraseo_expiry.candidates(e) WHERE class=i.class AND logical_key=i."logicalKey";
 IF NOT FOUND OR NOT c.qualified THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
 PERFORM lyraseo_expiry.lock_target(e,CASE WHEN i.class='BLOB' AND i."ownerKind"='AUDIT_PAGE' THEN 'BLOB_AUDIT' ELSE i.class END,c.target_id);
 IF c.blob_id IS NOT NULL THEN
  SELECT * INTO b FROM public."ArtifactBlob" WHERE id=c.blob_id AND generation=c.generation FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
  SELECT * INTO f FROM public."ArtifactRef" WHERE "blobId"=c.blob_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND AND EXISTS(SELECT FROM public."ArtifactRef" WHERE "blobId"=c.blob_id) THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
 ELSIF i.class='SCRATCH' THEN
  PERFORM 1 FROM public."AuditEvaluationScratch" s WHERE 'SCRATCH:'||encode(sha256(convert_to(jsonb_build_array(s."workspaceId",s."auditId",s."pageId")::text,'UTF8')),'hex')=i."logicalKey" FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
 ELSIF i.class='UNAVAILABLE' THEN
  PERFORM 1 FROM lyraseo_audit.unavailable_observation u WHERE 'UNAVAILABLE:'||encode(sha256(convert_to(jsonb_build_array(u.work_id,u.generation,u.url,u.audit_id)::text,'UTF8')),'hex')=i."logicalKey" FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
 END IF;
 SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE id=item_id FOR UPDATE;
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=plan_id FOR SHARE;
 SELECT * INTO c FROM lyraseo_expiry.candidates(e) WHERE class=i.class AND logical_key=i."logicalKey";
 IF scope_ IS DISTINCT FROM jsonb_build_object('workspaceId',p."workspaceId",'siteId',p."siteId") OR i."currentPlanId"<>p.id OR p.paused OR p."expiresAt"<=clock_timestamp() OR
    i.status='COMPLETE' OR (i."leaseUntil" IS NOT NULL AND i."leaseUntil">clock_timestamp()) OR
    i."nextRetryAt">clock_timestamp() OR NOT FOUND OR NOT c.qualified OR
    i.fingerprint IS DISTINCT FROM c.fingerprint OR i.deadline IS DISTINCT FROM c.deadline OR
    i.origin IS DISTINCT FROM c.origin OR i.version IS DISTINCT FROM c.version OR
    i."blobId" IS DISTINCT FROM c.blob_id OR i.generation IS DISTINCT FROM c.generation THEN
  RAISE EXCEPTION 'EXPIRY_STALE_CLAIM';
 END IF;
 prior:=i.status;
 IF i.class='BLOB' THEN
  IF b.id IS NULL OR b."ownerKind"<>i."ownerKind" OR b."expiresAt"<>i.deadline OR
     b."workspaceId"<>e.workspace_id OR b."siteId"<>e.site_id OR b.generation<>i.generation THEN RAISE EXCEPTION 'EXPIRY_BLOB_CHANGED'; END IF;
  IF f.id IS NOT NULL THEN
   IF (f."blobId",f.generation,f."workspaceId",f."siteId",f."ownerKind",f."capturedAt",f."expiresAt") IS DISTINCT FROM
      (b.id,b.generation,b."workspaceId",b."siteId",b."ownerKind",b."capturedAt",b."expiresAt") OR
      f."expiresAt">lyraseo_expiry.eligibility_now(e) THEN RAISE EXCEPTION 'EXPIRY_REF_CHANGED'; END IF;
   DELETE FROM public."ArtifactRef" WHERE id=f.id;
  END IF;
  IF EXISTS(SELECT FROM public."ArtifactRef" WHERE "blobId"=b.id) THEN RAISE EXCEPTION 'EXPIRY_REF_RETAINED'; END IF;
  UPDATE public."ArtifactBlob" SET state=CASE WHEN state IN ('STAGED','READY') THEN 'ORPHAN' ELSE state END,
   "pendingReceipt"=NULL WHERE id=b.id;
  -- Receipt and payload can both be selected, potentially by different plans.
  -- The target and blob locks serialize receipt claims before this carrier CAS.
  IF b."pendingReceipt" IS NOT NULL THEN
   SELECT * INTO related_ FROM public."ArtifactExpiryItem"
    WHERE "logicalKey"='PENDING:'||b.id::text||':'||b.generation::text FOR UPDATE;
   IF FOUND THEN
    SELECT * INTO related_plan FROM public."ArtifactExpiryPlan" WHERE id=related_."currentPlanId";
    IF related_.class<>'PENDING_RECEIPT' OR related_."workspaceId"<>b."workspaceId" OR related_."siteId"<>b."siteId" OR
       related_."blobId" IS DISTINCT FROM b.id OR related_.generation IS DISTINCT FROM b.generation OR
       related_.deadline IS DISTINCT FROM b."expiresAt" OR related_.token IS NOT NULL OR related_."workerTokenHash" IS NOT NULL OR related_."leaseUntil" IS NOT NULL OR
       related_.status NOT IN ('READY','COMPLETE') OR related_plan.id IS NULL OR related_plan."environmentId"<>e.id OR
       related_plan."workspaceId"<>e.workspace_id OR related_plan."siteId"<>e.site_id OR
       NOT related_plan.manifest @> jsonb_build_array(jsonb_build_object('class',related_.class,'id',related_."logicalKey")) THEN
     RAISE EXCEPTION 'EXPIRY_RECEIPT_CARRIER_CHANGED';
    END IF;
    IF related_.status='READY' THEN
     UPDATE public."ArtifactExpiryItem" SET status='COMPLETE',"attemptSequence"="attemptSequence"+1,
      "completedAt"=clock_timestamp() WHERE id=related_.id RETURNING * INTO related_;
     INSERT INTO public."ArtifactExpiryEvent"("planId","itemId",sequence,token,outcome,reason)
      VALUES(related_."currentPlanId",related_.id,related_."attemptSequence",NULL,'COMPLETE','TRANSIENT_REMOVED');
    END IF;
   END IF;
  END IF;
 ELSIF i.class='PENDING_RECEIPT' THEN
  UPDATE public."ArtifactBlob" SET "pendingReceipt"=NULL WHERE id=c.blob_id AND generation=c.generation AND "expiresAt"<=lyraseo_expiry.eligibility_now(e);
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
 ELSIF i.class='SCRATCH' THEN
  DELETE FROM public."AuditEvaluationScratch" s WHERE 'SCRATCH:'||encode(sha256(convert_to(jsonb_build_array(s."workspaceId",s."auditId",s."pageId")::text,'UTF8')),'hex')=i."logicalKey" AND s."expiresAt"=i.deadline;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
 ELSE
  DELETE FROM lyraseo_audit.unavailable_observation u WHERE 'UNAVAILABLE:'||encode(sha256(convert_to(jsonb_build_array(u.work_id,u.generation,u.url,u.audit_id)::text,'UTF8')),'hex')=i."logicalKey" AND u.expires_at=i.deadline;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
 END IF;
 worker_cap:=CASE WHEN i.class='BLOB' THEN gen_random_uuid() ELSE NULL END;
 UPDATE public."ArtifactExpiryItem" SET status=CASE WHEN i.class='BLOB' THEN 'CLAIMED' ELSE 'COMPLETE' END,
  "attemptSequence"="attemptSequence"+1,token=CASE WHEN i.class='BLOB' THEN gen_random_uuid() ELSE NULL END,
  "workerTokenHash"=CASE WHEN worker_cap IS NOT NULL THEN encode(sha256(convert_to(worker_cap::text,'UTF8')),'hex') ELSE NULL END,
  "leaseUntil"=CASE WHEN i.class='BLOB' THEN clock_timestamp()+interval '5 minutes' ELSE NULL END,
  "completedAt"=CASE WHEN i.class='BLOB' THEN NULL ELSE clock_timestamp() END WHERE id=i.id RETURNING * INTO i;
 INSERT INTO public."ArtifactExpiryEvent"("planId","itemId",sequence,token,outcome,reason)
 VALUES(p.id,i.id,i."attemptSequence",i.token,CASE WHEN i.class='BLOB' THEN 'CLAIMED' ELSE 'COMPLETE' END,
  CASE WHEN i.class='BLOB' THEN 'DUE' ELSE 'TRANSIENT_REMOVED' END);
 IF i.class<>'BLOB' THEN RETURN jsonb_build_object('itemId',i.id,'status','COMPLETE'); END IF;
 RETURN jsonb_build_object('itemId',i.id,'planId',p.id,'status','CLAIMED','token',i.token,'workerToken',worker_cap,'sequence',i."attemptSequence",
  'version',i.version,'origin',i.origin,'signingPrefix',lyraseo_expiry.proof_prefix(p,i,e),
  'reconcileFirst',prior IN ('CLAIMED','PENDING'),'leaseUntil',i."leaseUntil");
END $$;

CREATE FUNCTION lyraseo_expiry.record_pending(token_ uuid,worker_token uuid,reason_ text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i public."ArtifactExpiryItem"; p public."ArtifactExpiryPlan"; e lyraseo_expiry.environment; c record; BEGIN
 SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE token=token_;
 IF i.id IS NULL OR i.status<>'CLAIMED' OR reason_ NOT IN ('BACKEND_UNAVAILABLE','ABSENCE_UNCERTAIN') THEN RAISE EXCEPTION 'EXPIRY_STALE_CLAIM'; END IF;
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=i."currentPlanId";
 e:=lyraseo_expiry.enrollment(p."workspaceId",p."siteId");
 SELECT * INTO c FROM lyraseo_expiry.candidates(e) WHERE class=i.class AND logical_key=i."logicalKey";
 IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
 PERFORM lyraseo_expiry.lock_target(e,CASE WHEN i."ownerKind"='AUDIT_PAGE' THEN 'BLOB_AUDIT' ELSE 'BLOB' END,c.target_id);
 PERFORM 1 FROM public."ArtifactBlob" WHERE id=i."blobId" AND generation=i.generation FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
 SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE id=i.id FOR UPDATE;
 IF i.token IS DISTINCT FROM token_ OR worker_token IS NULL OR i."workerTokenHash" IS DISTINCT FROM encode(sha256(convert_to(worker_token::text,'UTF8')),'hex') OR i.status<>'CLAIMED' THEN RAISE EXCEPTION 'EXPIRY_STALE_CLAIM'; END IF;
 UPDATE public."ArtifactExpiryItem" SET status='PENDING',token=NULL,"workerTokenHash"=NULL,"leaseUntil"=NULL,"nextRetryAt"=clock_timestamp()+interval '30 seconds' WHERE id=i.id;
 INSERT INTO public."ArtifactExpiryEvent"("planId","itemId",sequence,token,outcome,reason)
 VALUES(p.id,i.id,i."attemptSequence",token_,'PENDING',reason_);
END $$;

DO $$ DECLARE crypto_schema name; BEGIN
 SELECT n.nspname INTO STRICT crypto_schema FROM pg_extension x JOIN pg_namespace n ON n.oid=x.extnamespace WHERE x.extname='pgcrypto';
 IF NOT EXISTS(SELECT FROM pg_depend d JOIN pg_proc p ON p.oid=d.objid WHERE d.refclassid='pg_extension'::regclass AND
  d.refobjid=(SELECT oid FROM pg_extension WHERE extname='pgcrypto') AND d.deptype='e' AND
  d.classid='pg_proc'::regclass AND p.oid=to_regprocedure(format('%I.hmac(bytea,bytea,text)',crypto_schema))) THEN
  RAISE EXCEPTION 'UNTRUSTED_EXPIRY_CRYPTO';
 END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO lyraseo_expiry_owner',crypto_schema);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.hmac(bytea,bytea,text) TO lyraseo_expiry_owner',crypto_schema);
 EXECUTE format($ddl$
  CREATE FUNCTION lyraseo_expiry.verify_mac(e uuid,key_ uuid,payload text,supplied text) RETURNS void
  LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
  DECLARE expected bytea; BEGIN
   IF supplied IS NULL OR supplied !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'EXPIRY_PROOF_REQUIRED'; END IF;
   SELECT %I.hmac(convert_to(payload,'UTF8'),v.secret,'sha256'::text) INTO expected
   FROM lyraseo_expiry.absence_verifier v WHERE v.id=key_ AND v.environment_id=e AND
   v.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND
   v.postmaster_started_at=pg_postmaster_start_time();
   IF expected IS NULL OR sha256(expected)<>sha256(decode(supplied,'hex')) THEN RAISE EXCEPTION 'EXPIRY_PROOF_REQUIRED'; END IF;
  END $body$ $ddl$,crypto_schema);
END $$;

CREATE FUNCTION lyraseo_expiry.complete(token_ uuid,proof jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i public."ArtifactExpiryItem"; p public."ArtifactExpiryPlan"; e lyraseo_expiry.environment;
 b public."ArtifactBlob"; f public."ArtifactRef"; c record; inspected timestamptz; payload text; digest text; BEGIN
 SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE token=token_;
 IF i.id IS NULL OR i.class<>'BLOB' OR i.status<>'CLAIMED' THEN RAISE EXCEPTION 'EXPIRY_STALE_CLAIM'; END IF;
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=i."currentPlanId";
 e:=lyraseo_expiry.enrollment(p."workspaceId",p."siteId");
 SELECT * INTO c FROM lyraseo_expiry.candidates(e) WHERE class=i.class AND logical_key=i."logicalKey";
 IF NOT FOUND OR NOT c.qualified THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
 PERFORM lyraseo_expiry.lock_target(e,CASE WHEN i."ownerKind"='AUDIT_PAGE' THEN 'BLOB_AUDIT' ELSE 'BLOB' END,c.target_id);
 SELECT * INTO b FROM public."ArtifactBlob" WHERE id=i."blobId" AND generation=i.generation FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
 SELECT * INTO f FROM public."ArtifactRef" WHERE "blobId"=i."blobId" FOR UPDATE SKIP LOCKED;
 IF NOT FOUND AND EXISTS(SELECT FROM public."ArtifactRef" WHERE "blobId"=i."blobId") THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
 SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE id=i.id FOR UPDATE;
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=i."currentPlanId" FOR SHARE;
 IF i.token IS DISTINCT FROM token_ OR i.status<>'CLAIMED' OR i."currentPlanId"<>p.id OR
    p."environmentId"<>e.id OR b.id IS NULL OR b.state NOT IN ('ORPHAN','DELETED') OR f.id IS NOT NULL OR
    b."expiresAt"<>i.deadline OR b."workspaceId"<>e.workspace_id OR b."siteId"<>e.site_id OR
    lyraseo_origin.blob_descriptor(b) IS DISTINCT FROM i.origin OR
    lyraseo_audit.version_descriptor(b) IS DISTINCT FROM i.version OR
    i.deadline>lyraseo_expiry.eligibility_now(e) THEN RAISE EXCEPTION 'EXPIRY_STALE_CLAIM'; END IF;
 IF jsonb_typeof(proof)<>'object' OR proof-ARRAY['keyId','itemId','planId','token','sequence','inspectedAt','absence','mac']<>'{}'::jsonb OR
    proof->>'itemId' IS DISTINCT FROM i.id::text OR proof->>'planId' IS DISTINCT FROM p.id::text OR
    proof->>'token' IS DISTINCT FROM token_::text OR proof->>'sequence' IS DISTINCT FROM i."attemptSequence"::text OR
    proof->>'absence' NOT IN ('marker','missing') OR proof->>'keyId' IS NULL OR proof->>'inspectedAt' IS NULL THEN
  RAISE EXCEPTION 'EXPIRY_PROOF_REQUIRED'; END IF;
 inspected:=(proof->>'inspectedAt')::timestamptz;
 IF inspected>clock_timestamp()+interval '5 seconds' OR inspected<clock_timestamp()-interval '2 minutes' THEN RAISE EXCEPTION 'EXPIRY_PROOF_STALE'; END IF;
 payload:=lyraseo_expiry.proof_prefix(p,i,e)||chr(10)||(proof->>'inspectedAt')||chr(10)||(proof->>'absence');
 PERFORM lyraseo_expiry.verify_mac(e.id,(proof->>'keyId')::uuid,payload,proof->>'mac');
 digest:=encode(sha256(convert_to(payload,'UTF8')),'hex');
 UPDATE public."ArtifactBlob" SET state='DELETED',"pendingReceipt"=NULL WHERE id=b.id;
 UPDATE public."ArtifactExpiryItem" SET status='COMPLETE',token=NULL,"workerTokenHash"=NULL,"leaseUntil"=NULL,"completedAt"=clock_timestamp() WHERE id=i.id;
 INSERT INTO public."ArtifactExpiryEvent"("planId","itemId",sequence,token,outcome,reason,"proofDigest","proofAt")
 VALUES(p.id,i.id,i."attemptSequence",token_,'COMPLETE',CASE WHEN proof->>'absence'='marker' THEN 'VERIFIED_MARKER' ELSE 'VERIFIED_MISSING' END,digest,inspected);
 RETURN jsonb_build_object('itemId',i.id,'status','COMPLETE','proofDigest',digest);
END $$;

CREATE FUNCTION lyraseo_expiry.reconcile_claim(scope_ jsonb,plan_id uuid,item_id uuid,expected_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."ArtifactExpiryPlan"; i public."ArtifactExpiryItem"; e lyraseo_expiry.environment; c record; BEGIN
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=plan_id;
 SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE id=item_id;
 IF p.id IS NULL OR scope_ IS DISTINCT FROM jsonb_build_object('workspaceId',p."workspaceId",'siteId',p."siteId") OR
    i.id IS NULL OR i."currentPlanId"<>p.id OR p."manifestHash" IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION 'EXPIRY_PLAN_MISMATCH'; END IF;
 e:=lyraseo_expiry.enrollment(p."workspaceId",p."siteId");
 IF i.status='CLAIMED' AND i."leaseUntil">clock_timestamp() THEN
  SELECT * INTO c FROM lyraseo_expiry.candidates(e) WHERE class=i.class AND logical_key=i."logicalKey";
  IF NOT FOUND OR NOT c.qualified THEN RAISE EXCEPTION 'EXPIRY_CANDIDATE_CHANGED'; END IF;
  PERFORM lyraseo_expiry.lock_target(e,CASE WHEN i."ownerKind"='AUDIT_PAGE' THEN 'BLOB_AUDIT' ELSE 'BLOB' END,c.target_id);
  PERFORM 1 FROM public."ArtifactBlob" WHERE id=i."blobId" AND generation=i.generation FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPIRY_TARGET_BUSY'; END IF;
  SELECT * INTO i FROM public."ArtifactExpiryItem" WHERE id=i.id FOR UPDATE;
  IF i."currentPlanId"<>p.id OR i.status<>'CLAIMED' OR i.token IS NULL THEN RAISE EXCEPTION 'EXPIRY_STALE_CLAIM'; END IF;
  INSERT INTO public."ArtifactExpiryEvent"("planId","itemId",sequence,token,outcome,reason)
   VALUES(p.id,i.id,i."attemptSequence",i.token,'RECONCILED','DUE');
  RETURN jsonb_build_object('itemId',i.id,'planId',p.id,'status','CLAIMED','token',i.token,'sequence',i."attemptSequence",
   'version',i.version,'origin',i.origin,'signingPrefix',lyraseo_expiry.proof_prefix(p,i,e),
   'reconcileFirst',true,'inspectOnly',true,'leaseUntil',i."leaseUntil");
 END IF;
 RETURN lyraseo_expiry.claim(scope_,plan_id,item_id,expected_hash);
END $$;

CREATE FUNCTION lyraseo_expiry.next_items(scope_ jsonb,plan_id uuid,expected_hash text,lim integer,cursor_ uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."ArtifactExpiryPlan"; e lyraseo_expiry.environment; items jsonb; cursors_ jsonb; entry_ jsonb; BEGIN
 IF lim IS NULL OR lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_LIMIT'; END IF;
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=plan_id FOR UPDATE;
 IF p.id IS NULL OR scope_ IS DISTINCT FROM jsonb_build_object('workspaceId',p."workspaceId",'siteId',p."siteId") OR
    p."manifestHash" IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION 'EXPIRY_PLAN_MISMATCH'; END IF;
 e:=lyraseo_expiry.enrollment(p."workspaceId",p."siteId");
 IF e.id<>p."environmentId" THEN RAISE EXCEPTION 'EXPIRY_ENROLLMENT_CHANGED'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'class',class) ORDER BY position_,class_rank,id),'[]'::jsonb) INTO items
 FROM (SELECT id,class,position_,class_rank FROM (
   SELECT i.id,i.class,
    row_number() OVER (PARTITION BY i.class ORDER BY (i.id::text<=coalesce(p."classCursors"->>i.class,'')),i.id) AS position_,
    ((CASE i.class WHEN 'BLOB' THEN 0 WHEN 'PENDING_RECEIPT' THEN 1 WHEN 'SCRATCH' THEN 2 ELSE 3 END-p.rotation+4)%4) AS class_rank
   FROM public."ArtifactExpiryItem" i WHERE i."currentPlanId"=p.id AND i.status<>'COMPLETE' AND
    (i."nextRetryAt"<=clock_timestamp() OR i.status='CLAIMED') AND
    (NOT p.paused AND p."expiresAt">clock_timestamp() OR i.status='CLAIMED') AND
    (cursor_ IS NULL OR i.id>cursor_)) ranked
   ORDER BY position_,class_rank,id LIMIT lim) picked;
 cursors_:=p."classCursors";
 FOR entry_ IN SELECT value FROM jsonb_array_elements(items) LOOP
  cursors_:=jsonb_set(cursors_,ARRAY[entry_->>'class'],to_jsonb(entry_->>'id'),true);
 END LOOP;
 UPDATE public."ArtifactExpiryPlan" SET rotation=(rotation+1)%4,"classCursors"=cursors_ WHERE id=p.id;
 RETURN jsonb_build_object('items',items,'classCursors',cursors_);
END $$;

CREATE FUNCTION lyraseo_expiry.status(scope_ jsonb,plan_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."ArtifactExpiryPlan"; e lyraseo_expiry.environment; selected jsonb; residual jsonb; BEGIN
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=plan_id;
 IF p.id IS NULL OR scope_ IS DISTINCT FROM jsonb_build_object('workspaceId',p."workspaceId",'siteId',p."siteId") THEN RAISE EXCEPTION 'EXPIRY_PLAN_MISMATCH'; END IF;
 e:=lyraseo_expiry.enrollment(p."workspaceId",p."siteId");
 IF e.id<>p."environmentId" THEN RAISE EXCEPTION 'EXPIRY_ENROLLMENT_CHANGED'; END IF;
 SELECT jsonb_build_object('complete',count(*) FILTER(WHERE status='COMPLETE'),
  'pending',count(*) FILTER(WHERE status='PENDING'),'claimed',count(*) FILTER(WHERE status='CLAIMED'),
  'ready',count(*) FILTER(WHERE status='READY')) INTO selected FROM public."ArtifactExpiryItem" WHERE "currentPlanId"=p.id;
 SELECT jsonb_build_object('dueQualified',count(*) FILTER(WHERE qualified),
  'dueBlocked',count(*) FILTER(WHERE NOT qualified),'dueUnbound',count(*) FILTER(WHERE c.reason='UNBOUND'),
  'duePending',count(*) FILTER(WHERE i.status='PENDING'),'dueClaimed',count(*) FILTER(WHERE i.status='CLAIMED'),
  'dueUnselected',count(*) FILTER(WHERE qualified AND (i.id IS NULL OR i."currentPlanId"<>p.id)),
  'oldestUnresolved',min(c.deadline)) INTO residual
 FROM lyraseo_expiry.candidates(e) c LEFT JOIN public."ArtifactExpiryItem" i ON i."logicalKey"=c.logical_key;
 RETURN jsonb_build_object('planId',p.id,'hash',p."manifestHash",'paused',p.paused,'expiresAt',p."expiresAt",
  'selectedPlan',selected,'scopeResidual',residual,'qualification','LOCAL_TEST_ONLY_ACTIVE_STORE_P2B1');
END $$;

CREATE FUNCTION lyraseo_expiry.pause(scope_ jsonb,plan_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."ArtifactExpiryPlan"; e lyraseo_expiry.environment; BEGIN
 SELECT * INTO p FROM public."ArtifactExpiryPlan" WHERE id=plan_id;
 IF p.id IS NULL OR scope_ IS DISTINCT FROM jsonb_build_object('workspaceId',p."workspaceId",'siteId',p."siteId") THEN RAISE EXCEPTION 'EXPIRY_PLAN_MISMATCH'; END IF;
 e:=lyraseo_expiry.enrollment(p."workspaceId",p."siteId");
 IF e.id<>p."environmentId" THEN RAISE EXCEPTION 'EXPIRY_ENROLLMENT_CHANGED'; END IF;
 UPDATE public."ArtifactExpiryPlan" SET paused=true WHERE id=p.id RETURNING * INTO p;
 RETURN jsonb_build_object('planId',p.id,'paused',true);
END $$;

CREATE FUNCTION lyraseo_expiry.plan_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_EXPIRY_PLAN'; END IF;
 IF to_jsonb(NEW)-ARRAY['paused','rotation','classCursors'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['paused','rotation','classCursors'] OR (OLD.paused AND NOT NEW.paused) THEN RAISE EXCEPTION 'IMMUTABLE_EXPIRY_PLAN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_expiry_plan BEFORE UPDATE OR DELETE ON public."ArtifactExpiryPlan" FOR EACH ROW EXECUTE FUNCTION lyraseo_expiry.plan_immutable();
CREATE FUNCTION lyraseo_expiry.item_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['currentPlanId','status','attemptSequence','token','workerTokenHash','leaseUntil','nextRetryAt','completedAt'] IS DISTINCT FROM
    to_jsonb(OLD)-ARRAY['currentPlanId','status','attemptSequence','token','workerTokenHash','leaseUntil','nextRetryAt','completedAt'] OR
    NEW."attemptSequence"<OLD."attemptSequence" THEN RAISE EXCEPTION 'IMMUTABLE_EXPIRY_ITEM'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_expiry_item BEFORE UPDATE ON public."ArtifactExpiryItem" FOR EACH ROW EXECUTE FUNCTION lyraseo_expiry.item_identity();
CREATE FUNCTION lyraseo_expiry.event_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_EXPIRY_EVENT'; END $$;
CREATE TRIGGER immutable_expiry_event BEFORE UPDATE OR DELETE ON public."ArtifactExpiryEvent" FOR EACH ROW EXECUTE FUNCTION lyraseo_expiry.event_immutable();

-- Final audit read ticket linearizes after target, exact blob and ref locks.
-- Buffered bytes are returned by the caller only after this last ticket succeeds.
CREATE OR REPLACE FUNCTION lyraseo_audit.source_ticket(s text,id_ text,url text,epoch integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w_id text; st_id text; result_deadline timestamp; b public."ArtifactBlob"; f public."ArtifactRef"; BEGIN
 IF session_user<>'lyraseo_runtime' THEN RETURN NULL; END IF;
 SELECT id INTO w_id FROM public."Workspace" WHERE id=current_setting('app.workspace_id',true) AND "deletedAt" IS NULL FOR SHARE;
 IF w_id IS NULL THEN RETURN NULL; END IF;
 SELECT id INTO st_id FROM public."Site" WHERE ("workspaceId",id)=(w_id,s) AND "deletedAt" IS NULL FOR SHARE;
 IF st_id IS NULL THEN RETURN NULL; END IF;
 SELECT "resultExpiresAt" INTO result_deadline FROM public."AuditRun" WHERE ("workspaceId","siteId",id)=(w_id,s,id_) FOR SHARE;
 IF result_deadline IS NULL OR result_deadline<=clock_timestamp() AT TIME ZONE 'UTC' OR NOT EXISTS(
   SELECT FROM public."ProductUser" u JOIN public."Membership" m ON (m."workspaceId",m."userId")=(w_id,u.id)
   WHERE u.id=current_setting('app.actor_id',true) AND NOT u.suspended AND u."securityVersion"=epoch AND
    (m.role IN ('OWNER','ADMIN') OR EXISTS(SELECT FROM public."SiteGrant" g WHERE (g."workspaceId",g."siteId",g."userId")=(w_id,s,u.id)))
 ) THEN RETURN NULL; END IF;
 -- Discover the live reference without locking it; then lock its exact blob before
 -- locking and rechecking that same reference, preserving target -> blob -> ref.
 SELECT b0.* INTO b FROM public."ArtifactBlob" b0 WHERE b0.id=(
   SELECT f0."blobId" FROM public."ArtifactRef" f0 JOIN public."ArtifactBlob" candidate
    ON candidate.id=f0."blobId" AND candidate.generation=f0.generation
   WHERE (f0."workspaceId",f0."siteId",f0."auditId")=(w_id,s,id_)
    AND f0."ownerKind"='AUDIT_PAGE' AND candidate."requestedUrl"=url AND candidate.state='READY'
 ) AND b0."workspaceId"=w_id AND b0."siteId"=s AND b0."auditId"=id_ AND b0."ownerKind"='AUDIT_PAGE' FOR SHARE;
 IF b.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO f FROM public."ArtifactRef" WHERE "blobId"=b.id AND generation=b.generation AND
  ("workspaceId","siteId","auditId")=(w_id,s,id_) FOR SHARE;
 IF f.id IS NULL OR b.state<>'READY' OR least(f."expiresAt",result_deadline)<=clock_timestamp() AT TIME ZONE 'UTC' THEN RETURN NULL; END IF;
 RETURN lyraseo_audit.version_descriptor(b)||jsonb_build_object('refId',f.id,'sourcePageId',f."pageId",'factHash',b."factHash",'capturedAt',f."capturedAt",'expiresAt',least(f."expiresAt",result_deadline));
END $$;

CREATE OR REPLACE FUNCTION lyraseo_observation.ticket(s text,id_ text,prompt_ text,epoch integer,session_ text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."VisibilityRecording"; sl public."VisibilityObservationSlot"; f public."ArtifactRef"; b public."ArtifactBlob"; result_deadline timestamp; BEGIN
 PERFORM lyraseo_observation.scope_guard(s,epoch,session_,false);
 SELECT * INTO r FROM public."VisibilityRecording" WHERE ("workspaceId","siteId","runId")=(current_setting('app.workspace_id',true),s,id_) FOR SHARE;
 IF NOT FOUND OR r.state<>'FINALIZED' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT "resultExpiresAt" INTO result_deadline FROM public."VisibilityRun" WHERE id=id_;
 IF result_deadline<=clock_timestamp() AT TIME ZONE 'UTC' THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
 SELECT * INTO sl FROM public."VisibilityObservationSlot" WHERE ("recordingId","promptId")=(r.id,prompt_);
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF r."retiredAt" IS NOT NULL OR sl.disposition IN ('RETIRED','CANCELLED') THEN RETURN jsonb_build_object('state','rights-unavailable','reason','RIGHTS_RETIRED'); END IF;
 IF sl."rawExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN RETURN jsonb_build_object('state','expired','reason','RAW_EXPIRED'); END IF;
 IF sl.disposition='NO_BODY' THEN RETURN jsonb_build_object('state','not-retained','reason','NO_BODY'); END IF;
 SELECT * INTO b FROM public."ArtifactBlob" WHERE ("recordingId","promptId")=(r.id,prompt_) FOR SHARE;
 SELECT * INTO f FROM public."ArtifactRef" WHERE "blobId"=b.id AND "ownerKind"='VISIBILITY_SLOT' FOR SHARE;
 IF b.state IS DISTINCT FROM 'READY' OR f.id IS NULL OR
    least(sl."rawExpiresAt",f."expiresAt",result_deadline)<=clock_timestamp() AT TIME ZONE 'UTC' THEN
  RETURN jsonb_build_object('state','unavailable','reason','NO_LICENSED_REF'); END IF;
 RETURN jsonb_build_object('state','retained-parsed','reason','READY','version',lyraseo_audit.version_descriptor(b),'refId',f.id,'runId',r."runId",'panelId',r."panelId",'promptId',sl."promptId",'factDigest',sl."factDigest",'sourceBinding',r."sourceBinding",'manifestHash',r."manifestHash",'observedAt',sl."observedAt" AT TIME ZONE 'UTC','deadline',least(sl."rawExpiresAt",f."expiresAt",result_deadline) AT TIME ZONE 'UTC','actor',current_setting('app.actor_id',true),'epoch',epoch,'session',session_,'representation','ANSWER_PARSED_JSON_V1','producerClass','CONTROLLED_FIXTURE_V1','originalProviderWire',false);
END $$;

-- The login sees named bounded entry points only. Helpers and tables remain private.
DO $$ DECLARE f record; BEGIN FOR f IN SELECT oid::regprocedure fn FROM pg_proc WHERE pronamespace='lyraseo_expiry'::regnamespace LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_expiry_owner',f.fn);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.fn);
 END LOOP; END $$;
GRANT EXECUTE ON FUNCTION lyraseo_expiry.preview(jsonb,integer,text),lyraseo_expiry.record_plan(jsonb,jsonb,text),
 lyraseo_expiry.claim(jsonb,uuid,uuid,text),lyraseo_expiry.record_pending(uuid,uuid,text),lyraseo_expiry.complete(uuid,jsonb),
 lyraseo_expiry.reconcile_claim(jsonb,uuid,uuid,text),lyraseo_expiry.next_items(jsonb,uuid,text,integer,uuid),
 lyraseo_expiry.status(jsonb,uuid),lyraseo_expiry.pause(jsonb,uuid)
 TO lyraseo_artifact_maintenance;
COMMIT;


