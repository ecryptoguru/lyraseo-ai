-- AlterTable
ALTER TABLE "ProductUser" ADD COLUMN     "securityVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StaffGrant" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "StaffGrant_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "StepUpGrant" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "StepUpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetPeriod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "limit" DECIMAL(20,9) NOT NULL,
    "spent" DECIMAL(20,9) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(20,9) NOT NULL DEFAULT 0,

    CONSTRAINT "BudgetPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "securityVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "tariffVersion" TEXT NOT NULL,
    "reservedCost" DECIMAL(20,9) NOT NULL,
    "actualCost" DECIMAL(20,9),
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelRequestedAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "fence" INTEGER NOT NULL DEFAULT 0,
    "attemptState" TEXT NOT NULL DEFAULT 'NONE',
    "providerTaskId" TEXT,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageReceipt" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "amount" DECIMAL(20,9) NOT NULL,
    "acceptedOutput" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StepUpGrant_tokenHash_key" ON "StepUpGrant"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPeriod_userId_period_bucket_key" ON "BudgetPeriod"("userId", "period", "bucket");

-- CreateIndex
CREATE INDEX "Operation_workspaceId_createdAt_id_idx" ON "Operation"("workspaceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Operation_status_leaseUntil_idx" ON "Operation"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_userId_workspaceId_route_idempotencyKey_key" ON "Operation"("userId", "workspaceId", "route", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_operationId_key" ON "OutboxEvent"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageReceipt_provider_receiptId_key" ON "UsageReceipt"("provider", "receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageReceipt_operationId_provider_key" ON "UsageReceipt"("operationId", "provider");

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_workspaceId_siteId_fkey" FOREIGN KEY ("workspaceId", "siteId") REFERENCES "Site"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ProductUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageReceipt" ADD CONSTRAINT "UsageReceipt_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['StaffGrant','StepUpGrant','BudgetPeriod','Operation','OutboxEvent','UsageReceipt'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY actor_scope ON %I USING ("userId" = current_setting(''app.actor_id'',true)) WITH CHECK ("userId" = current_setting(''app.actor_id'',true))',t);
 END LOOP;
END $$;
ALTER TABLE "BudgetPeriod" ADD CONSTRAINT positive_budget CHECK ("limit">=0 AND spent>=0 AND reserved>=0);
ALTER TABLE "Operation" ADD CONSTRAINT positive_cost CHECK ("reservedCost">=0 AND ("actualCost" IS NULL OR "actualCost">=0));
ALTER TABLE "Operation" ADD CONSTRAINT operation_status CHECK (status IN ('QUEUED','RUNNING','WAITING_PROVIDER','RECONCILING','COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED'));
ALTER TABLE "UsageReceipt" ADD CONSTRAINT positive_receipt CHECK (amount>=0);
REVOKE ALL ON "StaffGrant","StepUpGrant","BudgetPeriod","Operation","OutboxEvent","UsageReceipt" FROM PUBLIC;
DO $$ DECLARE r text; t text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   FOREACH t IN ARRAY ARRAY['ProductUser','ProviderIdentity','Workspace','Membership','Site','SiteGrant','StaffGrant','StepUpGrant','BudgetPeriod','Operation','OutboxEvent','UsageReceipt'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I',t,r);
   END LOOP;
  END IF;
 END LOOP;
END $$;
