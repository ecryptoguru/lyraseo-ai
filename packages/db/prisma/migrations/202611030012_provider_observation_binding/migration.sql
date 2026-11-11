BEGIN;
-- A fixture-only operation/panel binding. This does not qualify any real account,
-- grant artifact ingestion, or relax CONTROLLED_FIXTURE_V1 source constraints.
CREATE SCHEMA lyraseo_observation_binding;
REVOKE ALL ON SCHEMA lyraseo_observation_binding FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_observation_binding TO lyraseo_ledger_owner,lyraseo_ledger_fixture;
CREATE TABLE lyraseo_observation_binding.fixture_attempt (
 attempt_id uuid PRIMARY KEY REFERENCES lyraseo_ledger.attempt(id) ON DELETE RESTRICT,
 operation_id text NOT NULL REFERENCES lyraseo_ledger.managed_operation(operation_id) ON DELETE RESTRICT,
 panel_id text NOT NULL REFERENCES public."VisibilityPanel"(id) ON DELETE RESTRICT,
 panel_version integer NOT NULL CHECK(panel_version>0),prompt_id text NOT NULL,
 prompt_version text NOT NULL,profile text NOT NULL CHECK(profile IN ('azure-sol-api','consumer-chatgpt','consumer-gemini')),
 scenario text NOT NULL CHECK(scenario IN ('complete','refusal','truncated','wrong-locale','missing-cost','pending','ambiguous-post')),
 adapter_version text NOT NULL CHECK(adapter_version='observation-adapters-v1'),
 source_class text NOT NULL CHECK(source_class='SYNTHETIC'),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE lyraseo_observation_binding.fixture_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_observation_binding.fixture_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY fixture_binding_owner ON lyraseo_observation_binding.fixture_attempt TO lyraseo_ledger_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON lyraseo_observation_binding.fixture_attempt TO lyraseo_ledger_owner;
CREATE TRIGGER immutable_fixture_binding BEFORE UPDATE OR DELETE ON lyraseo_observation_binding.fixture_attempt FOR EACH ROW EXECUTE FUNCTION lyraseo_ledger.immutable();
-- Only narrowly scoped DEFINER functions can disclose an admitted fixture prompt.
GRANT SELECT,UPDATE(id) ON public."VisibilityPanel" TO lyraseo_ledger_owner;
CREATE POLICY ledger_fixture_panel ON public."VisibilityPanel" TO lyraseo_ledger_owner USING(true) WITH CHECK(false);
CREATE FUNCTION lyraseo_observation_binding.prepare_fixture(op_id text,fence_ integer,step_ text,revision_ integer,panel_ jsonb,prompt_id_ text,prompt_version_ text,profile_ text,scenario_ text,request_hash_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o public."Operation"; p public."VisibilityPanel"; expected_profile text; a jsonb; prior lyraseo_observation_binding.fixture_attempt; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();
 SELECT * INTO o FROM public."Operation" WHERE id=op_id FOR UPDATE;
 SELECT CASE o.kind WHEN 'API_OBSERVATION' THEN 'azure-sol-api' WHEN 'CHATGPT_OBSERVATION' THEN 'consumer-chatgpt' WHEN 'GEMINI_OBSERVATION' THEN 'consumer-gemini' END INTO expected_profile;
 IF expected_profile IS NULL OR profile_ IS DISTINCT FROM expected_profile OR o."ledgerMode"<>'FIXTURE' THEN RAISE EXCEPTION 'OBSERVATION_PROFILE_MISMATCH'; END IF;
 SELECT * INTO p FROM public."VisibilityPanel" WHERE id=panel_->>'id' AND "workspaceId"=o."workspaceId" AND "siteId"=o."siteId" AND "reviewedAt" IS NOT NULL FOR SHARE;
 IF p.id IS NULL OR panel_ IS DISTINCT FROM jsonb_build_object('id',p.id,'version',p.version,'prompts',p.prompts,'brands',p.brands)
 OR NOT EXISTS(SELECT FROM jsonb_array_elements(p.prompts)x WHERE x->>'id'=prompt_id_)
 OR prompt_version_ IS DISTINCT FROM 'panel-'||p.version::text||':'||prompt_id_ THEN RAISE EXCEPTION 'FROZEN_PANEL_SLOT_REQUIRED'; END IF;
 IF scenario_ IS NULL OR scenario_ NOT IN ('complete','refusal','truncated','wrong-locale','missing-cost','pending','ambiguous-post') THEN RAISE EXCEPTION 'UNSUPPORTED_FIXTURE'; END IF;
 a:=lyraseo_ledger.prepare_attempt(op_id,fence_,step_,request_hash_,revision_);
 SELECT * INTO prior FROM lyraseo_observation_binding.fixture_attempt WHERE attempt_id=(a->>'id')::uuid;
 IF prior.attempt_id IS NOT NULL THEN
  IF (prior.operation_id,prior.panel_id,prior.panel_version,prior.prompt_id,prior.prompt_version,prior.profile,prior.scenario) IS DISTINCT FROM (op_id,p.id,p.version,prompt_id_,prompt_version_,profile_,scenario_) THEN RAISE EXCEPTION 'IMMUTABLE_OBSERVATION_BINDING'; END IF;
 ELSE
  IF (a->>'submissionGranted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'OBSERVATION_BINDING_REQUIRED'; END IF;
  INSERT INTO lyraseo_observation_binding.fixture_attempt(attempt_id,operation_id,panel_id,panel_version,prompt_id,prompt_version,profile,scenario,adapter_version,source_class)
  VALUES((a->>'id')::uuid,op_id,p.id,p.version,prompt_id_,prompt_version_,profile_,scenario_,'observation-adapters-v1','SYNTHETIC');
 END IF;
 RETURN a;
END $$;
CREATE FUNCTION lyraseo_observation_binding.known_fixture_task(attempt_ uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; BEGIN
 PERFORM lyraseo_ledger.fixture_guard();
 SELECT jsonb_build_object('operationId',b.operation_id,'panelId',b.panel_id,'promptId',b.prompt_id,'profile',b.profile,'scenario',b.scenario,'context',jsonb_build_object('profile',b.profile,'account',m.account_fingerprint,'taskId',a.external_task_id,'prompt',prompt.value->>'text','promptVersion',b.prompt_version,'locationCode',2356,'language','en','market','IN'),'cost',e.payload->>'cost','observedAt',e.payload->>'observedAt') INTO result
 FROM lyraseo_observation_binding.fixture_attempt b JOIN lyraseo_ledger.attempt a ON a.id=b.attempt_id AND a.operation_id=b.operation_id
 JOIN lyraseo_ledger.managed_operation m ON m.operation_id=a.operation_id JOIN public."VisibilityPanel" p ON p.id=b.panel_id AND p.version=b.panel_version
 JOIN lyraseo_ledger.attempt_event e ON e.attempt_id=a.id AND e.source_key='fixture-post-accepted:'||a.id::text AND e.kind='ACCEPTED'
 CROSS JOIN LATERAL jsonb_array_elements(p.prompts) prompt(value)
 WHERE a.id=attempt_ AND a.external_task_id IS NOT NULL AND prompt.value->>'id'=b.prompt_id AND b.source_class='SYNTHETIC' AND b.profile<>'azure-sol-api';
 IF result IS NULL THEN RAISE EXCEPTION 'KNOWN_TASK_REQUIRED'; END IF;
 RETURN result;
END $$;
ALTER FUNCTION lyraseo_observation_binding.known_fixture_task(uuid) OWNER TO lyraseo_ledger_owner;
REVOKE ALL ON FUNCTION lyraseo_observation_binding.known_fixture_task(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_observation_binding.known_fixture_task(uuid) TO lyraseo_ledger_fixture;
-- No supported live qualification exists in29: classification excludes QUALIFIED,
-- live_enabled has CHECK(NOT live_enabled), operation modes exclude PROVIDER, and
-- attempt receipts are SYNTHETIC_LEDGER_V1 only. A flag is never a producer grant.
CREATE FUNCTION lyraseo_observation_binding.provider_source_eligibility() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('available',false,'producerVersion','PROVIDER_OBSERVATION_V1','reason','QUALIFIED_PROVIDER_LEDGER_AND_EXECUTION_PRINCIPAL_REQUIRED','sourcePersistence',false)
$$;
ALTER FUNCTION lyraseo_observation_binding.prepare_fixture(text,integer,text,integer,jsonb,text,text,text,text,text) OWNER TO lyraseo_ledger_owner;
ALTER FUNCTION lyraseo_observation_binding.provider_source_eligibility() OWNER TO lyraseo_ledger_owner;
REVOKE ALL ON FUNCTION lyraseo_observation_binding.prepare_fixture(text,integer,text,integer,jsonb,text,text,text,text,text),lyraseo_observation_binding.provider_source_eligibility() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_observation_binding.prepare_fixture(text,integer,text,integer,jsonb,text,text,text,text,text),lyraseo_observation_binding.provider_source_eligibility() TO lyraseo_ledger_fixture;
COMMIT;
