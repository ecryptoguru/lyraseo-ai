// One exact predicate is shared by local provisioning and its isolated gate.
export const LEGACY_VISIBILITY_ROLE_GUARD = `SELECT EXISTS(
    SELECT 1 FROM pg_roles r WHERE r.rolname='lyraseo_legacy_visibility_owner'
    AND (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    UNION ALL SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.member,m.roleid) WHERE r.rolname='lyraseo_legacy_visibility_owner'
    UNION ALL SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname='lyraseo_legacy_visibility_owner'
    UNION ALL SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='lyraseo_legacy_visibility_owner'
    UNION ALL SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE r.rolname='lyraseo_legacy_visibility_owner'
    UNION ALL SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE r.rolname='lyraseo_legacy_visibility_owner' AND (n.nspname<>'lyraseo_legacy_visibility' OR p.proname NOT IN ('hash_json','bounded_row','scope_id','enroll_scope','enroll_row','classify','guard_run','verify_transition','create_plan','execute_one','pause','preview','status','next_items','read_detail','read_projection'))
    UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
      WHERE r.rolname='lyraseo_legacy_visibility_owner' AND NOT (
        (n.nspname='public' AND c.relname IN ('Workspace','Site','VisibilityRun','VisibilityPanel') AND a.privilege_type='SELECT') OR
        (n.nspname='lyraseo_kernel' AND c.relname='test_environment' AND a.privilege_type='SELECT') OR
        (n.nspname='lyraseo_legacy_visibility' AND c.relname IN ('scope','enrollment','plan','item','retry','authorization','event') AND a.privilege_type IN ('SELECT','INSERT')) OR
        (n.nspname='lyraseo_legacy_visibility' AND c.relname='retry' AND a.privilege_type='DELETE') OR
        (n.nspname='lyraseo_legacy_visibility' AND c.relname='fixture_clock' AND a.privilege_type='SELECT'))
    UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute col ON col.attrelid=c.oid CROSS JOIN LATERAL aclexplode(col.attacl) a JOIN pg_roles r ON r.oid=a.grantee
      WHERE r.rolname='lyraseo_legacy_visibility_owner' AND NOT (
        (n.nspname='public' AND c.relname IN ('Workspace','Site') AND col.attname='id' AND a.privilege_type='UPDATE') OR
        (n.nspname='public' AND c.relname='VisibilityRun' AND col.attname='rawAnswers' AND a.privilege_type='UPDATE') OR
        (n.nspname='public' AND c.relname='ProductUser' AND ((col.attname IN ('id','securityVersion','suspended') AND a.privilege_type='SELECT') OR (col.attname='id' AND a.privilege_type='UPDATE'))) OR
        (n.nspname='public' AND c.relname='Membership' AND ((col.attname IN ('workspaceId','userId','role') AND a.privilege_type='SELECT') OR (col.attname='userId' AND a.privilege_type='UPDATE'))) OR
        (n.nspname='public' AND c.relname='SiteGrant' AND ((col.attname IN ('workspaceId','siteId','userId') AND a.privilege_type='SELECT') OR (col.attname='userId' AND a.privilege_type='UPDATE'))) OR
        (n.nspname='lyraseo_legacy_visibility' AND a.privilege_type='UPDATE' AND ((c.relname='plan' AND col.attname='paused') OR (c.relname='authorization' AND col.attname='consumed') OR (c.relname='retry' AND col.attname IN ('attempts','next_retry_at')))))
  )`;
