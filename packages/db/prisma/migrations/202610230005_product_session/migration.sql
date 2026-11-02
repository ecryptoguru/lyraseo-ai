-- Server-only refresh history prevents a newly refreshed provider timestamp from
-- erasing an already-expired inactivity window. No tokens are stored here.
CREATE TABLE "ProductSession" ("sessionId" TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"securityVersion" INTEGER NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL,"refreshedAt" TIMESTAMP(3) NOT NULL);
REVOKE ALL ON "ProductSession" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON "ProductSession" FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON "ProductSession" FROM authenticated; END IF;
END $$;
