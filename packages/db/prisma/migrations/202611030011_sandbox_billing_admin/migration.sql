-- Phase-one SANDBOX only. Provision separate restricted logins before install.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ DECLARE r record; n integer; BEGIN
 SELECT count(*) INTO n FROM pg_roles WHERE rolname IN ('lyraseo_billing_owner','lyraseo_billing_intake','lyraseo_billing_reconciler','lyraseo_staff_executor');
 IF n<>4 THEN RAISE EXCEPTION 'BILLING_ROLES_REQUIRED'; END IF;
 FOR r IN SELECT * FROM pg_roles WHERE rolname IN ('lyraseo_billing_owner','lyraseo_billing_intake','lyraseo_billing_reconciler','lyraseo_staff_executor') LOOP
  IF r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
   OR r.rolcanlogin=(r.rolname='lyraseo_billing_owner')
   OR EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   OR EXISTS(SELECT FROM pg_database WHERE datdba=r.oid)
   OR EXISTS(SELECT FROM pg_class WHERE relowner=r.oid AND relkind IN('r','p','v','m'))
   OR EXISTS(SELECT FROM pg_namespace WHERE nspowner=r.oid)
   OR EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN('r','p','v','m') AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
  THEN RAISE EXCEPTION 'UNSAFE_BILLING_ROLE'; END IF;
 END LOOP;
END $$;
CREATE SCHEMA lyraseo_billing;
REVOKE ALL ON SCHEMA lyraseo_billing FROM PUBLIC;
GRANT USAGE ON SCHEMA lyraseo_billing TO lyraseo_billing_owner,lyraseo_billing_intake,lyraseo_billing_reconciler,lyraseo_staff_executor,lyraseo_runtime,lyraseo_operator;
GRANT USAGE ON SCHEMA public TO lyraseo_billing_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE lyraseo_billing_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE lyraseo_billing.merchant(provider text NOT NULL CHECK(provider IN('RAZORPAY','POLAR')),merchant_id text NOT NULL,mode text NOT NULL DEFAULT 'SANDBOX' CHECK(mode='SANDBOX'),enabled boolean NOT NULL DEFAULT true,PRIMARY KEY(provider,merchant_id));
CREATE TABLE lyraseo_billing.account(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text UNIQUE NOT NULL REFERENCES public."Workspace"(id) ON DELETE RESTRICT,tombstoned_at timestamptz,revision integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE lyraseo_billing.price_mapping(provider text NOT NULL,merchant_id text NOT NULL,external_price text NOT NULL,version text NOT NULL,plan_id text NOT NULL,currency text NOT NULL CHECK(currency IN('USD','INR','EUR','GBP','JPY','KWD','BHD')),amount_minor bigint NOT NULL CHECK(amount_minor>0),exponent integer NOT NULL CHECK((currency IN('USD','INR','EUR','GBP') AND exponent=2) OR (currency='JPY' AND exponent=0) OR (currency IN('KWD','BHD') AND exponent=3)),PRIMARY KEY(provider,merchant_id,external_price,version),FOREIGN KEY(provider,merchant_id) REFERENCES lyraseo_billing.merchant);
CREATE TABLE lyraseo_billing.base_slot(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL UNIQUE REFERENCES lyraseo_billing.account,provider text NOT NULL,merchant_id text NOT NULL,price_id text NOT NULL,price_version text NOT NULL,sponsor_id text NOT NULL REFERENCES public."ProductUser"(id) ON DELETE RESTRICT,idempotency_key text NOT NULL,fingerprint text NOT NULL,resource_id text,generation integer NOT NULL CHECK(generation>0),state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','ACTIVE','PAST_DUE','CANCEL_AT_PERIOD_END','DISPUTED')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(provider,merchant_id,price_id,price_version) REFERENCES lyraseo_billing.price_mapping);
CREATE TABLE lyraseo_billing.intent(id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES lyraseo_billing.account,idempotency_key text NOT NULL,fingerprint text NOT NULL,provider text NOT NULL,merchant_id text NOT NULL,price_id text NOT NULL,price_version text NOT NULL,generation integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(account_id,idempotency_key));
CREATE TABLE lyraseo_billing.binding(provider text NOT NULL,merchant_id text NOT NULL,resource_id text NOT NULL,customer_id text NOT NULL,account_id uuid NOT NULL REFERENCES lyraseo_billing.account,PRIMARY KEY(provider,merchant_id,resource_id),FOREIGN KEY(provider,merchant_id) REFERENCES lyraseo_billing.merchant);
CREATE TABLE lyraseo_billing.event(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider text NOT NULL,merchant_id text NOT NULL,external_id text NOT NULL,payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),key_version text NOT NULL,event_type text NOT NULL,resource_id text NOT NULL,account_id uuid REFERENCES lyraseo_billing.account,references_json jsonb NOT NULL DEFAULT '{}',occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),contract text NOT NULL,collision boolean NOT NULL,mode text NOT NULL DEFAULT 'SANDBOX' CHECK(mode='SANDBOX'),UNIQUE(provider,merchant_id,external_id,payload_hash),FOREIGN KEY(provider,merchant_id) REFERENCES lyraseo_billing.merchant);
CREATE INDEX billing_event_resource ON lyraseo_billing.event(provider,merchant_id,resource_id,received_at,id);
CREATE TABLE lyraseo_billing.inbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider text NOT NULL,merchant_id text NOT NULL,resource_id text NOT NULL,generation integer NOT NULL DEFAULT 1,fence integer NOT NULL DEFAULT 0,token uuid,lease_until timestamptz,state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','READING','DONE','CONFLICT','UNAVAILABLE','FAILED')),attempts integer NOT NULL DEFAULT 0,next_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_error text,completed_at timestamptz,UNIQUE(provider,merchant_id,resource_id),FOREIGN KEY(provider,merchant_id,resource_id) REFERENCES lyraseo_billing.binding);
CREATE INDEX billing_due ON lyraseo_billing.inbox(next_at,id) WHERE state IN('PENDING','UNAVAILABLE','CONFLICT');
CREATE TABLE lyraseo_billing.subscription(provider text NOT NULL,merchant_id text NOT NULL,resource_id text NOT NULL,account_id uuid NOT NULL REFERENCES lyraseo_billing.account,state text NOT NULL CHECK(state IN('NONE','PENDING','ACTIVE','PAST_DUE','CANCEL_AT_PERIOD_END','ENDED','DISPUTED')),native_state text NOT NULL,plan_id text,currency text NOT NULL,exponent integer NOT NULL,period_start timestamptz,period_end timestamptz,sandbox_entitled boolean NOT NULL DEFAULT false,production_entitled boolean NOT NULL DEFAULT false CHECK(NOT production_entitled),snapshot_hash text NOT NULL,generation integer NOT NULL,source_version numeric(20,0) NOT NULL,external_price_id text NOT NULL,price_mapping_version text NOT NULL,reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(provider,merchant_id,resource_id),FOREIGN KEY(provider,merchant_id,resource_id) REFERENCES lyraseo_billing.binding);
CREATE TABLE lyraseo_billing.money_fact(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES lyraseo_billing.account,provider text NOT NULL,merchant_id text NOT NULL,resource_id text NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,kind text NOT NULL CHECK(kind IN('PAYMENT','REFUND','DISPUTE_OPEN','DISPUTE_RESOLVED')),reference text NOT NULL,parent_reference text,amount_minor bigint NOT NULL CHECK(amount_minor>=0),currency text NOT NULL,exponent integer NOT NULL,snapshot_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(provider,merchant_id,kind,reference));
CREATE TABLE lyraseo_billing.transition(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES lyraseo_billing.account,provider text NOT NULL,resource_id text NOT NULL,old_state text,new_state text NOT NULL,snapshot_hash text NOT NULL,generation integer NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(account_id,provider,resource_id,generation));
CREATE TABLE lyraseo_billing.admission_binding(intent_id uuid PRIMARY KEY REFERENCES lyraseo_billing.intent,account_id uuid NOT NULL REFERENCES lyraseo_billing.account,generation integer NOT NULL,provider text NOT NULL,merchant_id text NOT NULL,resource_id text NOT NULL,customer_id text NOT NULL,evidence_hash text NOT NULL CHECK(evidence_hash~'^[a-f0-9]{64}$'),qualification text NOT NULL CHECK(qualification='SYNTHETIC_EXTERNAL_BINDING_V2'),UNIQUE(provider,merchant_id,resource_id),FOREIGN KEY(provider,merchant_id,resource_id) REFERENCES lyraseo_billing.binding);
CREATE TABLE lyraseo_billing.retirement(provider text NOT NULL,merchant_id text NOT NULL,resource_id text NOT NULL,intent_id uuid REFERENCES lyraseo_billing.intent,source_version numeric(20,0) NOT NULL,snapshot_hash text NOT NULL,retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(provider,merchant_id,resource_id));
CREATE TABLE lyraseo_billing.economic_observation(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES lyraseo_billing.account,provider text NOT NULL,merchant_id text NOT NULL,resource_id text NOT NULL,kind text NOT NULL,reference text NOT NULL,status text NOT NULL CHECK(status IN('PENDING','FAILED','SUCCEEDED')),amount_minor bigint NOT NULL CHECK(amount_minor>=0),currency text NOT NULL,exponent integer NOT NULL,parent_reference text,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,source_version numeric(20,0) NOT NULL,evidence_hash text NOT NULL,source_contract text NOT NULL CHECK(source_contract='SYNTHETIC_CANONICAL_V2'),UNIQUE(provider,merchant_id,kind,reference,source_version));
CREATE TABLE lyraseo_billing.event_route(event_id uuid PRIMARY KEY REFERENCES lyraseo_billing.event,account_id uuid NOT NULL REFERENCES lyraseo_billing.account,provider text NOT NULL,merchant_id text NOT NULL,resource_id text NOT NULL,basis text NOT NULL CHECK(basis IN('SIGNED_SUBSCRIPTION_REFERENCE','KNOWN_PAYMENT_REFERENCE')),FOREIGN KEY(provider,merchant_id,resource_id) REFERENCES lyraseo_billing.binding);
CREATE TABLE lyraseo_billing.discovery(event_id uuid PRIMARY KEY REFERENCES lyraseo_billing.event,state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','ROUTED','UNAVAILABLE','FAILED')),attempts integer NOT NULL DEFAULT 0,next_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_error text);
CREATE INDEX billing_discovery_due ON lyraseo_billing.discovery(next_at,event_id) WHERE state IN('PENDING','UNAVAILABLE');
CREATE TABLE lyraseo_billing.canonical_rejection(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES lyraseo_billing.account,resource_id text NOT NULL,generation integer NOT NULL,snapshot_hash text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE lyraseo_billing.staff_capability(user_id text NOT NULL REFERENCES public."StaffGrant"("userId") ON DELETE RESTRICT,action text NOT NULL CHECK(action IN('billing:reconcile','policy:pause','recovery:manage','support:search','privacy:read')),enabled boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 0,PRIMARY KEY(user_id,action));
CREATE TABLE lyraseo_billing.staff_epoch(user_id text PRIMARY KEY,revision integer NOT NULL DEFAULT 0);
INSERT INTO lyraseo_billing.staff_epoch(user_id) SELECT "userId" FROM public."StaffGrant";
CREATE TABLE lyraseo_billing.staff_receipt(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),staff_id text NOT NULL,action text NOT NULL,target text,outcome text NOT NULL,reason text NOT NULL,old_state jsonb,new_state jsonb,request_id uuid NOT NULL DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX staff_receipt_cursor ON lyraseo_billing.staff_receipt(created_at,id);
CREATE TABLE lyraseo_billing.staff_rate(user_id text NOT NULL,kind text NOT NULL,window_start timestamptz NOT NULL,count integer NOT NULL,PRIMARY KEY(user_id,kind,window_start));
CREATE TABLE lyraseo_billing.step_up(token_hash text PRIMARY KEY,user_id text NOT NULL,session_id text NOT NULL,security_version integer NOT NULL,action text NOT NULL,target text NOT NULL,grant_revision integer NOT NULL,capability_revision integer NOT NULL,authenticated_at timestamptz NOT NULL,mfa_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,request_hash text,result jsonb);
CREATE TABLE lyraseo_billing.action_request(id uuid PRIMARY KEY,user_id text NOT NULL,session_id text NOT NULL,security_version integer NOT NULL,action text NOT NULL,target text NOT NULL,args_text text NOT NULL,reason text NOT NULL,request_hash text NOT NULL,token_hash text NOT NULL REFERENCES lyraseo_billing.step_up(token_hash),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE lyraseo_billing.request_resolution(request_id uuid PRIMARY KEY REFERENCES lyraseo_billing.action_request,state text NOT NULL DEFAULT 'OPEN' CHECK(state IN('OPEN','COMMITTED','ACKNOWLEDGED','ABANDONED')),last_error text,resolved_at timestamptz);
CREATE TABLE lyraseo_billing.policy_intent(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),staff_id text NOT NULL,actor jsonb NOT NULL,policy_key text NOT NULL REFERENCES public."RuntimePolicy"(key),expected_revision integer NOT NULL,grant_revision integer NOT NULL,capability_revision integer NOT NULL,reason text NOT NULL,expires_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','APPLIED','CONFLICT','DENIED','UNAVAILABLE')),effective_revision integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE lyraseo_billing.recovery_case(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject_id text NOT NULL REFERENCES public."ProductUser"(id) ON DELETE RESTRICT,workspace_id text REFERENCES public."Workspace"(id) ON DELETE RESTRICT,opened_by text NOT NULL,state text NOT NULL DEFAULT 'VERIFYING' CHECK(state IN('VERIFYING','HOLD','APPROVED','DENIED','COMPLETED')),revision integer NOT NULL DEFAULT 0,evidence_hash text,notice_receipt_hash text,accepted_by text,accepted_at timestamptz,hold_until timestamptz,decision_by text,decision_at timestamptz,reason text NOT NULL,provider_state text NOT NULL DEFAULT 'UNAVAILABLE' CHECK(provider_state='UNAVAILABLE'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(hold_until IS NULL OR hold_until>=accepted_at+interval '72 hours'),CHECK(state NOT IN('HOLD','APPROVED') OR (evidence_hash IS NOT NULL AND notice_receipt_hash IS NOT NULL AND accepted_at IS NOT NULL)),CHECK(state<>'COMPLETED'));
CREATE INDEX recovery_case_cursor ON lyraseo_billing.recovery_case(created_at,id);
CREATE FUNCTION lyraseo_billing.staff_epoch_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 INSERT INTO lyraseo_billing.staff_epoch(user_id,revision) VALUES(NEW."userId",1) ON CONFLICT(user_id) DO UPDATE SET revision=staff_epoch.revision+1;
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason,new_state) VALUES('db:'||session_user,'staff:provision',NEW."userId",'RECORDED','OFFLINE_STAFF_GRANT_CHANGE',jsonb_build_object('enabled',NEW.enabled));
 RETURN NEW;
END $$;
CREATE TRIGGER staff_epoch_change AFTER INSERT OR UPDATE ON public."StaffGrant" FOR EACH ROW EXECUTE FUNCTION lyraseo_billing.staff_epoch_change();
CREATE FUNCTION lyraseo_billing.capability_epoch_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE subject text; action_name text; enabled_value boolean; BEGIN
 IF TG_OP='DELETE' THEN subject:=OLD.user_id;action_name:=OLD.action;enabled_value:=false;
 ELSE subject:=NEW.user_id;action_name:=NEW.action;enabled_value:=NEW.enabled;IF TG_OP='UPDATE' THEN NEW.revision:=OLD.revision+1; END IF; END IF;
 INSERT INTO lyraseo_billing.staff_epoch(user_id,revision) VALUES(subject,1) ON CONFLICT(user_id) DO UPDATE SET revision=staff_epoch.revision+1;
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason,new_state) VALUES('db:'||session_user,'staff:capability',subject,'RECORDED','OFFLINE_STAFF_CAPABILITY_CHANGE',jsonb_build_object('action',action_name,'enabled',enabled_value));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER capability_epoch_change BEFORE INSERT OR UPDATE OR DELETE ON lyraseo_billing.staff_capability FOR EACH ROW EXECUTE FUNCTION lyraseo_billing.capability_epoch_change();
CREATE FUNCTION lyraseo_billing.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_BILLING_EVIDENCE'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['action_request','price_mapping','intent','binding','admission_binding','retirement','economic_observation','event_route','canonical_rejection','event','money_fact','transition','staff_receipt'] LOOP EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON lyraseo_billing.%I FOR EACH ROW EXECUTE FUNCTION lyraseo_billing.immutable()',t); END LOOP;
END $$;
CREATE UNIQUE INDEX action_request_one_token ON lyraseo_billing.action_request(token_hash);
CREATE FUNCTION lyraseo_billing.actor_valid(a jsonb,staff boolean,capability text DEFAULT NULL,fresh boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t timestamptz; m timestamptz; BEGIN
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR a ? 'credential' OR a->>'authProvider' IS DISTINCT FROM 'supabase' OR NOT EXISTS(SELECT FROM public."ProductUser" u WHERE u.id=a->>'userId' AND NOT u.suspended AND u."securityVersion"=(a->>'securityVersion')::integer FOR SHARE) OR NOT EXISTS(SELECT FROM public."ProductSession" s WHERE s."sessionId"=a->>'sessionId' AND s."userId"=a->>'userId' AND s."securityVersion"=(a->>'securityVersion')::integer AND s."createdAt">clock_timestamp()-interval '30 days' AND s."refreshedAt">clock_timestamp()-interval '7 days' FOR SHARE) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF staff AND (a->>'mfaVerified' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT FROM public."StaffGrant" g WHERE g."userId"=a->>'userId' AND g.enabled FOR SHARE)) THEN RAISE EXCEPTION 'STAFF_REQUIRED'; END IF;
 IF capability IS NOT NULL AND NOT EXISTS(SELECT FROM lyraseo_billing.staff_capability c WHERE c.user_id=a->>'userId' AND c.action=capability AND c.enabled FOR SHARE) THEN RAISE EXCEPTION 'STAFF_ACTION_FORBIDDEN'; END IF;
 IF staff THEN PERFORM 1 FROM lyraseo_billing.staff_epoch WHERE user_id=a->>'userId' FOR SHARE; END IF;
 IF staff AND (a->>'mfaAuthenticatedAt' IS NULL OR (a->>'mfaAuthenticatedAt')::timestamptz>clock_timestamp()+interval '30 seconds') THEN RAISE EXCEPTION 'STAFF_REQUIRED'; END IF;
 IF fresh THEN t:=(a->>'authenticatedAt')::timestamptz; m:=(a->>'mfaAuthenticatedAt')::timestamptz; IF t IS NULL OR m IS NULL OR t<=clock_timestamp()-interval '10 minutes' OR m<=clock_timestamp()-interval '10 minutes' OR t>clock_timestamp()+interval '30 seconds' OR m>clock_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'FRESH_AUTH_REQUIRED'; END IF; END IF;
END $$;
CREATE FUNCTION lyraseo_billing.reserve_slot(a jsonb,workspace text,provider_name text,merchant_name text,price text,version text,idem text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE acc lyraseo_billing.account; slot lyraseo_billing.base_slot; old lyraseo_billing.intent; fp text; new_id uuid:=gen_random_uuid(); BEGIN
 IF session_user<>'lyraseo_runtime' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=workspace FOR UPDATE;
 PERFORM lyraseo_billing.actor_valid(a,false,NULL,false);
 IF NOT EXISTS(SELECT FROM public."Workspace" w JOIN public."Membership" m ON m."workspaceId"=w.id WHERE w.id=workspace AND w."deletedAt" IS NULL AND m."userId"=a->>'userId' AND m.role='OWNER') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF length(idem) NOT BETWEEN 1 AND 128 OR NOT EXISTS(SELECT FROM lyraseo_billing.merchant WHERE provider=provider_name AND merchant_id=merchant_name AND enabled) OR NOT EXISTS(SELECT FROM lyraseo_billing.price_mapping WHERE provider=provider_name AND merchant_id=merchant_name AND external_price=price AND price_mapping.version=reserve_slot.version) THEN RAISE EXCEPTION 'UNQUALIFIED_SANDBOX_MAPPING'; END IF;
 INSERT INTO lyraseo_billing.account(workspace_id) VALUES(workspace) ON CONFLICT(workspace_id) DO NOTHING;
 SELECT * INTO acc FROM lyraseo_billing.account WHERE workspace_id=workspace FOR UPDATE;
 IF acc.tombstoned_at IS NOT NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(a->>'userId',provider_name,merchant_name,price,version)::text,'UTF8')),'hex');
 SELECT * INTO old FROM lyraseo_billing.intent WHERE account_id=acc.id AND idempotency_key=idem;
 IF FOUND THEN IF old.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; RETURN jsonb_build_object('id',old.id,'mode','SANDBOX','checkoutAvailable',false); END IF;
 IF EXISTS(SELECT FROM lyraseo_billing.base_slot WHERE account_id=acc.id) THEN RAISE EXCEPTION 'BASE_SLOT_OCCUPIED'; END IF;
 UPDATE lyraseo_billing.account SET revision=revision+1 WHERE id=acc.id RETURNING * INTO acc;
 INSERT INTO lyraseo_billing.base_slot(id,account_id,provider,merchant_id,price_id,price_version,sponsor_id,idempotency_key,fingerprint,generation) VALUES(new_id,acc.id,provider_name,merchant_name,price,version,a->>'userId',idem,fp,acc.revision);
 INSERT INTO lyraseo_billing.intent(id,account_id,idempotency_key,fingerprint,provider,merchant_id,price_id,price_version,generation) VALUES(new_id,acc.id,idem,fp,provider_name,merchant_name,price,version,acc.revision);
 RETURN jsonb_build_object('id',new_id,'mode','SANDBOX','checkoutAvailable',false);
END $$;
CREATE FUNCTION lyraseo_billing.bind_subscription(intent_id_ uuid,resource text,customer text,qualification text,evidence text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE i lyraseo_billing.intent; slot lyraseo_billing.base_slot; b lyraseo_billing.binding; BEGIN
 IF session_user<>'lyraseo_billing_reconciler' OR qualification IS DISTINCT FROM 'SYNTHETIC_EXTERNAL_BINDING_V2' OR evidence!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'UNQUALIFIED_BINDING'; END IF;
 SELECT * INTO i FROM lyraseo_billing.intent WHERE id=intent_id_;
 PERFORM 1 FROM lyraseo_billing.account WHERE id=i.account_id FOR UPDATE;
 SELECT * INTO slot FROM lyraseo_billing.base_slot WHERE id=intent_id_ FOR UPDATE;
 SELECT * INTO b FROM lyraseo_billing.binding WHERE provider=i.provider AND merchant_id=i.merchant_id AND resource_id=resource;
 IF slot.id IS NULL OR b.account_id IS DISTINCT FROM i.account_id OR b.customer_id IS DISTINCT FROM customer OR slot.generation<>i.generation OR EXISTS(SELECT FROM lyraseo_billing.retirement WHERE provider=b.provider AND merchant_id=b.merchant_id AND resource_id=resource) OR (slot.resource_id IS NOT NULL AND slot.resource_id<>resource) THEN RAISE EXCEPTION 'ADMISSION_BINDING_CONFLICT'; END IF;
 IF EXISTS(SELECT FROM lyraseo_billing.admission_binding WHERE intent_id=intent_id_ AND (resource_id<>resource OR customer_id<>customer OR evidence_hash<>evidence)) THEN RAISE EXCEPTION 'ADMISSION_BINDING_CONFLICT'; END IF;
 INSERT INTO lyraseo_billing.admission_binding(intent_id,account_id,generation,provider,merchant_id,resource_id,customer_id,evidence_hash,qualification) VALUES(intent_id_,i.account_id,i.generation,i.provider,i.merchant_id,resource,customer,evidence,qualification) ON CONFLICT(intent_id) DO NOTHING;
 UPDATE lyraseo_billing.base_slot SET resource_id=resource WHERE id=intent_id_;
END $$;
CREATE FUNCTION lyraseo_billing.route_event(event_id uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
<<route_event>>
DECLARE e lyraseo_billing.event; b lyraseo_billing.binding; target text; basis text; BEGIN
 SELECT * INTO e FROM lyraseo_billing.event WHERE id=event_id;
 IF e.references_json->>'accountVerified'='false' THEN RETURN false; END IF;
 IF EXISTS(SELECT FROM lyraseo_billing.event_route WHERE event_route.event_id=route_event.event_id) THEN RETURN true; END IF;
 target:=coalesce(e.references_json->>'subscriptionId',CASE WHEN e.event_type LIKE 'subscription.%' THEN e.resource_id END);
 basis:='SIGNED_SUBSCRIPTION_REFERENCE';
 IF target IS NULL AND coalesce(e.references_json->>'paymentId',e.references_json->>'orderId') IS NOT NULL THEN
  SELECT resource_id INTO target FROM lyraseo_billing.money_fact WHERE provider=e.provider AND merchant_id=e.merchant_id AND kind='PAYMENT' AND reference=coalesce(e.references_json->>'paymentId',e.references_json->>'orderId'); basis:='KNOWN_PAYMENT_REFERENCE';
 END IF;
 SELECT * INTO b FROM lyraseo_billing.binding WHERE provider=e.provider AND merchant_id=e.merchant_id AND resource_id=target;
 IF NOT FOUND OR (e.account_id IS NOT NULL AND e.account_id<>b.account_id) OR (e.references_json->>'customerId' IS NOT NULL AND e.references_json->>'customerId'<>b.customer_id) THEN RETURN false; END IF;
 INSERT INTO lyraseo_billing.event_route VALUES(e.id,b.account_id,b.provider,b.merchant_id,b.resource_id,basis);
 INSERT INTO lyraseo_billing.inbox(provider,merchant_id,resource_id) VALUES(b.provider,b.merchant_id,b.resource_id) ON CONFLICT(provider,merchant_id,resource_id) DO UPDATE SET generation=inbox.generation+1,state='PENDING',token=NULL,lease_until=NULL,next_at=clock_timestamp(),attempts=CASE WHEN inbox.state='DONE' THEN 0 ELSE inbox.attempts END;
 RETURN true;
END $$;
CREATE FUNCTION lyraseo_billing.record_event(e jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event_id uuid; collision_found boolean; account uuid; refs jsonb:=coalesce(e->'references','{}'::jsonb); BEGIN
 IF session_user<>'lyraseo_billing_intake' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 IF e->>'mode' IS DISTINCT FROM 'SANDBOX' OR length(e::text)>8192 OR coalesce(e->>'payloadHash','')!~'^[a-f0-9]{64}$' OR coalesce(e->>'keyVersion','')='' OR coalesce(e->>'contract','')='' OR jsonb_typeof(refs)<>'object' OR NOT EXISTS(SELECT FROM lyraseo_billing.merchant WHERE provider=e->>'provider' AND merchant_id=e->>'merchantId') THEN RAISE EXCEPTION 'INVALID_BILLING_EVENT'; END IF;
 refs:=refs||jsonb_build_object('accountVerified',coalesce((e->>'sourceAccountVerified')::boolean,true));
 IF e->>'customerId' IS NOT NULL THEN refs:=refs||jsonb_build_object('customerId',e->>'customerId'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((e->>'provider')||':'||(e->>'merchantId')||':'||(e->>'externalId'),91132));
 SELECT id INTO event_id FROM lyraseo_billing.event WHERE provider=e->>'provider' AND merchant_id=e->>'merchantId' AND external_id=e->>'externalId' AND payload_hash=e->>'payloadHash';
 IF FOUND THEN RETURN jsonb_build_object('outcome','EXACT_REPLAY','id',event_id); END IF;
 SELECT account_id INTO account FROM lyraseo_billing.binding WHERE provider=e->>'provider' AND merchant_id=e->>'merchantId' AND resource_id=coalesce(refs->>'subscriptionId',CASE WHEN e->>'type' LIKE 'subscription.%' THEN e->>'resourceId' END) AND (refs->>'customerId' IS NULL OR customer_id=refs->>'customerId');
 collision_found:=EXISTS(SELECT FROM lyraseo_billing.event WHERE provider=e->>'provider' AND merchant_id=e->>'merchantId' AND external_id=e->>'externalId');
 INSERT INTO lyraseo_billing.event(provider,merchant_id,external_id,payload_hash,key_version,event_type,resource_id,account_id,references_json,occurred_at,contract,collision) VALUES(e->>'provider',e->>'merchantId',e->>'externalId',e->>'payloadHash',e->>'keyVersion',e->>'type',e->>'resourceId',account,refs,(e->>'occurredAt')::timestamptz,e->>'contract',collision_found) RETURNING id INTO event_id;
 IF NOT lyraseo_billing.route_event(event_id) THEN INSERT INTO lyraseo_billing.discovery(event_id,last_error) VALUES(event_id,'ACCOUNT_BOUND_REFERENCE_DISCOVERY_REQUIRED');RETURN jsonb_build_object('outcome','DURABLE_UNRESOLVED','id',event_id); END IF;
 RETURN jsonb_build_object('outcome',CASE WHEN collision_found THEN 'COLLISION' ELSE 'ACCEPTED' END,'id',event_id);
END $$;
CREATE FUNCTION lyraseo_billing.resolve_pending(event_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
<<resolve_pending>>
DECLARE d lyraseo_billing.discovery; BEGIN
 IF session_user<>'lyraseo_billing_reconciler' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 SELECT * INTO d FROM lyraseo_billing.discovery WHERE discovery.event_id=resolve_pending.event_id FOR UPDATE;
 IF NOT FOUND OR d.state='ROUTED' THEN RETURN jsonb_build_object('state','ROUTED'); END IF;
 IF d.next_at>clock_timestamp() OR d.attempts>=8 THEN RETURN jsonb_build_object('state',d.state,'reason','BACKOFF_OR_TERMINAL'); END IF;
 IF lyraseo_billing.route_event(event_id) THEN UPDATE lyraseo_billing.discovery SET state='ROUTED',attempts=attempts+1,last_error=NULL WHERE discovery.event_id=resolve_pending.event_id;RETURN jsonb_build_object('state','ROUTED'); END IF;
 UPDATE lyraseo_billing.discovery SET state=CASE WHEN attempts+1>=8 THEN 'FAILED' ELSE 'UNAVAILABLE' END,attempts=attempts+1,next_at=clock_timestamp()+make_interval(secs=>least(3600,30*(2^least(attempts,7))::integer)),last_error='QUALIFIED_REFERENCE_READER_UNAVAILABLE' WHERE discovery.event_id=resolve_pending.event_id RETURNING * INTO d;
 RETURN jsonb_build_object('state',d.state,'reason',d.last_error);
END $$;
CREATE FUNCTION lyraseo_billing.claim(provider_name text,merchant_name text,resource text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j lyraseo_billing.inbox; BEGIN
 IF session_user<>'lyraseo_billing_reconciler' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 SELECT * INTO j FROM lyraseo_billing.inbox WHERE provider=provider_name AND merchant_id=merchant_name AND resource_id=resource FOR UPDATE;
 IF NOT FOUND OR j.state='DONE' OR j.next_at>clock_timestamp() OR (j.state='READING' AND j.lease_until>clock_timestamp()) OR j.attempts>=8 THEN RAISE EXCEPTION 'NOT_RECONCILABLE'; END IF;
 UPDATE lyraseo_billing.inbox SET state='READING',fence=fence+1,token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1 WHERE id=j.id RETURNING * INTO j;
 RETURN jsonb_build_object('id',j.id,'provider',j.provider,'merchantId',j.merchant_id,'resourceId',j.resource_id,'generation',j.generation,'fence',j.fence,'token',j.token);
END $$;
CREATE FUNCTION lyraseo_billing.defer(job uuid,expected_fence integer,expected_generation integer,proof uuid,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF session_user<>'lyraseo_billing_reconciler' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 IF reason NOT IN('READER_UNAVAILABLE','READ_TIMEOUT','INVALID_SNAPSHOT','SCHEMA_UNSUPPORTED') THEN RAISE EXCEPTION 'INVALID_REASON'; END IF;
 UPDATE lyraseo_billing.inbox SET state=CASE WHEN attempts>=8 THEN 'FAILED' ELSE 'UNAVAILABLE' END,next_at=clock_timestamp()+make_interval(secs=>least(3600,30*(2^least(attempts,7))::integer)),last_error=reason,token=NULL,lease_until=NULL WHERE id=job AND state='READING' AND fence=expected_fence AND generation=expected_generation AND token=proof AND lease_until>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'STALE_RECONCILIATION'; END IF;
END $$;
CREATE FUNCTION lyraseo_billing.apply_snapshot(job uuid,expected_fence integer,expected_generation integer,proof uuid,s jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j lyraseo_billing.inbox; b lyraseo_billing.binding; acc lyraseo_billing.account; slot lyraseo_billing.base_slot; prior lyraseo_billing.subscription; admission lyraseo_billing.admission_binding; mapping lyraseo_billing.price_mapping; f jsonb; mf lyraseo_billing.money_fact; sh text; entitled boolean:=false; state_name text; reason text:='CANONICAL_FIXTURE'; ps timestamptz; pe timestamptz; sv numeric(20,0); paid_minor numeric:=0; refunded numeric:=0; BEGIN
 IF session_user<>'lyraseo_billing_reconciler' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 SELECT * INTO j FROM lyraseo_billing.inbox WHERE id=job;
 SELECT * INTO b FROM lyraseo_billing.binding WHERE provider=j.provider AND merchant_id=j.merchant_id AND resource_id=j.resource_id;
 SELECT * INTO acc FROM lyraseo_billing.account WHERE id=b.account_id;
 PERFORM 1 FROM public."Workspace" WHERE id=acc.workspace_id FOR UPDATE;
 SELECT * INTO acc FROM lyraseo_billing.account WHERE id=acc.id FOR UPDATE;
 SELECT * INTO slot FROM lyraseo_billing.base_slot WHERE account_id=acc.id FOR UPDATE;
 SELECT * INTO prior FROM lyraseo_billing.subscription WHERE provider=b.provider AND merchant_id=b.merchant_id AND resource_id=b.resource_id FOR UPDATE;
 SELECT * INTO j FROM lyraseo_billing.inbox WHERE id=job FOR UPDATE;
 IF NOT FOUND OR expected_fence IS NULL OR expected_generation IS NULL OR proof IS NULL OR j.state<>'READING' OR j.fence<>expected_fence OR j.generation<>expected_generation OR j.token IS DISTINCT FROM proof OR j.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'STALE_RECONCILIATION'; END IF;
 sh:=encode(sha256(convert_to(s::text,'UTF8')),'hex');
 IF s->'sourceVersion'->>'qualification' IS DISTINCT FROM 'SYNTHETIC_COMPARABLE_V2' OR coalesce(s->'sourceVersion'->>'value','')!~'^(0|[1-9][0-9]{0,18})$' THEN reason:='UNORDERED_CANONICAL';
 ELSE sv:=(s->'sourceVersion'->>'value')::numeric;IF prior.source_version IS NOT NULL AND sv<prior.source_version THEN reason:='STALE_CANONICAL';ELSIF prior.source_version=sv AND prior.snapshot_hash<>sh THEN reason:='AMBIGUOUS_CANONICAL';END IF;END IF;
 IF reason<>'CANONICAL_FIXTURE' THEN
  INSERT INTO lyraseo_billing.canonical_rejection(account_id,resource_id,generation,snapshot_hash,reason) VALUES(acc.id,b.resource_id,j.generation,sh,reason);
  UPDATE lyraseo_billing.inbox SET state='CONFLICT',token=NULL,lease_until=NULL,last_error=reason,next_at=clock_timestamp()+interval '30 seconds' WHERE id=j.id;
  RETURN jsonb_build_object('state',coalesce(prior.state,'NONE'),'sandboxEntitled',coalesce(prior.sandbox_entitled,false),'productionEntitled',false,'reason',reason);
 END IF;
 IF length(s::text)>32768 OR s->>'state' IS NULL OR s->>'state' NOT IN('NONE','PENDING','ACTIVE','PAST_DUE','CANCEL_AT_PERIOD_END','ENDED','DISPUTED') OR coalesce(s->>'nativeState','')!~'^[a-z_]{1,64}$' OR jsonb_typeof(s->'effects') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'effects')>100 OR jsonb_typeof(s->'disputed') IS DISTINCT FROM 'boolean' OR (s->'sourceIdentity'->>'provider',s->'sourceIdentity'->>'merchantId',s->'sourceIdentity'->>'resourceId',s->'sourceIdentity'->>'customerId') IS DISTINCT FROM (b.provider,b.merchant_id,b.resource_id,b.customer_id) THEN RAISE EXCEPTION 'INVALID_BILLING_SNAPSHOT'; END IF;
 SELECT * INTO admission FROM lyraseo_billing.admission_binding WHERE provider=b.provider AND merchant_id=b.merchant_id AND resource_id=b.resource_id;
 SELECT * INTO mapping FROM lyraseo_billing.price_mapping WHERE provider=b.provider AND merchant_id=b.merchant_id AND external_price=s->>'externalPriceId' AND version=s->>'priceMappingVersion';
 state_name:=CASE WHEN (s->>'disputed')::boolean THEN 'DISPUTED' ELSE s->>'state' END;ps:=(s->>'periodStart')::timestamptz;pe:=(s->>'periodEnd')::timestamptz;
 IF mapping.plan_id IS DISTINCT FROM s->>'planId' OR mapping.currency IS DISTINCT FROM s->>'currency' OR mapping.exponent IS DISTINCT FROM (s->>'exponent')::integer OR slot.price_id IS DISTINCT FROM s->>'externalPriceId' OR slot.price_version IS DISTINCT FROM s->>'priceMappingVersion' THEN reason:='FROZEN_PRICE_CONFLICT'; END IF;
 IF slot.id IS NULL OR admission.intent_id IS DISTINCT FROM slot.id OR admission.generation IS DISTINCT FROM slot.generation OR slot.resource_id IS DISTINCT FROM b.resource_id THEN reason:='BASE_SLOT_CONFLICT'; END IF;
 IF EXISTS(SELECT FROM lyraseo_billing.retirement WHERE provider=b.provider AND merchant_id=b.merchant_id AND resource_id=b.resource_id) AND state_name<>'ENDED' THEN reason:='RETIRED_SUBSCRIPTION_CONFLICT'; END IF;
 IF reason='FROZEN_PRICE_CONFLICT' OR mapping.external_price IS NULL OR s->>'externalPriceId' IS NULL OR s->>'priceMappingVersion' IS NULL THEN
  INSERT INTO lyraseo_billing.canonical_rejection(account_id,resource_id,generation,snapshot_hash,reason) VALUES(acc.id,b.resource_id,j.generation,sh,'FROZEN_PRICE_CONFLICT');
  UPDATE lyraseo_billing.subscription SET sandbox_entitled=false WHERE provider=b.provider AND merchant_id=b.merchant_id AND resource_id=b.resource_id;
  UPDATE lyraseo_billing.inbox SET state='CONFLICT',token=NULL,lease_until=NULL,last_error='FROZEN_PRICE_CONFLICT' WHERE id=j.id;
  RETURN jsonb_build_object('state',coalesce(prior.state,'NONE'),'sandboxEntitled',false,'productionEntitled',false,'reason','FROZEN_PRICE_CONFLICT');
 END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(s->'effects') ORDER BY CASE value->>'kind' WHEN 'PAYMENT' THEN 0 WHEN 'REFUND' THEN 1 ELSE 2 END,value->>'reference' LOOP
  IF f->>'kind' IS NULL OR f->>'kind' NOT IN('PAYMENT','REFUND','DISPUTE_OPEN','DISPUTE_RESOLVED') OR f->>'status' IS NULL OR f->>'status' NOT IN('PENDING','FAILED','SUCCEEDED') OR f->>'sourceContract' IS DISTINCT FROM 'SYNTHETIC_CANONICAL_V2' OR f->>'resourceId' IS DISTINCT FROM b.resource_id OR coalesce(f->>'evidenceHash','')!~'^[a-f0-9]{64}$' OR coalesce(f->>'reference','')!~'^[A-Za-z0-9_-]{1,128}$' OR coalesce(f->>'amountMinor','')!~'^(0|[1-9][0-9]{0,18})$' OR (f->>'amountMinor')::numeric>9223372036854775807 OR f->>'currency' IS DISTINCT FROM s->>'currency' OR f->>'exponent' IS DISTINCT FROM s->>'exponent' OR f->>'periodStart' IS NULL OR f->>'periodEnd' IS NULL THEN RAISE EXCEPTION 'INVALID_BILLING_EVIDENCE'; END IF;
  IF EXISTS(SELECT FROM lyraseo_billing.economic_observation o WHERE o.provider=b.provider AND o.merchant_id=b.merchant_id AND o.kind=f->>'kind' AND o.reference=f->>'reference' AND o.source_version=sv AND (o.account_id,o.resource_id,o.status,o.amount_minor,o.currency,o.exponent,o.parent_reference,o.period_start,o.period_end,o.evidence_hash,o.source_contract) IS DISTINCT FROM (acc.id,b.resource_id,f->>'status',(f->>'amountMinor')::bigint,f->>'currency',(f->>'exponent')::integer,f->>'parentReference',(f->>'periodStart')::timestamptz,(f->>'periodEnd')::timestamptz,f->>'evidenceHash',f->>'sourceContract')) THEN RAISE EXCEPTION 'BILLING_ECONOMIC_CONFLICT'; END IF;
  INSERT INTO lyraseo_billing.economic_observation(account_id,provider,merchant_id,resource_id,kind,reference,status,amount_minor,currency,exponent,parent_reference,period_start,period_end,source_version,evidence_hash,source_contract) VALUES(acc.id,b.provider,b.merchant_id,b.resource_id,f->>'kind',f->>'reference',f->>'status',(f->>'amountMinor')::bigint,f->>'currency',(f->>'exponent')::integer,f->>'parentReference',(f->>'periodStart')::timestamptz,(f->>'periodEnd')::timestamptz,sv,f->>'evidenceHash',f->>'sourceContract') ON CONFLICT(provider,merchant_id,kind,reference,source_version) DO NOTHING;
  IF f->>'status'<>'SUCCEEDED' THEN CONTINUE; END IF;
  SELECT * INTO mf FROM lyraseo_billing.money_fact WHERE provider=b.provider AND merchant_id=b.merchant_id AND kind=f->>'kind' AND reference=f->>'reference';
  IF FOUND THEN IF (mf.account_id,mf.resource_id,mf.amount_minor,mf.currency,mf.exponent,mf.parent_reference,mf.period_start,mf.period_end) IS DISTINCT FROM (acc.id,b.resource_id,(f->>'amountMinor')::bigint,f->>'currency',(f->>'exponent')::integer,f->>'parentReference',(f->>'periodStart')::timestamptz,(f->>'periodEnd')::timestamptz) THEN RAISE EXCEPTION 'BILLING_ECONOMIC_CONFLICT'; END IF;
  ELSE
   IF f->>'kind'='REFUND' AND (NOT EXISTS(SELECT FROM lyraseo_billing.money_fact WHERE account_id=acc.id AND provider=b.provider AND merchant_id=b.merchant_id AND resource_id=b.resource_id AND kind='PAYMENT' AND reference=f->>'parentReference' AND currency=f->>'currency') OR (SELECT coalesce(sum(amount_minor),0) FROM lyraseo_billing.money_fact WHERE account_id=acc.id AND provider=b.provider AND merchant_id=b.merchant_id AND kind='REFUND' AND parent_reference=f->>'parentReference')+(f->>'amountMinor')::numeric>(SELECT amount_minor FROM lyraseo_billing.money_fact WHERE account_id=acc.id AND provider=b.provider AND merchant_id=b.merchant_id AND kind='PAYMENT' AND reference=f->>'parentReference')) THEN RAISE EXCEPTION 'UNRECONCILED_REFUND'; END IF;
   INSERT INTO lyraseo_billing.money_fact(account_id,provider,merchant_id,resource_id,period_start,period_end,kind,reference,parent_reference,amount_minor,currency,exponent,snapshot_hash) VALUES(acc.id,b.provider,b.merchant_id,b.resource_id,(f->>'periodStart')::timestamptz,(f->>'periodEnd')::timestamptz,f->>'kind',f->>'reference',f->>'parentReference',(f->>'amountMinor')::bigint,f->>'currency',(f->>'exponent')::integer,sh);
  END IF;
 END LOOP;
 SELECT amount_minor INTO paid_minor FROM lyraseo_billing.money_fact WHERE provider=b.provider AND merchant_id=b.merchant_id AND resource_id=b.resource_id AND account_id=acc.id AND kind='PAYMENT' AND reference=s->>'paymentReference' AND period_start=ps AND period_end=pe AND currency=mapping.currency AND exponent=mapping.exponent;
 SELECT coalesce(sum(amount_minor),0) INTO refunded FROM lyraseo_billing.money_fact WHERE provider=b.provider AND merchant_id=b.merchant_id AND resource_id=b.resource_id AND account_id=acc.id AND kind='REFUND' AND parent_reference=s->>'paymentReference';
 entitled:=coalesce(reason='CANONICAL_FIXTURE' AND paid_minor-refunded>=mapping.amount_minor AND NOT(s->>'disputed')::boolean AND state_name IN('ACTIVE','CANCEL_AT_PERIOD_END') AND ps<=clock_timestamp() AND pe>clock_timestamp() AND pe>ps,false);
 IF reason='CANONICAL_FIXTURE' AND NOT entitled AND state_name IN('ACTIVE','CANCEL_AT_PERIOD_END') THEN reason:='PAYMENT_NOT_CORROBORATED'; END IF;
 IF acc.tombstoned_at IS NOT NULL OR NOT EXISTS(SELECT FROM public."Workspace" WHERE id=acc.workspace_id AND "deletedAt" IS NULL) THEN entitled:=false;reason:='TOMBSTONED'; END IF;
 INSERT INTO lyraseo_billing.subscription(provider,merchant_id,resource_id,account_id,state,native_state,plan_id,currency,exponent,period_start,period_end,sandbox_entitled,snapshot_hash,generation,source_version,external_price_id,price_mapping_version) VALUES(b.provider,b.merchant_id,b.resource_id,acc.id,state_name,s->>'nativeState',s->>'planId',s->>'currency',(s->>'exponent')::integer,ps,pe,entitled,sh,j.generation,sv,s->>'externalPriceId',s->>'priceMappingVersion') ON CONFLICT(provider,merchant_id,resource_id) DO UPDATE SET state=excluded.state,native_state=excluded.native_state,plan_id=excluded.plan_id,currency=excluded.currency,exponent=excluded.exponent,period_start=excluded.period_start,period_end=excluded.period_end,sandbox_entitled=excluded.sandbox_entitled,snapshot_hash=excluded.snapshot_hash,generation=excluded.generation,source_version=excluded.source_version,external_price_id=excluded.external_price_id,price_mapping_version=excluded.price_mapping_version,reconciled_at=clock_timestamp();
 INSERT INTO lyraseo_billing.transition(account_id,provider,resource_id,old_state,new_state,snapshot_hash,generation,reason) VALUES(acc.id,b.provider,b.resource_id,prior.state,state_name,sh,j.generation,reason);
 IF reason='CANONICAL_FIXTURE' AND admission.intent_id=slot.id AND admission.generation=slot.generation AND state_name='ENDED' AND pe IS NOT NULL AND pe<=clock_timestamp() THEN
  INSERT INTO lyraseo_billing.retirement(provider,merchant_id,resource_id,intent_id,source_version,snapshot_hash) VALUES(b.provider,b.merchant_id,b.resource_id,admission.intent_id,sv,sh) ON CONFLICT DO NOTHING;
  DELETE FROM lyraseo_billing.base_slot WHERE id=admission.intent_id AND resource_id=b.resource_id AND generation=admission.generation;
 ELSIF admission.intent_id=slot.id AND state_name IN('PENDING','ACTIVE','PAST_DUE','CANCEL_AT_PERIOD_END','DISPUTED') THEN UPDATE lyraseo_billing.base_slot SET state=state_name WHERE id=slot.id; END IF;
 UPDATE lyraseo_billing.inbox SET state=CASE WHEN reason IN('FROZEN_PRICE_CONFLICT','BASE_SLOT_CONFLICT','RETIRED_SUBSCRIPTION_CONFLICT') THEN 'CONFLICT' ELSE 'DONE' END,completed_at=clock_timestamp(),token=NULL,lease_until=NULL,last_error=CASE WHEN reason='CANONICAL_FIXTURE' THEN NULL ELSE reason END WHERE id=j.id;
 RETURN jsonb_build_object('state',state_name,'sandboxEntitled',entitled,'productionEntitled',false,'reason',reason);
END $$;
CREATE FUNCTION lyraseo_billing.owner_status(a jsonb,workspace text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE acc lyraseo_billing.account; rows jsonb; BEGIN
 IF session_user<>'lyraseo_runtime' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=workspace FOR SHARE;
 PERFORM lyraseo_billing.actor_valid(a,false);
 IF NOT EXISTS(SELECT FROM public."Workspace" w JOIN public."Membership" m ON m."workspaceId"=w.id WHERE w.id=workspace AND w."deletedAt" IS NULL AND m."userId"=a->>'userId' AND m.role='OWNER') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO acc FROM lyraseo_billing.account WHERE workspace_id=workspace;
 SELECT coalesce(jsonb_agg(jsonb_build_object('provider',s.provider,'state',s.state,'periodEnd',s.period_end,'sandboxEntitled',s.sandbox_entitled,'productionEntitled',false,'reconciledAt',s.reconciled_at)),'[]') INTO rows FROM lyraseo_billing.subscription s WHERE s.account_id=acc.id;
 RETURN jsonb_build_object('mode','SANDBOX','pilotAccess','FREE','checkoutAvailable',false,'productionEntitled',false,'subscriptions',rows,'pendingIntent',EXISTS(SELECT FROM lyraseo_billing.base_slot WHERE account_id=acc.id AND state='PENDING'));
END $$;
CREATE FUNCTION lyraseo_billing.rate_staff(p_user text,p_kind text,p_ceiling integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE amount integer; BEGIN
 INSERT INTO lyraseo_billing.staff_rate(user_id,kind,window_start,count) VALUES(p_user,p_kind,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(user_id,kind,window_start) DO UPDATE SET count=staff_rate.count+1 RETURNING count INTO amount;
 IF amount>p_ceiling THEN RAISE EXCEPTION 'STAFF_RATE_LIMITED'; END IF;
 DELETE FROM lyraseo_billing.staff_rate WHERE window_start<clock_timestamp()-interval '10 minutes' AND staff_rate.user_id=p_user;
END $$;
CREATE FUNCTION lyraseo_billing.staff_view(a jsonb,view_name text,cursor_id text DEFAULT NULL,page_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE rows jsonb; privacy_result jsonb; BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true);
 PERFORM lyraseo_billing.rate_staff(a->>'userId','read',60);
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 25 OR (cursor_id IS NOT NULL AND cursor_id!~'^[A-Za-z0-9_-]{3,128}$') THEN RAISE EXCEPTION 'INVALID_SUPPORT_QUERY'; END IF;
 IF view_name='billing' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT a.id AS account_id,a.workspace_id,coalesce(s.provider,slot.provider) AS provider,coalesce(s.state,slot.state,'NONE') AS state,s.native_state,coalesce(s.sandbox_entitled,false) AS sandbox_entitled,false AS production_entitled,s.reconciled_at,s.period_end,i.state AS reconciliation_state,i.last_error,(SELECT count(*) FROM lyraseo_billing.subscription WHERE account_id=a.id AND state IN('ACTIVE','CANCEL_AT_PERIOD_END','DISPUTED')) AS observed_open_subscriptions FROM lyraseo_billing.account a LEFT JOIN lyraseo_billing.base_slot slot ON slot.account_id=a.id LEFT JOIN LATERAL (SELECT * FROM lyraseo_billing.subscription WHERE account_id=a.id ORDER BY reconciled_at DESC,resource_id LIMIT 1) s ON true LEFT JOIN lyraseo_billing.inbox i ON i.provider=s.provider AND i.merchant_id=s.merchant_id AND i.resource_id=s.resource_id WHERE cursor_id IS NULL OR a.id>cursor_id::uuid ORDER BY a.id,s.provider LIMIT page_limit) x;
 ELSIF view_name='jobs' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT id,provider,state,generation,fence,attempts,next_at,last_error,completed_at FROM lyraseo_billing.inbox WHERE cursor_id IS NULL OR id>cursor_id::uuid ORDER BY id LIMIT page_limit) x;
 ELSIF view_name='deliveries' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT e.id,e.provider,e.event_type,d.state,d.attempts,d.next_at,d.last_error FROM lyraseo_billing.discovery d JOIN lyraseo_billing.event e ON e.id=d.event_id WHERE cursor_id IS NULL OR e.id>cursor_id::uuid ORDER BY e.id LIMIT page_limit) x;
 ELSIF view_name='operations' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT id,kind,status,provider,"attemptState" AS provider_attempt_state,fence,"leaseUntil" AS lease_until,"createdAt" AS created_at,"cancelRequestedAt" AS cancel_requested_at FROM public."Operation" WHERE cursor_id IS NULL OR id>cursor_id ORDER BY id LIMIT page_limit) x;
 ELSIF view_name='usage' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT id,"userId" AS user_id,period,bucket,"limit"::text AS limit,spent::text AS spent,reserved::text AS reserved,greatest("limit"-spent-reserved,0)::text AS available FROM public."BudgetPeriod" WHERE cursor_id IS NULL OR id>cursor_id ORDER BY id LIMIT page_limit) x;
 ELSIF view_name='privacy' THEN
 PERFORM lyraseo_billing.actor_valid(a,true,'privacy:read',true);
 IF to_regprocedure('lyraseo_deletion.staff_projection(text,integer,text,text,integer,uuid)') IS NULL THEN
  privacy_result:=jsonb_build_object('available',false,'profile','UNQUALIFIED','rows','[]'::jsonb,'allCopiesErased',false,'nextCursor',NULL);
 ELSE
  privacy_result:=lyraseo_deletion.staff_projection(a->>'userId',(a->>'securityVersion')::integer,NULL,NULL,page_limit,cursor_id::uuid);
 END IF;
 rows:=privacy_result->'rows';
 ELSIF view_name='recovery' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT id,subject_id,workspace_id,state,revision,accepted_at,hold_until,decision_at,provider_state,created_at,(state='HOLD' AND hold_until<=clock_timestamp() AND accepted_by<>a->>'userId') AS can_approve FROM lyraseo_billing.recovery_case WHERE cursor_id IS NULL OR id>cursor_id::uuid ORDER BY id LIMIT page_limit) x;
 ELSIF view_name='audit' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT id,staff_id,action,target,outcome,reason,created_at FROM lyraseo_billing.staff_receipt WHERE cursor_id IS NULL OR id>cursor_id::uuid ORDER BY id LIMIT page_limit) x;
 ELSIF view_name='controls' THEN
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT p.key,p.enabled,p.revision,p."changedAt",i.id AS requested_intent,i.state AS requested_state,i.effective_revision FROM public."RuntimePolicy" p LEFT JOIN LATERAL (SELECT id,state,effective_revision FROM lyraseo_billing.policy_intent WHERE policy_key=p.key ORDER BY created_at DESC,id DESC LIMIT 1) i ON true ORDER BY p.key) x;
 ELSE RAISE EXCEPTION 'INVALID_SUPPORT_VIEW'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true);
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(a->>'userId','read:'||view_name,NULL,'ALLOWED','BOUNDED_SUPPORT_READ');
 RETURN jsonb_build_object('actionContextId',encode(sha256(convert_to(jsonb_build_array(a->>'userId',a->>'sessionId',a->>'securityVersion')::text,'UTF8')),'hex'),'actionPrincipalId',encode(sha256(convert_to(a->>'userId','UTF8')),'hex'),'pendingRequests',lyraseo_billing.pending_requests(a),'pauseExecution','UNAVAILABLE','mode','SANDBOX','recoveryMode','LOCAL_REHEARSAL','available',coalesce((privacy_result->>'available')::boolean,true),'profile',privacy_result->>'profile','allCopiesErased',false,'rows',rows,'limit',page_limit,'nextCursor',CASE WHEN view_name='privacy' THEN privacy_result->>'nextCursor' WHEN view_name<>'controls' AND jsonb_array_length(rows)=page_limit THEN coalesce(rows->(page_limit-1)->>'id',rows->(page_limit-1)->>'account_id') ELSE NULL END,'productionCommerceEnabled',false,'permissions',(SELECT coalesce(jsonb_agg(action),'[]') FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND enabled));
END $$;
CREATE INDEX staff_support_user_prefix ON public."ProductUser"((id COLLATE "C"));
CREATE INDEX staff_support_workspace_prefix ON public."Workspace"((id COLLATE "C"));
CREATE INDEX staff_support_site_prefix ON public."Site"((id COLLATE "C"));
CREATE FUNCTION lyraseo_billing.staff_search(a jsonb,query_text text,match_kind text,cursor_kind text,cursor_id text,page_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE term text:=btrim(query_text); rows jsonb; last_row jsonb; BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,'support:search',true);
 PERFORM lyraseo_billing.rate_staff(a->>'userId','search',10);
 IF match_kind IS NULL OR match_kind NOT IN('EXACT','PREFIX') OR term IS NULL OR term!~'^[A-Za-z0-9_-]{8,128}$' OR (match_kind='PREFIX' AND length(term)<12) OR page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 25 OR (cursor_kind IS NULL)<>(cursor_id IS NULL) OR (cursor_kind IS NOT NULL AND cursor_kind NOT IN('SITE','USER','WORKSPACE')) OR (cursor_id IS NOT NULL AND cursor_id!~'^[A-Za-z0-9_-]{1,128}$') THEN RAISE EXCEPTION 'INVALID_SUPPORT_QUERY'; END IF;
 -- Literal ASCII prefix: range uses explicit C indexes, left equality treats _/% as data, never patterns.
 WITH candidates AS (
  (SELECT 'USER'::text AS kind,u.id,NULL::text AS workspace_id,u.suspended,NULL::boolean AS verified,false AS tombstoned FROM public."ProductUser" u WHERE ((match_kind='EXACT' AND u.id=term) OR (match_kind='PREFIX' AND u.id COLLATE "C">=term COLLATE "C" AND u.id COLLATE "C"<(term||chr(127)) COLLATE "C" AND left(u.id,length(term))=term)) AND (cursor_kind IS NULL OR ('USER' COLLATE "C",u.id COLLATE "C")>(cursor_kind COLLATE "C",cursor_id COLLATE "C")) ORDER BY u.id COLLATE "C" LIMIT 25)
  UNION ALL
  (SELECT 'WORKSPACE',w.id,NULL::text,NULL::boolean,NULL::boolean,w."deletedAt" IS NOT NULL FROM public."Workspace" w WHERE ((match_kind='EXACT' AND w.id=term) OR (match_kind='PREFIX' AND w.id COLLATE "C">=term COLLATE "C" AND w.id COLLATE "C"<(term||chr(127)) COLLATE "C" AND left(w.id,length(term))=term)) AND (cursor_kind IS NULL OR ('WORKSPACE' COLLATE "C",w.id COLLATE "C")>(cursor_kind COLLATE "C",cursor_id COLLATE "C")) ORDER BY w.id COLLATE "C" LIMIT 25)
  UNION ALL
  (SELECT 'SITE',s.id,s."workspaceId",NULL::boolean,s."verifiedAt" IS NOT NULL,s."deletedAt" IS NOT NULL FROM public."Site" s WHERE ((match_kind='EXACT' AND s.id=term) OR (match_kind='PREFIX' AND s.id COLLATE "C">=term COLLATE "C" AND s.id COLLATE "C"<(term||chr(127)) COLLATE "C" AND left(s.id,length(term))=term)) AND (cursor_kind IS NULL OR ('SITE' COLLATE "C",s.id COLLATE "C")>(cursor_kind COLLATE "C",cursor_id COLLATE "C")) ORDER BY s.id COLLATE "C" LIMIT 25)
 ), bounded AS (SELECT * FROM candidates WHERE cursor_kind IS NULL OR (kind COLLATE "C",id COLLATE "C")>(cursor_kind COLLATE "C",cursor_id COLLATE "C") ORDER BY kind COLLATE "C",id COLLATE "C" LIMIT page_limit)
 SELECT coalesce(jsonb_agg(to_jsonb(bounded) ORDER BY kind COLLATE "C",id COLLATE "C"),'[]') INTO rows FROM bounded;
 PERFORM lyraseo_billing.actor_valid(a,true,'support:search',true);
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(a->>'userId','read:support-search',NULL,'ALLOWED','BOUNDED_OPAQUE_IDENTIFIER_SEARCH');
 last_row:=CASE WHEN jsonb_array_length(rows)=page_limit THEN rows->(page_limit-1) ELSE NULL END;
 RETURN jsonb_build_object('actionContextId',encode(sha256(convert_to(jsonb_build_array(a->>'userId',a->>'sessionId',a->>'securityVersion')::text,'UTF8')),'hex'),'actionPrincipalId',encode(sha256(convert_to(a->>'userId','UTF8')),'hex'),'pendingRequests',lyraseo_billing.pending_requests(a),'pauseExecution','UNAVAILABLE','mode','SANDBOX','recoveryMode','LOCAL_REHEARSAL','rows',rows,'limit',page_limit,'productionCommerceEnabled',false,'nextKind',last_row->>'kind','nextId',last_row->>'id','permissions',(SELECT coalesce(jsonb_agg(action),'[]') FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND enabled),'nextCursor',NULL);
END $$;
CREATE FUNCTION lyraseo_billing.staff_denied(a jsonb,action_name text,target_id text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true);
 PERFORM lyraseo_billing.rate_staff(a->>'userId','denied',20);
 IF action_name NOT IN('billing:reconcile','policy:pause','recovery:open','recovery:hold','recovery:approve','recovery:deny','recovery:complete') OR target_id!~'^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(a->>'userId',action_name,target_id,'DENIED','ACTION_REJECTED');
END $$;
CREATE FUNCTION lyraseo_billing.issue_step_up(a jsonb,action_name text,target_id text,token text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE cap text; BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 cap:=CASE WHEN action_name LIKE 'recovery:%' THEN 'recovery:manage' ELSE action_name END;
 IF action_name NOT IN('billing:reconcile','policy:pause','recovery:open','recovery:hold','recovery:approve','recovery:deny','recovery:complete') OR length(target_id) NOT BETWEEN 1 AND 128 OR length(token) NOT BETWEEN 16 AND 256 THEN RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(a->>'userId',93371));
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 IF EXISTS(SELECT FROM lyraseo_billing.action_request q JOIN lyraseo_billing.request_resolution x ON x.request_id=q.id WHERE q.user_id=a->>'userId' AND x.state IN('OPEN','COMMITTED')) THEN RAISE EXCEPTION 'UNRESOLVED_STAFF_REQUEST'; END IF;
 PERFORM lyraseo_billing.rate_staff(a->>'userId','step-up',20);
 INSERT INTO lyraseo_billing.step_up(token_hash,user_id,session_id,security_version,action,target,grant_revision,capability_revision,authenticated_at,mfa_at,expires_at) VALUES(encode(sha256(convert_to(token,'UTF8')),'hex'),a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer,action_name,target_id,(SELECT revision FROM lyraseo_billing.staff_epoch WHERE user_id=a->>'userId'),(SELECT revision FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND action=cap),(a->>'authenticatedAt')::timestamptz,(a->>'mfaAuthenticatedAt')::timestamptz,clock_timestamp()+interval '10 minutes');
END $$;
CREATE FUNCTION lyraseo_billing.perform_action(a jsonb,action_name text,target_id text,token_hash_ text,args_text text,reason_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE cap text; args jsonb:=args_text::jsonb; grant_row lyraseo_billing.step_up; r lyraseo_billing.recovery_case; p lyraseo_billing.policy_intent; action_result jsonb; before_state jsonb; BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 IF length(reason_text) NOT BETWEEN 12 AND 500 OR length(args_text)>2048 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
 cap:=CASE WHEN action_name LIKE 'recovery:%' THEN 'recovery:manage' ELSE action_name END;
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 SELECT * INTO grant_row FROM lyraseo_billing.step_up WHERE token_hash=token_hash_ FOR UPDATE;
 IF NOT FOUND OR grant_row.user_id<>a->>'userId' OR grant_row.session_id<>a->>'sessionId' OR grant_row.security_version<>(a->>'securityVersion')::integer OR grant_row.action<>action_name OR grant_row.target<>target_id THEN RAISE EXCEPTION 'STEP_UP_REQUIRED'; END IF;
 IF grant_row.grant_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_epoch WHERE user_id=a->>'userId') OR grant_row.capability_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND action=cap) THEN RAISE EXCEPTION 'STAFF_AUTHORITY_CHANGED'; END IF;
 IF grant_row.consumed_at IS NOT NULL THEN IF grant_row.request_hash IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_array(args,reason_text)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; PERFORM lyraseo_billing.rate_staff(a->>'userId','action-replay',20); INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason,new_state) VALUES(a->>'userId',action_name,target_id,'REPLAY','IDEMPOTENT_STAFF_RETRY',grant_row.result); RETURN grant_row.result; END IF;
 IF grant_row.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'STEP_UP_REQUIRED'; END IF;
 IF action_name='policy:pause' THEN
  IF target_id NOT IN('global','audits','context','search','analytics','content','visibility','mcp') THEN RAISE EXCEPTION 'INVALID_POLICY'; END IF;
  INSERT INTO lyraseo_billing.policy_intent(staff_id,actor,policy_key,expected_revision,grant_revision,capability_revision,reason,expires_at) VALUES(a->>'userId',a,target_id,(args->>'expectedRevision')::integer,grant_row.grant_revision,grant_row.capability_revision,reason_text,least(grant_row.expires_at,clock_timestamp()+interval '2 minutes')) RETURNING * INTO p;
  action_result:=jsonb_build_object('id',p.id,'state','PENDING','effective',false,'resumeAvailable',false);
 ELSIF action_name='billing:reconcile' THEN
  UPDATE lyraseo_billing.inbox SET generation=generation+1,state='PENDING',token=NULL,lease_until=NULL,next_at=clock_timestamp(),attempts=0 WHERE id=target_id::uuid RETURNING jsonb_build_object('id',id,'state',state,'generation',generation) INTO action_result;
  IF action_result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 ELSIF action_name='recovery:open' THEN
  IF NOT EXISTS(SELECT FROM public."ProductUser" WHERE id=target_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  INSERT INTO lyraseo_billing.recovery_case(subject_id,workspace_id,opened_by,reason) VALUES(target_id,args->>'workspaceId',a->>'userId',reason_text) RETURNING * INTO r;
  action_result:=jsonb_build_object('id',r.id,'state',r.state,'revision',r.revision,'providerState',r.provider_state,'mode','LOCAL_REHEARSAL');
 ELSIF action_name LIKE 'recovery:%' THEN
  SELECT * INTO r FROM lyraseo_billing.recovery_case WHERE id=target_id::uuid FOR UPDATE;
  IF NOT FOUND OR args->>'expectedRevision' IS NULL OR r.revision<>(args->>'expectedRevision')::integer THEN RAISE EXCEPTION 'RECOVERY_CONFLICT'; END IF;
  before_state:=jsonb_build_object('state',r.state,'revision',r.revision);
  IF action_name='recovery:hold' THEN
   IF r.state<>'VERIFYING' OR coalesce(args->>'evidenceHash','')!~'^[a-f0-9]{64}$' OR coalesce(args->>'noticeReceiptHash','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'RECOVERY_EVIDENCE_REQUIRED'; END IF;
   UPDATE lyraseo_billing.recovery_case SET state='HOLD',evidence_hash=args->>'evidenceHash',notice_receipt_hash=args->>'noticeReceiptHash',accepted_by=a->>'userId',accepted_at=clock_timestamp(),hold_until=clock_timestamp()+interval '72 hours',revision=revision+1,reason=reason_text WHERE id=r.id RETURNING * INTO r;
  ELSIF action_name='recovery:approve' THEN
   IF r.state<>'HOLD' OR r.hold_until>clock_timestamp() THEN RAISE EXCEPTION 'RECOVERY_HOLD_ACTIVE'; END IF;
   IF r.accepted_by=a->>'userId' THEN RAISE EXCEPTION 'INDEPENDENT_RECOVERY_DECISION_REQUIRED'; END IF;
   UPDATE lyraseo_billing.recovery_case SET state='APPROVED',decision_by=a->>'userId',decision_at=clock_timestamp(),revision=revision+1,reason=reason_text WHERE id=r.id RETURNING * INTO r;
  ELSIF action_name='recovery:deny' THEN
   IF r.state NOT IN('VERIFYING','HOLD') THEN RAISE EXCEPTION 'RECOVERY_CONFLICT'; END IF;
   UPDATE lyraseo_billing.recovery_case SET state='DENIED',decision_by=a->>'userId',decision_at=clock_timestamp(),revision=revision+1,reason=reason_text WHERE id=r.id RETURNING * INTO r;
  ELSIF action_name='recovery:complete' THEN RAISE EXCEPTION 'RECOVERY_PROVIDER_UNAVAILABLE';
  ELSE RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
  action_result:=jsonb_build_object('id',r.id,'state',r.state,'revision',r.revision,'holdUntil',r.hold_until,'providerState',r.provider_state,'mode','LOCAL_REHEARSAL');
 ELSE RAISE EXCEPTION 'INVALID_STAFF_ACTION'; END IF;
 -- Authoritative time after all lock waits. A stale session/factor/grant cannot commit an action.
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 IF grant_row.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'STEP_UP_REQUIRED'; END IF;
 UPDATE lyraseo_billing.step_up SET consumed_at=clock_timestamp(),request_hash=encode(sha256(convert_to(jsonb_build_array(args,reason_text)::text,'UTF8')),'hex'),result=action_result WHERE token_hash=grant_row.token_hash;
 INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason,old_state,new_state) VALUES(a->>'userId',action_name,target_id,'ALLOWED',reason_text,before_state,action_result);
 RETURN action_result;
END $$;
CREATE FUNCTION lyraseo_billing.staff_action(a jsonb,action_name text,target_id text,token text,args_text text,reason_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r lyraseo_billing.action_request;cap text;h text;fp text;request_id_ uuid;outcome jsonb; BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED';END IF;
 cap:=CASE WHEN action_name LIKE 'recovery:%' THEN 'recovery:manage' ELSE action_name END;
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(a->>'userId',93371));
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 h:=encode(sha256(convert_to(token,'UTF8')),'hex');
 fp:=encode(sha256(convert_to(jsonb_build_array(action_name,target_id,args_text::jsonb,reason_text)::text,'UTF8')),'hex');
 SELECT * INTO r FROM lyraseo_billing.action_request WHERE token_hash=h;
 IF FOUND THEN
  IF r.user_id IS DISTINCT FROM a->>'userId' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  IF r.request_hash<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  request_id_:=r.id;
 ELSE
  IF EXISTS(SELECT FROM lyraseo_billing.action_request q JOIN lyraseo_billing.request_resolution x ON x.request_id=q.id WHERE q.user_id=a->>'userId' AND x.state IN('OPEN','COMMITTED')) THEN RAISE EXCEPTION 'UNRESOLVED_STAFF_REQUEST';END IF;
  IF NOT EXISTS(SELECT FROM lyraseo_billing.step_up g WHERE g.token_hash=h AND g.user_id=a->>'userId' AND g.session_id=a->>'sessionId' AND g.security_version=(a->>'securityVersion')::integer AND g.action=action_name AND g.target=target_id AND g.consumed_at IS NULL AND g.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'STEP_UP_REQUIRED';END IF;
  -- The unique full token hash identifies retries. Allocate its public handle once.
  request_id_:=gen_random_uuid();
  INSERT INTO lyraseo_billing.action_request VALUES(request_id_,a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer,action_name,target_id,args_text,reason_text,fp,h,clock_timestamp());
  INSERT INTO lyraseo_billing.request_resolution(request_id) VALUES(request_id_);
 END IF;
 outcome:=lyraseo_billing.execute_request(a,request_id_);
 -- Preserve the legacy success payload. Unconsumed requests need their resolution state.
 IF outcome->>'requestState' IN('COMMITTED','ACKNOWLEDGED') THEN RETURN outcome-'requestState'; END IF;
 RETURN outcome;
END $$;
CREATE FUNCTION lyraseo_billing.request_result(a jsonb,request_id uuid,choice text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
<<request_result>>
DECLARE r lyraseo_billing.action_request; x lyraseo_billing.request_resolution; g lyraseo_billing.step_up; cap text; h text; BEGIN
 SELECT * INTO r FROM lyraseo_billing.action_request WHERE id=request_id;
 IF NOT FOUND OR r.user_id IS DISTINCT FROM a->>'userId' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 cap:=CASE WHEN r.action LIKE 'recovery:%' THEN 'recovery:manage' ELSE r.action END;
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 SELECT * INTO x FROM lyraseo_billing.request_resolution WHERE request_resolution.request_id=request_result.request_id FOR UPDATE;
 SELECT * INTO g FROM lyraseo_billing.step_up WHERE token_hash=r.token_hash FOR UPDATE;
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 IF g.consumed_at IS NOT NULL AND x.state='OPEN' THEN UPDATE lyraseo_billing.request_resolution SET state='COMMITTED' WHERE request_resolution.request_id=request_result.request_id RETURNING * INTO x; END IF;
 IF x.state IN('COMMITTED','ACKNOWLEDGED') THEN
  h:=encode(sha256(convert_to(g.result::text,'UTF8')),'hex');
  IF choice<>'ACK' THEN INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason,new_state) VALUES(a->>'userId',r.action,r.target,'REPLAY','SAME_PRINCIPAL_REQUEST_RESULT',g.result);END IF;
  RETURN jsonb_build_object('requestId',r.id,'requestState',x.state,'committed',true,'canAbandon',false,'result',g.result,'resultHash',h);
 END IF;
 IF x.state='ABANDONED' THEN RETURN jsonb_build_object('requestId',r.id,'requestState','ABANDONED','committed',false,'canAbandon',false); END IF;
 IF choice='ABANDON' THEN
  UPDATE lyraseo_billing.request_resolution SET state='ABANDONED',resolved_at=clock_timestamp() WHERE request_resolution.request_id=request_result.request_id;
  UPDATE lyraseo_billing.step_up SET expires_at=least(expires_at,clock_timestamp()) WHERE token_hash=r.token_hash;
  INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(a->>'userId',r.action,r.target,'ABANDONED','LOCKED_UNCONSUMED_REQUEST');
  RETURN jsonb_build_object('requestId',r.id,'requestState','ABANDONED','committed',false,'canAbandon',false);
 END IF;
 RETURN jsonb_build_object('requestId',r.id,'requestState',CASE WHEN g.expires_at<=clock_timestamp() THEN 'AUTHORIZATION_EXPIRED' WHEN (r.session_id,r.security_version) IS DISTINCT FROM (a->>'sessionId',(a->>'securityVersion')::integer) THEN 'REAUTHORIZATION_REQUIRED' WHEN x.last_error IS NOT NULL THEN 'REJECTED' ELSE 'PREPARED' END,'committed',false,'canAbandon',true,'reason',x.last_error);
END $$;
CREATE FUNCTION lyraseo_billing.resolve_request(a jsonb,request_id uuid,choice text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF session_user<>'lyraseo_staff_executor' OR choice IS NULL OR choice NOT IN('STATUS','ABANDON') THEN RAISE EXCEPTION 'UNAUTHORIZED';END IF;
 RETURN lyraseo_billing.request_result(a,request_id,choice);
END $$;
CREATE FUNCTION lyraseo_billing.ack_request(a jsonb,request_id uuid,result_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
<<ack_request>>
DECLARE outcome jsonb; BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 outcome:=lyraseo_billing.request_result(a,request_id,'ACK');
 IF outcome->>'committed' IS DISTINCT FROM 'true' OR result_hash IS DISTINCT FROM outcome->>'resultHash' THEN RAISE EXCEPTION 'RESULT_ACKNOWLEDGEMENT_REQUIRED'; END IF;
 UPDATE lyraseo_billing.request_resolution SET state='ACKNOWLEDGED',resolved_at=clock_timestamp() WHERE request_resolution.request_id=ack_request.request_id AND state='COMMITTED';
 IF FOUND THEN INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(a->>'userId','request:ack',request_id::text,'ACKNOWLEDGED','EXACT_RESULT_OBSERVED'); END IF;
 RETURN jsonb_build_object('requestId',request_id,'requestState','ACKNOWLEDGED');
END $$;
CREATE FUNCTION lyraseo_billing.pending_requests(a jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb:='[]';r record;cap text; BEGIN
 FOR r IN SELECT q.*,x.state FROM lyraseo_billing.action_request q JOIN lyraseo_billing.request_resolution x ON x.request_id=q.id WHERE q.user_id=a->>'userId' AND x.state IN('OPEN','COMMITTED') ORDER BY q.created_at,q.id LIMIT 25 LOOP
  cap:=CASE WHEN r.action LIKE 'recovery:%' THEN 'recovery:manage' ELSE r.action END;
  IF EXISTS(SELECT FROM lyraseo_billing.staff_capability WHERE user_id=a->>'userId' AND action=cap AND enabled) THEN
   result:=result||jsonb_build_array(jsonb_build_object('requestId',r.id,'action',r.action,'target',r.target,'args',r.args_text::jsonb,'reason',r.reason,'requestState',r.state));
  ELSE result:=result||jsonb_build_array(jsonb_build_object('requestId',r.id,'requestState','PERMISSION_UNAVAILABLE'));END IF;
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION lyraseo_billing.prepare_request(a jsonb,request_id uuid,action_name text,target_id text,args_text text,reason_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r lyraseo_billing.action_request;token text:=gen_random_uuid()::text||gen_random_uuid()::text;cap text;fp text;state text; BEGIN
 IF session_user<>'lyraseo_staff_executor' OR request_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 cap:=CASE WHEN action_name LIKE 'recovery:%' THEN 'recovery:manage' ELSE action_name END;PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 fp:=encode(sha256(convert_to(jsonb_build_array(action_name,target_id,args_text::jsonb,reason_text)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(a->>'userId',93371));
 PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 SELECT * INTO r FROM lyraseo_billing.action_request WHERE id=request_id;
 IF FOUND THEN
  IF r.user_id IS DISTINCT FROM a->>'userId' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  IF r.request_hash<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  SELECT x.state INTO state FROM lyraseo_billing.request_resolution x WHERE x.request_id=r.id;
  RETURN jsonb_build_object('requestId',r.id,'state',CASE WHEN state='OPEN' THEN 'PREPARED' ELSE state END,'requiresResolution',(r.session_id,r.security_version) IS DISTINCT FROM (a->>'sessionId',(a->>'securityVersion')::integer));
 END IF;
 IF EXISTS(SELECT FROM lyraseo_billing.action_request q JOIN lyraseo_billing.request_resolution x ON x.request_id=q.id WHERE q.user_id=a->>'userId' AND x.state IN('OPEN','COMMITTED')) THEN RAISE EXCEPTION 'UNRESOLVED_STAFF_REQUEST'; END IF;
 PERFORM lyraseo_billing.issue_step_up(a,action_name,target_id,token);
 INSERT INTO lyraseo_billing.action_request VALUES(request_id,a->>'userId',a->>'sessionId',(a->>'securityVersion')::integer,action_name,target_id,args_text,reason_text,fp,encode(sha256(convert_to(token,'UTF8')),'hex'),clock_timestamp());
 INSERT INTO lyraseo_billing.request_resolution(request_id) VALUES(request_id);
 RETURN jsonb_build_object('requestId',request_id,'state','PREPARED','requiresResolution',false);
END $$;
CREATE FUNCTION lyraseo_billing.execute_request(a jsonb,request_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
<<execute_request>>
DECLARE r lyraseo_billing.action_request;x lyraseo_billing.request_resolution;g lyraseo_billing.step_up;cap text;outcome jsonb;resolution jsonb; BEGIN
 IF session_user<>'lyraseo_staff_executor' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 SELECT * INTO r FROM lyraseo_billing.action_request WHERE id=request_id;
 IF NOT FOUND OR r.user_id IS DISTINCT FROM a->>'userId' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 cap:=CASE WHEN r.action LIKE 'recovery:%' THEN 'recovery:manage' ELSE r.action END;PERFORM lyraseo_billing.actor_valid(a,true,cap,true);
 SELECT * INTO x FROM lyraseo_billing.request_resolution WHERE request_resolution.request_id=execute_request.request_id FOR UPDATE;
 SELECT * INTO g FROM lyraseo_billing.step_up WHERE token_hash=r.token_hash FOR UPDATE;
 resolution:=lyraseo_billing.request_result(a,request_id,'STATUS');
 IF resolution->>'committed'='true' THEN RETURN (resolution->'result')||jsonb_build_object('requestId',request_id,'requestState',resolution->>'requestState','resultHash',resolution->>'resultHash'); END IF;
 IF resolution->>'requestState'<>'PREPARED' THEN RETURN resolution; END IF;
 BEGIN
  outcome:=lyraseo_billing.perform_action(a,r.action,r.target,r.token_hash,r.args_text,r.reason);
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT IN('RECOVERY_CONFLICT','NOT_FOUND','STEP_UP_REQUIRED','STAFF_AUTHORITY_CHANGED') THEN RAISE; END IF;
  UPDATE lyraseo_billing.request_resolution SET last_error=CASE WHEN SQLERRM IN('RECOVERY_CONFLICT','NOT_FOUND') THEN 'TARGET_CONFLICT' ELSE 'AUTHORIZATION_CHANGED' END WHERE request_resolution.request_id=execute_request.request_id;
  RETURN lyraseo_billing.request_result(a,request_id,'STATUS');
 END;
 UPDATE lyraseo_billing.request_resolution SET state='COMMITTED',last_error=NULL WHERE request_resolution.request_id=execute_request.request_id;
 RETURN outcome||jsonb_build_object('requestId',request_id,'requestState','COMMITTED','resultHash',encode(sha256(convert_to(outcome::text,'UTF8')),'hex'));
END $$;
CREATE FUNCTION lyraseo_billing.execute_pause(intent_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p lyraseo_billing.policy_intent; BEGIN
 IF session_user<>'lyraseo_operator' THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
 SELECT * INTO p FROM lyraseo_billing.policy_intent WHERE id=intent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- ProductSession is cached history, not authoritative Supabase revocation/not_after.
 -- No current provider-proof issuer is qualified. Never call kernel.change_policy here.
 PERFORM lyraseo_billing.actor_valid(p.actor,true,'policy:pause',true);
 IF p.grant_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_epoch WHERE user_id=p.staff_id) OR p.capability_revision IS DISTINCT FROM (SELECT revision FROM lyraseo_billing.staff_capability WHERE user_id=p.staff_id AND action='policy:pause') THEN RAISE EXCEPTION 'STAFF_AUTHORITY_CHANGED'; END IF;
 SELECT * INTO p FROM lyraseo_billing.policy_intent WHERE id=intent_id FOR UPDATE;
 IF p.state='PENDING' THEN
  UPDATE lyraseo_billing.policy_intent SET state='UNAVAILABLE' WHERE id=p.id;
  INSERT INTO lyraseo_billing.staff_receipt(staff_id,action,target,outcome,reason) VALUES(p.staff_id,'policy:pause:unavailable',p.policy_key,'DENIED','AUTHORITATIVE_SESSION_REVALIDATION_UNAVAILABLE');
 END IF;
 RETURN jsonb_build_object('state','UNAVAILABLE','reason','AUTHORITATIVE_SESSION_REVALIDATION_UNAVAILABLE','effective',false);
END $$;

-- New tables stay owned by the installer, forced RLS; definer owns functions only.
DO $$ DECLARE t record; f record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='lyraseo_billing' LOOP
  EXECUTE format('ALTER TABLE lyraseo_billing.%I ENABLE ROW LEVEL SECURITY',t.tablename);
  EXECUTE format('ALTER TABLE lyraseo_billing.%I FORCE ROW LEVEL SECURITY',t.tablename);
  EXECUTE format('REVOKE ALL ON lyraseo_billing.%I FROM PUBLIC,lyraseo_runtime,lyraseo_billing_intake,lyraseo_billing_reconciler,lyraseo_staff_executor,lyraseo_operator',t.tablename);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON lyraseo_billing.%I TO lyraseo_billing_owner',t.tablename);
  EXECUTE format('CREATE POLICY billing_owner ON lyraseo_billing.%I TO lyraseo_billing_owner USING(true) WITH CHECK(true)',t.tablename);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lyraseo_billing' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.name);
  EXECUTE format('ALTER FUNCTION %s OWNER TO lyraseo_billing_owner',f.name);
 END LOOP;
END $$;
GRANT SELECT ON public."Operation",public."BudgetPeriod" TO lyraseo_billing_owner;
GRANT SELECT(id,"workspaceId","verifiedAt","deletedAt") ON public."Site" TO lyraseo_billing_owner;
CREATE POLICY billing_owner_read ON public."Site" FOR SELECT TO lyraseo_billing_owner USING(true);
CREATE POLICY billing_owner_read ON public."Operation" FOR SELECT TO lyraseo_billing_owner USING(true);
CREATE POLICY billing_owner_read ON public."BudgetPeriod" FOR SELECT TO lyraseo_billing_owner USING(true);
GRANT SELECT ON public."Workspace",public."ProductUser",public."StaffGrant",public."ProductSession",public."Membership",public."RuntimePolicy" TO lyraseo_billing_owner;
GRANT UPDATE(id) ON public."Workspace",public."ProductUser" TO lyraseo_billing_owner;
GRANT UPDATE("userId") ON public."StaffGrant" TO lyraseo_billing_owner;
GRANT UPDATE("sessionId") ON public."ProductSession" TO lyraseo_billing_owner;
GRANT UPDATE(key) ON public."RuntimePolicy" TO lyraseo_billing_owner;
CREATE POLICY billing_owner_read ON public."RuntimePolicy" FOR SELECT TO lyraseo_billing_owner USING(true);
CREATE POLICY billing_owner_lock ON public."RuntimePolicy" FOR UPDATE TO lyraseo_billing_owner USING(true) WITH CHECK(false);
CREATE POLICY billing_owner_read ON public."Workspace" FOR SELECT TO lyraseo_billing_owner USING(true);
CREATE POLICY billing_owner_lock ON public."Workspace" FOR UPDATE TO lyraseo_billing_owner USING(true) WITH CHECK(false);
CREATE POLICY billing_owner_read ON public."Membership" FOR SELECT TO lyraseo_billing_owner USING(true);
CREATE POLICY billing_owner_read ON public."ProductUser" FOR SELECT TO lyraseo_billing_owner USING(true);
CREATE POLICY billing_owner_read ON public."StaffGrant" FOR SELECT TO lyraseo_billing_owner USING(true);
CREATE POLICY billing_owner_lock ON public."StaffGrant" FOR UPDATE TO lyraseo_billing_owner USING(true) WITH CHECK(false);
CREATE POLICY billing_owner_lock ON public."ProductUser" FOR UPDATE TO lyraseo_billing_owner USING(true) WITH CHECK(false);
-- No UPDATE policies for user/staff/session; SELECT FOR SHARE needs UPDATE privilege but cannot change rows.
GRANT EXECUTE ON FUNCTION lyraseo_billing.owner_status(jsonb,text) TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_billing.reserve_slot(jsonb,text,text,text,text,text,text) TO lyraseo_runtime;
GRANT EXECUTE ON FUNCTION lyraseo_billing.record_event(jsonb) TO lyraseo_billing_intake;
GRANT EXECUTE ON FUNCTION lyraseo_billing.bind_subscription(uuid,text,text,text,text),lyraseo_billing.resolve_pending(uuid) TO lyraseo_billing_reconciler;
GRANT EXECUTE ON FUNCTION lyraseo_billing.claim(text,text,text),lyraseo_billing.apply_snapshot(uuid,integer,integer,uuid,jsonb),lyraseo_billing.defer(uuid,integer,integer,uuid,text) TO lyraseo_billing_reconciler;
GRANT EXECUTE ON FUNCTION lyraseo_billing.resolve_request(jsonb,uuid,text),lyraseo_billing.ack_request(jsonb,uuid,text) TO lyraseo_staff_executor;
GRANT EXECUTE ON FUNCTION lyraseo_billing.prepare_request(jsonb,uuid,text,text,text,text),lyraseo_billing.execute_request(jsonb,uuid) TO lyraseo_staff_executor;
GRANT EXECUTE ON FUNCTION lyraseo_billing.staff_search(jsonb,text,text,text,text,integer) TO lyraseo_staff_executor;
GRANT EXECUTE ON FUNCTION lyraseo_billing.staff_denied(jsonb,text,text) TO lyraseo_staff_executor;
GRANT EXECUTE ON FUNCTION lyraseo_billing.staff_view(jsonb,text,text,integer),lyraseo_billing.issue_step_up(jsonb,text,text,text),lyraseo_billing.staff_action(jsonb,text,text,text,text,text) TO lyraseo_staff_executor;
GRANT EXECUTE ON FUNCTION lyraseo_billing.execute_pause(uuid) TO lyraseo_operator;
GRANT USAGE ON SCHEMA lyraseo_kernel TO lyraseo_billing_owner;
-- No kernel policy-write grant: queued staff execution is unqualified/fail closed.
DO $$ BEGIN
 IF to_regprocedure('lyraseo_deletion.staff_projection(text,integer,text,text,integer,uuid)') IS NOT NULL THEN
  EXECUTE 'GRANT USAGE ON SCHEMA lyraseo_deletion TO lyraseo_billing_owner';
  EXECUTE 'GRANT EXECUTE ON FUNCTION lyraseo_deletion.staff_projection(text,integer,text,text,integer,uuid) TO lyraseo_billing_owner';
 END IF;
END $$;
COMMIT;
