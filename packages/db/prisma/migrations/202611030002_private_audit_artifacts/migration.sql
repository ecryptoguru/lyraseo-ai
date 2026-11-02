BEGIN;
-- NULL is the original 017 checkpoint format, including existing active runs.
ALTER TABLE "AuditRun" ADD COLUMN "storageFormat" text CHECK ("storageFormat" IS NULL OR
 ("storageFormat"='AUDIT_PRIVATE_V1' AND profile IN ('LOCAL_RAW_V1','CONTROLLED_RAW_TEST_V1') AND "methodologyVersion"='readiness-v2'));
ALTER TABLE "AuditRun" ADD UNIQUE ("workspaceId","siteId",id);
GRANT SELECT("workspaceId") ON "AuditPage" TO lyraseo_kernel_owner;
GRANT SELECT("storageFormat","resultExpiresAt") ON "AuditRun" TO lyraseo_kernel_owner;

-- A separate operator-enrolled key verifies publication. The reserving DB roles cannot
-- enroll/read keys or mint confirmations. No keys are provisioned by this migration.
CREATE TABLE lyraseo_audit.artifact_verifier (
 id uuid PRIMARY KEY, secret bytea NOT NULL CHECK(octet_length(secret)=32),
 db_oid oid NOT NULL, started timestamptz NOT NULL
);
CREATE TABLE lyraseo_audit.unavailable_observation (
 work_id uuid NOT NULL REFERENCES public."WorkDispatch"(id) ON DELETE CASCADE, generation integer NOT NULL, url text NOT NULL,
 audit_id text NOT NULL REFERENCES public."AuditRun"(id) ON DELETE CASCADE, fact_hash text NOT NULL,
 expires_at timestamp NOT NULL, receipt jsonb NOT NULL CHECK(octet_length(receipt::text)<=524288 AND NOT ((receipt->'provenance') ? 'rawHtml')),
 PRIMARY KEY(work_id,generation,url)
);
CREATE INDEX ON lyraseo_audit.unavailable_observation(expires_at,work_id);
ALTER TABLE lyraseo_audit.artifact_verifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_audit.artifact_verifier FORCE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_audit.unavailable_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_audit.unavailable_observation FORCE ROW LEVEL SECURITY;
CREATE POLICY kernel_read ON lyraseo_audit.artifact_verifier FOR SELECT TO lyraseo_kernel_owner USING(true);
CREATE POLICY kernel_slot ON lyraseo_audit.unavailable_observation TO lyraseo_kernel_owner USING(true) WITH CHECK(true);
REVOKE ALL ON lyraseo_audit.artifact_verifier,lyraseo_audit.unavailable_observation FROM PUBLIC,lyraseo_runtime,lyraseo_dispatch,lyraseo_identity;
GRANT SELECT ON lyraseo_audit.artifact_verifier TO lyraseo_kernel_owner;
GRANT SELECT,INSERT,DELETE ON lyraseo_audit.unavailable_observation TO lyraseo_kernel_owner;

-- Use the installed extension-owned exact overload in its existing, trusted schema.
-- A new installation gets a private schema. Never relocate an existing extension.
DO $$ DECLARE crypto_schema name; crypto_oid oid; BEGIN
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_extension WHERE extname='pgcrypto') THEN
  CREATE SCHEMA lyraseo_artifact_crypto; REVOKE ALL ON SCHEMA lyraseo_artifact_crypto FROM PUBLIC;
  CREATE EXTENSION pgcrypto WITH SCHEMA lyraseo_artifact_crypto;
 END IF;
 SELECT n.nspname,e.oid INTO STRICT crypto_schema,crypto_oid FROM pg_catalog.pg_extension e
 JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';
 IF EXISTS(SELECT FROM pg_catalog.pg_namespace n,LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) acl
    WHERE n.nspname=crypto_schema AND acl.privilege_type='CREATE' AND (acl.grantee=0 OR acl.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','lyraseo_runtime','lyraseo_dispatch','lyraseo_identity'))))
 OR EXISTS(SELECT FROM pg_roles login_ CROSS JOIN pg_roles r WHERE login_.rolname IN ('anon','authenticated','lyraseo_runtime','lyraseo_dispatch','lyraseo_identity')
    AND pg_has_role(login_.oid,r.oid,'SET') AND has_schema_privilege(r.oid,crypto_schema,'CREATE'))
 OR NOT EXISTS (SELECT FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_extension'::regclass AND d.refobjid=crypto_oid AND d.deptype='e'
    AND d.classid='pg_proc'::regclass AND d.objid=to_regprocedure(format('%I.hmac(bytea,bytea,text)',crypto_schema)))
 THEN RAISE EXCEPTION 'UNTRUSTED_CRYPTO_SCHEMA'; END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO lyraseo_kernel_owner',crypto_schema);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.hmac(bytea,bytea,text) TO lyraseo_kernel_owner',crypto_schema);
 EXECUTE format($ddl$
 CREATE FUNCTION lyraseo_audit.verify_artifact_mac(purpose text,binding text,data_ json,sig json) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
 DECLARE expected bytea; supplied text:=sig->>'mac'; BEGIN
  IF supplied IS NULL OR supplied !~ '^[a-f0-9]{64}$' OR sig->>'keyId' IS NULL THEN RAISE EXCEPTION 'CONFIRMATION_REQUIRED'; END IF;
  SELECT %I.hmac(convert_to(purpose||chr(10)||binding||chr(10)||
   encode(sha256(convert_to((data_->'evidence')::text,'UTF8')),'hex')||chr(10)||
   encode(sha256(convert_to((data_->'provenance')::text,'UTF8')),'hex'),'UTF8'),k.secret,'sha256'::text)
   INTO expected FROM lyraseo_audit.artifact_verifier k WHERE k.id::text=sig->>'keyId'
   AND k.db_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND k.started=pg_postmaster_start_time();
  IF expected IS NULL OR sha256(decode(supplied,'hex'))<>sha256(expected) THEN RAISE EXCEPTION 'CONFIRMATION_REQUIRED'; END IF;
 END $body$ $ddl$,crypto_schema);
END $$;

CREATE TABLE "ArtifactBlob" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "workspaceId" text NOT NULL, "siteId" text NOT NULL, "auditId" text NOT NULL,
 "requestedUrl" text NOT NULL, "pageId" uuid NOT NULL DEFAULT gen_random_uuid(), fence integer NOT NULL,
 "workId" uuid, "workGeneration" integer,
 category text NOT NULL DEFAULT 'AUDIT_SOURCE' CHECK(category='AUDIT_SOURCE'),
 rights text NOT NULL DEFAULT 'PRIVATE_AUDIT' CHECK(rights='PRIVATE_AUDIT'),
 "expiryClass" text NOT NULL DEFAULT 'CAPTURE_30D' CHECK("expiryClass"='CAPTURE_30D'),
 "capturedAt" timestamp(3) NOT NULL, "expiresAt" timestamp(3) NOT NULL,
 "pendingReceipt" jsonb CHECK ("pendingReceipt" IS NULL OR (jsonb_typeof("pendingReceipt")='object' AND octet_length("pendingReceipt"::text)<=524288 AND NOT ("pendingReceipt" ? 'rawHtml'))),
 "factHash" text NOT NULL CHECK ("factHash" ~ '^[0-9a-f]{64}$'),
 "storageKey" uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), generation uuid NOT NULL DEFAULT gen_random_uuid(),
 codec text NOT NULL DEFAULT 'IDENTITY' CHECK(codec='IDENTITY'),
 "sourceHash" text NOT NULL CHECK("sourceHash" ~ '^[0-9a-f]{64}$'), "sourceLength" integer NOT NULL CHECK("sourceLength" BETWEEN 1 AND 5242880),
 "storedHash" text NOT NULL, "storedLength" integer NOT NULL,
 state text NOT NULL DEFAULT 'STAGED' CHECK(state IN ('STAGED','READY','ORPHAN','DELETED')),
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ("sourceHash"="storedHash" AND "sourceLength"="storedLength" AND "expiresAt"="capturedAt"+interval '30 days'
   AND ("workId" IS NULL)=("workGeneration" IS NULL)),
 UNIQUE ("auditId","requestedUrl",fence),
 UNIQUE ("workspaceId","siteId","auditId","pageId",id,generation,"capturedAt","expiresAt"),
 FOREIGN KEY ("workspaceId","siteId","auditId") REFERENCES "AuditRun"("workspaceId","siteId",id)
);
CREATE UNIQUE INDEX artifact_work_slot ON "ArtifactBlob"("workId","workGeneration","requestedUrl") WHERE "workId" IS NOT NULL;
CREATE INDEX ON "ArtifactBlob"("workspaceId",id);
CREATE INDEX ON "ArtifactBlob"(state,"expiresAt",id);
CREATE TABLE "ArtifactRef" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "workspaceId" text NOT NULL, "siteId" text NOT NULL, "auditId" text NOT NULL,
 anchors jsonb NOT NULL CHECK(jsonb_typeof(anchors)='array' AND jsonb_array_length(anchors)<=100 AND octet_length(anchors::text)<=524288),
 "pageId" text NOT NULL UNIQUE, "slotPageId" uuid NOT NULL, "blobId" uuid NOT NULL UNIQUE, generation uuid NOT NULL,
 "ownerKind" text NOT NULL DEFAULT 'AUDIT_PAGE' CHECK ("ownerKind"='AUDIT_PAGE'),
 role text NOT NULL DEFAULT 'ORIGINAL_BODY' CHECK(role='ORIGINAL_BODY'),
 "capturedAt" timestamp(3) NOT NULL, "expiresAt" timestamp(3) NOT NULL,
 CHECK ("pageId"="slotPageId"::text),
 FOREIGN KEY ("workspaceId","auditId","pageId") REFERENCES "AuditPageRetention"("workspaceId","auditId","pageId"),
 FOREIGN KEY ("workspaceId","siteId","auditId","slotPageId","blobId",generation,"capturedAt","expiresAt")
 REFERENCES "ArtifactBlob"("workspaceId","siteId","auditId","pageId",id,generation,"capturedAt","expiresAt")
);
CREATE INDEX ON "ArtifactRef"("workspaceId","auditId","pageId");
CREATE INDEX ON "ArtifactRef"("expiresAt",id);
CREATE TABLE "AuditEvaluationScratch" (
 "workspaceId" text NOT NULL, "auditId" text NOT NULL, "pageId" text NOT NULL,
 "expiresAt" timestamp(3) NOT NULL, facts jsonb NOT NULL, PRIMARY KEY ("workspaceId","auditId","pageId"),
 FOREIGN KEY ("workspaceId","auditId","pageId") REFERENCES "AuditPageRetention"("workspaceId","auditId","pageId"),
 CHECK(jsonb_typeof(facts)='object' AND octet_length(facts::text)<=524288)
);
CREATE INDEX ON "AuditEvaluationScratch"("expiresAt","pageId");
DO $$ DECLARE t text; restricted text; BEGIN
 FOREACH t IN ARRAY ARRAY['ArtifactBlob','ArtifactRef','AuditEvaluationScratch'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY artifact_owner ON %I TO lyraseo_kernel_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,lyraseo_runtime,lyraseo_dispatch,lyraseo_identity',t);
  FOREACH restricted IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT FROM pg_roles WHERE rolname=restricted) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,restricted); END IF;
  END LOOP;
 END LOOP;
END $$;
GRANT SELECT,INSERT ON "ArtifactBlob","ArtifactRef","AuditEvaluationScratch" TO lyraseo_kernel_owner;
GRANT UPDATE(state,"pendingReceipt") ON "ArtifactBlob" TO lyraseo_kernel_owner;
-- An UPDATE column privilege is required for row locking; no function updates ref identity.
GRANT UPDATE(id) ON "ArtifactRef" TO lyraseo_kernel_owner;
GRANT DELETE ON "AuditEvaluationScratch" TO lyraseo_kernel_owner;
GRANT SELECT ON "AuditPageRetention" TO lyraseo_kernel_owner;
CREATE POLICY artifact_clock ON "AuditPageRetention" FOR SELECT TO lyraseo_kernel_owner USING(true);

CREATE FUNCTION lyraseo_audit.enforce_source_deadline() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE saved public."AuditPageRetention"; BEGIN
 SELECT * INTO STRICT saved FROM public."AuditPageRetention" WHERE ("workspaceId","auditId","pageId")=(NEW."workspaceId",NEW."auditId",NEW."pageId");
 IF saved."rawExpiresAt" IS NULL OR NEW."expiresAt" IS DISTINCT FROM saved."rawExpiresAt" THEN RAISE EXCEPTION 'INVALID_SOURCE_DEADLINE'; END IF;
 IF TG_TABLE_NAME='ArtifactRef' THEN
  IF NEW."capturedAt" IS DISTINCT FROM saved."capturedAt" OR NOT EXISTS(SELECT FROM public."ArtifactBlob" b JOIN public."AuditPage" p ON p.id=NEW."pageId"
     WHERE b.id=NEW."blobId" AND b.state='READY' AND b."requestedUrl"=p."requestedUrl") THEN RAISE EXCEPTION 'INVALID_SOURCE_BINDING'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_artifact_source BEFORE INSERT OR UPDATE ON "ArtifactRef" FOR EACH ROW EXECUTE FUNCTION lyraseo_audit.enforce_source_deadline();
CREATE TRIGGER bind_scratch_clock BEFORE INSERT OR UPDATE ON "AuditEvaluationScratch" FOR EACH ROW EXECUTE FUNCTION lyraseo_audit.enforce_source_deadline();
CREATE FUNCTION lyraseo_audit.storage_mode(id_ text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT "storageFormat" FROM public."AuditRun" WHERE id=id_
$$;
CREATE FUNCTION lyraseo_audit.storage_format_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN IF OLD."storageFormat" IS DISTINCT FROM NEW."storageFormat" THEN RAISE EXCEPTION 'IMMUTABLE_STORAGE_FORMAT'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_audit_storage BEFORE UPDATE OF "storageFormat" ON "AuditRun" FOR EACH ROW EXECUTE FUNCTION lyraseo_audit.storage_format_immutable();

-- Revalidate the bounded transient original, including the 017 raw-profile contract, on BOTH calls.
CREATE FUNCTION lyraseo_audit.artifact_attestation(a public."AuditRun", data_ json) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE ev jsonb; prov jsonb; stamp timestamp; policy jsonb; point_ jsonb; rule_ jsonb; BEGIN
 IF NOT lyraseo_kernel.is_test_database() THEN RAISE EXCEPTION 'ARTIFACT_UNQUALIFIED'; END IF;
 IF lyraseo_audit.storage_mode(a.id) IS DISTINCT FROM 'AUDIT_PRIVATE_V1' THEN RAISE EXCEPTION 'UNSUPPORTED_STORAGE_PROFILE'; END IF;
 IF octet_length((data_->'evidence')::text)>262144 OR octet_length((data_->'provenance')::text)>33554432 THEN RAISE EXCEPTION 'EVIDENCE_TOO_LARGE'; END IF;
 ev:=lyraseo_audit.bounded_projection((data_->'evidence')::jsonb,524288); prov:=lyraseo_audit.bounded_projection((data_->'provenance')::jsonb,67108864);
 IF jsonb_typeof(ev) IS DISTINCT FROM 'object' OR jsonb_typeof(prov) IS DISTINCT FROM 'object'
 OR (a.manifest ? (ev->>'requestedUrl')) IS DISTINCT FROM true OR prov->>'requestedUrl' IS DISTINCT FROM ev->>'requestedUrl'
 OR prov->>'channel' IS DISTINCT FROM 'raw-http' OR jsonb_typeof(prov->'robotsPolicy') IS DISTINCT FROM 'object'
 OR (prov ? 'error' AND (jsonb_typeof(prov->'error') IS DISTINCT FROM 'string' OR prov->>'error' !~ '^[A-Z_0-9]{1,64}$'))
 OR (prov ? 'sha256' AND (jsonb_typeof(prov->'sha256') IS DISTINCT FROM 'string' OR prov->>'sha256' !~ '^[a-f0-9]{64}$'))
 OR jsonb_typeof(ev->'acquired') IS DISTINCT FROM 'boolean' OR ev->'headComplete' IS DISTINCT FROM 'false'::jsonb
 OR ev->'bodyComplete' IS DISTINCT FROM 'false'::jsonb OR ev->'headingLevels' IS DISTINCT FROM '[]'::jsonb OR ev->'h1Texts' IS DISTINCT FROM '[]'::jsonb
 OR (ev ? 'jsonLdComplete' AND ev->'jsonLdComplete'<>'false'::jsonb) OR (ev->'metadata') ? 'rendered'
 OR ev ?| ARRAY['visibleText','mainText','populatedSections','articleDates','headingTexts','pageType','indexingIntent','intendedCanonical','intentionallyExcluded','mainMediaNames','logoNames']
 OR (ev->'acquired'='true'::jsonb AND (jsonb_typeof(prov->'rawHtml') IS DISTINCT FROM 'string'
 OR octet_length(prov->>'rawHtml') NOT BETWEEN 1 AND 5242880 OR prov->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(prov->>'rawHtml','UTF8')),'hex')))
 THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
 policy:=prov->'robotsPolicy';
 IF prov-ARRAY['channel','requestedUrl','finalUrl','status','acquiredAt','headers','redirects','rawHtml','sha256','error','robotsPolicy']<>'{}'
 OR octet_length(policy::text)>32768 OR policy-ARRAY['requestedUrl','finalUrl','acquiredAt','status','state','sha256','googleGroup','requested','final']<>'{}'
 OR jsonb_typeof(prov->'headers') IS DISTINCT FROM 'object' OR (prov->'headers')-ARRAY['content-type','link','last-modified','x-robots-tag']<>'{}'
 OR EXISTS(SELECT FROM jsonb_each(prov->'headers') WHERE jsonb_typeof(value)<>'string')
 OR jsonb_typeof(prov->'redirects') IS DISTINCT FROM 'array' OR jsonb_array_length(prov->'redirects')>5 OR EXISTS(SELECT FROM jsonb_array_elements(prov->'redirects') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}')>2048)
 OR EXISTS(SELECT FROM jsonb_each(policy-ARRAY['googleGroup','requested','final']) WHERE jsonb_typeof(value) NOT IN ('string','number'))
 THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
 FOREACH point_ IN ARRAY ARRAY[policy->'requested',policy->'final'] LOOP
  IF point_ IS NOT NULL AND (jsonb_typeof(point_)<>'object' OR point_-ARRAY['url','allowed']<>'{}' OR jsonb_typeof(point_->'url') IS DISTINCT FROM 'string' OR (point_ ? 'allowed' AND jsonb_typeof(point_->'allowed')<>'boolean')) THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
 END LOOP;
 IF jsonb_typeof(policy->'googleGroup')='object' THEN
  IF (policy->'googleGroup')-ARRAY['agent','rules']<>'{}' OR policy#>>'{googleGroup,agent}' NOT IN ('*','googlebot') OR jsonb_typeof(policy#>'{googleGroup,rules}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(policy#>'{googleGroup,rules}')>128 THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
  FOR rule_ IN SELECT * FROM jsonb_array_elements(policy#>'{googleGroup,rules}') LOOP
   IF jsonb_typeof(rule_)<>'object' OR rule_-ARRAY['directive','pattern']<>'{}' OR rule_->>'directive' NOT IN ('allow','disallow') OR jsonb_typeof(rule_->'pattern') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
  END LOOP;
 ELSIF jsonb_typeof(policy->'googleGroup')<>'null' THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
 stamp:=lyraseo_audit.capture_clock(prov->>'acquiredAt',clock_timestamp() AT TIME ZONE 'UTC');
 IF stamp IS NULL OR stamp+interval '30 days'<=clock_timestamp() AT TIME ZONE 'UTC' OR NOT EXISTS (SELECT FROM public."AuditRun" WHERE id=a.id AND "resultExpiresAt">clock_timestamp() AT TIME ZONE 'UTC')
 THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
 RETURN encode(sha256(convert_to(jsonb_build_array('AUDIT_PRIVATE_V1',ev,prov-'rawHtml')::text,'UTF8')),'hex');
END $$;
CREATE FUNCTION lyraseo_audit.version_descriptor(b public."ArtifactBlob") RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('workspaceId',b."workspaceId",'storageKey',b."storageKey",'generation',b.generation,'codec',b.codec,
 'sourceHash',b."sourceHash",'sourceLength',b."sourceLength",'storedHash',b."storedHash",'storedLength',b."storedLength")
$$;
CREATE FUNCTION lyraseo_audit.confirmation_binding(a public."AuditRun",context_ text,work_ uuid,generation_ integer,url text,stamp text,fact text,b public."ArtifactBlob")
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array('audit-private-1',a."workspaceId",a."siteId",a.id,a."userId",a."securityVersion",a.fence,
 context_,work_,generation_,url,stamp,fact,b.id,b."pageId",CASE WHEN b.id IS NOT NULL THEN lyraseo_audit.version_descriptor(b) END)::text,'UTF8')),'hex')
$$;
CREATE FUNCTION lyraseo_audit.reserve_artifact(a public."AuditRun", context_ text, work_ uuid, generation_ integer, data_ json) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prov json:=data_->'provenance'; ev json:=data_->'evidence'; fact text; stamp timestamp; b public."ArtifactBlob"; n integer;
BEGIN
 IF lyraseo_audit.storage_mode(a.id) IS NULL THEN RETURN jsonb_build_object('legacy',true); END IF;
 fact:=lyraseo_audit.artifact_attestation(a,data_);
 IF (ev->>'acquired')::boolean=false THEN
  IF EXISTS(SELECT FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=ev->>'requestedUrl' AND
   ((work_ IS NULL AND fence=a.fence) OR ("workId","workGeneration")=(work_,generation_))) THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
  IF (prov::jsonb ? 'rawHtml') OR ev::jsonb IS DISTINCT FROM lyraseo_audit.artifact_scratch(ev::jsonb) THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
  IF work_ IS NULL OR NOT EXISTS(SELECT FROM lyraseo_audit.unavailable_observation WHERE (work_id,generation,url,audit_id,fact_hash)=(work_,generation_,ev->>'requestedUrl',a.id,fact)) THEN
   PERFORM lyraseo_audit.verify_artifact_mac('audit-observation-v1',context_,data_,data_->'captureConfirmation');
  END IF;
  IF work_ IS NOT NULL THEN
   INSERT INTO lyraseo_audit.unavailable_observation VALUES(work_,generation_,ev->>'requestedUrl',a.id,fact,
    ((prov->>'acquiredAt')::timestamptz AT TIME ZONE 'UTC')+interval '30 days',jsonb_build_object('evidence',ev::jsonb,'provenance',prov::jsonb))
   ON CONFLICT DO NOTHING;
   IF NOT EXISTS(SELECT FROM lyraseo_audit.unavailable_observation WHERE (work_id,generation,url,audit_id,fact_hash)=(work_,generation_,ev->>'requestedUrl',a.id,fact)) THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
  END IF;
  RETURN jsonb_build_object('version',null,'binding',lyraseo_audit.confirmation_binding(a,context_,work_,generation_,ev->>'requestedUrl',prov->>'acquiredAt',fact,b));
 END IF;
 IF EXISTS(SELECT FROM lyraseo_audit.unavailable_observation WHERE (work_id,generation,url)=(work_,generation_,ev->>'requestedUrl')) THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
 IF EXISTS(SELECT FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=ev->>'requestedUrl' AND "factHash"<>fact AND
    ((work_ IS NULL AND "workId" IS NULL AND fence=a.fence) OR ("workId","workGeneration")=(work_,generation_))) THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
 IF NOT EXISTS(SELECT FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=ev->>'requestedUrl' AND "factHash"=fact AND
   ((work_ IS NULL AND "workId" IS NULL AND fence=a.fence) OR ("workId","workGeneration")=(work_,generation_))) THEN
  PERFORM lyraseo_audit.verify_artifact_mac('audit-observation-v1',context_,data_,data_->'captureConfirmation');
 END IF;
 stamp:=(prov->>'acquiredAt')::timestamptz AT TIME ZONE 'UTC'; n:=octet_length(prov->>'rawHtml');
 INSERT INTO public."ArtifactBlob" ("workspaceId","siteId","auditId","requestedUrl",fence,"workId","workGeneration","capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength","pendingReceipt")
 VALUES(a."workspaceId",a."siteId",a.id,ev->>'requestedUrl',a.fence,work_,generation_,stamp,stamp+interval '30 days',fact,prov->>'sha256',n,prov->>'sha256',n,
  CASE WHEN work_ IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object('channel','raw-http','requestedUrl',ev->>'requestedUrl','finalUrl',prov->>'finalUrl','status',(prov->>'status')::integer,'acquiredAt',prov->>'acquiredAt',
  'headers',jsonb_build_object('content-type',prov#>>'{headers,content-type}','link',prov#>>'{headers,link}','x-robots-tag',prov#>>'{headers,x-robots-tag}','last-modified',prov#>>'{headers,last-modified}'),
  'redirects',(prov->'redirects')::jsonb,'sha256',prov->>'sha256')) || jsonb_build_object('robotsPolicy',(prov->'robotsPolicy')::jsonb) END)
 ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT b FROM public."ArtifactBlob" WHERE "auditId"=a.id AND "requestedUrl"=ev->>'requestedUrl' AND
 ((work_ IS NULL AND fence=a.fence) OR ("workId","workGeneration")=(work_,generation_)) FOR UPDATE;
 IF b."factHash"<>fact OR (b."workId",b."workGeneration") IS DISTINCT FROM (work_,generation_) OR b.state NOT IN ('STAGED','READY')
 THEN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF;
 RETURN jsonb_build_object('version',lyraseo_audit.version_descriptor(b),'binding',lyraseo_audit.confirmation_binding(a,context_,work_,generation_,ev->>'requestedUrl',prov->>'acquiredAt',fact,b));
END $$;
CREATE FUNCTION lyraseo_audit.web_artifact_reserve(s text,id_ text,epoch integer,fence_ integer,data_ json) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public."AuditRun"; BEGIN
 IF session_user<>'lyraseo_runtime' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 a:=lyraseo_audit.audit_transition_guard(current_setting('app.workspace_id',true),s,id_,current_setting('app.actor_id',true),epoch,'LOCAL_RAW_V1','prepare',fence_);
 IF lyraseo_audit.next_page(a) IS DISTINCT FROM data_->'evidence'->>'requestedUrl' THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
 RETURN lyraseo_audit.reserve_artifact(a,'web/'||a.id||'/'||a.fence,NULL,NULL,data_);
END $$;
CREATE FUNCTION lyraseo_audit.step_artifact_reserve(rid uuid,proof text,data_ json) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p lyraseo_audit.attempt; BEGIN
 p:=lyraseo_audit.checked_attempt(rid,proof);
 IF data_->'evidence'->>'requestedUrl' IS DISTINCT FROM p.url THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
 RETURN lyraseo_audit.reserve_artifact(lyraseo_audit.read_target(p.audit_id),'step/'||rid,p.work_id,p.generation,data_);
END $$;
-- Normalize parser channels explicitly. Only the raw headers/original directive and canonical facts
-- can affect readiness-v2. Arrays behind an unobserved head/body/JSON-LD channel stay empty.
CREATE FUNCTION lyraseo_audit.artifact_scratch(ev jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE meta jsonb:='{}'; chan text; src jsonb; d jsonb; vals jsonb;
BEGIN
 FOREACH chan IN ARRAY ARRAY['headers','original'] LOOP
  src:=ev#>ARRAY['metadata',chan];
  IF src IS NULL THEN CONTINUE; END IF;
  IF jsonb_typeof(src) IS DISTINCT FROM 'object' OR jsonb_typeof(src->'directives') IS DISTINCT FROM 'array'
   OR jsonb_typeof(src->'canonicalUrls') IS DISTINCT FROM 'array'
   OR src->'directivesComplete' IS DISTINCT FROM 'true'::jsonb OR src->'canonicalsComplete' IS DISTINCT FROM 'true'::jsonb
   OR EXISTS(SELECT FROM jsonb_array_elements(src->'canonicalUrls') c WHERE jsonb_typeof(c)<>'string')
   THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
  vals:='[]';
  FOR d IN SELECT * FROM jsonb_array_elements(src->'directives') LOOP
   IF jsonb_typeof(d->'agent') IS DISTINCT FROM 'string' OR jsonb_typeof(d->'value') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
   vals:=vals||jsonb_build_array(jsonb_build_object('agent',d->'agent','value',d->'value'));
  END LOOP;
  meta:=meta||jsonb_build_object(chan,jsonb_build_object('directivesComplete',true,'canonicalsComplete',true,'directives',vals,'canonicalUrls',src->'canonicalUrls'));
 END LOOP;
 RETURN jsonb_strip_nulls(jsonb_build_object('requestedUrl',ev->>'requestedUrl','finalUrl',ev->>'finalUrl','acquired',(ev->>'acquired')::boolean,'status',(ev->>'status')::integer,
 'contentType',ev->>'contentType','robotsGoogleAllowed',(ev->>'robotsGoogleAllowed')::boolean,'requestedRobotsGoogleAllowed',(ev->>'requestedRobotsGoogleAllowed')::boolean,
 'headComplete',false,'bodyComplete',false,'headingLevels','[]'::jsonb,'h1Texts','[]'::jsonb,'titleElements','[]'::jsonb,'canonicalUrls','[]'::jsonb,
 'linkNames','[]'::jsonb,'jsonLd','[]'::jsonb,'jsonLdComplete',(ev->>'jsonLdComplete')::boolean,'metadata',nullif(meta,'{}')));
END $$;
CREATE FUNCTION lyraseo_audit.artifact_checkpoint(a public."AuditRun", data_ json) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
 PERFORM lyraseo_audit.verify_artifact_mac('audit-publication-v1',lyraseo_audit.confirmation_binding(a,context_,attempt_.work_id,attempt_.generation,url,prov->>'acquiredAt',fact,b),data_,data_->'confirmation');
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

-- Every acquired page pins its original logical ref in the immutable compact receipt.
-- Hold the blob and ref locks through publication. An overlapping retirement either wins
-- before this read (invalidating the score) or waits until publication has committed.
CREATE FUNCTION lyraseo_audit.check_live_sources(a public."AuditRun") RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM b.id FROM public."ArtifactBlob" b JOIN public."AuditPage" p ON b.id=(p.provenance#>>'{sourceRef,blobId}')::uuid
 WHERE p."auditId"=a.id ORDER BY b.id FOR SHARE OF b;
 PERFORM f.id FROM public."ArtifactRef" f JOIN public."AuditPage" p ON f.id=(p.provenance#>>'{sourceRef,id}')::uuid
 WHERE p."auditId"=a.id ORDER BY f.id FOR SHARE OF f;
 IF EXISTS (SELECT FROM public."AuditPage" p WHERE p."auditId"=a.id AND p.evidence->'acquired'='true'::jsonb AND NOT EXISTS (
   SELECT FROM public."ArtifactRef" f JOIN public."ArtifactBlob" b ON b.id=f."blobId" AND b.generation=f.generation
   JOIN public."AuditPageRetention" c ON (c."workspaceId",c."auditId",c."pageId")=(f."workspaceId",f."auditId",f."pageId")
   WHERE (f."workspaceId",f."siteId",f."auditId",f."pageId")=(a."workspaceId",a."siteId",a.id,p.id)
   AND (f.id::text,b.id::text,b.generation::text)=(p.provenance#>>'{sourceRef,id}',p.provenance#>>'{sourceRef,blobId}',p.provenance#>>'{sourceRef,generation}')
   AND b.state='READY' AND b."factHash"=p.provenance->>'factHash' AND b."sourceHash"=p.provenance->>'sha256'
   AND f."capturedAt"=c."capturedAt" AND f."expiresAt"=c."rawExpiresAt" AND f."expiresAt">clock_timestamp() AT TIME ZONE 'UTC'))
 THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
END $$;
CREATE FUNCTION lyraseo_audit.active_artifact_pages(a public."AuditRun") RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE pages jsonb;
BEGIN
 PERFORM lyraseo_audit.check_live_sources(a);
 IF NOT EXISTS(SELECT FROM public."AuditRun" WHERE id=a.id AND "resultExpiresAt">clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
 SELECT coalesce(jsonb_agg(s.facts ORDER BY p."requestedUrl"),'[]') INTO pages FROM public."AuditPage" p LEFT JOIN public."AuditEvaluationScratch" s ON (s."workspaceId",s."auditId",s."pageId")=(a."workspaceId",a.id,p.id) AND s."expiresAt">clock_timestamp() AT TIME ZONE 'UTC' WHERE p."auditId"=a.id;
 IF pages @> '[null]' THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF; RETURN pages;
END $$;
-- Validate the bounded durable finding shape independently of the Node projection. Never persist
-- opaque rule payloads, foreign refs or declarations supplied instead of those on the frozen run.
CREATE FUNCTION lyraseo_audit.check_artifact_result(a public."AuditRun", e jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r jsonb; ref jsonb; k text; item jsonb; excerpt_chars integer:=0; BEGIN
 IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR e-ARRAY['score','coverage','categoryScores','categoryCoverage','eligible','manifest','methodologyVersion','profile','declarations','contextRevision','contextRevisionId','duplicateDestinations','rules','rulesAvailable','ruleCount','omittedRules','truncatedExcerpts','outcomeCounts']<>'{}'
 OR e->'declarations' IS DISTINCT FROM (a.declarations-ARRAY['contextRevision','contextRevisionId'])
 OR e->'contextRevision' IS DISTINCT FROM a.declarations->'contextRevision' OR e->'contextRevisionId' IS DISTINCT FROM a.declarations->'contextRevisionId'
 OR jsonb_typeof(e->'rules') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'rules')>512 OR e->'rulesAvailable' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(e->'eligible') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
 PERFORM lyraseo_audit.bounded_projection(e,4194304);
 FOREACH k IN ARRAY ARRAY['score','coverage','ruleCount','omittedRules','truncatedExcerpts'] LOOP
  IF e ? k AND jsonb_typeof(e->k) NOT IN ('number','null') THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['categoryScores','categoryCoverage','outcomeCounts'] LOOP
  IF jsonb_typeof(e->k) IS DISTINCT FROM 'object' OR (e->k) - (CASE WHEN k='outcomeCounts'
     THEN ARRAY['PASS','WARNING','FAIL','UNKNOWN','NOT_APPLICABLE'] ELSE ARRAY['discovery','extractability','answer','entity'] END) <>'{}'
     OR EXISTS(SELECT FROM jsonb_each(e->k) WHERE jsonb_typeof(value) NOT IN ('number','null')) THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
 END LOOP;
 FOR item IN SELECT * FROM jsonb_array_elements(e->'duplicateDestinations') LOOP
  IF item-ARRAY['finalUrl','requestedUrls']<>'{}' OR jsonb_typeof(item->'finalUrl') IS DISTINCT FROM 'string' OR length(item->>'finalUrl')>2048
     OR jsonb_typeof(item->'requestedUrls') IS DISTINCT FROM 'array' OR NOT(a.manifest @> (item->'requestedUrls')) THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
 END LOOP;
 FOR r IN SELECT * FROM jsonb_array_elements(e->'rules') LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['omittedEvidenceRefs','ruleId','ruleVersion','scopeKey','category','priority','reasonCode','outcome','evidence','evidenceRefs']<>'{}'
    OR NOT(r ?& ARRAY['ruleId','ruleVersion','scopeKey','reasonCode','outcome','category','priority','evidenceRefs'])
    OR r->>'ruleId' !~ '^[DEAT][0-9]{2}$' OR r->>'ruleVersion'<>'2' OR r->>'reasonCode' !~ '^[A-Z_0-9]{1,128}$'
    OR r->>'outcome' NOT IN ('PASS','WARNING','FAIL','UNKNOWN','NOT_APPLICABLE') OR r->>'priority' NOT IN ('low','medium','high')
    OR r->>'category' NOT IN ('discovery','extractability','answer','entity') OR jsonb_typeof(r->'scopeKey') IS DISTINCT FROM 'string' OR length(r->>'scopeKey')>2048
    OR (r ? 'evidence' AND (jsonb_typeof(r->'evidence') IS DISTINCT FROM 'string' OR length(r->>'evidence')>512))
    OR (r ? 'omittedEvidenceRefs' AND jsonb_typeof(r->'omittedEvidenceRefs')<>'number') OR jsonb_typeof(r->'evidenceRefs') IS DISTINCT FROM 'array'
    OR jsonb_array_length(r->'evidenceRefs')>64 THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
  excerpt_chars:=excerpt_chars+coalesce(length(r->>'evidence'),0);
  FOR ref IN SELECT * FROM jsonb_array_elements(r->'evidenceRefs') LOOP
   IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref-ARRAY['source','requestedUrl','fields']<>'{}'
    OR ref->>'source' NOT IN ('page','receipt','declarations','manifest') OR (ref ? 'requestedUrl' AND (a.manifest ? (ref->>'requestedUrl')) IS DISTINCT FROM true)
    OR jsonb_typeof(ref->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(ref->'fields')>64
    OR EXISTS(SELECT FROM jsonb_array_elements(ref->'fields') field WHERE jsonb_typeof(field)<>'string' OR field#>>'{}' !~ '^[a-zA-Z][a-zA-Z0-9.]{0,127}$') THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
  END LOOP;
 END LOOP;
 IF excerpt_chars>2048 THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
END $$;

ALTER FUNCTION lyraseo_audit.write_transition(public."AuditRun",text,text,json) RENAME TO write_inline_transition;
CREATE FUNCTION lyraseo_audit.write_transition(a public."AuditRun",action_ text,owner_ text,data_ json) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF lyraseo_audit.storage_mode(a.id) IS NOT NULL THEN
  IF action_='checkpoint' THEN RETURN lyraseo_audit.artifact_checkpoint(a,data_); END IF;
  IF action_='finish' THEN
   PERFORM lyraseo_audit.active_artifact_pages(a);
   PERFORM lyraseo_audit.check_artifact_result(a,data_::jsonb);
   IF data_->>'profile' IS DISTINCT FROM a.profile OR data_->>'methodologyVersion' IS DISTINCT FROM a."methodologyVersion"
    OR (data_->'manifest')::jsonb IS DISTINCT FROM a.manifest OR json_typeof(data_->'rules') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_EVALUATION'; END IF;
  END IF;
 END IF;
 RETURN lyraseo_audit.write_inline_transition(a,action_,owner_,data_);
END $$;

ALTER FUNCTION lyraseo_audit.prepare_step(uuid,text) RENAME TO prepare_inline_step;
REVOKE ALL ON FUNCTION lyraseo_audit.prepare_inline_step(uuid,text) FROM lyraseo_dispatch;
CREATE FUNCTION lyraseo_audit.prepare_step(rid uuid,proof text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p lyraseo_audit.attempt; a public."AuditRun"; pages jsonb; BEGIN
 p:=lyraseo_audit.checked_attempt(rid,proof); a:=lyraseo_audit.read_target(p.audit_id);
 IF lyraseo_audit.storage_mode(a.id) IS NULL THEN RETURN lyraseo_audit.prepare_inline_step(rid,proof); END IF;
 IF (SELECT count(*)+1 FROM public."AuditPage" WHERE "auditId"=a.id)=jsonb_array_length(a.manifest) THEN pages:=lyraseo_audit.active_artifact_pages(a); END IF;
 RETURN jsonb_build_object('url',p.url,'manifest',a.manifest,'profile',a.profile,'methodologyVersion',a."methodologyVersion",
 'declarations',a.declarations,'origin',(SELECT origin FROM public."Site" WHERE id=a."siteId"),'priorEvidence',pages,'storageFormat','AUDIT_PRIVATE_V1');
END $$;

-- The format is private admission metadata; it never enters an HTTP or Queue body.
CREATE FUNCTION lyraseo_audit.step_artifact_mode(rid uuid,proof text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p lyraseo_audit.attempt; b public."ArtifactBlob"; absent_ lyraseo_audit.unavailable_observation; BEGIN
 p:=lyraseo_audit.checked_attempt(rid,proof);
 IF lyraseo_audit.storage_mode(p.audit_id) IS NULL THEN RETURN NULL; END IF;
 PERFORM lyraseo_audit.active_artifact_pages(lyraseo_audit.read_target(p.audit_id));
 SELECT * INTO b FROM public."ArtifactBlob" WHERE ("workId","workGeneration","requestedUrl")=(p.work_id,p.generation,p.url) FOR SHARE;
 IF b.id IS NULL THEN
  SELECT * INTO absent_ FROM lyraseo_audit.unavailable_observation WHERE (work_id,generation,url,audit_id)=(p.work_id,p.generation,p.url,p.audit_id);
  IF absent_.work_id IS NULL THEN RETURN '{}'; END IF;
  IF absent_.expires_at<=clock_timestamp() AT TIME ZONE 'UTC' THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
  RETURN jsonb_build_object('unavailable',absent_.receipt);
 END IF;
 IF b.state<>'STAGED' OR b."pendingReceipt" IS NULL OR b."expiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN RAISE EXCEPTION 'ARTIFACT_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('version',lyraseo_audit.version_descriptor(b),'provenance',b."pendingReceipt");
END $$;

CREATE FUNCTION lyraseo_audit.web_artifact_pages(s text,id_ text,epoch integer,fence_ integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public."AuditRun"; BEGIN
 IF session_user<>'lyraseo_runtime' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 a:=lyraseo_audit.audit_transition_guard(current_setting('app.workspace_id',true),s,id_,current_setting('app.actor_id',true),epoch,'LOCAL_RAW_V1','prepare',fence_);
 RETURN lyraseo_audit.active_artifact_pages(a);
END $$;
-- Final check is after all page/ref/evaluation writes, using the starting lease (yield invalidates it).
CREATE FUNCTION lyraseo_audit.web_artifact_commit(s text,id_ text,epoch integer,fence_ integer,data_ json,evaluation_ json) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public."AuditRun"; page_ text; done boolean; source_deadline timestamp; BEGIN
 IF session_user<>'lyraseo_runtime' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 a:=lyraseo_audit.audit_transition_guard(current_setting('app.workspace_id',true),s,id_,current_setting('app.actor_id',true),epoch,'LOCAL_RAW_V1','prepare',fence_);
 IF lyraseo_audit.next_page(a) IS DISTINCT FROM data_->'evidence'->>'requestedUrl' THEN RAISE EXCEPTION 'INVALID_PAGE_EVIDENCE'; END IF;
 page_:=lyraseo_audit.artifact_checkpoint(a,data_);
 SELECT min("expiresAt") INTO source_deadline FROM public."AuditEvaluationScratch" WHERE "auditId"=a.id;
 done:=lyraseo_audit.next_page(a) IS NULL;
 IF done IS DISTINCT FROM (evaluation_ IS NOT NULL) THEN RAISE EXCEPTION 'AUDIT_INCOMPLETE'; END IF;
 IF done THEN PERFORM lyraseo_audit.write_transition(a,'finish',NULL,evaluation_); ELSE PERFORM lyraseo_audit.write_transition(a,'yield',NULL,NULL); END IF;
 IF least(a."leaseUntil" AT TIME ZONE 'UTC',(SELECT "verifiedAt" AT TIME ZONE 'UTC'+interval '1 day' FROM public."Site" WHERE id=s))<=clock_timestamp()
 OR NOT lyraseo_audit.run_site_permission(a."workspaceId",s,a."userId") THEN RAISE EXCEPTION 'STALE_LEASE'; END IF;
 PERFORM lyraseo_audit.check_live_sources(a);
 IF source_deadline<=clock_timestamp() AT TIME ZONE 'UTC' OR NOT EXISTS(SELECT FROM public."AuditRun" WHERE id=a.id AND "resultExpiresAt">clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
 RETURN page_;
END $$;
-- Keep legacy lifecycle authority for unconverted runs; private writes must use the atomic endpoint.
ALTER FUNCTION lyraseo_audit.web_transition(text,text,integer,text,integer,text,json) RENAME TO web_inline_transition;
REVOKE ALL ON FUNCTION lyraseo_audit.web_inline_transition(text,text,integer,text,integer,text,json) FROM lyraseo_runtime;
CREATE FUNCTION lyraseo_audit.web_transition(s text,id_ text,epoch integer,action_ text,expected integer,owner_ text,data_ json) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF action_ IN ('checkpoint','finish','yield') AND lyraseo_audit.storage_mode(id_) IS NOT NULL THEN RAISE EXCEPTION 'ARTIFACT_REQUIRED'; END IF;
 RETURN lyraseo_audit.web_inline_transition(s,id_,epoch,action_,expected,owner_,data_);
END $$;
CREATE FUNCTION lyraseo_audit.release_scratch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 DELETE FROM lyraseo_audit.unavailable_observation WHERE audit_id=NEW.id;
 DELETE FROM public."AuditEvaluationScratch" WHERE "workspaceId"=NEW."workspaceId" AND "auditId"=NEW.id;
 UPDATE public."ArtifactBlob" SET state='ORPHAN',"pendingReceipt"=NULL WHERE "auditId"=NEW.id AND state='STAGED'; RETURN NULL;
END $$;
CREATE TRIGGER release_audit_scratch AFTER UPDATE OF status ON "AuditRun" FOR EACH ROW WHEN(NEW.status IN ('COMPLETED','FAILED') AND NEW."storageFormat" IS NOT NULL) EXECUTE FUNCTION lyraseo_audit.release_scratch();
-- Keep 017's fixed proof, generation transition, deadline check and replay insert intact.
ALTER FUNCTION lyraseo_audit.commit_step(uuid,text,json,jsonb) RENAME TO commit_guarded_step;
REVOKE ALL ON FUNCTION lyraseo_audit.commit_guarded_step(uuid,text,json,jsonb) FROM lyraseo_dispatch;
CREATE FUNCTION lyraseo_audit.commit_step(rid uuid,proof text,receipt json,evaluation_ jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p lyraseo_audit.attempt; deadline_ timestamp; outcome jsonb; BEGIN
 p:=lyraseo_audit.checked_attempt(rid,proof);
 IF lyraseo_audit.storage_mode(p.audit_id) IS NOT NULL THEN
  SELECT least(min("expiresAt"),(receipt->'provenance'->>'acquiredAt')::timestamptz AT TIME ZONE 'UTC'+ interval '30 days') INTO deadline_
  FROM public."AuditEvaluationScratch" WHERE "auditId"=p.audit_id;
 END IF;
 outcome:=lyraseo_audit.commit_guarded_step(rid,proof,receipt,evaluation_);
 IF deadline_ IS NOT NULL THEN
  PERFORM lyraseo_audit.check_live_sources(lyraseo_audit.read_target(p.audit_id));
  IF deadline_<=clock_timestamp() AT TIME ZONE 'UTC' OR NOT EXISTS(SELECT FROM public."AuditRun" WHERE id=p.audit_id AND "resultExpiresAt">clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
  IF NOT EXISTS(SELECT FROM public."AuditRun" a WHERE a.id=p.audit_id AND lyraseo_audit.run_site_permission(a."workspaceId",a."siteId",a."userId")) THEN RAISE EXCEPTION 'STALE_ATTEMPT'; END IF;
 END IF;
 RETURN outcome;
END $$;

CREATE FUNCTION lyraseo_audit.source_ticket(s text,id_ text,url text,epoch integer) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT lyraseo_audit.version_descriptor(b)||jsonb_build_object('refId',f.id,'sourcePageId',f."pageId",'factHash',b."factHash",'capturedAt',f."capturedAt",'expiresAt',least(f."expiresAt",a."resultExpiresAt")) FROM public."ArtifactRef" f JOIN public."ArtifactBlob" b ON b.id=f."blobId" AND b.generation=f.generation
 JOIN public."AuditRun" a ON a.id=f."auditId" JOIN public."Workspace" w ON w.id=a."workspaceId" JOIN public."Site" st ON st.id=a."siteId"
 JOIN public."ProductUser" u ON u.id=current_setting('app.actor_id',true) JOIN public."Membership" m ON m."workspaceId"=w.id AND m."userId"=u.id
 WHERE session_user='lyraseo_runtime' AND NOT u.suspended AND u."securityVersion"=epoch AND w."deletedAt" IS NULL AND st."deletedAt" IS NULL
 AND (m.role IN ('OWNER','ADMIN') OR EXISTS (SELECT FROM public."SiteGrant" g WHERE (g."workspaceId",g."siteId",g."userId")=(w.id,st.id,u.id)))
 AND (f."workspaceId",f."siteId",f."auditId")=(current_setting('app.workspace_id',true),s,id_) AND b."requestedUrl"=url AND b.state='READY'
 AND least(f."expiresAt",a."resultExpiresAt")>clock_timestamp() AT TIME ZONE 'UTC'
$$;

-- Same current browser authorization and P1 source clock as the attachment. Publish only
-- named, attested links between two acquired pages of this frozen manifest.
CREATE FUNCTION lyraseo_audit.private_anchors(s text,id_ text,epoch integer)
RETURNS TABLE("pageId" text,"rawExpiresAt" timestamp,url text,href text,name text,total integer,"artifactRefId" uuid,"artifactGeneration" uuid,"sourceFactHash" text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT f."pageId",f."expiresAt",b."requestedUrl",link->>'href',link->>'name',(count(*) OVER())::integer,f.id,f.generation,b."factHash"
 FROM public."ArtifactRef" f JOIN public."ArtifactBlob" b ON b.id=f."blobId" AND b.generation=f.generation AND b.state='READY'
 JOIN public."AuditRun" a ON a.id=f."auditId" CROSS JOIN LATERAL jsonb_array_elements(f.anchors) WITH ORDINALITY l(link,ord)
 JOIN public."AuditPage" dest ON dest."auditId"=f."auditId" AND dest."workspaceId"=f."workspaceId" AND dest."requestedUrl"=link->>'href' AND dest.evidence->'acquired'='true'::jsonb
 WHERE (f."workspaceId",f."siteId",f."auditId")=(current_setting('app.workspace_id',true),s,id_) AND a.status='COMPLETED'
 AND lyraseo_audit.source_ticket(s,id_,b."requestedUrl",epoch) IS NOT NULL
 ORDER BY b."requestedUrl",ord LIMIT 100
$$;

-- Local maintenance only, operator/admin invocation. No product role can enumerate keys.
-- Mark generations unpublishable under the same target-before-blob lock order.
CREATE FUNCTION lyraseo_audit.orphan_artifacts(id_ text,lim integer) RETURNS SETOF jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a public."AuditRun"; BEGIN
 IF lim NOT BETWEEN 1 AND 100 OR lim IS NULL THEN RAISE EXCEPTION 'INVALID_LIMIT'; END IF;
 SELECT * INTO STRICT a FROM public."AuditRun" WHERE id=id_ FOR UPDATE;
 UPDATE public."ArtifactBlob" SET state='ORPHAN',"pendingReceipt"=NULL WHERE id IN (SELECT id FROM public."ArtifactBlob" WHERE "auditId"=a.id AND state='STAGED'
 AND (a.status IN ('COMPLETED','FAILED') OR "expiresAt"<=clock_timestamp() AT TIME ZONE 'UTC'
   OR ("workId" IS NULL AND (fence<>a.fence OR a.status<>'RUNNING' OR a."leaseUntil"<=clock_timestamp() AT TIME ZONE 'UTC'))
   OR ("workId" IS NOT NULL AND NOT EXISTS (SELECT FROM public."WorkDispatch" d WHERE (d.id,d.generation)=("workId","workGeneration") AND d.disposition='DELIVERED' AND d."expiresAt">clock_timestamp() AND d."revokedAt" IS NULL)))
 ORDER BY id LIMIT lim FOR UPDATE);
 RETURN QUERY SELECT lyraseo_audit.version_descriptor(b) FROM public."ArtifactBlob" b WHERE "auditId"=a.id AND state='ORPHAN' ORDER BY id LIMIT lim;
END $$;
CREATE FUNCTION lyraseo_audit.sweep_scratch(lim integer) RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE n integer; BEGIN
 IF lim NOT BETWEEN 1 AND 100 OR lim IS NULL THEN RAISE EXCEPTION 'INVALID_LIMIT'; END IF;
 DELETE FROM public."AuditEvaluationScratch" WHERE "pageId" IN (SELECT "pageId" FROM public."AuditEvaluationScratch"
 WHERE "expiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' ORDER BY "expiresAt","pageId" LIMIT lim FOR UPDATE SKIP LOCKED);
 GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM lyraseo_audit.unavailable_observation WHERE (work_id,generation,url) IN (SELECT u.work_id,u.generation,u.url FROM lyraseo_audit.unavailable_observation u
  WHERE u.expires_at<=clock_timestamp() AT TIME ZONE 'UTC' OR NOT EXISTS(SELECT FROM public."WorkDispatch" d WHERE d.id=u.work_id AND d.generation=u.generation AND d.disposition='DELIVERED')
  ORDER BY expires_at,work_id LIMIT (lim-n) FOR UPDATE SKIP LOCKED);
 RETURN n;
END $$;

DO $$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='lyraseo_audit'::regnamespace AND proname IN
 ('verify_artifact_mac','confirmation_binding','enforce_source_deadline','storage_mode','storage_format_immutable','artifact_attestation','version_descriptor','reserve_artifact','web_artifact_reserve','step_artifact_reserve','artifact_scratch','artifact_checkpoint',
 'check_live_sources','active_artifact_pages','check_artifact_result','step_artifact_mode','commit_step','write_transition','prepare_step','web_artifact_pages','web_artifact_commit','web_transition','release_scratch','private_anchors','source_ticket','sweep_scratch','orphan_artifacts')
 LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_kernel_owner',fn); EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION lyraseo_audit.web_artifact_reserve(text,text,integer,integer,json),lyraseo_audit.web_artifact_pages(text,text,integer,integer),
 lyraseo_audit.web_artifact_commit(text,text,integer,integer,json,json),lyraseo_audit.web_transition(text,text,integer,text,integer,text,json),
 lyraseo_audit.private_anchors(text,text,integer),lyraseo_audit.source_ticket(text,text,text,integer) TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_audit.step_artifact_mode(uuid,text),lyraseo_audit.commit_step(uuid,text,json,jsonb),lyraseo_audit.step_artifact_reserve(uuid,text,json),lyraseo_audit.prepare_step(uuid,text) TO lyraseo_dispatch;
COMMIT;
