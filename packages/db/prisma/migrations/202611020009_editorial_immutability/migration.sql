-- Only the optimistic revision counter may change; original evidence and scope stay frozen.
CREATE FUNCTION protect_editorial_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."siteId" IS DISTINCT FROM OLD."siteId" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."revision" <> OLD."revision" + 1 THEN
RAISE EXCEPTION 'IMMUTABLE_EVIDENCE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_draft_evidence BEFORE UPDATE ON "ContentDraft" FOR EACH ROW EXECUTE FUNCTION protect_editorial_evidence();
