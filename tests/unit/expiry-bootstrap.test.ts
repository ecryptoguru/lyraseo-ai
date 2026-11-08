import { expect, it } from "vitest";
import { EXPIRY_ROLE_GUARD } from "../../scripts/lib/expiry-bootstrap.mjs";
import { LOCAL_GRANT_BOOTSTRAP } from "../../scripts/lib/local-grants.mjs";

it("exports the real role, membership and database predicate used by the gate", () => {
  expect(EXPIRY_ROLE_GUARD).toContain("lyraseo_artifact_maintenance");
  expect(EXPIRY_ROLE_GUARD).toContain("lyraseo_expiry_owner");
  expect(EXPIRY_ROLE_GUARD).toContain("pg_auth_members");
  expect(EXPIRY_ROLE_GUARD).toContain("pg_database");
  expect(EXPIRY_ROLE_GUARD).toContain("rolsuper");
  expect(EXPIRY_ROLE_GUARD).toContain("rolbypassrls");
});

it("shares the guarded grant bootstrap with the local provisioner", () => {
  expect(LOCAL_GRANT_BOOTSTRAP).toContain(
    "GRANT USAGE ON SCHEMA public TO lyraseo_runtime",
  );
  expect(LOCAL_GRANT_BOOTSTRAP).toContain("UNSAFE_LEGACY_BOOTSTRAP_GRANT");
});
