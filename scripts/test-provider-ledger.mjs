import { LOCAL_GRANT_BOOTSTRAP } from "./lib/local-grants.mjs";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(`PROVIDER_LEDGER_GATE_FAILED:${command}`);
  return r;
}
const container = "lyraseo-phase1-postgres";
const inspect = run("docker", ["inspect", container], {
  encoding: "utf8",
  stdio: "pipe",
});
const c = JSON.parse(inspect.stdout)[0],
  b = c.HostConfig.PortBindings?.["5432/tcp"];
if (
  c.Config.Image !== "postgres:17-alpine" ||
  b?.length !== 1 ||
  b[0].HostIp !== "127.0.0.1" ||
  b[0].HostPort !== "54329" ||
  !c.State.Running
)
  throw Error("UNSAFE_LEDGER_TEST_CONTAINER");
function sql(db, input) {
  run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      db,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input, stdio: ["pipe", "inherit", "inherit"] },
  );
}
const database =
  "lyraseo_ledger_" + randomUUID().replaceAll("-", "").slice(0, 12);
run("docker", [
  "exec",
  container,
  "createdb",
  "-U",
  "postgres",
  "-T",
  "template0",
  database,
]);
console.log("Owned provider ledger database:", database);
let passed = false;
let historyDatabase;
const temp = mkdtempSync(resolve(tmpdir(), "lyraseo-ledger-history-"));
try {
  sql(
    database,
    `DO $$ DECLARE r record; BEGIN FOR r IN SELECT * FROM pg_roles WHERE rolname IN ('lyraseo_ledger_owner','lyraseo_ledger_fixture') LOOP IF r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR (r.rolname='lyraseo_ledger_owner')=r.rolcanlogin OR EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) OR EXISTS(SELECT FROM pg_database WHERE datdba=r.oid) THEN RAISE EXCEPTION 'UNSAFE_LEDGER_ROLE'; END IF; END LOOP; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_ledger_owner') THEN CREATE ROLE lyraseo_ledger_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_ledger_fixture') THEN CREATE ROLE lyraseo_ledger_fixture LOGIN PASSWORD 'local_ledger_only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;`,
  );
  run(
    "pnpm",
    ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
    {
      env: {
        ...process.env,
        DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${database}`,
      },
    },
  );
  sql(database, LOCAL_GRANT_BOOTSTRAP);
  sql(
    database,
    `INSERT INTO lyraseo_ledger.environment(database_oid,postmaster_started_at,fixture_version) SELECT oid,pg_postmaster_start_time(),'SYNTHETIC_LEDGER_V1' FROM pg_database WHERE datname=current_database();`,
  );
  run("pnpm", ["exec", "vitest", "run", "tests/provider-ledger"], {
    env: { ...process.env, LYRA_LEDGER_DB: database },
  });
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "tests/integration/accounting.test.ts",
      "tests/integration/execution.test.ts",
      "tests/integration/dispatch.test.ts",
      "tests/integration/quotes.test.ts",
      "tests/integration/gsc.test.ts",
    ],
    { env: { ...process.env, LYRA_TEST_DB_NAME: database } },
  );
  if (process.env.LYRA_LEDGER_BASELINE === "true")
    run("pnpm", ["test:integration"], {
      env: { ...process.env, LYRA_TEST_DB_NAME: database },
    });
  historyDatabase =
    "lyraseo_ledger_" + randomUUID().replaceAll("-", "").slice(0, 12);
  run("docker", [
    "exec",
    container,
    "createdb",
    "-U",
    "postgres",
    "-T",
    "template0",
    historyDatabase,
  ]);
  console.log("Owned provider history database:", historyDatabase);
  const migrationRoot = resolve(root, "packages/db/prisma/migrations"),
    directory = resolve(temp, "migrations");
  mkdirSync(directory);
  for (const name of readdirSync(migrationRoot, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && e.name <= "202611030005_private_artifact_expiry",
    )
    .map((e) => e.name))
    cpSync(resolve(migrationRoot, name), resolve(directory, name), {
      recursive: true,
    });
  cpSync(
    resolve(migrationRoot, "migration_lock.toml"),
    resolve(directory, "migration_lock.toml"),
  );
  const modulePath = createRequire(
      resolve(root, "packages/db/package.json"),
    ).resolve("prisma/config"),
    config = resolve(temp, "history.config.ts");
  writeFileSync(
    config,
    `import {defineConfig} from ${JSON.stringify(modulePath)};export default defineConfig({schema:${JSON.stringify(resolve(root, "packages/db/prisma/schema.prisma"))},migrations:{path:${JSON.stringify(directory)}},datasource:{url:process.env.DIRECT_URL}});`,
  );
  const env = {
    ...process.env,
    DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${historyDatabase}`,
  };
  run(
    "pnpm",
    [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      config,
    ],
    { env },
  );
  const seed = readFileSync(
    resolve(root, "tests/fixtures/migrations/dispatch-paid.sql"),
    "utf8",
  )
    .replace(/INSERT INTO "OutboxEvent"[\s\S]*?WHERE id<>'terminal';/, "")
    .replace(
      'GRANT SELECT,INSERT,UPDATE ON "Operation","OutboxEvent","UsageReceipt" TO lyraseo_runtime;',
      "",
    );
  const fingerprint = `SELECT encode(sha256(convert_to(jsonb_build_object('operations',(SELECT jsonb_agg(to_jsonb(o)-'ledgerMode'-'ledgerVersion' ORDER BY id) FROM public."Operation" o),'budgets',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM public."BudgetPeriod" b),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public."UsageReceipt" r),'quotes',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM public."OperationQuote" q),'dispatch',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public."WorkDispatch" d),'outbox',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public."OutboxEvent" e))::text,'UTF8')),'hex')`;
  sql(
    historyDatabase,
    seed +
      `CREATE TABLE public.ledger_history_receipt(digest text NOT NULL);INSERT INTO public.ledger_history_receipt ${fingerprint};`,
  );
  run(
    "pnpm",
    ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
    { env },
  );
  sql(
    historyDatabase,
    `DO $$ BEGIN IF (SELECT digest FROM public.ledger_history_receipt) IS DISTINCT FROM (${fingerprint}) OR EXISTS(SELECT FROM public."Operation" WHERE "ledgerMode"<>'LEGACY' OR "ledgerVersion"<>0) THEN RAISE EXCEPTION 'PROVIDER_HISTORY_CHANGED'; END IF; END $$;`,
  );
  console.log(
    "PASS: empty migration, restricted fixture ledger and unchanged populated legacy financial history",
  );
  const migrationInput =
    "/tmp/lyraseo-ledger-role-" + randomUUID().replaceAll("-", "") + ".sql";
  run("docker", [
    "cp",
    resolve(
      migrationRoot,
      "202611030007_provider_attempt_ledger/migration.sql",
    ),
    container + ":" + migrationInput,
  ]);
  try {
    run(
      "docker",
      [
        "exec",
        "-i",
        "-u",
        "postgres",
        container,
        "sh",
        "-s",
        "--",
        migrationInput,
      ],
      {
        input: readFileSync(
          resolve(root, "tests/fixtures/provider-ledger/unsafe-roles.sh"),
        ),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  } finally {
    run("docker", ["exec", container, "rm", "-f", migrationInput]);
  }
  passed = true;
} finally {
  // Failed fixtures are retained by name for diagnosis; never touch an existing DB.
  if (passed)
    run("docker", ["exec", container, "dropdb", "-U", "postgres", database]);
  else console.error("Retained failed owned fixture:", database);
  if (historyDatabase) {
    if (passed)
      run("docker", [
        "exec",
        container,
        "dropdb",
        "-U",
        "postgres",
        historyDatabase,
      ]);
    else
      console.error("Retained failed owned history fixture:", historyDatabase);
  }
  rmSync(temp, { recursive: true, force: true });
}
