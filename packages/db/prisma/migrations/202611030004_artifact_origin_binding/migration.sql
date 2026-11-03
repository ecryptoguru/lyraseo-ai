BEGIN;
-- LOCAL_TEST_ONLY. Additive origin assertions; no backfill, lifecycle, expiry or role changes.
CREATE SCHEMA lyraseo_origin;
REVOKE ALL ON SCHEMA lyraseo_origin FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_origin TO lyraseo_kernel_owner,lyraseo_runtime,lyraseo_dispatch;
CREATE TABLE lyraseo_origin.store_registration (
 id uuid PRIMARY KEY, root_identity jsonb NOT NULL UNIQUE,
 assertion_version text NOT NULL CHECK(assertion_version='STORE_ORIGIN_V1'),
 backend text NOT NULL CHECK(backend='POSIX_FD_V1'),
 qualification text NOT NULL CHECK(qualification='LOCAL_TEST_ONLY'),
 provenance_digest text NOT NULL CHECK(provenance_digest ~ '^[a-f0-9]{64}$'),
 CHECK(jsonb_typeof(root_identity)='object' AND root_identity ?& ARRAY['identity','stamp','instance'])
);
-- Historical metadata is independent of live verifier secret lifetime and revocation.
CREATE TABLE lyraseo_origin.source_store_key (
 key_id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES lyraseo_origin.store_registration(id),
 provenance_digest text NOT NULL CHECK(provenance_digest ~ '^[a-f0-9]{64}$')
);
CREATE TABLE lyraseo_origin.store_namespace (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES lyraseo_origin.store_registration(id),
 workspace_id text NOT NULL, namespace_identity jsonb NOT NULL,
 provenance_digest text NOT NULL CHECK(provenance_digest ~ '^[a-f0-9]{64}$'),
 UNIQUE(store_id,workspace_id), UNIQUE(store_id,id,workspace_id),
 CHECK(jsonb_typeof(namespace_identity)='object' AND namespace_identity ?& ARRAY['identity','stamp'])
);
ALTER TABLE public."ArtifactBlob" ADD UNIQUE(id,generation,"workspaceId");
CREATE TABLE lyraseo_origin.blob_store_binding (
 blob_id uuid PRIMARY KEY, generation uuid NOT NULL, workspace_id text NOT NULL,
 store_id uuid NOT NULL REFERENCES lyraseo_origin.store_registration(id), namespace_id uuid NOT NULL,
 assertion_version text NOT NULL CHECK(assertion_version='STORE_ORIGIN_V1'),
 provenance_digest text NOT NULL CHECK(provenance_digest ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(blob_id,generation,workspace_id) REFERENCES public."ArtifactBlob"(id,generation,"workspaceId"),
 FOREIGN KEY(store_id,namespace_id,workspace_id) REFERENCES lyraseo_origin.store_namespace(store_id,id,workspace_id)
);
CREATE FUNCTION lyraseo_origin.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_ARTIFACT_ORIGIN'; END $$;
DO $$ DECLARE t text; restricted text; BEGIN
 FOREACH t IN ARRAY ARRAY['store_registration','source_store_key','store_namespace','blob_store_binding'] LOOP
  EXECUTE format('ALTER TABLE lyraseo_origin.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE lyraseo_origin.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY kernel_read ON lyraseo_origin.%I FOR SELECT TO lyraseo_kernel_owner USING(true)',t);
  EXECUTE format('REVOKE ALL ON lyraseo_origin.%I FROM PUBLIC,lyraseo_runtime,lyraseo_dispatch,lyraseo_identity',t);
  FOREACH restricted IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT FROM pg_roles WHERE rolname=restricted) THEN EXECUTE format('REVOKE ALL ON lyraseo_origin.%I FROM %I',t,restricted); END IF;
  END LOOP;
  EXECUTE format('CREATE TRIGGER immutable_origin BEFORE UPDATE OR DELETE ON lyraseo_origin.%I FOR EACH ROW EXECUTE FUNCTION lyraseo_origin.immutable()',t);
  EXECUTE format('GRANT SELECT ON lyraseo_origin.%I TO lyraseo_kernel_owner',t);
 END LOOP;
END $$;
CREATE POLICY kernel_bind ON lyraseo_origin.blob_store_binding FOR INSERT TO lyraseo_kernel_owner WITH CHECK(true);
GRANT INSERT ON lyraseo_origin.blob_store_binding TO lyraseo_kernel_owner;

-- Only named guarded callers supply authoritative workspace IDs. No runtime resolver grant.
CREATE FUNCTION lyraseo_origin.descriptor(w text,key_ text) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE result_ text; BEGIN
 SELECT jsonb_build_object('assertionVersion',r.assertion_version,'qualification',r.qualification,'backend',r.backend,
 'storeId',r.id,'root',r.root_identity,'namespaceId',n.id,'workspaceId',n.workspace_id,'namespace',n.namespace_identity)::text INTO result_
 FROM lyraseo_origin.source_store_key k JOIN lyraseo_origin.store_registration r ON r.id=k.store_id
 JOIN lyraseo_origin.store_namespace n ON n.store_id=r.id AND n.workspace_id=w
 JOIN lyraseo_audit.artifact_verifier v ON v.id=k.key_id
 WHERE k.key_id::text=key_ AND v.db_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND v.started=pg_postmaster_start_time();
 IF result_ IS NULL OR NOT lyraseo_kernel.is_test_database() THEN RAISE EXCEPTION 'ARTIFACT_ORIGIN_REQUIRED'; END IF;
 RETURN result_;
END $$;
CREATE FUNCTION lyraseo_origin.verify_mac(w text,purpose text,binding text,data_ json,sig json) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE origin_ text; BEGIN
 IF sig->>'keyId' IS NULL OR sig->>'mac' IS NULL THEN RAISE EXCEPTION 'CONFIRMATION_REQUIRED'; END IF;
 origin_:=lyraseo_origin.descriptor(w,sig->>'keyId');
 IF sig->>'origin' IS DISTINCT FROM origin_ THEN RAISE EXCEPTION 'ARTIFACT_ORIGIN_REQUIRED'; END IF;
 PERFORM lyraseo_audit.verify_artifact_mac(purpose,binding||chr(10)||origin_,data_,sig);
 RETURN origin_;
END $$;
CREATE FUNCTION lyraseo_origin.blob_descriptor(b public."ArtifactBlob") RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('assertionVersion',r.assertion_version,'qualification',r.qualification,'backend',r.backend,
 'storeId',r.id,'root',r.root_identity,'namespaceId',n.id,'workspaceId',n.workspace_id,'namespace',n.namespace_identity)::text
 FROM lyraseo_origin.blob_store_binding x JOIN lyraseo_origin.store_registration r ON r.id=x.store_id JOIN lyraseo_origin.store_namespace n ON n.id=x.namespace_id
 WHERE x.blob_id=b.id AND x.generation=b.generation AND x.workspace_id=b."workspaceId"
$$;
CREATE FUNCTION lyraseo_origin.bind_blob(b public."ArtifactBlob",key_ text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE origin_ text:=lyraseo_origin.descriptor(b."workspaceId",key_); BEGIN
 INSERT INTO lyraseo_origin.blob_store_binding(blob_id,generation,workspace_id,store_id,namespace_id,assertion_version,provenance_digest)
 VALUES(b.id,b.generation,b."workspaceId",(origin_::jsonb->>'storeId')::uuid,(origin_::jsonb->>'namespaceId')::uuid,'STORE_ORIGIN_V1',
 encode(sha256(convert_to(jsonb_build_array('STORE_ORIGIN_V1',b.id,b.generation,b."workspaceId",origin_::jsonb)::text,'UTF8')),'hex'));
END $$;
CREATE FUNCTION lyraseo_origin.require_blob(b public."ArtifactBlob",origin_ text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF origin_ IS NULL OR lyraseo_origin.blob_descriptor(b) IS DISTINCT FROM origin_ THEN RAISE EXCEPTION 'ARTIFACT_ORIGIN_REQUIRED'; END IF;
END $$;

CREATE FUNCTION lyraseo_origin.web_context(s text,id_ text,epoch integer,fence_ integer,key_ text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public."AuditRun"; BEGIN
 IF session_user<>'lyraseo_runtime' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 a:=lyraseo_audit.audit_transition_guard(current_setting('app.workspace_id',true),s,id_,current_setting('app.actor_id',true),epoch,'LOCAL_RAW_V1','prepare',fence_);
 RETURN lyraseo_origin.descriptor(a."workspaceId",key_);
END $$;
CREATE FUNCTION lyraseo_origin.step_context(rid uuid,proof text,key_ text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p lyraseo_audit.attempt; a public."AuditRun"; BEGIN
 p:=lyraseo_audit.checked_attempt(rid,proof); a:=lyraseo_audit.read_target(p.audit_id);
 RETURN lyraseo_origin.descriptor(a."workspaceId",key_);
END $$;
CREATE FUNCTION lyraseo_origin.observation_context(s text,panel_ text,epoch integer,session_ text,key_ text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."VisibilityPanel"; BEGIN
 PERFORM lyraseo_observation.source_context(s,panel_,epoch,session_);
 SELECT * INTO STRICT p FROM public."VisibilityPanel" WHERE id=panel_ AND "workspaceId"=current_setting('app.workspace_id',true) AND "siteId"=s;
 RETURN lyraseo_origin.descriptor(p."workspaceId",key_);
END $$;
CREATE OR REPLACE FUNCTION lyraseo_audit.version_descriptor(b public."ArtifactBlob") RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('workspaceId',b."workspaceId",'storageKey',b."storageKey",'generation',b.generation,'codec',b.codec,
 'sourceHash',b."sourceHash",'sourceLength',b."sourceLength",'storedHash',b."storedHash",'storedLength',b."storedLength") || CASE WHEN lyraseo_origin.blob_descriptor(b) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('origin',lyraseo_origin.blob_descriptor(b)) END
$$;
CREATE OR REPLACE FUNCTION lyraseo_audit.reserve_artifact(a public."AuditRun", context_ text, work_ uuid, generation_ integer, data_ json) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prov json:=data_->'provenance'; ev json:=data_->'evidence'; fact text; stamp timestamp; b public."ArtifactBlob"; n integer; inserted_ uuid; origin_ text;
BEGIN
 IF lyraseo_audit.storage_mode(a.id) IS NULL THEN RETURN jsonb_build_object('legacy',true); END IF;
 fact:=lyraseo_audit.artifact_attestation(a,data_);
 IF (ev->>'acquired')::boolean=false THEN
  IF EXISTS(SELECT FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=ev->>'requestedUrl' AND
   ((work_ IS NULL AND fence=a.fence) OR ("workId","workGeneration")=(work_,generation_))) THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
 origin_:=lyraseo_origin.verify_mac(a."workspaceId",'audit-origin-v1',context_,data_,data_->'originAssertion');
  IF (prov::jsonb ? 'rawHtml') OR ev::jsonb IS DISTINCT FROM lyraseo_audit.artifact_scratch(ev::jsonb) THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
  IF work_ IS NULL OR NOT EXISTS(SELECT FROM lyraseo_audit.unavailable_observation WHERE (work_id,generation,url,audit_id,fact_hash)=(work_,generation_,ev->>'requestedUrl',a.id,fact)) THEN
   PERFORM lyraseo_origin.verify_mac(a."workspaceId",'audit-observation-v1',context_,data_,data_->'captureConfirmation');
  END IF;
  IF work_ IS NOT NULL THEN
   INSERT INTO lyraseo_audit.unavailable_observation VALUES(work_,generation_,ev->>'requestedUrl',a.id,fact,
    ((prov->>'acquiredAt')::timestamptz AT TIME ZONE 'UTC')+interval '30 days',jsonb_build_object('evidence',ev::jsonb,'provenance',prov::jsonb))
   ON CONFLICT DO NOTHING;
   IF NOT EXISTS(SELECT FROM lyraseo_audit.unavailable_observation WHERE (work_id,generation,url,audit_id,fact_hash)=(work_,generation_,ev->>'requestedUrl',a.id,fact)) THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
  END IF;
  RETURN jsonb_build_object('origin',origin_,'version',null,'binding',lyraseo_audit.confirmation_binding(a,context_,work_,generation_,ev->>'requestedUrl',prov->>'acquiredAt',fact,b));
 END IF;
 IF EXISTS(SELECT FROM lyraseo_audit.unavailable_observation WHERE (work_id,generation,url)=(work_,generation_,ev->>'requestedUrl')) THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
 IF EXISTS(SELECT FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=ev->>'requestedUrl' AND "factHash"<>fact AND
    ((work_ IS NULL AND "workId" IS NULL AND fence=a.fence) OR ("workId","workGeneration")=(work_,generation_))) THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
 origin_:=lyraseo_origin.verify_mac(a."workspaceId",'audit-origin-v1',context_,data_,data_->'originAssertion');
 IF NOT EXISTS(SELECT FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=ev->>'requestedUrl' AND "factHash"=fact AND
   ((work_ IS NULL AND "workId" IS NULL AND fence=a.fence) OR ("workId","workGeneration")=(work_,generation_))) THEN
  PERFORM lyraseo_origin.verify_mac(a."workspaceId",'audit-observation-v1',context_,data_,data_->'captureConfirmation');
 END IF;
 stamp:=(prov->>'acquiredAt')::timestamptz AT TIME ZONE 'UTC'; n:=octet_length(prov->>'rawHtml');
 INSERT INTO public."ArtifactBlob" ("workspaceId","siteId","auditId","requestedUrl",fence,"workId","workGeneration","capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength","pendingReceipt")
 VALUES(a."workspaceId",a."siteId",a.id,ev->>'requestedUrl',a.fence,work_,generation_,stamp,stamp+interval '30 days',fact,prov->>'sha256',n,prov->>'sha256',n,
  CASE WHEN work_ IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object('channel','raw-http','requestedUrl',ev->>'requestedUrl','finalUrl',prov->>'finalUrl','status',(prov->>'status')::integer,'acquiredAt',prov->>'acquiredAt',
  'headers',jsonb_build_object('content-type',prov#>>'{headers,content-type}','link',prov#>>'{headers,link}','x-robots-tag',prov#>>'{headers,x-robots-tag}','last-modified',prov#>>'{headers,last-modified}'),
  'redirects',(prov->'redirects')::jsonb,'sha256',prov->>'sha256')) || jsonb_build_object('robotsPolicy',(prov->'robotsPolicy')::jsonb) END)
 ON CONFLICT DO NOTHING RETURNING id INTO inserted_;
 SELECT * INTO STRICT b FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=ev->>'requestedUrl' AND
 ((work_ IS NULL AND fence=a.fence) OR ("workId","workGeneration")=(work_,generation_)) FOR UPDATE;
 IF b."factHash"<>fact OR (b."workId",b."workGeneration") IS DISTINCT FROM (work_,generation_) OR b.state NOT IN ('STAGED','READY')
 THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
 IF inserted_ IS NOT NULL THEN PERFORM lyraseo_origin.bind_blob(b,data_->'originAssertion'->>'keyId'); END IF;
 PERFORM lyraseo_origin.require_blob(b,origin_);
 RETURN jsonb_build_object('origin',origin_,'version',lyraseo_audit.version_descriptor(b),'binding',lyraseo_audit.confirmation_binding(a,context_,work_,generation_,ev->>'requestedUrl',prov->>'acquiredAt',fact,b));
END $$;
CREATE OR REPLACE FUNCTION lyraseo_audit.artifact_checkpoint(a public."AuditRun", data_ json) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE fact text; ev jsonb; prov jsonb; url text; old public."AuditPage"; b public."ArtifactBlob"; page_ text;
 clock_ public."AuditPageRetention"; compact jsonb; pol jsonb; scratch jsonb; ref_id uuid; attempt_ lyraseo_audit.attempt; context_ text;
BEGIN
 fact:=lyraseo_audit.artifact_attestation(a,data_); ev:=(data_->'evidence')::jsonb; prov:=(data_->'provenance')::jsonb; url:=ev->>'requestedUrl'; pol:=prov->'robotsPolicy';
 IF data_->>'storageFormat' IS DISTINCT FROM 'AUDIT_PRIVATE_V1' THEN RAISE EXCEPTION 'ARTIFACT_REQUIRED'; END IF;
 IF (ev->>'acquired')::boolean THEN
  SELECT * INTO b FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=url AND
   ((session_user='lyraseo_runtime' AND "workId" IS NULL AND fence=a.fence) OR
   (session_user='lyraseo_dispatch' AND ("workId","workGeneration") IN (SELECT work_id,generation FROM lyraseo_audit.attempt p
     WHERE p.principal=session_user AND p.audit_id=a.id AND p.audit_fence=a.fence AND p.url=ev->>'requestedUrl'))) FOR UPDATE;
  IF b.id IS NULL OR b."factHash"<>fact OR b.state NOT IN ('STAGED','READY') OR b."expiresAt"<=clock_timestamp() AT TIME ZONE 'UTC'
   OR (data_->'version')::jsonb IS DISTINCT FROM lyraseo_audit.version_descriptor(b) THEN RAISE EXCEPTION 'INVALID_ARTIFACT'; END IF;
 ELSIF (data_->'version')::jsonb IS DISTINCT FROM 'null'::jsonb OR EXISTS (SELECT FROM public."ArtifactBlob" b0 WHERE b0."auditId"=a.id AND b0."requestedUrl"=url
  AND (b0.fence=a.fence OR (b0."workId",b0."workGeneration") IN (SELECT work_id,generation FROM lyraseo_audit.attempt p WHERE p.principal=session_user AND p.audit_id=a.id AND p.audit_fence=a.fence))) THEN RAISE EXCEPTION 'INVALID_ARTIFACT'; END IF;
 IF session_user='lyraseo_dispatch' THEN
  SELECT * INTO STRICT attempt_ FROM lyraseo_audit.attempt p WHERE p.audit_id=a.id AND p.audit_fence=a.fence AND p.url=ev->>'requestedUrl' AND p.principal=session_user;
  context_:='step/'||attempt_.request_id;
  IF b.id IS NULL AND NOT EXISTS(SELECT FROM lyraseo_audit.unavailable_observation u WHERE (u.work_id,u.generation,u.url,u.audit_id,u.fact_hash)=(attempt_.work_id,attempt_.generation,attempt_.url,a.id,fact)) THEN RAISE EXCEPTION 'CONFIRMATION_REQUIRED'; END IF;
 ELSE context_:='web/'||a.id||'/'||a.fence; END IF;
 PERFORM lyraseo_origin.verify_mac(a."workspaceId",'audit-publication-v1',lyraseo_audit.confirmation_binding(a,context_,attempt_.work_id,attempt_.generation,url,prov->>'acquiredAt',fact,b),data_,data_->'confirmation');
 IF b.id IS NOT NULL THEN PERFORM lyraseo_origin.require_blob(b,lyraseo_origin.descriptor(a."workspaceId",data_->'confirmation'->>'keyId')); END IF;
 SELECT id,provenance INTO old.id,old.provenance FROM public."AuditPage" WHERE ("auditId","requestedUrl")=(a.id,url);
 IF FOUND THEN IF old.provenance->>'factHash' IS DISTINCT FROM fact THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF; RETURN old.id; END IF;
 scratch:=lyraseo_audit.artifact_scratch(ev);
 IF b.id IS NOT NULL THEN ref_id:=gen_random_uuid(); END IF;
 compact:=jsonb_strip_nulls(jsonb_build_object('storageFormat','AUDIT_PRIVATE_V1','factHash',fact,'sourceRef',CASE WHEN ref_id IS NOT NULL THEN jsonb_build_object('id',ref_id,'blobId',b.id,'generation',b.generation) END,'channel','raw-http','requestedUrl',url,
 'acquiredAt',prov->>'acquiredAt','sha256',prov->>'sha256','status',(prov->>'status')::integer,'error',prov->>'error','finalUrl',prov->>'finalUrl',
 'redirects',(SELECT jsonb_agg(v ORDER BY ord) FROM jsonb_array_elements(coalesce(prov->'redirects','[]')) WITH ORDINALITY r(v,ord)
   WHERE jsonb_typeof(v)='string' AND octet_length(v::text)<=8194 AND ord<=8),
 'robotsPolicy',jsonb_build_object('requestedUrl',pol->>'requestedUrl','finalUrl',pol->>'finalUrl','acquiredAt',pol->>'acquiredAt','status',(pol->>'status')::integer,
 'sha256',pol->>'sha256','state',pol->>'state','groupAgent',pol#>>'{googleGroup,agent}','ruleCount',CASE WHEN jsonb_typeof(pol#>'{googleGroup,rules}')='array' THEN jsonb_array_length(pol#>'{googleGroup,rules}') END,
 'requested',CASE WHEN pol ? 'requested' THEN jsonb_build_object('url',pol#>>'{requested,url}','allowed',(pol#>>'{requested,allowed}')::boolean) END,
 'final',CASE WHEN pol ? 'final' THEN jsonb_build_object('url',pol#>>'{final,url}','allowed',(pol#>>'{final,allowed}')::boolean) END)));
 page_:=coalesce(b."pageId",gen_random_uuid())::text;
 INSERT INTO public."AuditPage"(id,"workspaceId","auditId","requestedUrl",evidence,provenance)
 VALUES(page_,a."workspaceId",a.id,url,jsonb_strip_nulls(jsonb_build_object('requestedUrl',url,'acquired',ev->'acquired','status',(ev->>'status')::integer,'headComplete',false,'bodyComplete',false)),compact);
 SELECT * INTO STRICT clock_ FROM public."AuditPageRetention" WHERE "pageId"=page_;
 IF clock_."rawExpiresAt" IS NULL OR clock_."rawExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
 IF b.id IS NOT NULL THEN
  UPDATE public."ArtifactBlob" SET state='READY',"pendingReceipt"=NULL WHERE id=b.id;
  INSERT INTO public."ArtifactRef"(id,"workspaceId","siteId","auditId","pageId","slotPageId","blobId",generation,"capturedAt","expiresAt",anchors)
   VALUES(ref_id,a."workspaceId",a."siteId",a.id,page_,b."pageId",b.id,b.generation,clock_."capturedAt",clock_."rawExpiresAt",
    (SELECT coalesce(jsonb_agg(jsonb_build_object('href',link->>'href','name',link->>'name') ORDER BY ord),'[]') FROM jsonb_array_elements(ev->'linkNames') WITH ORDINALITY l(link,ord)
      WHERE ord<=100 AND jsonb_typeof(link->'name')='string' AND length(link->>'name') BETWEEN 1 AND 500 AND btrim(link->>'name')<>'' AND jsonb_typeof(link->'href')='string'
      AND a.manifest ? (link->>'href') AND url<>link->>'href'));
 END IF;
 INSERT INTO public."AuditEvaluationScratch" VALUES(a."workspaceId",a.id,page_,clock_."rawExpiresAt",scratch);
 IF attempt_.work_id IS NOT NULL AND b.id IS NULL THEN DELETE FROM lyraseo_audit.unavailable_observation u WHERE (u.work_id,u.generation,u.url)=(attempt_.work_id,attempt_.generation,attempt_.url); END IF;
 RETURN page_;
END $$;
CREATE OR REPLACE FUNCTION lyraseo_observation.reservation(r public."VisibilityRecording") RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('origin',(SELECT lyraseo_origin.blob_descriptor(b) FROM public."ArtifactBlob" b WHERE b."recordingId"=r.id ORDER BY b.id LIMIT 1),'id',r.id,'runId',r."runId",'state',r.state,'proof',r.proof,'binding',lyraseo_observation.publication_binding(r),'versions',
 (SELECT coalesce(jsonb_agg(jsonb_build_object('promptId',s."promptId",'version',CASE WHEN b.id IS NOT NULL THEN lyraseo_audit.version_descriptor(b) END) ORDER BY s."promptId"),'[]') FROM public."VisibilityObservationSlot" s LEFT JOIN public."ArtifactBlob" b ON b."recordingId"=r.id AND b."promptId"=s."promptId" WHERE s."recordingId"=r.id))
$$;
CREATE OR REPLACE FUNCTION lyraseo_observation.reserve(s text,panel_ text,epoch integer,session_ text,namespace_ text,key_ text,data_ json,sig json) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE origin_ text; b_ public."ArtifactBlob"; ctx text; r public."VisibilityRecording"; p public."VisibilityPanel"; slot_ jsonb; m jsonb:=(data_->'evidence')::jsonb; mh text:=encode(sha256(convert_to((data_->'evidence')::text,'UTF8')),'hex'); BEGIN
 ctx:=lyraseo_observation.source_context(s,panel_,epoch,session_);
 IF namespace_ IS DISTINCT FROM 'CONTROLLED_FIXTURE_V1' OR key_ IS NULL OR key_ !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR (data_->'provenance')::jsonb IS DISTINCT FROM lyraseo_observation.source_provenance(panel_,namespace_,key_) THEN RAISE EXCEPTION 'UNSUPPORTED_OBSERVATION_SOURCE'; END IF;
 SELECT * INTO p FROM public."VisibilityPanel" WHERE id=panel_;
 origin_:=lyraseo_origin.verify_mac(p."workspaceId",'observation-fixture-source-v1',ctx,data_,sig);
 SELECT * INTO r FROM public."VisibilityRecording" WHERE ("workspaceId","siteId","sourceNamespace","recordingKey")=(p."workspaceId",s,namespace_,key_) FOR UPDATE;
 IF FOUND THEN
 IF (r."panelId",r."userId",r."securityVersion",r."sessionId",r."sourceBinding",r."manifestHash") IS DISTINCT FROM (panel_,current_setting('app.actor_id',true),epoch,session_,ctx,mh) THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF;
 IF r.state='FINALIZED' THEN RETURN jsonb_build_object('id',r.id,'runId',r."runId",'state',r.state); END IF;
 IF r.state='CANCELLED' OR r."retiredAt" IS NOT NULL THEN RAISE EXCEPTION 'OBSERVATION_RETIRED'; END IF;
 PERFORM lyraseo_observation.validate_manifest(p,m);
 ELSE
 PERFORM lyraseo_observation.validate_manifest(p,m);

 INSERT INTO public."VisibilityRecording"("workspaceId","siteId","panelId","userId","securityVersion","sessionId","sourceNamespace","recordingKey","sourceBinding","manifestHash",manifest,"observedAt","rawExpiresAt") VALUES(p."workspaceId",s,panel_,current_setting('app.actor_id',true),epoch,session_,namespace_,key_,ctx,mh,m,(m->>'createdAt')::timestamptz AT TIME ZONE 'UTC',(m->>'rawExpiresAt')::timestamptz AT TIME ZONE 'UTC') RETURNING * INTO r;
 FOR slot_ IN SELECT * FROM jsonb_array_elements(m->'slots') LOOP
 INSERT INTO public."VisibilityObservationSlot"("workspaceId","siteId","panelId","runId","recordingId","promptId","observedAt","factDigest","answerHash","answerLength","rawExpiresAt",disposition) VALUES(r."workspaceId",s,panel_,r."runId",r.id,slot_->>'promptId',r."observedAt",slot_->>'factDigest',slot_->>'answerHash', (slot_->>'answerLength')::integer,r."rawExpiresAt",CASE WHEN slot_->'answerHash'='null'::jsonb THEN 'NO_BODY' ELSE 'STAGED' END);
 IF slot_->'answerHash'<>'null'::jsonb THEN
 INSERT INTO public."ArtifactBlob"("workspaceId","siteId","ownerKind","recordingId","runId","panelId","promptId",category,rights,"expiryClass","capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength","pageId") VALUES(r."workspaceId",s,'VISIBILITY_SLOT',r.id,r."runId",panel_,slot_->>'promptId','ANSWER_PARSED_JSON_V1','CONTROLLED_FIXTURE_V1','ANSWER_RIGHTS_90D',r."observedAt",r."rawExpiresAt",slot_->>'factDigest',slot_->>'answerHash',(slot_->>'answerLength')::integer,slot_->>'answerHash',(slot_->>'answerLength')::integer,NULL) RETURNING * INTO b_;
 PERFORM lyraseo_origin.bind_blob(b_,sig->>'keyId');
 END IF;
 END LOOP;
 END IF;
 -- A fresh reservation rotates the fencing proof, but never source clocks or object identities.
 UPDATE public."VisibilityRecording" SET proof=gen_random_uuid(),"proofExpiresAt"=clock_timestamp()+interval '5 minutes' WHERE id=r.id RETURNING * INTO r;
 IF EXISTS(SELECT FROM public."ArtifactBlob" WHERE "recordingId"=r.id AND state<>'STAGED') THEN RAISE EXCEPTION 'OBSERVATION_RETIRED'; END IF;
 FOR b_ IN SELECT * FROM public."ArtifactBlob" WHERE "recordingId"=r.id LOOP
 PERFORM lyraseo_origin.require_blob(b_,origin_);
 END LOOP;
 RETURN lyraseo_observation.reservation(r)||jsonb_build_object('origin',origin_);
END $$;
CREATE OR REPLACE FUNCTION lyraseo_observation.finalize(s text,id_ uuid,epoch integer,session_ text,proof_ uuid,data_ json,sig json) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."VisibilityRecording"; p public."VisibilityPanel"; b public."ArtifactBlob"; compact jsonb; BEGIN
 PERFORM lyraseo_observation.scope_guard(s,epoch,session_,true);
 SELECT * INTO r FROM public."VisibilityRecording" WHERE ("workspaceId","siteId",id)=(current_setting('app.workspace_id',true),s,id_) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF (r."userId",r."securityVersion",r."sessionId") IS DISTINCT FROM (current_setting('app.actor_id',true),epoch,session_) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF r.state<>'STAGED' OR r."retiredAt" IS NOT NULL THEN RAISE EXCEPTION 'OBSERVATION_RETIRED'; END IF;
 IF r.proof IS DISTINCT FROM proof_ OR r."proofExpiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'STALE_OBSERVATION_PROOF'; END IF;
 IF r."sourceBinding" IS DISTINCT FROM lyraseo_observation.source_context(s,r."panelId",epoch,session_) OR r."manifestHash" IS DISTINCT FROM encode(sha256(convert_to((data_->'evidence')::text,'UTF8')),'hex') OR (data_->'provenance')::jsonb IS DISTINCT FROM lyraseo_observation.source_provenance(r."panelId",r."sourceNamespace",r."recordingKey") THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF;
 SELECT * INTO p FROM public."VisibilityPanel" WHERE id=r."panelId";
 PERFORM lyraseo_observation.validate_manifest(p,r.manifest);
 -- Target first, then ordered physical generations, same order as retirement.
 PERFORM 1 FROM public."ArtifactBlob" WHERE "recordingId"=r.id ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT FROM public."VisibilityObservationSlot" sl LEFT JOIN public."ArtifactBlob" bl ON bl."recordingId"=sl."recordingId" AND bl."promptId"=sl."promptId" WHERE sl."recordingId"=r.id AND
 ((sl.disposition='STAGED' AND (bl.id IS NULL OR bl.state<>'STAGED' OR bl."sourceHash"<>sl."answerHash" OR bl."factHash"<>sl."factDigest")) OR sl.disposition NOT IN ('STAGED','NO_BODY'))) THEN RAISE EXCEPTION 'OBSERVATION_RETIRED'; END IF;
 IF (SELECT count(*) FROM public."VisibilityObservationSlot" WHERE "recordingId"=r.id)<>jsonb_array_length(r.manifest->'slots') THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 PERFORM lyraseo_origin.verify_mac(r."workspaceId",'observation-fixture-publication-v1',lyraseo_observation.publication_binding(r),data_,sig);
 FOR b IN SELECT * FROM public."ArtifactBlob" WHERE "recordingId"=r.id LOOP
 PERFORM lyraseo_origin.require_blob(b,lyraseo_origin.descriptor(r."workspaceId",sig->>'keyId'));
 END LOOP;
 SELECT jsonb_agg(v-ARRAY['answerHash','answerLength','factDigest'] ORDER BY n) INTO compact FROM jsonb_array_elements(r.manifest->'slots') WITH ORDINALITY q(v,n);
 INSERT INTO public."VisibilityRun"(id,"workspaceId","siteId","panelId",profile,cohort,provenance,slots,"rawAnswers","rawExpiresAt","createdAt","storageFormat") VALUES(r."runId",r."workspaceId",s,r."panelId",r.manifest->>'profile',r.manifest->>'cohort',r.manifest->'provenance',compact,NULL,r."rawExpiresAt",r."observedAt",'OBSERVATION_PRIVATE_V1');
 UPDATE public."VisibilityObservationSlot" SET disposition='READY' WHERE "recordingId"=r.id AND disposition='STAGED';
 FOR b IN SELECT * FROM public."ArtifactBlob" WHERE "recordingId"=r.id ORDER BY id LOOP
 UPDATE public."ArtifactBlob" SET state='READY' WHERE id=b.id;
 INSERT INTO public."ArtifactRef"("workspaceId","siteId","ownerKind","recordingId","runId","panelId","promptId",anchors,"blobId",generation,role,"capturedAt","expiresAt") VALUES(b."workspaceId",s,'VISIBILITY_SLOT',r.id,r."runId",r."panelId",b."promptId",'[]',b.id,b.generation,'ANSWER_PARSED_JSON_V1',b."capturedAt",b."expiresAt");
 END LOOP;
 UPDATE public."VisibilityRecording" SET state='FINALIZED' WHERE id=r.id;
 -- Wall clock after lock waits and immediately before returning publication.
 IF r."rawExpiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' OR r."proofExpiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
 PERFORM lyraseo_observation.scope_guard(s,epoch,session_,true);
 RETURN jsonb_build_object('id',r."runId",'storageFormat','OBSERVATION_PRIVATE_V1');
END $$;

DO $$ DECLARE f record; BEGIN FOR f IN SELECT oid::regprocedure fn FROM pg_proc WHERE pronamespace='lyraseo_origin'::regnamespace LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_kernel_owner',f.fn); EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.fn); END LOOP; END $$;
GRANT EXECUTE ON FUNCTION lyraseo_origin.web_context(text,text,integer,integer,text),lyraseo_origin.observation_context(text,text,integer,text,text) TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_origin.step_context(uuid,text,text) TO lyraseo_dispatch;
COMMIT;
