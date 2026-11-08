// One predicate is used by both local provisioning and the isolated gate.
export const EXPIRY_ROLE_GUARD = `SELECT EXISTS(
    SELECT FROM pg_roles r WHERE r.rolname IN ('lyraseo_artifact_maintenance','lyraseo_expiry_owner')
    AND ((r.rolname='lyraseo_artifact_maintenance' AND NOT r.rolcanlogin)
      OR (r.rolname='lyraseo_expiry_owner' AND r.rolcanlogin)
      OR r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    UNION ALL SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.member,m.roleid)
      WHERE r.rolname IN ('lyraseo_artifact_maintenance','lyraseo_expiry_owner')
    UNION ALL SELECT FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
      WHERE r.rolname IN ('lyraseo_artifact_maintenance','lyraseo_expiry_owner'))`;
