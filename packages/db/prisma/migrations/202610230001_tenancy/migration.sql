-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER');

-- CreateTable
CREATE TABLE "ProductUser" (
    "id" TEXT NOT NULL,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderIdentity" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ProviderIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("workspaceId","userId")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteGrant" (
    "workspaceId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "SiteGrant_pkey" PRIMARY KEY ("workspaceId","siteId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderIdentity_provider_subject_key" ON "ProviderIdentity"("provider", "subject");

-- CreateIndex
CREATE INDEX "Site_workspaceId_createdAt_id_idx" ON "Site"("workspaceId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Site_workspaceId_id_key" ON "Site"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Site_workspaceId_origin_key" ON "Site"("workspaceId", "origin");

-- AddForeignKey
ALTER TABLE "ProviderIdentity" ADD CONSTRAINT "ProviderIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ProductUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ProductUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteGrant" ADD CONSTRAINT "SiteGrant_workspaceId_siteId_fkey" FOREIGN KEY ("workspaceId", "siteId") REFERENCES "Site"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteGrant" ADD CONSTRAINT "SiteGrant_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "Membership"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant context is transaction-local and supplied only after server authorization.
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON "Workspace" USING (id = current_setting('app.workspace_id', true)) WITH CHECK (id = current_setting('app.workspace_id', true));
ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_scope ON "Membership" USING ("workspaceId" = current_setting('app.workspace_id', true)) WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
ALTER TABLE "Site" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Site" FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON "Site" USING ("workspaceId" = current_setting('app.workspace_id', true)) WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
ALTER TABLE "SiteGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteGrant" FORCE ROW LEVEL SECURITY;
CREATE POLICY site_grant_scope ON "SiteGrant" USING ("workspaceId" = current_setting('app.workspace_id', true)) WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
REVOKE ALL ON "Workspace", "Membership", "Site", "SiteGrant", "ProductUser", "ProviderIdentity" FROM PUBLIC;
