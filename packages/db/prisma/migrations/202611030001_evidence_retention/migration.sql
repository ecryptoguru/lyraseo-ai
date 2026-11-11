BEGIN;
-- Original timestamp(3) columns store UTC wall time. Native month arithmetic clamps forward.
DO $$ DECLARE t text; anchor text;
BEGIN
  FOR t, anchor IN SELECT * FROM (VALUES
    ('AuditRun','"createdAt"'),('VisibilityRun','"createdAt"'),('SearchSnapshot','"importedAt"'),
    ('SearchImport','"startedAt"'),('AnalyticsImport','CASE WHEN status IN (''complete'',''partial'',''no_data'') THEN "importedAt" ELSE "startedAt" END')
  ) AS clocks(name, expression) LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN "resultExpiresAt" timestamp(3) GENERATED ALWAYS AS (%s + interval ''13 months'') STORED %s',t,anchor,CASE WHEN t='AnalyticsImport' THEN '' ELSE 'NOT NULL' END);
    EXECUTE format('CREATE INDEX %I ON public.%I ("workspaceId","siteId","resultExpiresAt")',t||'_workspaceId_siteId_resultExpiresAt_idx',t);
  END LOOP;
END $$;
ALTER TABLE "ContentDraft" ADD COLUMN "evidenceFormat" text CHECK ("evidenceFormat"='saved-evidence-v2');
ALTER TABLE "EvidenceReport" ADD COLUMN "evidenceFormat" text CHECK ("evidenceFormat"='saved-evidence-v2');
-- Drafts can advance their revision, but cannot promote a historical snapshot to reviewed.
CREATE FUNCTION lyraseo_audit.keep_evidence_format() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END $$;
CREATE TRIGGER immutable_draft_format BEFORE UPDATE OF "evidenceFormat" ON "ContentDraft"
FOR EACH ROW WHEN (OLD."evidenceFormat" IS DISTINCT FROM NEW."evidenceFormat") EXECUTE FUNCTION lyraseo_audit.keep_evidence_format();
REVOKE ALL ON FUNCTION lyraseo_audit.keep_evidence_format() FROM PUBLIC;

ALTER TABLE "AuditPage" ADD UNIQUE ("workspaceId","auditId",id);
CREATE TABLE "AuditPageRetention" (
  "pageId" text PRIMARY KEY, "workspaceId" text NOT NULL, "auditId" text NOT NULL,
  "capturedAt" timestamp(3), "rawExpiresAt" timestamp(3), "clockStatus" text NOT NULL,
  UNIQUE ("workspaceId","auditId","pageId"),
  FOREIGN KEY ("workspaceId","auditId","pageId") REFERENCES "AuditPage"("workspaceId","auditId",id) ON DELETE CASCADE,
  CHECK (("clockStatus"='known' AND "capturedAt" IS NOT NULL AND "rawExpiresAt" IS NOT NULL AND "rawExpiresAt"="capturedAt"+interval '30 days')
      OR ("clockStatus"='unknown' AND "capturedAt" IS NULL AND "rawExpiresAt" IS NULL))
);
CREATE INDEX "AuditPageRetention_workspaceId_auditId_rawExpiresAt_idx" ON "AuditPageRetention"("workspaceId","auditId","rawExpiresAt");

-- Accept ISO UTC receipt timestamps only. Invalid calendar dates and future receipts fail closed.
CREATE FUNCTION lyraseo_audit.capture_clock(value text, checkpoint timestamp) RETURNS timestamp
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE stamp timestamp;
BEGIN
  IF value IS NULL OR length(value)>35 OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' THEN RETURN NULL; END IF;
  stamp := (value::timestamptz AT TIME ZONE 'UTC');
  IF stamp > checkpoint OR stamp > clock_timestamp() AT TIME ZONE 'UTC' THEN RETURN NULL; END IF;
  RETURN stamp;
EXCEPTION WHEN data_exception THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lyraseo_audit.capture_clock(text,timestamp) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_audit.capture_clock(text,timestamp) TO lyraseo_kernel_owner;
INSERT INTO "AuditPageRetention" ("pageId","workspaceId","auditId","capturedAt","rawExpiresAt","clockStatus")
SELECT id,"workspaceId","auditId",stamp,stamp+interval '30 days',CASE WHEN stamp IS NULL THEN 'unknown' ELSE 'known' END
FROM (SELECT id,"workspaceId","auditId",lyraseo_audit.capture_clock(provenance->>'acquiredAt',"createdAt") AS stamp FROM "AuditPage" OFFSET 0) p;
CREATE FUNCTION lyraseo_audit.insert_capture_clock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE stamp timestamp;
BEGIN
  stamp := lyraseo_audit.capture_clock(NEW.provenance->>'acquiredAt',NEW."createdAt");
  INSERT INTO public."AuditPageRetention" ("pageId","workspaceId","auditId","capturedAt","rawExpiresAt","clockStatus")
  VALUES(NEW.id,NEW."workspaceId",NEW."auditId",stamp,stamp+interval '30 days',CASE WHEN stamp IS NULL THEN 'unknown' ELSE 'known' END);
  RETURN NULL;
END $$;
ALTER FUNCTION lyraseo_audit.insert_capture_clock() OWNER TO lyraseo_kernel_owner;
REVOKE ALL ON FUNCTION lyraseo_audit.insert_capture_clock() FROM PUBLIC;
CREATE TRIGGER audit_page_capture_clock AFTER INSERT ON "AuditPage" FOR EACH ROW EXECUTE FUNCTION lyraseo_audit.insert_capture_clock();
ALTER TABLE "AuditPageRetention" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditPageRetention" FORCE ROW LEVEL SECURITY;
CREATE POLICY capture_read ON "AuditPageRetention" FOR SELECT TO lyraseo_runtime USING ("workspaceId"=current_setting('app.workspace_id',true));
CREATE POLICY capture_write ON "AuditPageRetention" FOR INSERT TO lyraseo_kernel_owner WITH CHECK(true);
GRANT SELECT ON "AuditPageRetention" TO lyraseo_runtime;
GRANT INSERT ON "AuditPageRetention" TO lyraseo_kernel_owner;

ALTER TABLE "ContentRevision" ADD UNIQUE ("workspaceId","draftId",revision);
CREATE TABLE "ContentRevisionPin" (
  "workspaceId" text NOT NULL, "draftId" text NOT NULL, revision integer NOT NULL,
  "pinnedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "pinnedBy" text NOT NULL REFERENCES "ProductUser"(id),
  PRIMARY KEY ("workspaceId","draftId",revision),
  FOREIGN KEY ("workspaceId","draftId",revision) REFERENCES "ContentRevision"("workspaceId","draftId",revision) ON DELETE CASCADE
);
ALTER TABLE "ContentRevisionPin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentRevisionPin" FORCE ROW LEVEL SECURITY;
CREATE POLICY revision_pin ON "ContentRevisionPin" TO lyraseo_runtime
USING ("workspaceId"=current_setting('app.workspace_id',true))
WITH CHECK ("workspaceId"=current_setting('app.workspace_id',true) AND "pinnedBy"=current_setting('app.actor_id',true));
GRANT SELECT,INSERT,DELETE ON "ContentRevisionPin" TO lyraseo_runtime;
REVOKE ALL ON "ContentRevisionPin","AuditPageRetention" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','lyraseo_identity','lyraseo_dispatch'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON "ContentRevisionPin","AuditPageRetention" FROM %I',r); END IF;
END LOOP; END $$;

COMMIT;
