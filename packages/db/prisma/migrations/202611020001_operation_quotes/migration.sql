CREATE TABLE "OperationQuote" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "siteId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "provider" TEXT NOT NULL, "route" TEXT NOT NULL, "inputHash" TEXT NOT NULL,
 "maximumCost" DECIMAL(20,9) NOT NULL CHECK ("maximumCost">0), "tariffVersion" TEXT NOT NULL,
 "securityVersion" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMP(3) NOT NULL, "consumedOperationId" TEXT UNIQUE,
 CONSTRAINT "OperationQuote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ProductUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "OperationQuote_workspaceId_siteId_fkey" FOREIGN KEY ("workspaceId","siteId") REFERENCES "Site"("workspaceId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "OperationQuote_consumedOperationId_fkey" FOREIGN KEY ("consumedOperationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT quote_deadline CHECK ("expiresAt">"createdAt")
);
CREATE INDEX "OperationQuote_userId_expiresAt_idx" ON "OperationQuote"("userId","expiresAt");
ALTER TABLE "OperationQuote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationQuote" FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_scope ON "OperationQuote" USING ("userId"=current_setting('app.actor_id',true)) WITH CHECK ("userId"=current_setting('app.actor_id',true));
REVOKE ALL ON "OperationQuote" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON "OperationQuote" FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON "OperationQuote" FROM authenticated; END IF;
END $$;
