import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { Client } = require("pg");
const kernelTables = [
  "WorkDispatch",
  "InternalRequest",
  "RuntimePolicy",
  "RuntimePolicyChange",
];
const tables = [
  ...kernelTables,
  "WorkspaceAccessEvent",
  "WorkspaceInvitation",
  "WorkspaceInvitationSite",
  "IssueAssignment",
  "IssueAssignmentEvent",
  "WorkspaceBrandingRevision",
  "AgencyBatchQuote",
  "AgencyBatchItem",
  "PageIdentity",
  "PageJournal",
  "ApiToken",
  "ApiThrottle",
  "ProductUser",
  "ProviderIdentity",
  "Workspace",
  "Membership",
  "Site",
  "SiteGrant",
  "StaffGrant",
  "StepUpGrant",
  "BudgetPeriod",
  "Operation",
  "OutboxEvent",
  "UsageReceipt",
  "OperationQuote",
  "AuditRun",
  "AuditPage",
  "IssueAction",
  "SiteContextRevision",
  "SiteVerificationChallenge",
  "AnalyticsOAuthState",
  "AnalyticsConnection",
  "AnalyticsImport",
  "GoogleOAuthState",
  "GoogleConnection",
  "SearchSnapshot",
  "VisibilityPanel",
  "VisibilityRun",
  "ContentDraft",
  "ContentRevision",
  "ContentRevisionPin",
  "AuditPageRetention",
  "EvidenceReport",
  "AuthThrottle",
  "ProductSession",
];
export function preflightConfig(env) {
  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "DATABASE_URL",
    "AUTH_DATABASE_URL",
    "APP_ORIGIN",
    "PILOT_ALLOWED_EMAILS",
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length)
    throw new Error(`Missing configuration: ${missing.join(", ")}`);
  const provider = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
  const origin = new URL(env.APP_ORIGIN);
  if (
    provider.protocol !== "https:" ||
    provider.origin !== env.NEXT_PUBLIC_SUPABASE_URL ||
    provider.username ||
    provider.password
  )
    throw new Error("Supabase URL must be an exact HTTPS origin");
  if (
    origin.origin !== env.APP_ORIGIN ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname))
    )
  )
    throw new Error("APP_ORIGIN must be HTTPS or loopback HTTP");
  if (
    !env.PILOT_ALLOWED_EMAILS.split(",").every((email) =>
      /^\S+@\S+\.\S+$/.test(email.trim()),
    )
  )
    throw new Error("Pilot allowlist must contain valid email addresses");
  const runtime = new URL(env.DATABASE_URL),
    identity = new URL(env.AUTH_DATABASE_URL);
  if (
    !runtime.username ||
    !identity.username ||
    runtime.username === identity.username
  )
    throw new Error(
      "Separate restricted runtime and identity database roles are required",
    );
  if (
    runtime.hostname !== identity.hostname ||
    runtime.pathname !== identity.pathname
  )
    throw new Error(
      "Database roles must connect to the same dedicated project",
    );
  const projectRef = provider.hostname.endsWith(".supabase.co")
    ? provider.hostname.split(".")[0]
    : null;
  if (!projectRef)
    throw new Error(
      "Use the dedicated project's canonical Supabase URL for preflight",
    );
  for (const connection of [runtime, identity]) {
    const direct = connection.hostname === `db.${projectRef}.supabase.co`;
    const pooled =
      connection.hostname.endsWith(".pooler.supabase.com") &&
      decodeURIComponent(connection.username).endsWith(`.${projectRef}`);
    if (!direct && !pooled)
      throw new Error(
        "Database connection does not match the dedicated Supabase project",
      );
  }
  return { provider: provider.origin, key: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}
export async function checkDatabase(url, identity) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const {
      rows: [role],
    } = await client.query(
      "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user",
    );
    if (!role || Object.values(role).some(Boolean))
      throw new Error("Database role has excessive administrative privileges");
    const { rows: catalog } = await client.query(
      `SELECT c.relname, c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1)`,
      [tables],
    );
    if (catalog.length !== tables.length || catalog.some((r) => r.owns))
      throw new Error(
        "Product migrations are missing or runtime role owns product tables",
      );
    const scoped = [
      ...kernelTables,
      "WorkspaceAccessEvent",
  "WorkspaceInvitation",
  "WorkspaceInvitationSite",
  "IssueAssignment",
  "IssueAssignmentEvent",
  "WorkspaceBrandingRevision",
  "AgencyBatchQuote",
  "AgencyBatchItem",
  "PageIdentity",
      "PageJournal",
      "ApiToken",
      "Workspace",
      "Membership",
      "Site",
      "SiteGrant",
      "StaffGrant",
      "StepUpGrant",
      "BudgetPeriod",
      "Operation",
      "OutboxEvent",
      "UsageReceipt",
      "OperationQuote",
      "AuditRun",
      "AuditPage",
      "IssueAction",
      "SiteContextRevision",
      "SiteVerificationChallenge",
      "AnalyticsOAuthState",
      "AnalyticsConnection",
      "AnalyticsImport",
      "GoogleOAuthState",
      "GoogleConnection",
      "SearchSnapshot",
      "VisibilityPanel",
      "VisibilityRun",
      "ContentDraft",
      "ContentRevision",
      "ContentRevisionPin",
      "AuditPageRetention",
      "EvidenceReport",
    ];
    if (
      catalog.some(
        (r) =>
          scoped.includes(r.relname) &&
          (!r.relrowsecurity || !r.relforcerowsecurity),
      )
    )
      throw new Error("Product row-level security is incomplete");
    const { rows: browser } = await client.query(
      `SELECT r.rolname,c.relname FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.rolname IN ('anon','authenticated') AND n.nspname='public' AND c.relname=ANY($1) AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE')`,
      [tables],
    );
    if (browser.length)
      throw new Error("Browser roles have product-table privileges");
    const {
      rows: [kernel],
    } = await client.query(
      `SELECT
       has_schema_privilege(current_user,'lyraseo_kernel','USAGE,CREATE')
       OR EXISTS (SELECT FROM pg_proc WHERE pronamespace='lyraseo_kernel'::regnamespace
         AND has_function_privilege(current_user,oid,'EXECUTE'))
       OR EXISTS (SELECT FROM pg_class WHERE relnamespace='public'::regnamespace
         AND relname=ANY($1) AND (has_any_column_privilege(current_user,oid,'SELECT,INSERT,UPDATE,REFERENCES')
           OR has_table_privilege(current_user,oid,'DELETE,TRUNCATE,TRIGGER')))
       OR has_table_privilege(current_user,'public."UsageReceipt"','UPDATE,DELETE,TRUNCATE,TRIGGER')
       OR has_any_column_privilege(current_user,'public."UsageReceipt"','UPDATE')
       OR EXISTS (SELECT FROM pg_roles WHERE rolname IN ('lyraseo_kernel_owner','lyraseo_dispatch','lyraseo_operator','lyraseo_expiry_owner','lyraseo_artifact_maintenance')
         AND pg_has_role(current_user,oid,'MEMBER')) AS excessive`,
      [[...kernelTables, "OutboxEvent"]],
    );
    if (kernel.excessive)
      throw new Error(
        "Application role can access protected kernel or receipt state",
      );
    const {
      rows: [expiry],
    } = await client.query(`SELECT
      to_regnamespace('lyraseo_expiry') IS NOT NULL AS installed,
      coalesce(has_schema_privilege(current_user,to_regnamespace('lyraseo_expiry'),'USAGE,CREATE'),false) AS schema_access,
      EXISTS(SELECT FROM pg_proc WHERE pronamespace=to_regnamespace('lyraseo_expiry')
        AND has_function_privilege(current_user,oid,'EXECUTE')) AS function_access,
      EXISTS(SELECT FROM pg_roles r CROSS JOIN pg_proc p
        WHERE r.rolname IN ('anon','authenticated') AND p.pronamespace=to_regnamespace('lyraseo_expiry')
        AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS browser_function_access,
      EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE (n.nspname='lyraseo_expiry' OR (n.nspname='public' AND c.relname IN
          ('ArtifactExpiryPlan','ArtifactExpiryItem','ArtifactExpiryEvent')))
        AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
          OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS table_access,
      EXISTS(SELECT FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE r.rolname IN ('anon','authenticated') AND (n.nspname='lyraseo_expiry' OR
          (n.nspname='public' AND c.relname IN ('ArtifactExpiryPlan','ArtifactExpiryItem','ArtifactExpiryEvent')))
        AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE')) AS browser_access`);
    if (
      expiry.schema_access ||
      expiry.function_access ||
      expiry.browser_function_access ||
      expiry.table_access ||
      expiry.browser_access
    )
      throw new Error("Application or browser role can access protected expiry state");
    if (expiry.installed) {
      const { rows: expiryTables } = await client.query(
        `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE (n.nspname='lyraseo_expiry' AND c.relname IN ('environment','absence_verifier')) OR
           (n.nspname='public' AND c.relname IN ('ArtifactExpiryPlan','ArtifactExpiryItem','ArtifactExpiryEvent'))`,
      );
      if (
        expiryTables.length !== 5 ||
        expiryTables.some(
          (r) => !r.relrowsecurity || !r.relforcerowsecurity || r.owns,
        )
      )
        throw new Error("Protected expiry tables or row security are incomplete");
    }
    if (identity) {
      await client.query(
        "SELECT id::text,user_id::text,created_at,refreshed_at,not_after FROM lyraseo_private.session_metadata WHERE false",
      );
      const {
        rows: [view],
      } = await client.query(
        "SELECT reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lyraseo_private' AND c.relname='session_metadata'",
      );
      if (!view?.reloptions?.includes("security_invoker=true"))
        throw new Error("Session metadata view must use invoker privileges");
      const {
        rows: [access],
      } = await client.query(
        `SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND c.relname IN ('sessions','refresh_tokens') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')) AS excessive`,
      );
      if (access.excessive)
        throw new Error("Identity role has excessive managed-auth privileges");
    } else {
      const {
        rows: [writes],
      } = await client.query(
        `SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('ProductUser','ProviderIdentity','StaffGrant') AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE')) AS forbidden`,
      );
      if (writes.forbidden)
        throw new Error(
          "Runtime can mutate protected identities or staff grants",
        );
      const result = await client.query('SELECT id FROM "Workspace" LIMIT 1');
      if (result.rowCount !== 0)
        throw new Error("Tenant rows are visible without transaction context");
    }
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
}
export async function main(env = process.env) {
  const config = preflightConfig(env);
  const response = await fetch(`${config.provider}/auth/v1/settings`, {
    headers: { apikey: config.key },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(
      `Supabase public settings request failed (${response.status})`,
    );
  const settings = await response.json();
  const missing = [
    !settings.external?.email && "enable email sign-in",
    !settings.external?.google && "enable Google sign-in",
    settings.disable_signup !== true && "disable public signup",
    settings.external?.anonymous === true && "disable anonymous auth",
  ].filter(Boolean);
  if (missing.length)
    throw new Error(`Provider setup required: ${missing.join("; ")}.`);
  console.log(
    "PASS: dedicated provider reachable; email/Google enabled; public signup disabled",
  );
  await checkDatabase(env.DATABASE_URL, false);
  console.log(
    "PASS: restricted runtime, tenant isolation and browser-role grants",
  );
  await checkDatabase(env.AUTH_DATABASE_URL, true);
  console.log(
    "PASS: restricted identity role and selected managed session columns",
  );
  console.log(
    "Read-only preflight passed. SMTP delivery, signed sessions, OTP, Google and TOTP still require interactive live acceptance.",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    // Driver messages may contain private connection details. Emit only safe failure categories.
    console.error(
      error?.cause?.code === "ENOTFOUND"
        ? "Supabase settings host does not resolve. Check the configured project URL and whether the project is paused."
        : error?.code
          ? `Auth preflight failed (${String(error.code).replace(/[^A-Z0-9_]/g, "")}). Check configuration privately.`
          : error instanceof Error && !error.message.includes("://")
            ? error.message
            : "Auth preflight failed. Check configuration privately.",
    );
    process.exitCode = 1;
  }
}
