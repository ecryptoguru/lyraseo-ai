import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_GRANT_BOOTSTRAP } from "./lib/local-grants.mjs";
import { testDatabaseTarget } from "../tests/helpers/test-database-target.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loginRoles = [
  "anon",
  "authenticated",
  "lyraseo_runtime",
  "lyraseo_identity",
  "lyraseo_dispatch",
  "lyraseo_operator",
  "lyraseo_artifact_maintenance",
  "lyraseo_ledger_fixture",
  "lyraseo_billing_intake",
  "lyraseo_billing_reconciler",
  "lyraseo_staff_executor",
];
const ownerRoles = [
  "lyraseo_kernel_owner",
  "lyraseo_expiry_owner",
  "lyraseo_legacy_visibility_owner",
  "lyraseo_ledger_owner",
  "lyraseo_staff_job_owner",
  "lyraseo_billing_owner",
  "lyraseo_history_owner",
  "lyraseo_deletion_owner",
  "lyraseo_handoff_owner",
  "lyraseo_report_owner",
  "lyraseo_legacy_inline_owner",
];
const roleNames = [...loginRoles, ...ownerRoles];
const identitySql = `SELECT row_to_json(s) FROM (
  SELECT system_identifier::text,pg_postmaster_start_time()::text AS started,
    inet_server_port() AS port FROM pg_control_system()) s`;
const rolesSql = `SELECT json_agg(s ORDER BY rolname) FROM (
  SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,
    (SELECT count(*)::integer FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS memberships,
    EXISTS(SELECT FROM pg_database WHERE datdba=r.oid) AS owns_database
  FROM pg_roles r WHERE rolname IN (${roleNames.map((name) => `'${name}'`).join(",")})) s`;

export function integrationContainerId(container, name, target) {
  const validBinding = (bindings) =>
    Object.keys(bindings ?? {}).length === 1 &&
    bindings["5432/tcp"]?.length === 1 &&
    bindings["5432/tcp"][0].HostIp === "127.0.0.1" &&
    bindings["5432/tcp"][0].HostPort === target.hostPort;
  if (
    !container ||
    container.Name !== `/${name}` ||
    !/^[a-f0-9]{64}$/.test(container.Id ?? "") ||
    container.Config?.Image !== "postgres:17-alpine" ||
    !container.Config.Env?.includes(
      `POSTGRES_PASSWORD=${target.adminPassword}`,
    ) ||
    container.Config.Env.some((value) =>
      value.startsWith("POSTGRES_HOST_AUTH_METHOD="),
    ) ||
    container.State?.Running !== true ||
    container.State.Paused ||
    container.State.Restarting ||
    container.HostConfig?.NetworkMode !== "bridge" ||
    container.HostConfig.Privileged !== false ||
    !validBinding(container.HostConfig.PortBindings) ||
    !validBinding(container.NetworkSettings?.Ports)
  )
    throw Error("UNSAFE_INTEGRATION_TEST_CONTAINER");
  return container.Id;
}

export function assertRestrictedIntegrationRoles(roles) {
  if (!Array.isArray(roles) || roles.length !== roleNames.length)
    throw Error("UNSAFE_INTEGRATION_TEST_ROLES");
  for (const name of roleNames) {
    const role = roles.find((r) => r.rolname === name);
    if (
      !role ||
      role.rolcanlogin !== loginRoles.includes(name) ||
      [
        "rolsuper",
        "rolbypassrls",
        "rolinherit",
        "rolcreatedb",
        "rolcreaterole",
        "rolreplication",
        "owns_database",
      ].some((key) => role[key] !== false) ||
      role.memberships !== 0
    )
      throw Error("UNSAFE_INTEGRATION_TEST_ROLES");
  }
}

export function assertSameIntegrationServer(expected, actual) {
  if (
    !expected ||
    !actual ||
    !/^[0-9]+$/.test(expected.system_identifier ?? "") ||
    typeof expected.started !== "string" ||
    !expected.started ||
    expected.port !== 5432 ||
    actual.system_identifier !== expected.system_identifier ||
    actual.started !== expected.started ||
    actual.port !== expected.port
  )
    throw Error("INTEGRATION_TEST_SERVER_IDENTITY_MISMATCH");
}

export function runOwnedIntegration(environment = process.env, filters = []) {
  const name = environment.LYRA_TEST_DB_CONTAINER ?? "lyraseo-phase1-postgres";
  if (
    name !== name.trim() ||
    !/^(?:lyraseo-phase1-postgres|lyraseo-disposable-[0-9]{8}-[a-f0-9]{8,12})$/.test(
      name,
    )
  )
    throw Error("INVALID_INTEGRATION_TEST_CONTAINER");
  if (
    filters.some(
      (path) =>
        path !== path.trim() ||
        !/^tests\/integration\/[a-z0-9-]+\.test\.ts$/.test(path),
    )
  )
    throw Error("INVALID_INTEGRATION_TEST_FILTER");
  // Dedicated gates use different fixed endpoints; never inherit their targets.
  if (
    [
      "LYRA_INLINE_TEST_DB",
      "LYRA_HANDOFF_CARRIER_DB",
      "LYRA_EXPIRY_HISTORY_DB_NAME",
      "LYRA_REPORT_GATE_URL",
    ].some((key) => environment[key])
  )
    throw Error("DEDICATED_INTEGRATION_DATABASE_OVERRIDE_FORBIDDEN");
  const databaseName = "lyraseo_review_" + randomBytes(6).toString("hex");
  const target = testDatabaseTarget({
    ...environment,
    LYRA_TEST_DB_NAME: databaseName,
  });
  const receipts = resolve(root, "output", "integration-owned", databaseName);
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const env = { ...environment };
  for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
  Object.assign(env, {
    LYRA_TEST_DB_NAME: databaseName,
    LYRA_TEST_DB_HOST_PORT: target.hostPort,
    LYRA_TEST_DB_ADMIN_PASSWORD: target.adminPassword,
    DIRECT_URL: target.adminUrl,
    DATABASE_URL: target.runtimeUrl,
  });
  const summary = {
    databaseName,
    container: name,
    port: target.hostPort,
    created: false,
    dropped: false,
    passed: false,
    exitCode: 1,
    receipts,
  };
  let step = 0;
  function run(label, command, args, options = {}) {
    const prefix = resolve(
      receipts,
      `${String(++step).padStart(2, "0")}-${label}`,
    );
    const result = spawnSync(command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    writeFileSync(prefix + ".stdout.log", result.stdout ?? "", { mode: 0o600 });
    writeFileSync(prefix + ".stderr.log", result.stderr ?? "", { mode: 0o600 });
    writeFileSync(
      prefix + ".json",
      JSON.stringify({
        command,
        args,
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
      }) + "\n",
      { mode: 0o600 },
    );
    if (options.input)
      writeFileSync(prefix + ".sql", options.input, { mode: 0o600 });
    // Inspect contains disposable credentials; preserve it privately, not in stdout.
    if (label !== "inspect") process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error || result.status !== 0)
      throw Object.assign(Error(`OWNED_INTEGRATION_COMMAND_FAILED:${label}`), {
        exitCode: result.status ?? 1,
      });
    return result.stdout.trim();
  }
  let containerId;
  function sql(label, db, input) {
    return run(
      label,
      "docker",
      [
        "exec",
        "-i",
        "--env",
        "PGPASSWORD",
        containerId,
        "psql",
        "-X",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
        "-U",
        "postgres",
        "-d",
        db,
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input, env: { ...env, PGPASSWORD: target.adminPassword } },
    );
  }
  function inspect() {
    const container = JSON.parse(
      run("inspect", "docker", ["inspect", name]),
    )[0];
    return integrationContainerId(container, name, target);
  }
  try {
    containerId = inspect();
    summary.containerId = containerId;
    const expected = JSON.parse(
      sql("docker-identity", "postgres", identitySql),
    );
    const pgPath = createRequire(
      resolve(root, "packages/db/package.json"),
    ).resolve("pg");
    const host = run("host-identity", process.execPath, [
      "-e",
      `
      const {Client}=require(${JSON.stringify(pgPath)});
      const client=new Client({host:'127.0.0.1',port:Number(process.env.LYRA_TEST_DB_HOST_PORT),
        user:'postgres',password:process.env.LYRA_TEST_DB_ADMIN_PASSWORD,database:'postgres',connectionTimeoutMillis:5000});
      (async()=>{try{await client.connect();console.log(JSON.stringify((await client.query(${JSON.stringify(identitySql)})).rows[0].row_to_json));}
        finally{await client.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});`,
    ]);
    assertSameIntegrationServer(expected, JSON.parse(host));
    summary.server = expected;
    const beforeRoles = JSON.parse(sql("roles-before", "postgres", rolesSql));
    assertRestrictedIntegrationRoles(beforeRoles);
    console.log(
      "Validated local container. Creating owned database:",
      databaseName,
      "Receipts:",
      receipts,
    );
    sql(
      "create-database",
      "postgres",
      `CREATE DATABASE "${databaseName}" TEMPLATE template0;`,
    );
    summary.created = true; // A collision/failed CREATE never grants cleanup ownership.
    const ownershipSql = `SELECT json_build_object('oid',oid::text,'owner',pg_get_userbyid(datdba)) FROM pg_database WHERE datname='${databaseName}'`;
    const ownership = JSON.parse(sql("ownership", "postgres", ownershipSql));
    if (
      !/^[0-9]+$/.test(ownership?.oid ?? "") ||
      ownership.owner !== "postgres"
    )
      throw Error("OWNED_INTEGRATION_DATABASE_IDENTITY_MISMATCH");
    summary.databaseOid = ownership.oid;
    run("migrate-deploy", "pnpm", [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
    ]);
    sql("local-grant-bootstrap", databaseName, LOCAL_GRANT_BOOTSTRAP);
    run("vitest", "pnpm", [
      "exec",
      "vitest",
      "run",
      ...(filters.length ? filters : ["tests/integration"]),
    ]);
    if (inspect() !== containerId)
      throw Error("INTEGRATION_TEST_CONTAINER_CHANGED");
    assertSameIntegrationServer(
      expected,
      JSON.parse(sql("identity-after", "postgres", identitySql)),
    );
    const afterRoles = JSON.parse(sql("roles-after", "postgres", rolesSql));
    assertRestrictedIntegrationRoles(afterRoles);
    if (JSON.stringify(beforeRoles) !== JSON.stringify(afterRoles))
      throw Error("INTEGRATION_TEST_ROLES_CHANGED");
    if (
      JSON.stringify(ownership) !==
      JSON.stringify(
        JSON.parse(sql("ownership-before-drop", "postgres", ownershipSql)),
      )
    )
      throw Error("OWNED_INTEGRATION_DATABASE_IDENTITY_MISMATCH");
    // No FORCE, termination, role changes, or cleanup of any pre-existing resource.
    sql("drop-owned-database", "postgres", `DROP DATABASE "${databaseName}";`);
    summary.dropped = true;
    summary.passed = true;
    summary.exitCode = 0;
    return summary;
  } catch (error) {
    summary.exitCode = error.exitCode ?? 1;
    summary.error = error.message;
    console.error(
      summary.created
        ? `Retained failed owned database: ${databaseName}`
        : "No owned database was created; nothing was cleaned up.",
    );
    throw Object.assign(error, { receipts });
  } finally {
    writeFileSync(
      resolve(receipts, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log("Raw integration receipts:", receipts);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runOwnedIntegration(process.env, process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
