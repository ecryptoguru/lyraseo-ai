-- Quiesced cutover only. Drain all old publishers/admissions before taking
-- these locks. Old binaries with prefetched references cannot be fenced by SQL.
BEGIN;
SET LOCAL search_path = pg_catalog, public, pg_temp;
-- Abort if migration authority would see an RLS-filtered subset at backfill.
SET LOCAL row_security = off;
LOCK TABLE public."Operation", public."OutboxEvent" IN ACCESS EXCLUSIVE MODE;
-- Cluster roles must be preprovisioned, with no runtime membership path to
-- the definer, no default privileged memberships and no administrative powers.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_roles WHERE rolname IN
    ('lyraseo_kernel_owner','lyraseo_dispatch','lyraseo_operator','lyraseo_runtime','lyraseo_identity')
  LOOP
    IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
      OR (r.rolname='lyraseo_kernel_owner')=r.rolcanlogin
      OR EXISTS (SELECT FROM pg_auth_members WHERE member=r.oid)
      OR EXISTS (SELECT FROM pg_database WHERE datname=current_database() AND datdba=r.oid)
      OR EXISTS (SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=r.oid)
      OR (r.rolname IN ('lyraseo_kernel_owner','lyraseo_dispatch','lyraseo_operator') AND EXISTS (
        SELECT FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m')
        AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))))
      OR (r.rolname='lyraseo_kernel_owner' AND EXISTS (SELECT FROM pg_auth_members WHERE roleid=r.oid))
    THEN RAISE EXCEPTION 'unsafe kernel role: %',r.rolname; END IF;
  END LOOP;
END $$;
-- The definer owns only narrow functions. Future functions created *by it*
-- must also opt in to EXECUTE. Installer-created functions are revoked below.
ALTER DEFAULT PRIVILEGES FOR ROLE lyraseo_kernel_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE SCHEMA lyraseo_kernel;
REVOKE ALL ON SCHEMA lyraseo_kernel FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_kernel TO lyraseo_kernel_owner,lyraseo_dispatch,lyraseo_operator;
GRANT USAGE ON SCHEMA public TO lyraseo_kernel_owner;
ALTER TABLE public."Operation" ADD UNIQUE ("workspaceId","siteId","userId",id);
ALTER TABLE public."AuditRun" ADD UNIQUE ("workspaceId","siteId","userId",id);

CREATE TABLE public."RuntimePolicy" (
  key text PRIMARY KEY CHECK (key IN ('global','audits','context','search','analytics','content','visibility','mcp')),
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  "changedAt" timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public."RuntimePolicy"(key) VALUES
  ('global'),('audits'),('context'),('search'),('analytics'),('content'),('visibility'),('mcp');
CREATE TABLE public."RuntimePolicyChange" (
  key text NOT NULL REFERENCES public."RuntimePolicy"(key),
  revision integer NOT NULL, enabled boolean NOT NULL,
  "operatorId" text NOT NULL, "changedAt" timestamptz NOT NULL,
  PRIMARY KEY(key,revision)
);
-- Intentionally empty in every migrated database. The validated disposable
-- bootstrap registers the database on this running postmaster. Restoring a
-- cluster or restarting it requires fresh administrator registration.
CREATE TABLE lyraseo_kernel.test_environment (
  database_oid oid PRIMARY KEY,
  postmaster_started_at timestamptz NOT NULL DEFAULT pg_catalog.pg_postmaster_start_time()
);

CREATE TABLE public."WorkDispatch" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" text NOT NULL, "siteId" text NOT NULL, "userId" text NOT NULL,
  "admittedSecurityVersion" integer NOT NULL, "initiatedSessionId" text,
  "targetKind" text NOT NULL, "operationId" text UNIQUE, "auditId" text UNIQUE,
  "archiveId" text UNIQUE REFERENCES public."OutboxEvent"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  capability text NOT NULL, profile text NOT NULL,
  eligibility text NOT NULL CHECK (eligibility IN ('CONTROLLED_TEST','RECONCILIATION_ONLY','QUARANTINED')),
  "ledgerHandoff" text NOT NULL DEFAULT 'NONE' CHECK ("ledgerHandoff" IN ('NONE','PENDING','REPORTED')),
  CHECK ("targetKind"='OPERATION' OR "ledgerHandoff"='NONE'),
  "admittedAt" timestamptz NOT NULL, "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
  disposition text NOT NULL CHECK(disposition IN ('INERT','PENDING','DELIVERED','SUPPRESSED')),
  generation integer NOT NULL DEFAULT 1 CHECK(generation>=1), "nextAttemptAt" timestamptz,
  "deliveredAt" timestamptz, "claimToken" uuid, "leaseUntil" timestamptz,
  "sendAttempts" integer NOT NULL DEFAULT 0 CHECK("sendAttempts">=0), "lastErrorCode" text,
  FOREIGN KEY ("workspaceId","siteId","userId","operationId")
    REFERENCES public."Operation"("workspaceId","siteId","userId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY ("workspaceId","siteId","userId","auditId")
    REFERENCES public."AuditRun"("workspaceId","siteId","userId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((("targetKind"='AUDIT_RAW' AND "auditId" IS NOT NULL AND "operationId" IS NULL AND capability='audits' AND "archiveId" IS NULL)
      OR ("targetKind"='OPERATION' AND "operationId" IS NOT NULL AND "auditId" IS NULL AND capability IN ('content','visibility','unsupported')))),
  CHECK ((eligibility='CONTROLLED_TEST')=("targetKind"='AUDIT_RAW' AND profile='CONTROLLED_RAW_TEST_V1')),
  CHECK (eligibility='CONTROLLED_TEST' OR disposition IN ('INERT','SUPPRESSED')),
  CHECK ((disposition IN ('PENDING','DELIVERED'))=("nextAttemptAt" IS NOT NULL)),
  CHECK (("claimToken" IS NULL)=("leaseUntil" IS NULL)),
  CHECK ("claimToken" IS NULL OR disposition='PENDING'),
  CHECK (disposition<>'DELIVERED' OR "deliveredAt" IS NOT NULL),
  CHECK ("revokedAt" IS NULL OR disposition='SUPPRESSED')
);
CREATE INDEX dispatch_due ON public."WorkDispatch"("nextAttemptAt",id) WHERE "nextAttemptAt" IS NOT NULL;
CREATE INDEX dispatch_lease ON public."WorkDispatch"("leaseUntil",id)
 WHERE disposition='PENDING' AND eligibility='CONTROLLED_TEST' AND "leaseUntil" IS NOT NULL;
CREATE INDEX dispatch_stale_delivered ON public."WorkDispatch"("nextAttemptAt",id)
 WHERE disposition='DELIVERED' AND eligibility='CONTROLLED_TEST';
CREATE INDEX dispatch_expiry ON public."WorkDispatch"("expiresAt",id)
 WHERE eligibility='CONTROLLED_TEST' AND disposition IN ('PENDING','DELIVERED');
CREATE INDEX dispatch_ledger_pending ON public."WorkDispatch"("createdAt",id)
 WHERE "ledgerHandoff"='PENDING';
CREATE INDEX dispatch_scope ON public."WorkDispatch"("workspaceId","siteId","userId");

CREATE TABLE public."InternalRequest" (
  "servicePrincipalId" text NOT NULL, "requestId" uuid NOT NULL,
  fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
  "issuedAt" timestamptz NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), state text NOT NULL,
  "ownerToken" uuid, fence integer NOT NULL CHECK(fence>=1), "leaseUntil" timestamptz,
  "completedAt" timestamptz, result jsonb,
  CHECK (result IS NULL OR octet_length(result::text)<=32768),
  CHECK ((state='ACTIVE' AND "ownerToken" IS NOT NULL AND "leaseUntil" IS NOT NULL AND "completedAt" IS NULL AND result IS NULL)
      OR (state='COMPLETE' AND "ownerToken" IS NULL AND "leaseUntil" IS NULL AND "completedAt" IS NOT NULL AND result IS NOT NULL)),
  PRIMARY KEY("servicePrincipalId","requestId")
);
CREATE INDEX request_cleanup ON public."InternalRequest"("expiresAt","requestId");

-- CONTROLLED_TEST fixtures are inserted only by the isolated test admin.
-- Inert classifications distinguish SQL NULL and the valid JSON literal null.
CREATE FUNCTION lyraseo_kernel.op_capability(kind text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN kind IN ('GENERATION','RESEARCH') THEN 'content'
   WHEN kind IN ('API_OBSERVATION','CHATGPT_OBSERVATION','GEMINI_OBSERVATION') THEN 'visibility' ELSE 'unsupported' END
$$;
CREATE FUNCTION lyraseo_kernel.record_operation(op public."Operation", archived text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF op."settledAt" IS NOT NULL OR op."actualCost" IS NOT NULL OR op.status IN ('COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED') THEN RETURN; END IF;
  INSERT INTO public."WorkDispatch"("workspaceId","siteId","userId","admittedSecurityVersion","initiatedSessionId",
    "targetKind","operationId","archiveId",capability,profile,eligibility,"ledgerHandoff","admittedAt","expiresAt",disposition)
  VALUES(op."workspaceId",op."siteId",op."userId",op."securityVersion",op."sessionId",'OPERATION',op.id,archived,
    lyraseo_kernel.op_capability(op.kind),
    CASE WHEN op."requestInput" IS NULL THEN 'ABSENT_INPUT' WHEN op."requestInput"='null'::jsonb THEN 'JSON_NULL' ELSE 'UNQUALIFIED_INPUT' END,
    CASE WHEN op."attemptState"<>'NONE' THEN 'RECONCILIATION_ONLY' ELSE 'QUARANTINED' END,
    CASE WHEN op."attemptState"<>'NONE' THEN 'PENDING' ELSE 'NONE' END,
    op."createdAt" AT TIME ZONE 'UTC',op."expiresAt" AT TIME ZONE 'UTC','INERT');
END $$;
SELECT lyraseo_kernel.record_operation(o,e.id)
FROM public."Operation" o LEFT JOIN public."OutboxEvent" e ON e."operationId"=o.id
WHERE NOT EXISTS (SELECT FROM public."UsageReceipt" r WHERE r."operationId"=o.id);

CREATE FUNCTION lyraseo_kernel.archive_operation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE archive_id text := gen_random_uuid()::text;
BEGIN
  INSERT INTO public."OutboxEvent"(id,"operationId","workspaceId","userId") VALUES(archive_id,NEW.id,NEW."workspaceId",NEW."userId");
  PERFORM lyraseo_kernel.record_operation(NEW,archive_id);
  RETURN NEW;
END $$;
CREATE TRIGGER archive_operation AFTER INSERT ON public."Operation" FOR EACH ROW EXECUTE FUNCTION lyraseo_kernel.archive_operation();

CREATE FUNCTION lyraseo_kernel.immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_HISTORY'; END $$;
-- Also reject changes arriving indirectly via legacy ON UPDATE/DELETE CASCADE.
CREATE TRIGGER archive_immutable BEFORE UPDATE OR DELETE ON public."OutboxEvent" FOR EACH ROW EXECUTE FUNCTION lyraseo_kernel.immutable();
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON public."UsageReceipt" FOR EACH ROW EXECUTE FUNCTION lyraseo_kernel.immutable();
CREATE TRIGGER policy_history_immutable BEFORE UPDATE OR DELETE ON public."RuntimePolicyChange" FOR EACH ROW EXECUTE FUNCTION lyraseo_kernel.immutable();

CREATE FUNCTION lyraseo_kernel.check_dispatch_identity() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW."workspaceId",NEW."siteId",NEW."userId",NEW."admittedSecurityVersion",NEW."initiatedSessionId",NEW."targetKind",NEW."operationId",NEW."auditId",NEW."archiveId",NEW.capability,NEW.profile,NEW.eligibility,NEW."admittedAt",NEW."expiresAt",NEW."createdAt")
      IS DISTINCT FROM ROW(OLD.id,OLD."workspaceId",OLD."siteId",OLD."userId",OLD."admittedSecurityVersion",OLD."initiatedSessionId",OLD."targetKind",OLD."operationId",OLD."auditId",OLD."archiveId",OLD.capability,OLD.profile,OLD.eligibility,OLD."admittedAt",OLD."expiresAt",OLD."createdAt")
    THEN RAISE EXCEPTION 'IMMUTABLE_DISPATCH'; END IF;
  ELSIF NEW."targetKind"='AUDIT_RAW' AND NOT EXISTS (
    SELECT FROM public."AuditRun" a WHERE (a.id,a."workspaceId",a."siteId",a."userId",a."securityVersion",a.profile)
     =(NEW."auditId",NEW."workspaceId",NEW."siteId",NEW."userId",NEW."admittedSecurityVersion",NEW.profile)
    AND NEW."admittedAt"=(a."createdAt" AT TIME ZONE 'UTC')
    AND NEW."expiresAt" BETWEEN NEW."admittedAt" AND NEW."admittedAt"+interval '1 day'
    AND NEW.eligibility='CONTROLLED_TEST' AND lyraseo_kernel.is_test_database()
  ) THEN RAISE EXCEPTION 'INVALID_AUDIT_BINDING';
  ELSIF NEW."targetKind"='OPERATION' AND NOT EXISTS (
    SELECT FROM public."Operation" o WHERE (o.id,o."workspaceId",o."siteId",o."userId",o."securityVersion",o."sessionId")
     =(NEW."operationId",NEW."workspaceId",NEW."siteId",NEW."userId",NEW."admittedSecurityVersion",NEW."initiatedSessionId")
    AND NEW."admittedAt"=(o."createdAt" AT TIME ZONE 'UTC') AND NEW."expiresAt"=(o."expiresAt" AT TIME ZONE 'UTC')
    AND NEW.capability=lyraseo_kernel.op_capability(o.kind)
    AND NEW.profile=(CASE WHEN o."requestInput" IS NULL THEN 'ABSENT_INPUT' WHEN o."requestInput"='null'::jsonb THEN 'JSON_NULL' ELSE 'UNQUALIFIED_INPUT' END)
    AND NEW.eligibility=(CASE WHEN o."attemptState"='NONE' THEN 'QUARANTINED' ELSE 'RECONCILIATION_ONLY' END)
    AND (NEW."archiveId" IS NULL OR EXISTS (SELECT FROM public."OutboxEvent" e WHERE e.id=NEW."archiveId" AND e."operationId"=o.id))
  ) THEN RAISE EXCEPTION 'INVALID_OPERATION_BINDING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_identity BEFORE INSERT OR UPDATE ON public."WorkDispatch"
 FOR EACH ROW EXECUTE FUNCTION lyraseo_kernel.check_dispatch_identity();

-- Fires with target already locked. Neither target fences nor balances change.
CREATE FUNCTION lyraseo_kernel.suppress_target() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE unresolved boolean;
BEGIN
  IF TG_TABLE_NAME='Operation' THEN
    unresolved := NEW."settledAt" IS NULL AND NEW."actualCost" IS NULL AND NEW."attemptState"<>'NONE'
      AND NEW.status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED');
    UPDATE public."WorkDispatch" SET disposition='SUPPRESSED',"revokedAt"=coalesce("revokedAt",clock_timestamp()),
      "nextAttemptAt"=NULL,"leaseUntil"=NULL,"claimToken"=NULL,
      "ledgerHandoff"=CASE WHEN unresolved AND "ledgerHandoff"='NONE' THEN 'PENDING'
        WHEN NOT unresolved AND "ledgerHandoff"='PENDING' THEN 'NONE' ELSE "ledgerHandoff" END
    WHERE "operationId"=NEW.id AND ("revokedAt" IS NULL OR
      (unresolved AND "ledgerHandoff"='NONE') OR (NOT unresolved AND "ledgerHandoff"='PENDING'));
  ELSE
    UPDATE public."WorkDispatch" SET disposition='SUPPRESSED',"revokedAt"=clock_timestamp(),"nextAttemptAt"=NULL,"leaseUntil"=NULL,"claimToken"=NULL
    WHERE "auditId"=NEW.id AND "revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER suppress_operation AFTER UPDATE ON public."Operation" FOR EACH ROW
 WHEN (NEW."cancelRequestedAt" IS NOT NULL OR NEW."settledAt" IS NOT NULL OR NEW.status IN ('COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED'))
 EXECUTE FUNCTION lyraseo_kernel.suppress_target();
CREATE TRIGGER suppress_audit AFTER UPDATE ON public."AuditRun" FOR EACH ROW
 WHEN (NEW.status IN ('COMPLETED','FAILED')) EXECUTE FUNCTION lyraseo_kernel.suppress_target();

CREATE FUNCTION lyraseo_kernel.is_test_database() RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT FROM lyraseo_kernel.test_environment e JOIN pg_database d ON e.database_oid=d.oid WHERE d.datname=current_database() AND e.postmaster_started_at=pg_catalog.pg_postmaster_start_time())
$$;
CREATE FUNCTION lyraseo_kernel.read_policy(policy_key text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE snapshot jsonb;
BEGIN
  IF session_user<>'lyraseo_operator' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  SELECT jsonb_build_object('key',key,'enabled',enabled,'revision',revision,'changedAt',"changedAt")
    INTO snapshot FROM public."RuntimePolicy" WHERE key=policy_key;
  RETURN snapshot;
END $$;

CREATE FUNCTION lyraseo_kernel.change_policy(policy_key text, expected integer, turn_on boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE changed public."RuntimePolicy";
BEGIN
  IF session_user<>'lyraseo_operator' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  UPDATE public."RuntimePolicy" SET enabled=turn_on,revision=revision+1,"changedAt"=clock_timestamp()
    WHERE key=policy_key AND revision=expected RETURNING * INTO changed;
  IF NOT FOUND THEN RAISE EXCEPTION 'POLICY_CONFLICT'; END IF;
  INSERT INTO public."RuntimePolicyChange" VALUES(changed.key,changed.revision,changed.enabled,session_user,changed."changedAt");
  RETURN changed.revision;
END $$;

CREATE FUNCTION lyraseo_kernel.approved() RETURNS boolean LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  -- Acquire both rows in the same order and hold through the short transaction.
  PERFORM 1 FROM public."RuntimePolicy" WHERE key IN ('global','audits') ORDER BY key FOR SHARE;
  RETURN lyraseo_kernel.is_test_database() AND
    (SELECT count(*)=2 FROM public."RuntimePolicy" WHERE key IN ('global','audits') AND enabled);
END $$;
CREATE FUNCTION lyraseo_kernel.valid_target(d public."WorkDispatch") RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT d."targetKind"='AUDIT_RAW' AND d.eligibility='CONTROLLED_TEST' AND d.profile='CONTROLLED_RAW_TEST_V1'
 AND d.capability='audits' AND d."revokedAt" IS NULL AND d."expiresAt">clock_timestamp()
 AND EXISTS (
   SELECT FROM public."AuditRun" a
   JOIN public."ProductUser" u ON u.id=a."userId" AND u."securityVersion"=a."securityVersion" AND NOT u.suspended
   JOIN public."Workspace" w ON w.id=a."workspaceId" AND w."deletedAt" IS NULL
   JOIN public."Site" s ON (s."workspaceId",s.id)=(a."workspaceId",a."siteId") AND s."deletedAt" IS NULL
   JOIN public."Membership" m ON (m."workspaceId",m."userId")=(a."workspaceId",a."userId")
   WHERE (a.id,a."workspaceId",a."siteId",a."userId",a."securityVersion",a.profile)
      =(d."auditId",d."workspaceId",d."siteId",d."userId",d."admittedSecurityVersion",d.profile)
   AND a.status='QUEUED' AND a."leaseUntil" IS NULL
   AND s."verifiedAt" AT TIME ZONE 'UTC' BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()+interval '30 seconds'
   AND (m.role IN ('OWNER','ADMIN') OR (m.role='EDITOR' AND EXISTS(
      SELECT FROM public."SiteGrant" g WHERE (g."workspaceId",g."siteId",g."userId")=(d."workspaceId",d."siteId",d."userId")))))
$$;

CREATE FUNCTION lyraseo_kernel.resolve_step(work_id uuid, gen integer) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE binding jsonb;
BEGIN
  IF session_user<>'lyraseo_dispatch' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF lyraseo_kernel.approved() THEN
    SELECT jsonb_build_object('workId',d.id,'generation',d.generation,'targetId',d."auditId",'action','INSPECT_CONTROLLED_AUDIT',
        'workspaceId',d."workspaceId",'siteId',d."siteId",'userId',d."userId",'securityVersion',d."admittedSecurityVersion")
    INTO binding FROM public."WorkDispatch" d WHERE d.id=work_id AND d.generation=gen AND d.disposition='DELIVERED' AND lyraseo_kernel.valid_target(d);
  END IF;
  RETURN binding;
END $$;

-- Each lane has a matching partial index and locks at most batch_limit rows.
-- Deduplication and final ordering inspect at most four bounded batches.
CREATE FUNCTION lyraseo_kernel.recovery_ids(cutoff timestamptz, batch_limit integer, approved boolean)
RETURNS TABLE(work_id uuid) LANGUAGE sql VOLATILE ROWS 20 SET search_path=pg_catalog,pg_temp AS $$
  WITH ledger AS MATERIALIZED (
    SELECT id,"createdAt" AS due FROM public."WorkDispatch"
      WHERE "ledgerHandoff"='PENDING' ORDER BY "createdAt",id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), expired AS MATERIALIZED (
    SELECT id,"expiresAt" AS due FROM public."WorkDispatch"
      WHERE eligibility='CONTROLLED_TEST' AND disposition IN ('PENDING','DELIVERED') AND "expiresAt"<=cutoff
      ORDER BY "expiresAt",id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), abandoned AS MATERIALIZED (
    SELECT id,"leaseUntil" AS due FROM public."WorkDispatch"
      WHERE approved AND eligibility='CONTROLLED_TEST' AND disposition='PENDING' AND "leaseUntil" IS NOT NULL AND "leaseUntil"<=cutoff
      ORDER BY "leaseUntil",id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), undriven AS MATERIALIZED (
    SELECT id,"nextAttemptAt" AS due FROM public."WorkDispatch"
      WHERE approved AND eligibility='CONTROLLED_TEST' AND disposition='DELIVERED' AND "nextAttemptAt"<=cutoff
      ORDER BY "nextAttemptAt",id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), candidates AS (
    SELECT * FROM ledger UNION ALL SELECT * FROM expired UNION ALL SELECT * FROM abandoned UNION ALL SELECT * FROM undriven
  )
  SELECT candidates.id FROM candidates GROUP BY candidates.id ORDER BY min(due),id LIMIT batch_limit
$$;

CREATE FUNCTION lyraseo_kernel.apply_command(path text, body jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE approved boolean; batch_limit integer; retry_seconds integer; refs jsonb; reopened integer; suppressed integer; reconciliation integer;
BEGIN
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_BODY'; END IF;
  approved := lyraseo_kernel.approved();
  IF path IN ('/api/internal/runtime/dispatch','/api/internal/runtime/recover') THEN
    IF body-'limit' <> '{}' OR jsonb_typeof(body->'limit') IS DISTINCT FROM 'number' OR body->>'limit' !~ '^([1-9]|1[0-9]|20)$'
      THEN RAISE EXCEPTION 'INVALID_LIMIT'; END IF;
    batch_limit := (body->>'limit')::integer;
    IF path='/api/internal/runtime/dispatch' THEN
      IF NOT approved THEN RETURN '{"disposition":"PAUSED","refs":[]}'::jsonb; END IF;
      WITH due AS MATERIALIZED (
        SELECT d.id,d."nextAttemptAt" FROM public."WorkDispatch" d
        WHERE d.disposition='PENDING' AND d."nextAttemptAt"<=clock_timestamp()
          AND (d."leaseUntil" IS NULL OR d."leaseUntil"<=clock_timestamp()) AND lyraseo_kernel.valid_target(d)
        ORDER BY d."nextAttemptAt",d.id LIMIT batch_limit FOR UPDATE OF d SKIP LOCKED
      ), changed AS (
        UPDATE public."WorkDispatch" d SET "claimToken"=gen_random_uuid(),"leaseUntil"=clock_timestamp()+interval '30 seconds',
          "sendAttempts"="sendAttempts"+1 FROM due WHERE d.id=due.id
        RETURNING d.id,d.generation,d."claimToken",due."nextAttemptAt"
      ) SELECT coalesce(jsonb_agg(jsonb_build_object('workId',id,'generation',generation,'claimToken',"claimToken")
          ORDER BY "nextAttemptAt",id),'[]'::jsonb) INTO refs FROM changed;
      RETURN jsonb_build_object('disposition','OK','refs',refs);
    END IF;

    -- Independent 2 minute stale-delivery horizon, set by ack. No execution
    -- lock or financial mutation here. Terminal/suppressed rows leave the scan.
    WITH due AS MATERIALIZED (
      SELECT d.id,d."ledgerHandoff"='PENDING' AS ledger,lyraseo_kernel.valid_target(d) AS valid
      FROM lyraseo_kernel.recovery_ids(clock_timestamp(),batch_limit,approved) pending
      JOIN public."WorkDispatch" d ON d.id=pending.work_id
    ), changed AS (
      UPDATE public."WorkDispatch" d SET
        disposition=CASE WHEN due.valid THEN 'PENDING' ELSE 'SUPPRESSED' END,
        generation=d.generation+CASE WHEN due.valid THEN 1 ELSE 0 END,
        "nextAttemptAt"=CASE WHEN due.valid THEN clock_timestamp() END,
        "deliveredAt"=NULL,"claimToken"=NULL,"leaseUntil"=NULL,
        "ledgerHandoff"=CASE WHEN due.ledger THEN 'REPORTED' ELSE d."ledgerHandoff" END,
        "lastErrorCode"=CASE WHEN due.ledger THEN 'LEDGER_ONLY' WHEN NOT due.valid THEN 'INELIGIBLE' END
      FROM due WHERE d.id=due.id RETURNING due.valid,due.ledger
    ) SELECT count(*) FILTER(WHERE valid),count(*) FILTER(WHERE NOT valid AND NOT ledger),
        count(*) FILTER(WHERE ledger) INTO reopened,suppressed,reconciliation FROM changed;
    RETURN jsonb_build_object('disposition','OK','reopened',reopened,'suppressed',suppressed,'reconciliation',reconciliation);
  END IF;
  IF path NOT IN ('/api/internal/runtime/dispatch/ack','/api/internal/runtime/dispatch/defer') OR
    body-ARRAY['workId','generation','claimToken','retrySeconds']<>'{}' OR
    NOT (body ?& ARRAY['workId','generation','claimToken']) OR jsonb_typeof(body->'generation') IS DISTINCT FROM 'number' OR
    body->>'generation' !~ '^[1-9][0-9]{0,9}$' OR jsonb_typeof(body->'workId') IS DISTINCT FROM 'string' OR
    jsonb_typeof(body->'claimToken') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_REFERENCE'; END IF;
  IF path='/api/internal/runtime/dispatch/defer' THEN
    IF jsonb_typeof(body->'retrySeconds') IS DISTINCT FROM 'number' OR body->>'retrySeconds' !~ '^[1-9][0-9]{0,2}$'
      THEN RAISE EXCEPTION 'INVALID_RETRY'; END IF;
    retry_seconds := (body->>'retrySeconds')::integer;
    IF retry_seconds>300 THEN RAISE EXCEPTION 'INVALID_RETRY'; END IF;
  ELSIF body ? 'retrySeconds' THEN RAISE EXCEPTION 'INVALID_REFERENCE'; END IF;
  IF NOT approved THEN RETURN '{"disposition":"PAUSED"}'; END IF;
  -- A pure row lock can outlast a valid claim without changing the tuple.
  -- Validate the lease, scope and generation in a new statement after waiting.
  PERFORM 1 FROM public."WorkDispatch" WHERE id=(body->>'workId')::uuid AND eligibility='CONTROLLED_TEST' FOR UPDATE;
  UPDATE public."WorkDispatch" d SET disposition=CASE WHEN retry_seconds IS NULL THEN 'DELIVERED' ELSE 'PENDING' END,
    "deliveredAt"=CASE WHEN retry_seconds IS NULL THEN clock_timestamp() END,
    "nextAttemptAt"=clock_timestamp()+make_interval(secs=>coalesce(retry_seconds,120)),
    "claimToken"=NULL,"leaseUntil"=NULL,"lastErrorCode"=CASE WHEN retry_seconds IS NOT NULL THEN 'CARRIER_DEFERRED' END
    WHERE d.id=(body->>'workId')::uuid AND d.generation=(body->>'generation')::integer
    AND d."claimToken"=(body->>'claimToken')::uuid AND d."leaseUntil">clock_timestamp()
    AND d.disposition='PENDING' AND lyraseo_kernel.valid_target(d);
  IF NOT FOUND THEN RETURN '{"disposition":"STALE"}'; END IF;
  RETURN jsonb_build_object('disposition',CASE WHEN retry_seconds IS NULL THEN 'DELIVERED' ELSE 'DEFERRED' END);
END $$;

-- The bridge supplies already authenticated raw UTF-8 bytes in B. Here the
-- database binds those exact bytes to the command it actually applies. No
-- public finish(result) exists: only apply_command can construct replay data.
CREATE FUNCTION lyraseo_kernel.fingerprint(audience text,path text,raw_body text,issued timestamptz,expires timestamptz)
RETURNS bytea LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF session_user<>'lyraseo_dispatch' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF audience IS DISTINCT FROM 'lyraseo-kernel-a' OR path IS NULL OR path NOT IN
    ('/api/internal/runtime/dispatch','/api/internal/runtime/dispatch/ack','/api/internal/runtime/dispatch/defer','/api/internal/runtime/recover')
    OR raw_body IS NULL OR octet_length(raw_body)>8192 OR issued IS NULL OR expires IS NULL
    OR NOT isfinite(issued) OR NOT isfinite(expires) OR expires<=issued OR expires-issued>interval '60 seconds'
    OR expires<=clock_timestamp() OR issued>clock_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  RETURN sha256(convert_to(jsonb_build_array('v1',audience,'POST',path,encode(sha256(convert_to(raw_body,'UTF8')),'hex'),
    extract(epoch from issued),extract(epoch from expires))::text,'UTF8'));
END $$;

CREATE FUNCTION lyraseo_kernel.begin_request(request_id uuid,audience text,path text,raw_body text,issued timestamptz,expires timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE digest bytea; token uuid:=gen_random_uuid(); prior public."InternalRequest";
BEGIN
  digest:=lyraseo_kernel.fingerprint(audience,path,raw_body,issued,expires);
  INSERT INTO public."InternalRequest"("servicePrincipalId","requestId",fingerprint,"issuedAt","expiresAt",state,"ownerToken",fence,"leaseUntil")
   VALUES(session_user,request_id,digest,issued,expires,'ACTIVE',token,1,clock_timestamp()+interval '10 seconds')
   ON CONFLICT ("servicePrincipalId","requestId") DO NOTHING;
  SELECT * INTO STRICT prior FROM public."InternalRequest" WHERE ("servicePrincipalId","requestId")=(session_user,request_id) FOR UPDATE;
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  IF prior.fingerprint<>digest THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
  IF prior.state='COMPLETE' THEN RETURN jsonb_build_object('state','COMPLETE','result',prior.result); END IF;
  IF prior."ownerToken"<>token THEN
    IF prior."leaseUntil">clock_timestamp() THEN RETURN '{"state":"IN_PROGRESS"}'; END IF;
    UPDATE public."InternalRequest" SET fence=fence+1,"ownerToken"=token,"leaseUntil"=clock_timestamp()+interval '10 seconds'
    WHERE ("servicePrincipalId","requestId")=(session_user,request_id) RETURNING * INTO prior;
  END IF;
  RETURN jsonb_build_object('state','OWNED','token',token,'fence',prior.fence);
END $$;
CREATE FUNCTION lyraseo_kernel.finish_request(request_id uuid,audience text,path text,raw_body text,issued timestamptz,expires timestamptz,token uuid,expected integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE digest bytea; outcome jsonb;
BEGIN
  digest:=lyraseo_kernel.fingerprint(audience,path,raw_body,issued,expires);
  PERFORM 1 FROM public."InternalRequest" WHERE ("servicePrincipalId","requestId",fingerprint,"ownerToken",fence)
    =(session_user,request_id,digest,token,expected) AND state='ACTIVE' AND "leaseUntil">clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_REQUEST'; END IF;
  outcome:=lyraseo_kernel.apply_command(path,raw_body::jsonb);
  UPDATE public."InternalRequest" SET state='COMPLETE',"ownerToken"=NULL,"leaseUntil"=NULL,"completedAt"=clock_timestamp(),result=outcome
    WHERE ("servicePrincipalId","requestId")=(session_user,request_id) AND "leaseUntil">clock_timestamp() AND "expiresAt">clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_REQUEST'; END IF;
  RETURN outcome;
END $$;

CREATE FUNCTION lyraseo_kernel.command(request_id uuid,audience text,path text,raw_body text,issued timestamptz,expires timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE ticket jsonb;
BEGIN
  ticket:=lyraseo_kernel.begin_request(request_id,audience,path,raw_body,issued,expires);
  CASE ticket->>'state' WHEN 'COMPLETE' THEN RETURN ticket->'result';
   WHEN 'IN_PROGRESS' THEN RETURN '{"disposition":"IN_PROGRESS"}';
   ELSE RETURN lyraseo_kernel.finish_request(request_id,audience,path,raw_body,issued,expires,(ticket->>'token')::uuid,(ticket->>'fence')::integer);
  END CASE;
END $$;
CREATE FUNCTION lyraseo_kernel.cleanup_requests(batch_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE removed integer;
BEGIN
  IF session_user<>'lyraseo_dispatch' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'INVALID_LIMIT'; END IF;
  WITH old AS (SELECT "requestId" FROM public."InternalRequest" WHERE "servicePrincipalId"=session_user
      AND "expiresAt"<clock_timestamp()-interval '1 day' ORDER BY "expiresAt","requestId" LIMIT batch_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public."InternalRequest" r USING old WHERE r."servicePrincipalId"=session_user AND r."requestId"=old."requestId";
  GET DIAGNOSTICS removed=ROW_COUNT; RETURN removed;
END $$;

-- Object deployment, table/column rights and execute grants are atomic. No
-- dispatcher/operator membership in the definer role; no grants to the web.
DO $$
DECLARE t text; fn regprocedure; grantee_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY['RuntimePolicy','RuntimePolicyChange','InternalRequest','WorkDispatch'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY kernel ON public.%I TO lyraseo_kernel_owner USING(true) WITH CHECK(true)',t);
  END LOOP;
  FOR grantee_name IN SELECT rolname FROM pg_roles WHERE rolname IN
    ('anon','authenticated','service_role','lyraseo_runtime','lyraseo_identity','lyraseo_dispatch','lyraseo_operator','lyraseo_kernel_owner')
    UNION ALL SELECT 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON public."OutboxEvent",public."RuntimePolicy",public."RuntimePolicyChange",public."InternalRequest",public."WorkDispatch",lyraseo_kernel.test_environment FROM %I',grantee_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER ON public."UsageReceipt" FROM %I',grantee_name);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lyraseo_kernel FROM %I',grantee_name);
  END LOOP;
  FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='lyraseo_kernel'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_kernel_owner',fn);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['Workspace','Membership','Site','SiteGrant','Operation','AuditRun','OutboxEvent'] LOOP
    EXECUTE format('CREATE POLICY kernel_read ON public.%I FOR SELECT TO lyraseo_kernel_owner USING(true)',t);
  END LOOP;
END $$;
ALTER TABLE lyraseo_kernel.test_environment ENABLE ROW LEVEL SECURITY;
ALTER TABLE lyraseo_kernel.test_environment FORCE ROW LEVEL SECURITY;
CREATE POLICY kernel ON lyraseo_kernel.test_environment FOR SELECT TO lyraseo_kernel_owner USING(true);
CREATE POLICY kernel_archive ON public."OutboxEvent" FOR INSERT TO lyraseo_kernel_owner WITH CHECK(true);

GRANT SELECT ON lyraseo_kernel.test_environment,public."RuntimePolicy",public."InternalRequest",public."WorkDispatch" TO lyraseo_kernel_owner;
GRANT UPDATE(enabled,revision,"changedAt") ON public."RuntimePolicy" TO lyraseo_kernel_owner;
GRANT INSERT ON public."RuntimePolicyChange" TO lyraseo_kernel_owner;
GRANT INSERT,DELETE ON public."InternalRequest" TO lyraseo_kernel_owner;
GRANT UPDATE(state,"ownerToken",fence,"leaseUntil","completedAt",result) ON public."InternalRequest" TO lyraseo_kernel_owner;
GRANT INSERT ON public."WorkDispatch" TO lyraseo_kernel_owner;
GRANT UPDATE(disposition,generation,"ledgerHandoff","nextAttemptAt","leaseUntil","claimToken","deliveredAt","lastErrorCode","sendAttempts","revokedAt")
 ON public."WorkDispatch" TO lyraseo_kernel_owner;
GRANT SELECT(id,"securityVersion",suspended) ON public."ProductUser" TO lyraseo_kernel_owner;
GRANT SELECT(id,"deletedAt") ON public."Workspace" TO lyraseo_kernel_owner;
GRANT SELECT("workspaceId","userId",role) ON public."Membership" TO lyraseo_kernel_owner;
GRANT SELECT("workspaceId",id,"verifiedAt","deletedAt") ON public."Site" TO lyraseo_kernel_owner;
GRANT SELECT("workspaceId","siteId","userId") ON public."SiteGrant" TO lyraseo_kernel_owner;
GRANT SELECT(id,"workspaceId","siteId","userId","securityVersion",profile,status,"leaseUntil","createdAt") ON public."AuditRun" TO lyraseo_kernel_owner;
GRANT SELECT(id,"workspaceId","siteId","userId","securityVersion","sessionId","createdAt","expiresAt",kind,"requestInput","attemptState") ON public."Operation" TO lyraseo_kernel_owner;
GRANT SELECT(id,"operationId"),INSERT(id,"operationId","workspaceId","userId") ON public."OutboxEvent" TO lyraseo_kernel_owner;
GRANT EXECUTE ON FUNCTION lyraseo_kernel.read_policy(text),lyraseo_kernel.change_policy(text,integer,boolean) TO lyraseo_operator;
GRANT EXECUTE ON FUNCTION
 lyraseo_kernel.begin_request(uuid,text,text,text,timestamptz,timestamptz),
 lyraseo_kernel.finish_request(uuid,text,text,text,timestamptz,timestamptz,uuid,integer),
 lyraseo_kernel.command(uuid,text,text,text,timestamptz,timestamptz),
 lyraseo_kernel.resolve_step(uuid,integer),lyraseo_kernel.cleanup_requests(integer)
 TO lyraseo_dispatch;
COMMIT;
