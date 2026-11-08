BEGIN;
-- Row-lock privileges are limited to the no-login kernel owner. Restrictive
-- policies allow locking, but forbid that owner from changing these rows.
GRANT UPDATE("userId") ON public."Membership", public."SiteGrant" TO lyraseo_kernel_owner;
CREATE POLICY kernel_admission_lock ON public."Membership" AS RESTRICTIVE
 FOR UPDATE TO lyraseo_kernel_owner USING(true) WITH CHECK(false);
CREATE POLICY kernel_admission_lock ON public."SiteGrant" AS RESTRICTIVE
 FOR UPDATE TO lyraseo_kernel_owner USING(true) WITH CHECK(false);
-- Match the inline-writer trigger's Workspace SHARE -> Site UPDATE order.
-- Runtime callers cannot supply a different actor/workspace than their scope.
CREATE FUNCTION lyraseo_audit.web_guard_create(s text, epoch integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE w text := current_setting('app.workspace_id',true);
        u text := current_setting('app.actor_id',true);
        verified timestamp; actor_version integer; member_role text; has_grant boolean;
BEGIN
 IF session_user <> 'lyraseo_runtime' OR w IS NULL OR w='' OR u IS NULL OR u='' OR epoch IS NULL
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM public."Workspace" WHERE id=w FOR SHARE;
 SELECT "verifiedAt" INTO verified FROM public."Site" WHERE ("workspaceId",id)=(w,s) FOR UPDATE;
 SELECT "securityVersion" INTO actor_version FROM public."ProductUser" WHERE id=u AND NOT suspended FOR SHARE;
 SELECT role INTO member_role FROM public."Membership" WHERE ("workspaceId","userId")=(w,u) FOR SHARE;
 IF member_role='EDITOR' THEN
   SELECT true INTO has_grant FROM public."SiteGrant" WHERE ("workspaceId","siteId","userId")=(w,s,u) FOR SHARE;
 END IF;
 IF actor_version IS DISTINCT FROM epoch OR
    (member_role IS DISTINCT FROM 'OWNER' AND member_role IS DISTINCT FROM 'ADMIN'
     AND NOT (member_role='EDITOR' AND coalesce(has_grant,false))) OR
    NOT lyraseo_audit.run_site_permission(w,s,u)
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF verified IS NULL OR verified AT TIME ZONE 'UTC' NOT BETWEEN clock_timestamp()-interval '1 day' AND clock_timestamp()
 THEN RAISE EXCEPTION 'SITE_NOT_VERIFIED'; END IF;
 RETURN true;
END $$;
ALTER FUNCTION lyraseo_audit.web_guard_create(text,integer) OWNER TO lyraseo_kernel_owner;
REVOKE ALL ON FUNCTION lyraseo_audit.web_guard_create(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lyraseo_audit.web_guard_create(text,integer) TO lyraseo_runtime;
-- Guard direct INSERT as well as the ordinary service path. Locks acquired by
-- the guard are held until the transaction commits, fencing epoch changes.
CREATE POLICY web_admission_epoch ON public."AuditRun" AS RESTRICTIVE
 FOR INSERT TO lyraseo_runtime
 WITH CHECK(lyraseo_audit.web_guard_create("siteId","securityVersion"));
COMMIT;
