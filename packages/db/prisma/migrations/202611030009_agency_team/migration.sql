BEGIN;
ALTER TABLE public."Workspace" ADD COLUMN "accessRevision" integer NOT NULL DEFAULT 0 CHECK ("accessRevision">=0);
CREATE INDEX "SiteGrant_workspaceId_userId_siteId_idx" ON public."SiteGrant"("workspaceId","userId","siteId");
CREATE TABLE public."WorkspaceAccessEvent" (
 id text PRIMARY KEY,"workspaceId" text NOT NULL REFERENCES public."Workspace"(id) ON DELETE RESTRICT,
 "actorId" text NOT NULL,"action" text NOT NULL CHECK(action IN ('role','remove','grant','revoke','accept','invite','revoke-invitation')),
 "targetUserId" text,"siteId" text,"previousRole" text,"nextRole" text,
 "accessRevision" integer NOT NULL CHECK("accessRevision">0),"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("workspaceId","accessRevision")
);
CREATE INDEX "WorkspaceAccessEvent_workspaceId_createdAt_id_idx" ON public."WorkspaceAccessEvent"("workspaceId","createdAt",id);
ALTER TABLE public."WorkspaceAccessEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkspaceAccessEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON public."WorkspaceAccessEvent" USING("workspaceId"=current_setting('app.workspace_id',true)) WITH CHECK("workspaceId"=current_setting('app.workspace_id',true));
REVOKE ALL ON public."WorkspaceAccessEvent" FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public."WorkspaceAccessEvent" TO lyraseo_runtime;
ALTER TABLE public."PageJournal" ADD COLUMN "assigneeUserId" text;
ALTER TABLE public."PageJournal" DROP CONSTRAINT "PageJournal_action_check";
ALTER TABLE public."PageJournal" ADD CONSTRAINT "PageJournal_action_check" CHECK(action IN ('change','claim','unassign','assign','access-revoked'));
CREATE TABLE public."WorkspaceInvitation"(
 id text PRIMARY KEY,"workspaceId" text NOT NULL REFERENCES public."Workspace"(id) ON DELETE RESTRICT,
 "tokenHash" text NOT NULL UNIQUE CHECK(length("tokenHash")=64),"invitedEmailDigest" text NOT NULL CHECK(length("invitedEmailDigest")=64),
 role public."Role" NOT NULL CHECK(role IN ('EDITOR','VIEWER')),"createdBy" text NOT NULL REFERENCES public."ProductUser"(id),
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"expiresAt" timestamp(3) NOT NULL,
 "acceptedAt" timestamp(3),"acceptedBy" text REFERENCES public."ProductUser"(id),"revokedAt" timestamp(3),UNIQUE("workspaceId",id),
 CHECK("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '7 days'),
 CHECK(("acceptedAt" IS NULL)=("acceptedBy" IS NULL))
);
CREATE INDEX "WorkspaceInvitation_workspaceId_createdAt_id_idx" ON public."WorkspaceInvitation"("workspaceId","createdAt",id);
CREATE INDEX "WorkspaceInvitation_expiresAt_id_idx" ON public."WorkspaceInvitation"("expiresAt",id);
CREATE TABLE public."WorkspaceInvitationSite"(
 "workspaceId" text NOT NULL,"invitationId" text NOT NULL,"siteId" text NOT NULL,
 PRIMARY KEY("workspaceId","invitationId","siteId"),
 FOREIGN KEY("workspaceId","invitationId") REFERENCES public."WorkspaceInvitation"("workspaceId",id) ON DELETE CASCADE,
 FOREIGN KEY("workspaceId","siteId") REFERENCES public."Site"("workspaceId",id) ON DELETE RESTRICT
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['WorkspaceInvitation','WorkspaceInvitationSite'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workspace_scope ON public.%I USING("workspaceId"=current_setting(''app.workspace_id'',true)) WITH CHECK("workspaceId"=current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO lyraseo_runtime',t);
 END LOOP;
END $$;
GRANT UPDATE("acceptedAt","acceptedBy","revokedAt") ON public."WorkspaceInvitation" TO lyraseo_runtime;
CREATE TABLE public."IssueAssignment"(
 id text PRIMARY KEY,"workspaceId" text NOT NULL,"siteId" text NOT NULL,"auditId" text NOT NULL,
 "ruleId" text NOT NULL,"scopeKey" text NOT NULL,"assigneeUserId" text,"revision" integer NOT NULL CHECK(revision>0),"updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("workspaceId","siteId","auditId","ruleId","scopeKey"),UNIQUE("workspaceId","siteId",id),
 FOREIGN KEY("workspaceId","siteId","auditId") REFERENCES public."AuditRun"("workspaceId","siteId",id) ON DELETE RESTRICT
);
CREATE INDEX "IssueAssignment_workspaceId_siteId_updatedAt_id_idx" ON public."IssueAssignment"("workspaceId","siteId","updatedAt",id);
CREATE INDEX "IssueAssignment_workspaceId_siteId_assigneeUserId_updatedAt_id_idx" ON public."IssueAssignment"("workspaceId","siteId","assigneeUserId","updatedAt",id);
CREATE TABLE public."IssueAssignmentEvent"(
 id text PRIMARY KEY,"workspaceId" text NOT NULL,"siteId" text NOT NULL,"assignmentId" text NOT NULL,"revision" integer NOT NULL CHECK(revision>0),"actorId" text NOT NULL,"assigneeUserId" text,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "idempotencyKey" text NOT NULL,"inputHash" text NOT NULL,
 UNIQUE("assignmentId",revision),UNIQUE("workspaceId","siteId","actorId","idempotencyKey"),
 FOREIGN KEY("workspaceId","siteId","assignmentId") REFERENCES public."IssueAssignment"("workspaceId","siteId",id) ON DELETE RESTRICT
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['IssueAssignment','IssueAssignmentEvent'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workspace_scope ON public.%I USING("workspaceId"=current_setting(''app.workspace_id'',true)) WITH CHECK("workspaceId"=current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO lyraseo_runtime',t);
 END LOOP;
END $$;
GRANT UPDATE("revision","assigneeUserId","updatedAt") ON public."IssueAssignment" TO lyraseo_runtime;
CREATE TABLE public."WorkspaceBrandingRevision"(
 id text PRIMARY KEY,"workspaceId" text NOT NULL REFERENCES public."Workspace"(id) ON DELETE RESTRICT,revision integer NOT NULL CHECK(revision>0),
 "displayName" text NOT NULL CHECK(length("displayName")<=100 AND octet_length("displayName")<=400),
 "logoBytes" bytea,"logoSha256" text,mime text,width integer,height integer,"createdBy" text NOT NULL,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("workspaceId",revision),
 CHECK(("logoBytes" IS NULL AND "logoSha256" IS NULL AND mime IS NULL AND width IS NULL AND height IS NULL)
 OR ("logoBytes" IS NOT NULL AND "logoSha256" IS NOT NULL AND mime IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND octet_length("logoBytes")<=65536 AND length("logoSha256")=64 AND mime='image/png' AND width BETWEEN 1 AND 512 AND height BETWEEN 1 AND 256))
);
CREATE INDEX "WorkspaceBrandingRevision_workspaceId_createdAt_id_idx" ON public."WorkspaceBrandingRevision"("workspaceId","createdAt",id);
ALTER TABLE public."WorkspaceBrandingRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkspaceBrandingRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON public."WorkspaceBrandingRevision" USING("workspaceId"=current_setting('app.workspace_id',true)) WITH CHECK("workspaceId"=current_setting('app.workspace_id',true));
REVOKE ALL ON public."WorkspaceBrandingRevision" FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public."WorkspaceBrandingRevision" TO lyraseo_runtime;
ALTER TABLE public."OperationQuote" ADD CONSTRAINT "OperationQuote_workspaceId_siteId_userId_id_key" UNIQUE("workspaceId","siteId","userId",id);
CREATE TABLE public."AgencyBatchQuote"(
 id text PRIMARY KEY,"workspaceId" text NOT NULL REFERENCES public."Workspace"(id) ON DELETE RESTRICT,"userId" text NOT NULL REFERENCES public."ProductUser"(id) ON DELETE RESTRICT,"securityVersion" integer NOT NULL,
 "requestInput" jsonb NOT NULL,"inputHash" text NOT NULL,"confirmationHash" text NOT NULL,preview jsonb NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"expiresAt" timestamp(3) NOT NULL,"confirmedAt" timestamp(3),"confirmationKey" text,
 UNIQUE("workspaceId","userId",id),UNIQUE("workspaceId","userId","confirmationKey"),
 CHECK("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '5 minutes'),CHECK(("confirmedAt" IS NULL)=("confirmationKey" IS NULL))
);
CREATE INDEX "AgencyBatchQuote_userId_createdAt_id_idx" ON public."AgencyBatchQuote"("userId","createdAt",id);
CREATE INDEX "AgencyBatchQuote_expiresAt_id_idx" ON public."AgencyBatchQuote"("expiresAt",id);
CREATE TABLE public."AgencyBatchItem"(
 "batchQuoteId" text NOT NULL,"workspaceId" text NOT NULL,"userId" text NOT NULL,"siteId" text NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
 "quoteId" text,"operationId" text UNIQUE,status text NOT NULL CHECK(status IN ('QUOTED','UNAVAILABLE','PENDING','ADMITTED','REJECTED')),"errorCode" text,
 PRIMARY KEY("batchQuoteId",ordinal),UNIQUE("batchQuoteId","siteId"),
 FOREIGN KEY("workspaceId","userId","batchQuoteId") REFERENCES public."AgencyBatchQuote"("workspaceId","userId",id) ON DELETE RESTRICT,
 FOREIGN KEY("workspaceId","siteId") REFERENCES public."Site"("workspaceId",id) ON DELETE RESTRICT,
 FOREIGN KEY("workspaceId","siteId","userId","quoteId") REFERENCES public."OperationQuote"("workspaceId","siteId","userId",id) ON DELETE RESTRICT,
 FOREIGN KEY("workspaceId","siteId","userId","operationId") REFERENCES public."Operation"("workspaceId","siteId","userId",id) ON DELETE RESTRICT
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['AgencyBatchQuote','AgencyBatchItem'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY actor_scope ON public.%I USING("userId"=current_setting(''app.actor_id'',true)) WITH CHECK("userId"=current_setting(''app.actor_id'',true) AND "workspaceId"=current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO lyraseo_runtime',t);
 END LOOP;
END $$;
GRANT UPDATE("confirmedAt","confirmationKey") ON public."AgencyBatchQuote" TO lyraseo_runtime;
GRANT UPDATE("operationId",status,"errorCode") ON public."AgencyBatchItem" TO lyraseo_runtime;
COMMIT;
