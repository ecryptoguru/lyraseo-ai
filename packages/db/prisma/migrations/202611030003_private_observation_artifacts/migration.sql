BEGIN;
-- Add a typed visibility owner to the accepted store; audit tuples stay unchanged.
ALTER TABLE "VisibilityRun" ADD COLUMN "storageFormat" text CHECK("storageFormat" IS NULL OR "storageFormat"='OBSERVATION_PRIVATE_V1');
ALTER TABLE "VisibilityRun" ADD UNIQUE("workspaceId","siteId","panelId",id);
CREATE TABLE "VisibilityRecording" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "runId" text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
 "workspaceId" text NOT NULL, "siteId" text NOT NULL, "panelId" text NOT NULL,
 "userId" text NOT NULL, "securityVersion" integer NOT NULL, "sessionId" text NOT NULL,
 "sourceNamespace" text NOT NULL CHECK("sourceNamespace"='CONTROLLED_FIXTURE_V1'), "recordingKey" text NOT NULL CHECK("recordingKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 "sourceBinding" text NOT NULL, "manifestHash" text NOT NULL CHECK("manifestHash" ~ '^[a-f0-9]{64}$'), manifest jsonb NOT NULL,
 state text NOT NULL DEFAULT 'STAGED' CHECK(state IN ('STAGED','FINALIZED','CANCELLED')),
 proof uuid NOT NULL DEFAULT gen_random_uuid(), "proofExpiresAt" timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
 "observedAt" timestamp(3) NOT NULL, "rawExpiresAt" timestamp(3) NOT NULL, "retiredAt" timestamptz,
 UNIQUE("workspaceId","siteId","sourceNamespace","recordingKey"),
 UNIQUE("workspaceId","siteId","panelId","runId",id),
 FOREIGN KEY("workspaceId","siteId","panelId") REFERENCES "VisibilityPanel"("workspaceId","siteId",id),
 CHECK(octet_length(manifest::text)<=262144)
);
CREATE INDEX ON "VisibilityRecording"(state,"proofExpiresAt",id);
CREATE TABLE "VisibilityObservationSlot" (
 "workspaceId" text NOT NULL, "siteId" text NOT NULL, "panelId" text NOT NULL, "runId" text NOT NULL,
 "recordingId" uuid NOT NULL, "promptId" text NOT NULL,
 "observedAt" timestamp(3) NOT NULL, "clockContract" text NOT NULL DEFAULT 'COMMON_OBSERVED_AT_V1' CHECK("clockContract"='COMMON_OBSERVED_AT_V1'),
 "factDigest" text NOT NULL CHECK("factDigest" ~ '^[a-f0-9]{64}$'), "answerHash" text CHECK("answerHash" ~ '^[a-f0-9]{64}$'), "answerLength" integer NOT NULL CHECK("answerLength" BETWEEN 0 AND 524288),
 "rawExpiresAt" timestamp(3) NOT NULL, disposition text NOT NULL CHECK(disposition IN ('STAGED','NO_BODY','READY','RETIRED','CANCELLED')),
 PRIMARY KEY("workspaceId","siteId","runId","promptId"),
 UNIQUE("workspaceId","siteId","panelId","runId","recordingId","promptId","observedAt","rawExpiresAt"),
 FOREIGN KEY("workspaceId","siteId","panelId","runId","recordingId") REFERENCES "VisibilityRecording"("workspaceId","siteId","panelId","runId",id),
 CHECK(("answerHash" IS NULL AND "answerLength"=0) OR ("answerHash" IS NOT NULL AND "answerLength">0))
);
CREATE INDEX ON "VisibilityObservationSlot"("rawExpiresAt","runId","promptId");
ALTER TABLE "ArtifactBlob" ALTER COLUMN "auditId" DROP NOT NULL, ALTER COLUMN "requestedUrl" DROP NOT NULL, ALTER COLUMN "pageId" DROP NOT NULL, ALTER COLUMN fence DROP NOT NULL;
ALTER TABLE "ArtifactBlob" ADD COLUMN "ownerKind" text NOT NULL DEFAULT 'AUDIT_PAGE', ADD COLUMN "recordingId" uuid, ADD COLUMN "runId" text, ADD COLUMN "panelId" text, ADD COLUMN "promptId" text;
ALTER TABLE "ArtifactRef" ALTER COLUMN "auditId" DROP NOT NULL, ALTER COLUMN "pageId" DROP NOT NULL, ALTER COLUMN "slotPageId" DROP NOT NULL;
ALTER TABLE "ArtifactRef" ADD COLUMN "recordingId" uuid, ADD COLUMN "runId" text, ADD COLUMN "panelId" text, ADD COLUMN "promptId" text;
-- Replace only the old audit-only CHECKs, including its combined clock assertion.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public."ArtifactBlob"'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%category%' OR pg_get_constraintdef(oid) LIKE '%rights%' OR pg_get_constraintdef(oid) LIKE '%expiryClass%' OR pg_get_constraintdef(oid) LIKE '%30 days%') LOOP EXECUTE format('ALTER TABLE public."ArtifactBlob" DROP CONSTRAINT %I',c.conname); END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public."ArtifactRef"'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%ownerKind%' OR pg_get_constraintdef(oid) LIKE '%role%') LOOP EXECUTE format('ALTER TABLE public."ArtifactRef" DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE "ArtifactBlob" ADD CHECK("sourceHash"="storedHash" AND "sourceLength"="storedLength" AND ("workId" IS NULL)=("workGeneration" IS NULL)),
 ADD CHECK(("ownerKind"='AUDIT_PAGE' AND "auditId" IS NOT NULL AND "requestedUrl" IS NOT NULL AND "pageId" IS NOT NULL AND fence IS NOT NULL AND "recordingId" IS NULL AND "runId" IS NULL AND "panelId" IS NULL AND "promptId" IS NULL AND category='AUDIT_SOURCE' AND rights='PRIVATE_AUDIT' AND "expiryClass"='CAPTURE_30D' AND "expiresAt"="capturedAt"+interval '30 days') OR
 ("ownerKind"='VISIBILITY_SLOT' AND "auditId" IS NULL AND "requestedUrl" IS NULL AND "pageId" IS NULL AND fence IS NULL AND "workId" IS NULL AND "workGeneration" IS NULL AND "pendingReceipt" IS NULL AND "recordingId" IS NOT NULL AND "runId" IS NOT NULL AND "panelId" IS NOT NULL AND "promptId" IS NOT NULL AND category='ANSWER_PARSED_JSON_V1' AND rights='CONTROLLED_FIXTURE_V1' AND "expiryClass"='ANSWER_RIGHTS_90D' AND "sourceLength"<=524288 AND "expiresAt">"capturedAt" AND "expiresAt"<="capturedAt"+interval '90 days')),
 ADD UNIQUE("workspaceId","siteId","panelId","runId","recordingId","promptId",id,generation,"capturedAt","expiresAt"),
 ADD FOREIGN KEY("workspaceId","siteId","panelId","runId","recordingId","promptId","capturedAt","expiresAt") REFERENCES "VisibilityObservationSlot"("workspaceId","siteId","panelId","runId","recordingId","promptId","observedAt","rawExpiresAt");
CREATE UNIQUE INDEX observation_blob_slot ON "ArtifactBlob"("recordingId","promptId") WHERE "ownerKind"='VISIBILITY_SLOT';
ALTER TABLE "ArtifactRef" ADD CHECK(("ownerKind"='AUDIT_PAGE' AND role='ORIGINAL_BODY' AND "auditId" IS NOT NULL AND "pageId" IS NOT NULL AND "slotPageId" IS NOT NULL AND "recordingId" IS NULL AND "runId" IS NULL AND "panelId" IS NULL AND "promptId" IS NULL) OR
 ("ownerKind"='VISIBILITY_SLOT' AND role='ANSWER_PARSED_JSON_V1' AND "auditId" IS NULL AND "pageId" IS NULL AND "slotPageId" IS NULL AND anchors='[]'::jsonb AND "recordingId" IS NOT NULL AND "runId" IS NOT NULL AND "panelId" IS NOT NULL AND "promptId" IS NOT NULL)),
 ADD FOREIGN KEY("workspaceId","siteId","panelId","runId","recordingId","promptId","blobId",generation,"capturedAt","expiresAt") REFERENCES "ArtifactBlob"("workspaceId","siteId","panelId","runId","recordingId","promptId",id,generation,"capturedAt","expiresAt"),
 ADD FOREIGN KEY("workspaceId","siteId","panelId","runId") REFERENCES "VisibilityRun"("workspaceId","siteId","panelId",id);
CREATE UNIQUE INDEX observation_ready_ref ON "ArtifactRef"("runId","promptId") WHERE "ownerKind"='VISIBILITY_SLOT';
CREATE INDEX ON "ArtifactRef"("workspaceId","siteId","runId","promptId","expiresAt") WHERE "ownerKind"='VISIBILITY_SLOT';

CREATE SCHEMA lyraseo_observation;
REVOKE ALL ON SCHEMA lyraseo_observation FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_observation TO lyraseo_kernel_owner,lyraseo_runtime;
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['VisibilityRecording','VisibilityObservationSlot'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY observation_kernel ON public.%I TO lyraseo_kernel_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,lyraseo_runtime,lyraseo_dispatch,lyraseo_identity',t);
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON public.%I FROM %I',t,r); END IF; END LOOP;
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON "VisibilityRecording","VisibilityObservationSlot" TO lyraseo_kernel_owner;
GRANT SELECT,INSERT ON "VisibilityRun" TO lyraseo_kernel_owner;
GRANT SELECT,UPDATE(id) ON "VisibilityPanel" TO lyraseo_kernel_owner;
CREATE POLICY observation_panel ON "VisibilityPanel" TO lyraseo_kernel_owner USING(true) WITH CHECK(false);
CREATE POLICY observation_run ON "VisibilityRun" TO lyraseo_kernel_owner USING(true) WITH CHECK(true);

CREATE FUNCTION lyraseo_observation.scope_guard(s text,epoch integer,session_ text,write_ boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w text:=current_setting('app.workspace_id',true); u text:=current_setting('app.actor_id',true); member_role text; current_epoch integer; BEGIN
 IF session_user<>'lyraseo_runtime' OR session_ IS NULL OR length(session_) NOT BETWEEN 1 AND 256 OR epoch IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=w AND "deletedAt" IS NULL FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM public."Site" WHERE ("workspaceId",id)=(w,s) AND "deletedAt" IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT "securityVersion" INTO current_epoch FROM public."ProductUser" WHERE id=u AND NOT suspended FOR SHARE;
 SELECT role::text INTO member_role FROM public."Membership" WHERE ("workspaceId","userId")=(w,u) FOR SHARE;
 IF current_epoch IS DISTINCT FROM epoch OR member_role IS NULL OR (write_ AND member_role='VIEWER') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF member_role NOT IN ('OWNER','ADMIN') THEN PERFORM 1 FROM public."SiteGrant" WHERE ("workspaceId","siteId","userId")=(w,s,u) FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF; END IF;
 IF write_ AND NOT lyraseo_kernel.is_test_database() THEN RAISE EXCEPTION 'ARTIFACT_UNQUALIFIED'; END IF;
END $$;
CREATE FUNCTION lyraseo_observation.source_context(s text,panel_ text,epoch integer,session_ text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."VisibilityPanel"; BEGIN
 PERFORM lyraseo_observation.scope_guard(s,epoch,session_,true);
 SELECT * INTO p FROM public."VisibilityPanel" WHERE ("workspaceId","siteId",id)=(current_setting('app.workspace_id',true),s,panel_) AND "reviewedAt" IS NOT NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REVIEWED_PANEL_REQUIRED'; END IF;
 RETURN encode(sha256(convert_to(jsonb_build_array('observation-fixture-context-v1',p."workspaceId",p."siteId",p.id,p.version,p.prompts,p.brands,current_setting('app.actor_id',true),epoch,session_)::text,'UTF8')),'hex');
END $$;

-- Transient normalized producer panel must equal the independently scoped immutable SQL panel.
CREATE FUNCTION lyraseo_observation.source_provenance(panel_ text,namespace_ text,key_ text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('sourceNamespace',namespace_,'recordingKey',key_,'panel',jsonb_build_object('id',p.id,'version',p.version,'prompts',p.prompts,'brands',p.brands)) FROM public."VisibilityPanel" p WHERE p.id=panel_ AND p."reviewedAt" IS NOT NULL
$$;

CREATE FUNCTION lyraseo_observation.validate_manifest(panel_ public."VisibilityPanel",m jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE slot_ jsonb; x jsonb; pair record; p jsonb:=m->'provenance'; stamp timestamp; deadline timestamp; BEGIN
 IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR octet_length(m::text)>262144 OR m-ARRAY['profile','cohort','createdAt','rawExpiresAt','provenance','slots']<>'{}'
 OR NOT(m ?& ARRAY['profile','cohort','createdAt','rawExpiresAt','provenance','slots']) OR m->>'profile' NOT IN ('azure-sol-api','consumer-chatgpt','consumer-gemini') OR m->>'cohort' !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(m->'slots') IS DISTINCT FROM 'array' OR jsonb_array_length(m->'slots') NOT BETWEEN 1 AND 25 OR jsonb_array_length(m->'slots')<>jsonb_array_length(panel_.prompts)
 OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['profile','provider','model','modelVersion','retrievalMode','observedAt','synthetic','rawAnswerRights','rawRightsUntil','requestedLocale','confirmedLocale','extractionVersion','clockContract','producerClass','representation']<>'{}'
 OR p->>'profile' IS DISTINCT FROM m->>'profile' OR p->>'observedAt' IS DISTINCT FROM m->>'createdAt' OR p->'synthetic' IS DISTINCT FROM 'true'::jsonb OR p->'rawAnswerRights' IS DISTINCT FROM 'true'::jsonb
 OR p->>'producerClass' IS DISTINCT FROM 'CONTROLLED_FIXTURE_V1' OR p->>'representation' IS DISTINCT FROM 'ANSWER_PARSED_JSON_V1' OR p->>'clockContract' IS DISTINCT FROM 'COMMON_OBSERVED_AT_V1' OR p->>'extractionVersion' IS DISTINCT FROM 'unicode-phrase-v1'
 OR p->'requestedLocale' IS DISTINCT FROM '{"language":"en","market":"IN"}'::jsonb OR p->>'provider' IS DISTINCT FROM (CASE WHEN m->>'profile'='azure-sol-api' THEN 'azure' ELSE 'dataforseo' END)
 OR jsonb_typeof(p->'confirmedLocale') IS DISTINCT FROM 'object' OR (p->'confirmedLocale')-ARRAY['language','market']<>'{}'
 THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 FOREACH x IN ARRAY ARRAY[p->'provider',p->'model',p->'modelVersion',p->'retrievalMode'] LOOP
 IF jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 128 OR x#>>'{}' ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF; END LOOP;
 FOREACH x IN ARRAY ARRAY[p#>'{confirmedLocale,language}',p#>'{confirmedLocale,market}'] LOOP
 IF x IS NULL OR (x<>'null'::jsonb AND (jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 32 OR x#>>'{}' ~ '[[:cntrl:]]')) THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF; END LOOP;
 stamp:=(m->>'createdAt')::timestamptz AT TIME ZONE 'UTC'; deadline:=(m->>'rawExpiresAt')::timestamptz AT TIME ZONE 'UTC';
 IF stamp IS NULL OR stamp>clock_timestamp() AT TIME ZONE 'UTC' OR deadline IS NULL OR deadline<>least(stamp+interval '90 days',coalesce((p->>'rawRightsUntil')::timestamptz AT TIME ZONE 'UTC','infinity'::timestamp)) OR deadline<=clock_timestamp() AT TIME ZONE 'UTC' THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
 IF (SELECT count(DISTINCT v->>'promptId') FROM jsonb_array_elements(m->'slots') v)<>jsonb_array_length(m->'slots') THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 FOR slot_ IN SELECT * FROM jsonb_array_elements(m->'slots') LOOP
 IF jsonb_typeof(slot_) IS DISTINCT FROM 'object' OR slot_-ARRAY['promptId','state','providerTaskId','completedAt','failureReason','extraction','answerHash','answerLength','factDigest']<>'{}'
 OR NOT(slot_ ?& ARRAY['promptId','state','providerTaskId','completedAt','failureReason','extraction','answerHash','answerLength','factDigest'])
 OR NOT EXISTS(SELECT FROM jsonb_array_elements(panel_.prompts) q WHERE q->>'id'=slot_->>'promptId') OR slot_->>'state' NOT IN ('successful','ambiguous','failed','unsupported','no-answer')
 OR slot_->>'providerTaskId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$' OR length(slot_->>'completedAt')>40 OR (slot_->>'completedAt')::timestamptz IS NULL
 OR slot_->'failureReason' IS DISTINCT FROM (CASE slot_->>'state' WHEN 'successful' THEN 'null'::jsonb WHEN 'failed' THEN '"PROVIDER_FAILED"'::jsonb WHEN 'unsupported' THEN '"UNSUPPORTED"'::jsonb WHEN 'no-answer' THEN '"NO_ANSWER"'::jsonb ELSE '"AMBIGUOUS"'::jsonb END)
 OR slot_->>'factDigest' !~ '^[a-f0-9]{64}$' OR jsonb_typeof(slot_->'extraction') IS DISTINCT FROM 'object'
 OR jsonb_typeof(slot_->'answerLength') IS DISTINCT FROM 'number' OR (slot_->>'answerLength')::integer NOT BETWEEN 0 AND 524288
 OR ((slot_->'answerHash'='null'::jsonb) IS DISTINCT FROM ((slot_->>'answerLength')::integer=0))
 OR (slot_->'answerHash'<>'null'::jsonb AND slot_->>'answerHash' !~ '^[a-f0-9]{64}$')
 THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 IF slot_->>'state' IN ('successful','ambiguous') THEN
 IF slot_->'answerHash'='null'::jsonb OR (m->>'profile'<>'azure-sol-api' AND p->'confirmedLocale'<>'{"language":"en","market":"IN"}'::jsonb)
 OR (SELECT count(*) FROM jsonb_each(slot_->'extraction'))<>jsonb_array_length(panel_.brands) THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 ELSIF slot_->'extraction'<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 FOR pair IN SELECT * FROM jsonb_each(slot_->'extraction') LOOP
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(panel_.brands) b WHERE b->>'id'=pair.key) OR jsonb_typeof(pair.value) IS DISTINCT FROM 'object' OR pair.value-ARRAY['mention','citation','recommendation','reason']<>'{}' OR NOT(pair.value ?& ARRAY['mention','citation','recommendation','reason']) THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 FOREACH x IN ARRAY ARRAY[pair.value->'mention',pair.value->'citation',pair.value->'recommendation'] LOOP IF jsonb_typeof(x) NOT IN ('boolean','null') THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF; END LOOP;
 IF pair.value->'reason' NOT IN ('null'::jsonb,'"SHARED_ALIAS"'::jsonb,'"RECOMMENDATION_UNADJUDICATED"'::jsonb) THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 END LOOP;
 END LOOP;
END $$;

CREATE FUNCTION lyraseo_observation.publication_binding(r public."VisibilityRecording") RETURNS text LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array('observation-fixture-publication-binding-v1',r.id,r."runId",r."sourceBinding",r."manifestHash",r.proof,r."proofExpiresAt",r."observedAt",r."rawExpiresAt",
 (SELECT coalesce(jsonb_agg(jsonb_build_array(s."promptId",s."factDigest",s."answerHash",s."answerLength",s.disposition,b.id,lyraseo_audit.version_descriptor(b)) ORDER BY s."promptId"),'[]') FROM public."VisibilityObservationSlot" s LEFT JOIN public."ArtifactBlob" b ON b."recordingId"=s."recordingId" AND b."promptId"=s."promptId" WHERE s."recordingId"=r.id))::text,'UTF8')),'hex')
$$;
CREATE FUNCTION lyraseo_observation.reservation(r public."VisibilityRecording") RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'runId',r."runId",'state',r.state,'proof',r.proof,'binding',lyraseo_observation.publication_binding(r),'versions',
 (SELECT coalesce(jsonb_agg(jsonb_build_object('promptId',s."promptId",'version',CASE WHEN b.id IS NOT NULL THEN lyraseo_audit.version_descriptor(b) END) ORDER BY s."promptId"),'[]') FROM public."VisibilityObservationSlot" s LEFT JOIN public."ArtifactBlob" b ON b."recordingId"=r.id AND b."promptId"=s."promptId" WHERE s."recordingId"=r.id))
$$;
CREATE FUNCTION lyraseo_observation.reserve(s text,panel_ text,epoch integer,session_ text,namespace_ text,key_ text,data_ json,sig json) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx text; r public."VisibilityRecording"; p public."VisibilityPanel"; slot_ jsonb; m jsonb:=(data_->'evidence')::jsonb; mh text:=encode(sha256(convert_to((data_->'evidence')::text,'UTF8')),'hex'); BEGIN
 ctx:=lyraseo_observation.source_context(s,panel_,epoch,session_);
 IF namespace_ IS DISTINCT FROM 'CONTROLLED_FIXTURE_V1' OR key_ IS NULL OR key_ !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR (data_->'provenance')::jsonb IS DISTINCT FROM lyraseo_observation.source_provenance(panel_,namespace_,key_) THEN RAISE EXCEPTION 'UNSUPPORTED_OBSERVATION_SOURCE'; END IF;
 SELECT * INTO p FROM public."VisibilityPanel" WHERE id=panel_;
 SELECT * INTO r FROM public."VisibilityRecording" WHERE ("workspaceId","siteId","sourceNamespace","recordingKey")=(p."workspaceId",s,namespace_,key_) FOR UPDATE;
 IF FOUND THEN
 IF (r."panelId",r."userId",r."securityVersion",r."sessionId",r."sourceBinding",r."manifestHash") IS DISTINCT FROM (panel_,current_setting('app.actor_id',true),epoch,session_,ctx,mh) THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF;
 IF r.state='FINALIZED' THEN RETURN jsonb_build_object('id',r.id,'runId',r."runId",'state',r.state); END IF;
 IF r.state='CANCELLED' OR r."retiredAt" IS NOT NULL THEN RAISE EXCEPTION 'OBSERVATION_RETIRED'; END IF;
 PERFORM lyraseo_observation.validate_manifest(p,m);
 ELSE
 PERFORM lyraseo_observation.validate_manifest(p,m);
 PERFORM lyraseo_audit.verify_artifact_mac('observation-fixture-source-v1',ctx,data_,sig);
 INSERT INTO public."VisibilityRecording"("workspaceId","siteId","panelId","userId","securityVersion","sessionId","sourceNamespace","recordingKey","sourceBinding","manifestHash",manifest,"observedAt","rawExpiresAt") VALUES(p."workspaceId",s,panel_,current_setting('app.actor_id',true),epoch,session_,namespace_,key_,ctx,mh,m,(m->>'createdAt')::timestamptz AT TIME ZONE 'UTC',(m->>'rawExpiresAt')::timestamptz AT TIME ZONE 'UTC') RETURNING * INTO r;
 FOR slot_ IN SELECT * FROM jsonb_array_elements(m->'slots') LOOP
 INSERT INTO public."VisibilityObservationSlot"("workspaceId","siteId","panelId","runId","recordingId","promptId","observedAt","factDigest","answerHash","answerLength","rawExpiresAt",disposition) VALUES(r."workspaceId",s,panel_,r."runId",r.id,slot_->>'promptId',r."observedAt",slot_->>'factDigest',slot_->>'answerHash', (slot_->>'answerLength')::integer,r."rawExpiresAt",CASE WHEN slot_->'answerHash'='null'::jsonb THEN 'NO_BODY' ELSE 'STAGED' END);
 IF slot_->'answerHash'<>'null'::jsonb THEN
 INSERT INTO public."ArtifactBlob"("workspaceId","siteId","ownerKind","recordingId","runId","panelId","promptId",category,rights,"expiryClass","capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength","pageId") VALUES(r."workspaceId",s,'VISIBILITY_SLOT',r.id,r."runId",panel_,slot_->>'promptId','ANSWER_PARSED_JSON_V1','CONTROLLED_FIXTURE_V1','ANSWER_RIGHTS_90D',r."observedAt",r."rawExpiresAt",slot_->>'factDigest',slot_->>'answerHash',(slot_->>'answerLength')::integer,slot_->>'answerHash',(slot_->>'answerLength')::integer,NULL);
 END IF;
 END LOOP;
 END IF;
 -- A fresh reservation rotates the fencing proof, but never source clocks or object identities.
 UPDATE public."VisibilityRecording" SET proof=gen_random_uuid(),"proofExpiresAt"=clock_timestamp()+interval '5 minutes' WHERE id=r.id RETURNING * INTO r;
 IF EXISTS(SELECT FROM public."ArtifactBlob" WHERE "recordingId"=r.id AND state<>'STAGED') THEN RAISE EXCEPTION 'OBSERVATION_RETIRED'; END IF;
 RETURN lyraseo_observation.reservation(r);
END $$;

CREATE FUNCTION lyraseo_observation.replay(s text,panel_ text,epoch integer,session_ text,key_ text,data_ json) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."VisibilityRecording"; ctx text; BEGIN
 ctx:=lyraseo_observation.source_context(s,panel_,epoch,session_);
 SELECT * INTO r FROM public."VisibilityRecording" WHERE ("workspaceId","siteId","sourceNamespace","recordingKey")=(current_setting('app.workspace_id',true),s,'CONTROLLED_FIXTURE_V1',key_) FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF (r."panelId",r."userId",r."securityVersion",r."sessionId",r."sourceBinding",r."manifestHash") IS DISTINCT FROM (panel_,current_setting('app.actor_id',true),epoch,session_,ctx,encode(sha256(convert_to((data_->'evidence')::text,'UTF8')),'hex')) OR (data_->'provenance')::jsonb IS DISTINCT FROM lyraseo_observation.source_provenance(r."panelId",r."sourceNamespace",r."recordingKey") THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF;
 IF r.state='FINALIZED' THEN RETURN jsonb_build_object('id',r."runId",'storageFormat','OBSERVATION_PRIVATE_V1'); END IF;
 IF r.state='CANCELLED' OR r."retiredAt" IS NOT NULL THEN RAISE EXCEPTION 'OBSERVATION_RETIRED'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION lyraseo_observation.finalize(s text,id_ uuid,epoch integer,session_ text,proof_ uuid,data_ json,sig json) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
 PERFORM lyraseo_audit.verify_artifact_mac('observation-fixture-publication-v1',lyraseo_observation.publication_binding(r),data_,sig);
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

-- Preserve legacy checks; the observation branch resolves its own strict composite owner.
ALTER FUNCTION lyraseo_audit.enforce_source_deadline() RENAME TO enforce_audit_source_deadline;
CREATE FUNCTION lyraseo_observation.enforce_ref() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b public."ArtifactBlob"; sl public."VisibilityObservationSlot"; BEGIN
 IF NEW."ownerKind"='AUDIT_PAGE' THEN RETURN NEW; END IF;
 SELECT * INTO b FROM public."ArtifactBlob" WHERE id=NEW."blobId";
 SELECT * INTO sl FROM public."VisibilityObservationSlot" WHERE ("recordingId","promptId")=(NEW."recordingId",NEW."promptId");
 IF b.state IS DISTINCT FROM 'READY' OR sl.disposition IS DISTINCT FROM 'READY' OR b."sourceHash" IS DISTINCT FROM sl."answerHash" OR b."factHash" IS DISTINCT FROM sl."factDigest" THEN RAISE EXCEPTION 'INVALID_SOURCE_BINDING'; END IF;
 RETURN NEW;
END $$;
-- The original trigger's function cannot be called as a normal function. Keep it for audit only.
DROP TRIGGER bind_artifact_source ON "ArtifactRef";
CREATE TRIGGER bind_artifact_source BEFORE INSERT OR UPDATE ON "ArtifactRef" FOR EACH ROW WHEN (NEW."ownerKind"='AUDIT_PAGE') EXECUTE FUNCTION lyraseo_audit.enforce_audit_source_deadline();
CREATE TRIGGER bind_observation_source BEFORE INSERT OR UPDATE ON "ArtifactRef" FOR EACH ROW EXECUTE FUNCTION lyraseo_observation.enforce_ref();
CREATE FUNCTION lyraseo_observation.guard_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r public."VisibilityRecording"; BEGIN
 IF TG_OP='UPDATE' AND (OLD."storageFormat" IS DISTINCT FROM NEW."storageFormat" OR OLD."storageFormat"='OBSERVATION_PRIVATE_V1') THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF;
 IF NEW."storageFormat" IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO r FROM public."VisibilityRecording" WHERE "runId"=NEW.id AND state='STAGED';
 IF current_user<>'lyraseo_kernel_owner' OR NEW."rawAnswers" IS NOT NULL OR r.id IS NULL OR
 (NEW."workspaceId",NEW."siteId",NEW."panelId",NEW.profile,NEW.cohort,NEW.provenance,NEW."createdAt",NEW."rawExpiresAt") IS DISTINCT FROM
 (r."workspaceId",r."siteId",r."panelId",r.manifest->>'profile',r.manifest->>'cohort',r.manifest->'provenance',r."observedAt",r."rawExpiresAt") OR NEW.slots IS DISTINCT FROM (SELECT jsonb_agg(v-ARRAY['answerHash','answerLength','factDigest'] ORDER BY n) FROM jsonb_array_elements(r.manifest->'slots') WITH ORDINALITY q(v,n)) THEN RAISE EXCEPTION 'INVALID_PROVIDER_EVIDENCE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER private_observation_run BEFORE INSERT OR UPDATE ON "VisibilityRun" FOR EACH ROW EXECUTE FUNCTION lyraseo_observation.guard_run();
CREATE FUNCTION lyraseo_observation.guard_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME IN ('ArtifactBlob','ArtifactRef') THEN IF OLD."ownerKind" IS DISTINCT FROM NEW."ownerKind" THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF; END IF;
 IF TG_TABLE_NAME='VisibilityRecording' THEN
 IF to_jsonb(NEW)-ARRAY['state','proof','proofExpiresAt','retiredAt'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['state','proof','proofExpiresAt','retiredAt'] OR (OLD.state<>'STAGED' AND NEW.state<>OLD.state) OR (OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt") THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF;
 ELSIF TG_TABLE_NAME='VisibilityObservationSlot' THEN
 IF to_jsonb(NEW)-'disposition' IS DISTINCT FROM to_jsonb(OLD)-'disposition' OR (OLD.disposition IN ('RETIRED','CANCELLED') AND NEW.disposition<>OLD.disposition) OR (OLD.disposition='NO_BODY' AND NEW.disposition NOT IN ('NO_BODY','RETIRED','CANCELLED')) OR (OLD.disposition='READY' AND NEW.disposition NOT IN ('READY','RETIRED')) THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF;
 ELSIF TG_TABLE_NAME='ArtifactBlob' THEN
 IF OLD."ownerKind"='VISIBILITY_SLOT' AND (to_jsonb(NEW)-'state' IS DISTINCT FROM to_jsonb(OLD)-'state' OR (OLD.state IN ('ORPHAN','DELETED') AND NEW.state NOT IN ('ORPHAN','DELETED')) OR (OLD.state='READY' AND NEW.state='STAGED')) THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION'; END IF;
 ELSIF OLD."ownerKind"='VISIBILITY_SLOT' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER observation_recording_identity BEFORE UPDATE ON "VisibilityRecording" FOR EACH ROW EXECUTE FUNCTION lyraseo_observation.guard_identity();
CREATE TRIGGER observation_slot_identity BEFORE UPDATE ON "VisibilityObservationSlot" FOR EACH ROW EXECUTE FUNCTION lyraseo_observation.guard_identity();
CREATE TRIGGER observation_blob_identity BEFORE UPDATE ON "ArtifactBlob" FOR EACH ROW EXECUTE FUNCTION lyraseo_observation.guard_identity();
CREATE TRIGGER observation_ref_identity BEFORE UPDATE ON "ArtifactRef" FOR EACH ROW EXECUTE FUNCTION lyraseo_observation.guard_identity();

CREATE FUNCTION lyraseo_observation.retire(s text,id_ text,epoch integer,session_ text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."VisibilityRecording"; BEGIN
 PERFORM lyraseo_observation.scope_guard(s,epoch,session_,true);
 SELECT * INTO r FROM public."VisibilityRecording" WHERE ("workspaceId","siteId","runId")=(current_setting('app.workspace_id',true),s,id_) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM 1 FROM public."ArtifactBlob" WHERE "recordingId"=r.id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."ArtifactRef" WHERE "recordingId"=r.id ORDER BY id FOR UPDATE;
 UPDATE public."VisibilityRecording" SET state=CASE WHEN state='STAGED' THEN 'CANCELLED' ELSE state END,"retiredAt"=coalesce("retiredAt",clock_timestamp()),proof=gen_random_uuid() WHERE id=r.id;
 UPDATE public."VisibilityObservationSlot" SET disposition=CASE WHEN r.state='STAGED' THEN 'CANCELLED' ELSE 'RETIRED' END WHERE "recordingId"=r.id;
 UPDATE public."ArtifactBlob" SET state='ORPHAN' WHERE "recordingId"=r.id AND state IN ('STAGED','READY');
END $$;

CREATE FUNCTION lyraseo_observation.ticket(s text,id_ text,prompt_ text,epoch integer,session_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
 IF b.state IS DISTINCT FROM 'READY' OR f.id IS NULL OR f."expiresAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN RETURN jsonb_build_object('state','unavailable','reason','NO_LICENSED_REF'); END IF;
 RETURN jsonb_build_object('state','retained-parsed','reason','READY','version',lyraseo_audit.version_descriptor(b),'refId',f.id,'runId',r."runId",'panelId',r."panelId",'promptId',sl."promptId",'factDigest',sl."factDigest",'sourceBinding',r."sourceBinding",'manifestHash',r."manifestHash",'observedAt',sl."observedAt" AT TIME ZONE 'UTC','deadline',least(sl."rawExpiresAt",f."expiresAt",result_deadline) AT TIME ZONE 'UTC','actor',current_setting('app.actor_id',true),'epoch',epoch,'session',session_,'representation','ANSWER_PARSED_JSON_V1','producerClass','CONTROLLED_FIXTURE_V1','originalProviderWire',false);
END $$;

-- Every helper is private; runtime sees only explicit scoped entry points. B/C gain nothing.
DO $$ DECLARE f record; BEGIN FOR f IN SELECT oid::regprocedure fn FROM pg_proc WHERE pronamespace='lyraseo_observation'::regnamespace LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_kernel_owner',f.fn); EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.fn); END LOOP; END $$;
GRANT EXECUTE ON FUNCTION lyraseo_observation.replay(text,text,integer,text,text,json),lyraseo_observation.source_context(text,text,integer,text),lyraseo_observation.reserve(text,text,integer,text,text,text,json,json),lyraseo_observation.finalize(text,uuid,integer,text,uuid,json,json),lyraseo_observation.retire(text,text,integer,text),lyraseo_observation.ticket(text,text,text,integer,text) TO lyraseo_runtime;
-- Required only for row locks, no new identity-writing operation.
GRANT UPDATE("userId") ON "Membership","SiteGrant" TO lyraseo_kernel_owner;
COMMIT;
