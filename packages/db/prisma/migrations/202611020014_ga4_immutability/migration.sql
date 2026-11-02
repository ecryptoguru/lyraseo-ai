-- Saved provider evidence is immutable. Disconnect/retention explicitly delete snapshots.
CREATE FUNCTION protect_analytics_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status IN ('complete','partial','no_data') THEN RAISE EXCEPTION 'Analytics evidence is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER analytics_evidence_immutable BEFORE UPDATE ON "AnalyticsImport" FOR EACH ROW EXECUTE FUNCTION protect_analytics_evidence();
