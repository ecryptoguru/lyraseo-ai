BEGIN;
-- Unqualified external writes stay quarantined. The only execution functions in
-- this migration require an independently enrolled disposable local fixture DB.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_handoff_owner') THEN
  CREATE ROLE lyraseo_handoff_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_handoff_owner' AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
 OR EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid IN(m.member,m.roleid) WHERE r.rolname='lyraseo_handoff_owner')
 OR EXISTS(SELECT FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname='lyraseo_handoff_owner')
 THEN RAISE EXCEPTION 'UNSAFE_HANDOFF_OWNER'; END IF;
END $$;
CREATE SCHEMA lyraseo_handoff;
REVOKE ALL ON SCHEMA lyraseo_handoff FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_handoff,public TO lyraseo_handoff_owner,lyraseo_runtime;
CREATE TABLE lyraseo_handoff.destination(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,site_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN('WORDPRESS','WEBHOOK')),generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 url text NOT NULL CHECK(length(url) BETWEEN 1 AND 2048),secret_cipher text,
 key_id text,event_types text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK(event_types <@ ARRAY['audit.completed','report.created']::text[]),previous_cipher text,previous_key_id text,previous_until timestamptz,
 status text NOT NULL CHECK(status IN('CONFIGURED','REVOKED')),created_by text NOT NULL,
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),revision integer NOT NULL DEFAULT 1,
 UNIQUE(workspace_id,site_id,kind),UNIQUE(workspace_id,site_id,id),
 FOREIGN KEY("workspace_id","site_id") REFERENCES public."Site"("workspaceId",id) ON DELETE CASCADE,
 CHECK((status='REVOKED' AND secret_cipher IS NULL AND previous_cipher IS NULL) OR(status='CONFIGURED' AND secret_cipher IS NOT NULL)),
 CHECK((previous_cipher IS NULL)=(previous_key_id IS NULL)), CHECK((previous_cipher IS NULL)=(previous_until IS NULL))
);
CREATE TABLE lyraseo_handoff.intent(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL,site_id text NOT NULL,
 destination_id uuid NOT NULL,destination_generation integer NOT NULL,
 kind text NOT NULL CHECK(kind IN('WORDPRESS','WEBHOOK')),created_by text NOT NULL,security_version integer NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'),
 mode text NOT NULL DEFAULT 'QUARANTINED' CHECK(mode IN('QUARANTINED','FIXTURE')),
 draft_id text REFERENCES public."ContentDraft"(id) ON DELETE SET NULL,
 draft_revision_id text REFERENCES public."ContentRevision"(id) ON DELETE SET NULL,
 event_type text,resource_kind text,resource_id text,event_id uuid NOT NULL DEFAULT gen_random_uuid(),
 body text NOT NULL CHECK(octet_length(body)<=524288),body_hash text NOT NULL CHECK(body_hash=encode(sha256(convert_to(body,'UTF8')),'hex')),
 renderer_version text NOT NULL,destination_url text NOT NULL,
 state text NOT NULL DEFAULT 'PREPARED' CHECK(state IN('PREPARED','SENDING','CONFIRMED_DRAFT','REJECTED','UNRESOLVED','REVOKED','CANCELLED','RETRY','DELIVERED','FAILED')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 6),fence integer NOT NULL DEFAULT 0,
 lease_until timestamptz,next_due_at timestamptz NOT NULL DEFAULT clock_timestamp(),remote_post_id bigint,editor_url text,
 last_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,site_id,created_by,idempotency_key),UNIQUE(destination_id,event_id),
 FOREIGN KEY(workspace_id,site_id,destination_id) REFERENCES lyraseo_handoff.destination(workspace_id,site_id,id) ON DELETE CASCADE,
 CHECK((kind='WORDPRESS' AND event_type IS NULL) OR(kind='WEBHOOK' AND event_type IN('test','audit.completed','report.created') AND octet_length(body)<=16384)),
 CHECK(kind<>'WEBHOOK' OR body::jsonb->>'id'=event_id::text),
 CHECK(remote_post_id IS NULL OR remote_post_id BETWEEN 1 AND 9007199254740991),CHECK(state<>'CONFIRMED_DRAFT' OR(remote_post_id IS NOT NULL AND editor_url IS NOT NULL))
);
CREATE INDEX handoff_due ON lyraseo_handoff.intent(mode,state,next_due_at,id);
CREATE INDEX handoff_history ON lyraseo_handoff.intent(workspace_id,site_id,created_at DESC,id);
CREATE TABLE lyraseo_handoff.receipt(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),intent_id uuid NOT NULL REFERENCES lyraseo_handoff.intent(id) ON DELETE CASCADE,
 fence integer NOT NULL,attempt integer NOT NULL,outcome text NOT NULL,status integer,code text NOT NULL,remote_post_id bigint,editor_url text,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(intent_id,fence),
 CHECK(status IS NULL OR status BETWEEN 200 AND 599),CHECK(length(code)<=64)
);
CREATE TABLE lyraseo_handoff.fixture_environment(database_oid oid PRIMARY KEY,postmaster_started_at timestamptz NOT NULL);
REVOKE ALL ON ALL TABLES IN SCHEMA lyraseo_handoff FROM PUBLIC,lyraseo_runtime;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['destination','intent','receipt','fixture_environment'] LOOP
 EXECUTE format('ALTER TABLE lyraseo_handoff.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE lyraseo_handoff.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY purpose_owner ON lyraseo_handoff.%I TO lyraseo_handoff_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['Workspace','Site','Membership','SiteGrant','ProductUser','ContentRevision','ContentDraft','ContentRevisionPin','AuditRun','EvidenceReport'] LOOP
 EXECUTE format('GRANT SELECT ON public.%I TO lyraseo_handoff_owner',t);
 EXECUTE format('CREATE POLICY handoff_read ON public.%I FOR SELECT TO lyraseo_handoff_owner USING(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['Workspace','Site','ProductUser'] LOOP
 EXECUTE format('GRANT UPDATE(id) ON public.%I TO lyraseo_handoff_owner',t);
 EXECUTE format('CREATE POLICY handoff_lock ON public.%I FOR UPDATE TO lyraseo_handoff_owner USING(true) WITH CHECK(false)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON lyraseo_handoff.destination,lyraseo_handoff.intent TO lyraseo_handoff_owner;
GRANT SELECT,INSERT,DELETE ON lyraseo_handoff.receipt TO lyraseo_handoff_owner;
GRANT SELECT ON lyraseo_handoff.fixture_environment TO lyraseo_handoff_owner;
CREATE FUNCTION lyraseo_handoff.permission(w text,s text,u text,epoch integer,manage boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT FROM public."Workspace" ws JOIN public."Site" st ON st."workspaceId"=ws.id
 JOIN public."Membership" m ON m."workspaceId"=ws.id AND m."userId"=u JOIN public."ProductUser" p ON p.id=u
 WHERE ws.id=w AND st.id=s AND ws."deletedAt" IS NULL AND st."deletedAt" IS NULL AND NOT p.suspended AND p."securityVersion"=epoch
 AND (m.role IN('OWNER','ADMIN') OR(NOT manage AND m.role='EDITOR' AND EXISTS(SELECT FROM public."SiteGrant" g WHERE(g."workspaceId",g."siteId",g."userId")=(w,s,u)))))
$$;
CREATE FUNCTION lyraseo_handoff.immutable_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','attempt','fence','lease_until','next_due_at','remote_post_id','editor_url','last_code','updated_at','draft_revision_id','draft_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['state','attempt','fence','lease_until','next_due_at','remote_post_id','editor_url','last_code','updated_at','draft_revision_id','draft_id'])
 OR(NEW.draft_revision_id IS DISTINCT FROM OLD.draft_revision_id AND NEW.draft_revision_id IS NOT NULL)
 OR(NEW.draft_id IS DISTINCT FROM OLD.draft_id AND NEW.draft_id IS NOT NULL)
 THEN RAISE EXCEPTION 'IMMUTABLE_HANDOFF'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER handoff_identity BEFORE UPDATE ON lyraseo_handoff.intent FOR EACH ROW EXECUTE FUNCTION lyraseo_handoff.immutable_intent();
CREATE FUNCTION lyraseo_handoff.immutable_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' AND current_user='lyraseo_handoff_owner' AND EXISTS(SELECT FROM lyraseo_handoff.intent i JOIN public."Site" st ON(st."workspaceId",st.id)=(i.workspace_id,i.site_id) WHERE i.id=OLD.intent_id AND st."deletedAt" IS NOT NULL) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'IMMUTABLE_HANDOFF_RECEIPT'; END $$;
CREATE TRIGGER handoff_receipt_immutable BEFORE UPDATE OR DELETE ON lyraseo_handoff.receipt FOR EACH ROW EXECUTE FUNCTION lyraseo_handoff.immutable_receipt();
CREATE FUNCTION lyraseo_handoff.summary(w text,s text,epoch integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u text:=current_setting('app.actor_id',true); result jsonb;
BEGIN
 IF session_user<>'lyraseo_runtime' OR NOT EXISTS(SELECT FROM public."Workspace" ws JOIN public."Site" st ON st."workspaceId"=ws.id JOIN public."Membership" m ON m."workspaceId"=ws.id AND m."userId"=u JOIN public."ProductUser" p ON p.id=u
 WHERE ws.id=w AND st.id=s AND ws."deletedAt" IS NULL AND st."deletedAt" IS NULL AND NOT p.suspended AND p."securityVersion"=epoch AND(m.role IN('OWNER','ADMIN') OR EXISTS(SELECT FROM public."SiteGrant" g WHERE(g."workspaceId",g."siteId",g."userId")=(w,s,u))))
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT jsonb_build_object('destinations',COALESCE((SELECT jsonb_agg(to_jsonb(d)-ARRAY['secret_cipher','previous_cipher','created_by']) FROM lyraseo_handoff.destination d WHERE(d.workspace_id,d.site_id)=(w,s)),'[]'::jsonb),
 'intents',COALESCE((SELECT jsonb_agg(v) FROM(SELECT id,kind,state,mode,destination_url,created_at,updated_at,attempt,remote_post_id,editor_url,last_code,next_due_at FROM lyraseo_handoff.intent WHERE(workspace_id,site_id)=(w,s) ORDER BY created_at DESC,id LIMIT 100)v),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION lyraseo_handoff.web_command(w text,s text,epoch integer,action text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u text:=current_setting('app.actor_id',true); d lyraseo_handoff.destination; i lyraseo_handoff.intent; kind_ text; origin_ text; content_ jsonb; rev_id text; draft_ text; event_ uuid; body_ text; input_ text; rendered_ text; old lyraseo_handoff.intent;
BEGIN
 IF session_user<>'lyraseo_runtime' OR current_setting('app.workspace_id',true) IS DISTINCT FROM w THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR UPDATE;
 SELECT origin INTO origin_ FROM public."Site" WHERE("workspaceId",id)=(w,s) AND "verifiedAt" IS NOT NULL AND "deletedAt" IS NULL FOR UPDATE;
 PERFORM 1 FROM public."ProductUser" WHERE id=u FOR SHARE;
 IF origin_ IS NULL OR NOT lyraseo_handoff.permission(w,s,u,epoch,action IN('wordpress.configure','webhook.configure','disconnect','webhook.rotate','webhook.test')) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF action IN('wordpress.configure','webhook.configure') THEN
  kind_:=CASE WHEN action='wordpress.configure' THEN 'WORDPRESS' ELSE 'WEBHOOK' END;
  IF (p->>'url') IS NULL OR length(p->>'url')>2048 OR (p->>'url')!~'^https://[^/@?#:]+\.[^/@?#:]+(/[^?#]*)?$' OR (p->>'cipher')!~'^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' OR length(p->>'cipher')>8192 THEN RAISE EXCEPTION 'INVALID_DESTINATION'; END IF;
  IF kind_='WORDPRESS' AND left(p->>'url',length(origin_)+1)<>origin_||'/' THEN RAISE EXCEPTION 'INVALID_DESTINATION'; END IF;
  SELECT * INTO d FROM lyraseo_handoff.destination WHERE(workspace_id,site_id,kind)=(w,s,kind_) FOR UPDATE;
  IF d.id IS NOT NULL AND d.revision IS DISTINCT FROM (p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
  IF d.id IS NULL THEN
   INSERT INTO lyraseo_handoff.destination(workspace_id,site_id,kind,url,secret_cipher,key_id,event_types,status,created_by) VALUES(w,s,kind_,p->>'url',p->>'cipher',p->>'keyId',ARRAY(SELECT jsonb_array_elements_text(COALESCE(p->'eventTypes','[]'::jsonb))),'CONFIGURED',u) RETURNING * INTO d;
  ELSE
   UPDATE lyraseo_handoff.destination SET generation=generation+1,revision=revision+1,url=p->>'url',secret_cipher=p->>'cipher',key_id=p->>'keyId',event_types=ARRAY(SELECT jsonb_array_elements_text(COALESCE(p->'eventTypes','[]'::jsonb))),previous_cipher=NULL,previous_key_id=NULL,previous_until=NULL,status='CONFIGURED',created_by=u,confirmed_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
   UPDATE lyraseo_handoff.intent SET state=CASE WHEN kind='WORDPRESS' AND state='SENDING' THEN 'UNRESOLVED' ELSE 'REVOKED' END,last_code='DESTINATION_CHANGED',updated_at=clock_timestamp() WHERE destination_id=d.id AND state IN('PREPARED','SENDING','RETRY');
  END IF;
  RETURN to_jsonb(d)-ARRAY['secret_cipher','previous_cipher'];
 ELSIF action IN('disconnect','webhook.rotate') THEN
  SELECT * INTO d FROM lyraseo_handoff.destination WHERE(workspace_id,site_id,id)=(w,s,(p->>'destinationId')::uuid) FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF d.revision IS DISTINCT FROM(p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
  IF action='webhook.rotate' THEN
   IF d.kind<>'WEBHOOK' OR d.status<>'CONFIGURED' OR(p->>'cipher')!~'^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' OR length(p->>'cipher')>8192 OR(p->>'keyId') IS NULL THEN RAISE EXCEPTION 'INVALID_DESTINATION'; END IF;
   UPDATE lyraseo_handoff.destination SET revision=revision+1,previous_cipher=secret_cipher,previous_key_id=key_id,previous_until=clock_timestamp()+interval '24 hours',secret_cipher=p->>'cipher',key_id=p->>'keyId' WHERE id=d.id RETURNING * INTO d;
  ELSE
   UPDATE lyraseo_handoff.destination SET generation=generation+1,revision=revision+1,status='REVOKED',secret_cipher=NULL,previous_cipher=NULL,previous_key_id=NULL,previous_until=NULL WHERE id=d.id RETURNING * INTO d;
   UPDATE lyraseo_handoff.intent SET state=CASE WHEN kind='WORDPRESS' AND state='SENDING' THEN 'UNRESOLVED' ELSE 'REVOKED' END,last_code='DESTINATION_REVOKED',updated_at=clock_timestamp() WHERE destination_id=d.id AND state IN('PREPARED','SENDING','RETRY');
  END IF;
  RETURN to_jsonb(d)-ARRAY['secret_cipher','previous_cipher'];
 ELSIF action IN('wordpress.prepare','webhook.test') THEN
  SELECT * INTO d FROM lyraseo_handoff.destination WHERE(workspace_id,site_id,id)=(w,s,(p->>'destinationId')::uuid) FOR UPDATE;
  IF d.id IS NULL OR d.status<>'CONFIGURED' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF (action='wordpress.prepare' AND d.kind<>'WORDPRESS') OR(action='webhook.test' AND d.kind<>'WEBHOOK') THEN RAISE EXCEPTION 'INVALID_DESTINATION'; END IF;
  IF(p->>'bodyHash') IS DISTINCT FROM encode(sha256(convert_to(p->>'body','UTF8')),'hex') THEN RAISE EXCEPTION 'INVALID_BODY_HASH'; END IF;
  IF length(p->>'idempotencyKey') NOT BETWEEN 1 AND 128 OR(p->>'inputHash')!~'^[a-f0-9]{64}$' OR(p->>'bodyHash')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_HANDOFF'; END IF;
  SELECT * INTO old FROM lyraseo_handoff.intent WHERE(workspace_id,site_id,created_by,idempotency_key)=(w,s,u,p->>'idempotencyKey');
  IF old.id IS NOT NULL THEN
   IF old.input_hash IS DISTINCT FROM(p->>'inputHash') THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
   RETURN to_jsonb(old)-'body';
  END IF;
  IF(SELECT count(*) FROM lyraseo_handoff.intent WHERE(workspace_id,site_id)=(w,s) AND state IN('PREPARED','SENDING','RETRY'))>=100 THEN RAISE EXCEPTION 'HANDOFF_QUEUE_FULL'; END IF;
  IF d.kind='WORDPRESS' THEN
   SELECT cr.id,cr."draftId",cr.content INTO rev_id,draft_,content_ FROM public."ContentRevision" cr JOIN public."ContentDraft" cd ON cd.id=cr."draftId" AND cd."workspaceId"=cr."workspaceId"
   WHERE(cr."workspaceId",cd."siteId",cr.id)=(w,s,p->>'draftRevisionId') AND cd.kind='draft' AND(cr.revision=cd.revision OR cr."createdAt">=clock_timestamp()-interval '90 days' OR EXISTS(SELECT FROM public."ContentRevisionPin" pin WHERE(pin."workspaceId",pin."draftId",pin.revision)=(w,cd.id,cr.revision)));
   IF rev_id IS NULL THEN RAISE EXCEPTION 'REVISION_UNAVAILABLE'; END IF;
   IF p->>'title' IS DISTINCT FROM content_->>'title' OR p->>'sourceBody' IS DISTINCT FROM content_->>'body' THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
   SELECT string_agg('<p>'||replace(replace(replace(replace(replace(part,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;'),chr(39),'&#39;')||'</p>','' ORDER BY ord) INTO rendered_ FROM regexp_split_to_table(content_->>'body',E'\\r?\\n\\s*\\r?\\n') WITH ORDINALITY parts(part,ord);
   IF(p->>'body')::jsonb IS DISTINCT FROM jsonb_build_object('title',content_->>'title','content',rendered_,'status','draft') THEN RAISE EXCEPTION 'INVALID_RENDERER'; END IF;
   IF p->>'destinationUrl' IS DISTINCT FROM d.url||'wp-json/wp/v2/posts?_fields=id,status,link' OR(p->>'body')::jsonb->>'status'<>'draft' OR(p->>'body')::jsonb->>'title' IS DISTINCT FROM content_->>'title' THEN RAISE EXCEPTION 'INVALID_HANDOFF'; END IF;
   IF EXISTS(SELECT FROM lyraseo_handoff.intent WHERE destination_id=d.id AND destination_url=p->>'destinationUrl' AND draft_id=draft_ AND mode='QUARANTINED' AND state IN('SENDING','UNRESOLVED','CONFIRMED_DRAFT')) THEN RAISE EXCEPTION 'WORDPRESS_RECONCILIATION_REQUIRED'; END IF;
   UPDATE lyraseo_handoff.intent SET state='CANCELLED',last_code='SUPERSEDED_BY_REVIEW',updated_at=clock_timestamp() WHERE destination_id=d.id AND destination_url=p->>'destinationUrl' AND draft_id=draft_ AND mode='QUARANTINED' AND state='PREPARED';
  ELSE
   IF octet_length(p->>'body')>16384 OR(p->>'body')::jsonb->>'type'<>'test' OR(p->>'body')::jsonb->>'workspaceId' IS DISTINCT FROM w OR(p->>'body')::jsonb->>'siteId' IS DISTINCT FROM s THEN RAISE EXCEPTION 'INVALID_EVENT'; END IF;
  END IF;
  INSERT INTO lyraseo_handoff.intent(workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,draft_id,draft_revision_id,event_type,resource_kind,resource_id,event_id,body,body_hash,renderer_version,destination_url)
  VALUES(w,s,d.id,d.generation,d.kind,u,epoch,p->>'idempotencyKey',p->>'inputHash',draft_,rev_id,CASE WHEN d.kind='WEBHOOK' THEN 'test' END,CASE WHEN d.kind='WEBHOOK' THEN 'test' END,CASE WHEN d.kind='WEBHOOK' THEN 'sample' END,COALESCE((p->>'eventId')::uuid,gen_random_uuid()),p->>'body',p->>'bodyHash',p->>'rendererVersion',CASE WHEN d.kind='WEBHOOK' THEN d.url ELSE p->>'destinationUrl' END) RETURNING * INTO i;
  RETURN to_jsonb(i)-'body';
 ELSE RAISE EXCEPTION 'INVALID_HANDOFF_ACTION'; END IF;
END $$;
CREATE FUNCTION lyraseo_handoff.fixture_guard() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF session_user<>'lyraseo_handoff_fixture' OR current_database()!~'^lyraseo_handoff_[a-f0-9]{12}$' OR NOT EXISTS(SELECT FROM lyraseo_handoff.fixture_environment e JOIN pg_database d ON d.oid=e.database_oid WHERE d.datname=current_database() AND e.postmaster_started_at=pg_postmaster_start_time()) THEN RAISE EXCEPTION 'FIXTURE_ONLY'; END IF;
END $$;
CREATE FUNCTION lyraseo_handoff.fixture_claim(id_ uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE i lyraseo_handoff.intent; d lyraseo_handoff.destination;
BEGIN
 PERFORM lyraseo_handoff.fixture_guard();
 SELECT ds.* INTO d FROM lyraseo_handoff.destination ds JOIN lyraseo_handoff.intent x ON x.destination_id=ds.id WHERE x.id=id_ FOR UPDATE OF ds;
 SELECT * INTO i FROM lyraseo_handoff.intent WHERE id=id_ AND mode='FIXTURE' FOR UPDATE;
 IF i.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF i.state='SENDING' AND i.lease_until<=clock_timestamp() THEN
  UPDATE lyraseo_handoff.intent SET state=CASE WHEN kind='WORDPRESS' THEN 'UNRESOLVED' WHEN attempt>=6 THEN 'FAILED' ELSE 'RETRY' END,next_due_at=clock_timestamp()+make_interval(secs=>CASE attempt WHEN 1 THEN 60 WHEN 2 THEN 300 WHEN 3 THEN 1800 WHEN 4 THEN 7200 ELSE 43200 END),last_code='LOST_ACKNOWLEDGEMENT',updated_at=clock_timestamp() WHERE id=id_;
  RETURN NULL;
 END IF;
 IF i.state NOT IN('PREPARED','RETRY') OR i.next_due_at>clock_timestamp() THEN RETURN NULL; END IF;
 IF d.status<>'CONFIGURED' OR d.generation<>i.destination_generation OR NOT EXISTS(SELECT FROM public."Site" st WHERE(st."workspaceId",st.id)=(i.workspace_id,i.site_id) AND st."verifiedAt" AT TIME ZONE 'UTC' BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()) OR NOT lyraseo_handoff.permission(i.workspace_id,i.site_id,i.created_by,i.security_version) THEN
  UPDATE lyraseo_handoff.intent SET state='REVOKED',last_code='ACCESS_REVOKED',updated_at=clock_timestamp() WHERE id=id_; RETURN NULL;
 END IF;
 IF i.kind='WORDPRESS' AND(i.draft_id IS NULL OR EXISTS(SELECT FROM lyraseo_handoff.intent other WHERE other.id<>i.id AND other.mode='FIXTURE' AND other.destination_id=i.destination_id AND other.destination_url=i.destination_url AND other.draft_id=i.draft_id AND other.state IN('SENDING','UNRESOLVED','CONFIRMED_DRAFT'))) THEN
  UPDATE lyraseo_handoff.intent SET state='REJECTED',last_code='RECONCILIATION_REQUIRED',updated_at=clock_timestamp() WHERE id=id_;RETURN NULL;
 END IF;
 IF i.kind='WORDPRESS' AND i.attempt<>0 THEN RAISE EXCEPTION 'WORDPRESS_CREATE_BARRIER'; END IF;
 IF i.attempt>=6 THEN RAISE EXCEPTION 'MAX_ATTEMPTS'; END IF;
 UPDATE lyraseo_handoff.intent SET state='SENDING',attempt=attempt+1,fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=id_ RETURNING * INTO i;
 RETURN jsonb_build_object('id',i.id,'kind',i.kind,'fence',i.fence,'attempt',i.attempt);
END $$;
CREATE FUNCTION lyraseo_handoff.fixture_before_socket(id_ uuid,fence_ integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE i lyraseo_handoff.intent; d lyraseo_handoff.destination;
BEGIN
 PERFORM lyraseo_handoff.fixture_guard();
 SELECT ds.* INTO d FROM lyraseo_handoff.destination ds JOIN lyraseo_handoff.intent x ON x.destination_id=ds.id WHERE x.id=id_ FOR SHARE OF ds;
 SELECT * INTO i FROM lyraseo_handoff.intent WHERE id=id_ AND mode='FIXTURE' FOR SHARE;
 IF i.id IS NULL OR i.state<>'SENDING' OR i.fence<>fence_ OR i.lease_until<=clock_timestamp() OR d.status<>'CONFIGURED' OR d.generation<>i.destination_generation OR NOT EXISTS(SELECT FROM public."Site" st WHERE(st."workspaceId",st.id)=(i.workspace_id,i.site_id) AND st."verifiedAt" AT TIME ZONE 'UTC' BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()) OR NOT lyraseo_handoff.permission(i.workspace_id,i.site_id,i.created_by,i.security_version) THEN RAISE EXCEPTION 'STALE_HANDOFF'; END IF;
 RETURN jsonb_build_object('url',i.destination_url,'connectionUrl',d.url,'generation',d.generation,'body',i.body,'bodyHash',i.body_hash,'kind',i.kind,'eventId',i.event_id,'cipher',d.secret_cipher,'keyId',d.key_id,'previousCipher',CASE WHEN d.previous_until>clock_timestamp() THEN d.previous_cipher END,'previousKeyId',CASE WHEN d.previous_until>clock_timestamp() THEN d.previous_key_id END,'workspaceId',i.workspace_id,'siteId',i.site_id);
END $$;
CREATE FUNCTION lyraseo_handoff.fixture_finish(id_ uuid,fence_ integer,outcome_ text,status_ integer,code_ text,remote_ bigint DEFAULT NULL,editor_ text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE i lyraseo_handoff.intent; d lyraseo_handoff.destination; state_ text; due_ timestamptz;
BEGIN
 PERFORM lyraseo_handoff.fixture_guard();
 SELECT ds.* INTO d FROM lyraseo_handoff.destination ds JOIN lyraseo_handoff.intent x ON x.destination_id=ds.id WHERE x.id=id_ FOR UPDATE OF ds;
 SELECT * INTO i FROM lyraseo_handoff.intent WHERE id=id_ AND mode='FIXTURE' FOR UPDATE;
 IF i.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF EXISTS(SELECT FROM lyraseo_handoff.receipt WHERE intent_id=id_ AND fence=fence_ AND outcome=outcome_ AND status IS NOT DISTINCT FROM status_ AND code=code_ AND remote_post_id IS NOT DISTINCT FROM remote_ AND editor_url IS NOT DISTINCT FROM editor_) THEN RETURN jsonb_build_object('state',i.state,'replayed',true); END IF;
 IF i.state<>'SENDING' OR i.fence<>fence_ OR i.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'STALE_HANDOFF'; END IF;
 IF length(code_)>64 OR code_!~'^[A-Z_]+$' OR(status_ IS NOT NULL AND status_ NOT BETWEEN 200 AND 599) THEN RAISE EXCEPTION 'INVALID_RECEIPT'; END IF;
 IF d.status<>'CONFIGURED' OR d.generation<>i.destination_generation OR NOT EXISTS(SELECT FROM public."Site" st WHERE(st."workspaceId",st.id)=(i.workspace_id,i.site_id) AND st."verifiedAt" AT TIME ZONE 'UTC' BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()) OR NOT lyraseo_handoff.permission(i.workspace_id,i.site_id,i.created_by,i.security_version) THEN state_:=CASE WHEN i.kind='WORDPRESS' THEN 'UNRESOLVED' ELSE 'REVOKED' END;
 ELSIF i.kind='WORDPRESS' THEN
  IF(outcome_='CONFIRMED_DRAFT' AND status_ NOT IN(200,201)) OR(outcome_='REJECTED' AND status_ NOT IN(400,401,403,404,405,413,415,422)) OR outcome_ NOT IN('CONFIRMED_DRAFT','REJECTED','UNRESOLVED') OR(outcome_='CONFIRMED_DRAFT' AND(remote_ IS NULL OR remote_<=0 OR editor_ IS DISTINCT FROM replace(i.destination_url,'wp-json/wp/v2/posts?_fields=id,status,link','wp-admin/post.php?post='||remote_||'&action=edit'))) THEN RAISE EXCEPTION 'INVALID_RECEIPT'; END IF;
  state_:=outcome_;
 ELSE
  IF outcome_ NOT IN('DELIVERED','RETRY','FAILED') THEN RAISE EXCEPTION 'INVALID_RECEIPT'; END IF;
  IF status_ BETWEEN 200 AND 299 THEN state_:='DELIVERED';
  ELSIF (status_ IS NULL OR status_=429 OR status_ BETWEEN 500 AND 599) AND i.attempt<6 THEN state_:='RETRY';due_:=clock_timestamp()+make_interval(secs=>CASE i.attempt WHEN 1 THEN 60 WHEN 2 THEN 300 WHEN 3 THEN 1800 WHEN 4 THEN 7200 ELSE 43200 END);
  ELSE state_:='FAILED'; END IF;
 END IF;
 INSERT INTO lyraseo_handoff.receipt(intent_id,fence,attempt,outcome,status,code,remote_post_id,editor_url) VALUES(id_,fence_,i.attempt,outcome_,status_,code_,remote_,editor_);
 UPDATE lyraseo_handoff.intent SET state=state_,lease_until=NULL,next_due_at=COALESCE(due_,next_due_at),remote_post_id=CASE WHEN state_='CONFIRMED_DRAFT' THEN remote_ END,editor_url=CASE WHEN state_='CONFIRMED_DRAFT' THEN editor_ END,last_code=code_,updated_at=clock_timestamp() WHERE id=id_;
 RETURN jsonb_build_object('state',state_,'replayed',false);
END $$;
-- Resource completion emits only an opted-in, minimal, immutable quarantined envelope.
CREATE FUNCTION lyraseo_handoff.resource_completed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d lyraseo_handoff.destination; type_ text; kind_ text; u text; epoch integer; event_ uuid; body_ text; state_ text;
BEGIN
 IF TG_TABLE_NAME='AuditRun' THEN
  IF NEW.status<>'COMPLETED' OR OLD.status='COMPLETED' THEN RETURN NEW; END IF;
  type_:='audit.completed';kind_:='audit';u:=NEW."userId";epoch:=NEW."securityVersion";
 ELSE type_:='report.created';kind_:='report';u:=current_setting('app.actor_id',true);SELECT "securityVersion" INTO epoch FROM public."ProductUser" WHERE id=u;
 END IF;
 SELECT * INTO d FROM lyraseo_handoff.destination WHERE(workspace_id,site_id,kind)=(NEW."workspaceId",NEW."siteId",'WEBHOOK') AND status='CONFIGURED' AND type_=ANY(event_types) FOR UPDATE;
 IF d.id IS NULL OR NOT lyraseo_handoff.permission(NEW."workspaceId",NEW."siteId",u,epoch) THEN RETURN NEW; END IF;
 event_:=gen_random_uuid();
 body_:=jsonb_build_object('id',event_,'type',type_,'version',1,'occurredAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'workspaceId',NEW."workspaceId",'siteId',NEW."siteId",'resource',jsonb_build_object('kind',kind_,'id',NEW.id))::text;
 state_:=CASE WHEN(SELECT count(*) FROM lyraseo_handoff.intent WHERE destination_id=d.id AND state IN('PREPARED','SENDING','RETRY'))>=100 THEN 'FAILED' ELSE 'PREPARED' END;
 INSERT INTO lyraseo_handoff.intent(workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,event_type,resource_kind,resource_id,event_id,body,body_hash,renderer_version,destination_url,state,last_code)
 VALUES(NEW."workspaceId",NEW."siteId",d.id,d.generation,'WEBHOOK',u,epoch,'resource:'||kind_||':'||NEW.id,encode(sha256(convert_to(body_,'UTF8')),'hex'),type_,kind_,NEW.id,event_,body_,encode(sha256(convert_to(body_,'UTF8')),'hex'),'webhook-resource-v1',d.url,state_,CASE WHEN state_='FAILED' THEN 'QUEUE_LIMIT' END) ON CONFLICT(workspace_id,site_id,created_by,idempotency_key) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER handoff_audit_completed AFTER UPDATE OF status ON public."AuditRun" FOR EACH ROW EXECUTE FUNCTION lyraseo_handoff.resource_completed();
CREATE TRIGGER handoff_report_created AFTER INSERT ON public."EvidenceReport" FOR EACH ROW EXECUTE FUNCTION lyraseo_handoff.resource_completed();
-- Called only by the deletion-purpose definer, never runtime/maintenance logins.
-- These helpers do not delete a WordPress post or an already-delivered receiver copy.
CREATE FUNCTION lyraseo_handoff.retire_site(w text,s text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE count_ integer;
BEGIN
 IF NOT EXISTS(SELECT FROM public."Site" WHERE("workspaceId",id)=(w,s) AND "deletedAt" IS NOT NULL) THEN RAISE EXCEPTION 'SITE_NOT_TOMBSTONED'; END IF;
 PERFORM 1 FROM lyraseo_handoff.destination WHERE(workspace_id,site_id)=(w,s) ORDER BY id FOR UPDATE;
 UPDATE lyraseo_handoff.destination SET generation=generation+1,revision=revision+1,status='REVOKED',secret_cipher=NULL,previous_cipher=NULL,previous_key_id=NULL,previous_until=NULL WHERE(workspace_id,site_id)=(w,s) AND status<>'REVOKED';
 GET DIAGNOSTICS count_=ROW_COUNT;
 UPDATE lyraseo_handoff.intent SET state=CASE WHEN kind='WORDPRESS' AND state='SENDING' THEN 'UNRESOLVED' ELSE 'REVOKED' END,last_code='SITE_DELETED',updated_at=clock_timestamp() WHERE(workspace_id,site_id)=(w,s) AND state IN('PREPARED','SENDING','RETRY');
 RETURN count_;
END $$;
CREATE FUNCTION lyraseo_handoff.erase_site(w text,s text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE receipts_ integer;intents_ integer;destinations_ integer;
BEGIN
 PERFORM lyraseo_handoff.retire_site(w,s);
 DELETE FROM lyraseo_handoff.receipt r USING lyraseo_handoff.intent i WHERE r.intent_id=i.id AND(i.workspace_id,i.site_id)=(w,s);
 GET DIAGNOSTICS receipts_=ROW_COUNT;
 DELETE FROM lyraseo_handoff.intent WHERE(workspace_id,site_id)=(w,s);GET DIAGNOSTICS intents_=ROW_COUNT;
 DELETE FROM lyraseo_handoff.destination WHERE(workspace_id,site_id)=(w,s);GET DIAGNOSTICS destinations_=ROW_COUNT;
 RETURN jsonb_build_object('receipts',receipts_,'intents',intents_,'destinations',destinations_,'externalCopies','USER_MANAGED');
END $$;
-- A purpose owner can execute its own helper only. No login inherits this role.
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lyraseo_handoff' LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_handoff_owner',f);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION lyraseo_handoff.summary(text,text,integer),lyraseo_handoff.web_command(text,text,integer,text,jsonb) TO lyraseo_runtime;
DO $$ BEGIN IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_deletion_owner') THEN
 GRANT USAGE ON SCHEMA lyraseo_handoff TO lyraseo_deletion_owner;
 GRANT EXECUTE ON FUNCTION lyraseo_handoff.retire_site(text,text),lyraseo_handoff.erase_site(text,text) TO lyraseo_deletion_owner;
 END IF; END $$;
COMMIT;
