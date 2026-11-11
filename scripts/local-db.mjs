import { spawnSync } from "node:child_process";
import { EXPIRY_ROLE_GUARD } from "./lib/expiry-bootstrap.mjs";
import { LOCAL_GRANT_BOOTSTRAP } from "./lib/local-grants.mjs";
import { LEGACY_VISIBILITY_ROLE_GUARD } from "./lib/legacy-visibility-role.mjs";
const name = "lyraseo-phase1-postgres";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("docker", ["info", "--format", "{{.ServerVersion}}"]);
const inspect = spawnSync("docker", ["inspect", name], { encoding: "utf8" });
if (inspect.status === 0) {
  const container = JSON.parse(inspect.stdout)[0];
  if (
    container.Config.Image !== "postgres:17-alpine" ||
    container.HostConfig.PortBindings["5432/tcp"]?.length !== 1 ||
    container.HostConfig.PortBindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
    container.HostConfig.PortBindings["5432/tcp"][0].HostPort !== "54329"
  ) {
    throw new Error(
      "An unrelated container uses the test name; leaving it untouched.",
    );
  }
  run("docker", ["start", name]);
} else
  run("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1:54329:5432",
    "--env",
    "POSTGRES_PASSWORD=lyraseo_local_only",
    "--env",
    "POSTGRES_DB=lyraseo_test",
    "postgres:17-alpine",
  ]);
// The image starts a socket-only server during initdb. Wait for the final TCP listener.
for (let attempt = 0; attempt < 30; attempt++) {
  const ready = spawnSync(
    "docker",
    [
      "exec",
      name,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      "postgres",
      "-d",
      "lyraseo_test",
      "-t",
      "1",
    ],
    { stdio: "ignore", timeout: 3000 },
  );
  if (ready.status === 0) break;
  if (attempt === 29) throw new Error("Local PostgreSQL did not become ready.");
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const env = {
  ...process.env,
  DIRECT_URL:
    "postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/lyraseo_test",
};
function localScalar(sql) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "lyraseo_test",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error("Could not verify local cutover state: " + result.stderr);
  return result.stdout.trim();
}
// A DB lock cannot retract a reference buffered in an old publisher process.
// On an existing populated database require both stopped DB clients and an
// explicit local drain attestation. Empty fresh bootstraps have no old sends.
if (
  localScalar(
    `SELECT to_regclass('public."OutboxEvent"') IS NOT NULL AND to_regclass('public."WorkDispatch"') IS NULL`,
  ) === "t"
) {
  if (
    localScalar(
      "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend')",
    ) === "t"
  )
    throw new Error(
      "Stop local admissions and legacy publishers before applying dispatch cutover.",
    );
  if (
    localScalar('SELECT EXISTS(SELECT FROM public."OutboxEvent")') === "t" &&
    process.env.LYRA_LOCAL_OUTBOX_DRAINED !== "true"
  )
    throw new Error(
      "Drain pending old publisher sends, stop admissions, then set LYRA_LOCAL_OUTBOX_DRAINED=true for this local cutover.",
    );
}
// Provision cluster roles separately from migration SQL; these credentials
// are exclusively for the validated loopback-only disposable test instance.
const localRoles = [
  ["lyraseo_runtime", "local_runtime_only"],
  ["lyraseo_identity", "local_identity_only"],
  ["lyraseo_dispatch", "local_dispatch_only"],
  ["lyraseo_operator", "local_operator_only"],
  ["lyraseo_kernel_owner", null],
  ["lyraseo_artifact_maintenance", "local_expiry_only"],
  ["lyraseo_expiry_owner", null],
  ["lyraseo_legacy_visibility_owner", null],
  ["lyraseo_ledger_owner", null],
  ["lyraseo_ledger_fixture", "local_ledger_only"],
  ["lyraseo_staff_job_owner", null],
  ["lyraseo_billing_owner", null],
  ["lyraseo_billing_intake", "local_billing_intake_only"],
  ["lyraseo_billing_reconciler", "local_billing_reconciler_only"],
  ["lyraseo_staff_executor", "local_staff_executor_only"],
  ["lyraseo_history_owner", null],
  ["lyraseo_deletion_owner", null],
  ["anon", "local_anon_only"],
  ["authenticated", "local_authenticated_only"],
];
// Ledger fixture roles have no authority in a database until separate enrollment.
if (
  localScalar(
    `SELECT EXISTS(SELECT FROM pg_roles r WHERE r.rolname IN ('lyraseo_ledger_owner','lyraseo_ledger_fixture') AND (r.rolsuper OR r.rolinherit OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR (r.rolname='lyraseo_ledger_owner')=r.rolcanlogin) UNION ALL SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.member,m.roleid) WHERE r.rolname IN ('lyraseo_ledger_owner','lyraseo_ledger_fixture') UNION ALL SELECT FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname IN ('lyraseo_ledger_owner','lyraseo_ledger_fixture'))`,
  ) === "t"
)
  throw Error("UNSAFE_LEDGER_ROLE");
// The purpose role is cluster-wide, but its functions and grants are database-local.
// Reject unsafe existing identities and unexpected ownership in this database.
if (localScalar(LEGACY_VISIBILITY_ROLE_GUARD) === "t")
  throw new Error(
    "Unsafe existing legacy visibility role; leaving it untouched.",
  );
// The purpose role is cluster-wide; allow its expected functions in this
// database after migration, but never accept unrelated ownership or membership.
if (
  localScalar(`SELECT EXISTS(
    SELECT FROM pg_roles r WHERE r.rolname='lyraseo_staff_job_owner' AND
      (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    UNION ALL SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.member,m.roleid) WHERE r.rolname='lyraseo_staff_job_owner'
    UNION ALL SELECT FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname='lyraseo_staff_job_owner'
    UNION ALL SELECT FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE r.rolname='lyraseo_staff_job_owner'
    UNION ALL SELECT FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='lyraseo_staff_job_owner'
    UNION ALL SELECT FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname='lyraseo_staff_job_owner' AND NOT (p.oid = ANY(array_remove(ARRAY[
      to_regprocedure('lyraseo_billing.assert_job_allocation(text,uuid)'),
      to_regprocedure('lyraseo_billing.allocate_job_request(jsonb,uuid)'),
      to_regprocedure('lyraseo_billing.resolve_job_request(jsonb,uuid)'),
      to_regprocedure('lyraseo_billing.job_request_status(jsonb,uuid)'),
      to_regprocedure('lyraseo_billing.prepare_job_request(jsonb,text,text,text,integer,text,uuid)'),
      to_regprocedure('lyraseo_billing.execute_job_request(jsonb,text,text,integer,text,uuid)'),
      to_regprocedure('lyraseo_billing.perform_staff_job_action(jsonb,text,text,text,integer,text)'),
      to_regprocedure('lyraseo_billing.staff_job_availability(jsonb)'),
      to_regprocedure('lyraseo_billing.staff_job_denied(jsonb,text,text)'),
      to_regprocedure('lyraseo_billing.job_test_proof(text,text,integer)'),
      to_regprocedure('lyraseo_billing.issue_job_step_up(jsonb,text,text,text)')],NULL)))
    UNION ALL SELECT FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a JOIN pg_roles r ON r.rolname='lyraseo_staff_job_owner' AND a.grantee IN (r.oid,0)
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND NOT (n.nspname IN ('public','lyraseo_kernel','lyraseo_billing') AND a.privilege_type='USAGE')
    UNION ALL SELECT FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname='lyraseo_staff_job_owner'
    -- PUBLIC is not the purpose role: its privileges must never inherit the
    -- purpose role's application-relation allowlist, even on the same column.
    UNION ALL SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE a.grantee=0 AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    UNION ALL SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute col ON col.attrelid=c.oid CROSS JOIN LATERAL aclexplode(col.attacl) a
      WHERE a.grantee=0 AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    UNION ALL SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.rolname='lyraseo_staff_job_owner' AND a.grantee=r.oid
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND NOT (
        (n.nspname='lyraseo_billing' AND c.relname IN ('staff_epoch','staff_capability','job_test_session') AND a.privilege_type='SELECT') OR
        (n.nspname='lyraseo_billing' AND c.relname IN ('step_up','job_allocation','job_request','closed_job_request') AND a.privilege_type IN ('SELECT','INSERT')) OR
        (n.nspname='lyraseo_billing' AND c.relname='staff_receipt' AND a.privilege_type='INSERT') OR
        (n.nspname='lyraseo_billing' AND c.relname='staff_rate' AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')) OR
        (n.nspname='lyraseo_kernel' AND c.relname='test_environment' AND a.privilege_type='SELECT'))
    UNION ALL SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute col ON col.attrelid=c.oid CROSS JOIN LATERAL aclexplode(col.attacl) a JOIN pg_roles r ON r.rolname='lyraseo_staff_job_owner' AND a.grantee=r.oid
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND NOT (
        (n.nspname='lyraseo_billing' AND a.privilege_type='UPDATE' AND ((c.relname='step_up' AND col.attname IN ('consumed_at','request_hash','result')) OR (c.relname='job_request' AND col.attname='token_hash') OR (c.relname='job_test_session' AND col.attname='user_id'))) OR
        (n.nspname='public' AND a.privilege_type='UPDATE' AND ((c.relname IN ('ProductUser','Workspace','Site') AND col.attname='id') OR (c.relname='ProductSession' AND col.attname='sessionId') OR (c.relname IN ('Membership','SiteGrant') AND col.attname='userId') OR (c.relname='BudgetPeriod' AND col.attname='reserved') OR (c.relname='Operation' AND col.attname IN ('status','cancelRequestedAt','settledAt','leaseOwner','leaseUntil','fence')))) OR
        (n.nspname='public' AND a.privilege_type='SELECT' AND ((c.relname='ProductUser' AND col.attname IN ('id','suspended','securityVersion')) OR (c.relname='ProductSession' AND col.attname IN ('sessionId','userId','securityVersion','createdAt','refreshedAt')) OR (c.relname='Workspace' AND col.attname IN ('id','deletedAt')) OR (c.relname='Site' AND col.attname IN ('workspaceId','id','verifiedAt','deletedAt')) OR (c.relname='Membership' AND col.attname IN ('workspaceId','userId','role')) OR (c.relname='SiteGrant' AND col.attname IN ('workspaceId','siteId','userId')) OR (c.relname='BudgetPeriod' AND col.attname IN ('userId','period','bucket','limit','spent','reserved')) OR (c.relname='Operation' AND col.attname IN ('id','workspaceId','siteId','userId','sessionId','securityVersion','kind','provider','period','reservedCost','status','expiresAt','cancelRequestedAt','leaseUntil','fence','attemptState','providerTaskId','settledAt','actualCost')))))
    UNION ALL SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.rolname='lyraseo_staff_job_owner'
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND (p.proowner=r.oid OR p.prosecdef) AND a.grantee=0 AND a.privilege_type='EXECUTE'
    UNION ALL SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid=a.grantee
      WHERE r.rolname='lyraseo_staff_job_owner' AND p.proowner<>r.oid AND NOT (p.oid = ANY(array_remove(ARRAY[to_regprocedure('lyraseo_billing.actor_valid(jsonb,boolean,text,boolean)'),to_regprocedure('lyraseo_billing.rate_staff(text,text,integer)')],NULL)))
  )`) === "t"
)
  throw new Error("Unsafe existing staff job role; leaving it untouched.");
// Never repair a pre-existing privileged expiry identity in place.
if (localScalar(EXPIRY_ROLE_GUARD) === "t")
  throw new Error("Unsafe existing expiry role; leaving it untouched.");
run(
  "docker",
  [
    "exec",
    "-i",
    name,
    "psql",
    "-U",
    "postgres",
    "-d",
    "lyraseo_test",
    "-v",
    "ON_ERROR_STOP=1",
  ],
  {
    input: localRoles
      .map(
        ([role, password]) =>
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} ${password ? `LOGIN PASSWORD '${password}'` : "NOLOGIN"} NOINHERIT NOSUPERUSER NOBYPASSRLS; END IF; END $$;`,
      )
      .join("\n"),
    stdio: ["pipe", "inherit", "inherit"],
  },
);
run("pnpm", ["--filter", "@lyraseo/db", "exec", "prisma", "generate"], { env });
run(
  "pnpm",
  ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
  { env },
);

run(
  "docker",
  [
    "exec",
    "-i",
    name,
    "psql",
    "-U",
    "postgres",
    "-d",
    "lyraseo_test",
    "-v",
    "ON_ERROR_STOP=1",
  ],
  { input: LOCAL_GRANT_BOOTSTRAP, stdio: ["pipe", "inherit", "inherit"] },
);
console.log(
  "Isolated local test database ready on 127.0.0.1:54329. No cloud database was contacted.",
);
