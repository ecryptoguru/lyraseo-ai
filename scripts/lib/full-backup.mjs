// Closed synthetic rehearsal only. No URL/adoption API, cloud transport or
// production command: every database and directory is created by this lab.
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePrivacyMigrationPlan } from "./privacy-bootstrap.mjs";
import {
  projectBackupTables,
  FULL_BACKUP_ADAPTER,
  fullBackupKnownTables,
  fullBackupOmittedTables,
} from "../../packages/db/src/backup-projection.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  container = "lyraseo-phase1-postgres";
const require = createRequire(join(root, "packages/db/package.json")),
  { Client } = require("pg");
const maximum = 256 * 1024 * 1024;
const roles = {
  postgres: "lyraseo_local_only",
  lyraseo_runtime: "local_runtime_only",
  lyraseo_identity: "local_identity_only",
  lyraseo_artifact_maintenance: "local_expiry_only",
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  return Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, sort(item)]),
        )
      : value;
}
const q = (value) => '"' + value.replaceAll('"', '""') + '"';
const relation = (value) => value.split(".").map(q).join(".");
function issue(code, receipt) {
  const error = Error(code);
  if (receipt) error.receipt = receipt;
  return error;
}
async function query(client, text, values = []) {
  try {
    return await client.query(text, values);
  } catch (error) {
    throw issue("LOCAL_BACKUP_SQL_FAILED", {
      code: error.code,
      table: /^[A-Za-z0-9_]+$/.test(error.table ?? "")
        ? error.table
        : undefined,
      constraint: /^[A-Za-z0-9_]+$/.test(error.constraint ?? "")
        ? error.constraint
        : undefined,
    });
  }
}
async function command(args, input, limit = maximum) {
  return new Promise((resolve, reject) => {
    const process_ = spawn(
      "docker",
      ["exec", ...(input === undefined ? [] : ["-i"]), container, ...args],
      { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] },
    );
    const output = [];
    let length = 0;
    const errors = createHash("sha256");
    process_.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > limit) process_.kill("SIGTERM");
      else output.push(chunk);
    });
    process_.stderr.on("data", (chunk) => errors.update(chunk));
    let inputError;
    process_.stdin?.on("error", (error) => {
      inputError = error.code;
    });
    process_.on("error", () =>
      reject(issue("LOCAL_BACKUP_COMMAND_START_FAILED")),
    );
    process_.on("close", (code) => {
      if (code !== 0 || length > limit || inputError)
        reject(
          issue("LOCAL_BACKUP_COMMAND_FAILED", {
            program: args[0],
            exit: code,
            inputError,
            stderrHash: errors.digest("hex"),
          }),
        );
      else resolve(Buffer.concat(output));
    });
    if (input !== undefined) process_.stdin.end(input);
  });
}
const handles = new WeakMap();
function owned(handle) {
  const entry = handles.get(handle);
  if (!entry) throw issue("OWNED_BACKUP_DATABASE_REQUIRED");
  return entry;
}
export async function catalog(client) {
  const tables = (
    await query(
      client,
      `SELECT n.nspname schema,c.relname name,pg_get_userbyid(c.relowner) owner,c.relrowsecurity rls,c.relforcerowsecurity forced,(SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type),'[]') FROM aclexplode(CASE WHEN c.relacl IS NULL THEN acldefault('r',c.relowner) WHEN cardinality(c.relacl)>0 THEN c.relacl ELSE NULL END) x) acl,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'acl',(SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type),'[]') FROM aclexplode(CASE WHEN cardinality(a.attacl)>0 THEN a.attacl ELSE NULL END) x)) ORDER BY a.attnum),'[]') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,true)) ORDER BY k.conname),'[]') FROM pg_constraint k WHERE k.conrelid=c.oid) constraints,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r.id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r.id) END ORDER BY CASE WHEN r.id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r.id) END) FROM unnest(p.polroles) r(id)),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p') AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname`,
    )
  ).rows;
  const functions = (
    await query(
      client,
      `SELECT n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) arguments,pg_get_userbyid(p.proowner) owner,p.prosecdef definer,p.proconfig settings,(SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type),'[]') FROM aclexplode(CASE WHEN p.proacl IS NULL THEN acldefault('f',p.proowner) WHEN cardinality(p.proacl)>0 THEN p.proacl ELSE NULL END) x) acl,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`,
    )
  ).rows;
  return { tables, functions };
}
export async function createLocalBackupLab({ onDatabaseStage } = {}) {
  if (onDatabaseStage !== undefined && typeof onDatabaseStage !== "function")
    throw issue("INVALID_LOCAL_BACKUP_OBSERVER");
  // Qualify and retain the exact migration bytes before any Docker/DB operation.
  const plan = preparePrivacyMigrationPlan(root, { profile: "historical" });
  const inspect = JSON.parse(
    (
      await new Promise((resolve_, reject) => {
        const child = spawn("docker", ["inspect", container], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        const chunks = [];
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve_(Buffer.concat(chunks))
            : reject(issue("BACKUP_CONTAINER_REQUIRED")),
        );
      })
    ).toString(),
  )[0];
  const ports = inspect.HostConfig.PortBindings?.["5432/tcp"];
  if (
    inspect.Config.Image !== "postgres:17-alpine" ||
    ports?.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    ports[0].HostPort !== "54329"
  )
    throw issue("UNSAFE_BACKUP_CONTAINER");
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "lyraseo-full-backup-")),
    ),
    created = [],
    clients = new Set(),
    directories = new Set();
  const system = (
    await command([
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-At",
      "-c",
      "SELECT system_identifier FROM pg_control_system()",
    ])
  )
    .toString()
    .trim();
  async function connect(handle, role = "postgres") {
    const entry = owned(handle);
    if (!Object.hasOwn(roles, role)) throw issue("INVALID_BACKUP_ROLE");
    const client = new Client({
      host: "127.0.0.1",
      port: 54329,
      database: entry.name,
      user: role,
      password: roles[role],
      application_name: "local-backup-rehearsal",
      connectionTimeoutMillis: 2000,
    });
    try {
      await client.connect();
      clients.add(client);
      if (role === "postgres") {
        const actual = (
          await query(
            client,
            "SELECT current_database() name,(SELECT oid FROM pg_database WHERE datname=current_database()) oid,(SELECT system_identifier::text FROM pg_control_system()) system,pg_postmaster_start_time()::text started",
          )
        ).rows[0];
        if (
          actual.name !== entry.name ||
          actual.system !== system ||
          (entry.oid !== undefined && entry.oid !== actual.oid)
        )
          throw issue("BACKUP_DATABASE_IDENTITY_CHANGED");
        entry.oid = actual.oid;
        entry.started = actual.started;
      }
      await query(client, "SET TIME ZONE 'UTC'");
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      clients.delete(client);
      throw error;
    }
  }
  async function observe(handle, stage) {
    const entry = owned(handle);
    await onDatabaseStage?.({ handle, stage, purpose: entry.purpose });
  }
  async function inspectQuarantine(handle) {
    const entry = owned(handle);
    const bytes = await command([
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT json_build_object('allowConnections',d.datallowconn,'runtimeConnect',has_database_privilege('lyraseo_runtime',d.oid,'CONNECT'),'nonAdminSessions',(SELECT count(*)::integer FROM pg_stat_activity WHERE datid=d.oid AND usename<>'postgres')) FROM pg_database d WHERE d.datname='${entry.name}'`,
    ]);
    const state = JSON.parse(bytes.toString());
    if (!state || typeof state.allowConnections !== "boolean")
      throw issue("BACKUP_DATABASE_MISSING");
    return state;
  }
  async function create({ purpose = "SYNTHETIC" } = {}) {
    if (!["SYNTHETIC", "PROJECTION", "RESTORE"].includes(purpose))
      throw issue("INVALID_BACKUP_DATABASE_PURPOSE");
    const name =
      "lyraseo_recovery_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const management = [
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ];
    // ALLOW_CONNECTIONS=false is part of CREATE itself: no role can enter a
    // default-PUBLIC-CONNECT database before its private ACL is installed.
    await command([
      ...management,
      "-c",
      `CREATE DATABASE ${q(name)} TEMPLATE template0 ALLOW_CONNECTIONS false`,
    ]);
    const handle = Object.freeze({
      qualification: "LOCAL_SYNTHETIC_ONLY",
      name,
    });
    handles.set(handle, { name, purpose });
    created.push(handle);
    await observe(handle, "DATABASE_CREATED");
    // Configure ACL from the maintenance database while the new target remains
    // closed. ON_ERROR_STOP prevents enabling it after any failed ACL statement.
    await command([
      ...management,
      "-c",
      `REVOKE ALL ON DATABASE ${q(name)} FROM PUBLIC`,
      "-c",
      `GRANT CONNECT ON DATABASE ${q(name)} TO postgres`,
    ]);
    await observe(handle, "DATABASE_ACL_CONFIGURED");
    const closed = await inspectQuarantine(handle);
    if (
      closed.allowConnections ||
      closed.runtimeConnect ||
      closed.nonAdminSessions !== 0
    )
      throw issue("BACKUP_INITIAL_QUARANTINE_FAILED");
    await command([
      ...management,
      "-c",
      `ALTER DATABASE ${q(name)} ALLOW_CONNECTIONS true`,
    ]);
    const secured = await inspectQuarantine(handle);
    if (
      !secured.allowConnections ||
      secured.runtimeConnect ||
      secured.nonAdminSessions !== 0
    )
      throw issue("BACKUP_DATABASE_QUARANTINE_FAILED");
    await observe(handle, "DATABASE_QUARANTINED");
    return handle;
  }
  async function install(handle) {
    const client = await connect(handle);
    try {
      for (const step of plan.steps) await query(client, step.sql);
      await query(client, plan.bootstrap);
      await query(
        client,
        `GRANT CONNECT ON DATABASE ${q(owned(handle).name)} TO lyraseo_runtime,lyraseo_artifact_maintenance`,
      );
    } finally {
      await client.end();
      clients.delete(client);
    }
  }
  return {
    directory,
    create,
    checkpoint: observe,
    inspectQuarantine,
    install,
    connect,
    assertDirectory(path) {
      if (!directories.has(path))
        throw issue("OWNED_BACKUP_DIRECTORY_REQUIRED");
    },
    url(handle, role = "postgres") {
      const entry = owned(handle);
      if (!Object.hasOwn(roles, role)) throw issue("INVALID_BACKUP_ROLE");
      return `postgresql://${role}:${roles[role]}@127.0.0.1:54329/${entry.name}`;
    },
    async privateDirectory(label) {
      if (!/^[a-z-]+$/.test(label)) throw issue("INVALID_BACKUP_DIRECTORY");
      const path = join(directory, label + "-" + randomUUID());
      await mkdir(path, { mode: 0o700 });
      directories.add(path);
      return path;
    },
    async close(client) {
      await client.end();
      clients.delete(client);
    },
    async drop(handle) {
      const entry = owned(handle);
      await command(["dropdb", "-U", "postgres", entry.name]);
      created.splice(created.indexOf(handle), 1);
      handles.delete(handle);
    },
    async cleanup() {
      for (const client of clients) await client.end().catch(() => {});
      clients.clear();
      for (const handle of [...created].reverse())
        await command(["dropdb", "-U", "postgres", owned(handle).name]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function checkRoot(path) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw issue("UNSAFE_FULL_BACKUP_ROOT");
}
async function syncDirectory(path) {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function writePrivate(path, bytes) {
  const fd = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function readPrivate(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      stat.size > maximum
    )
      throw issue("UNSAFE_FULL_BACKUP_FILE");
    return await fd.readFile();
  } finally {
    await fd.close();
  }
}
function keys(config) {
  if (
    !config ||
    ![config.database, config.artifacts, config.manifest].every(
      (key) => key instanceof Uint8Array && key.length === 32,
    ) ||
    new Set(
      [config.database, config.artifacts, config.manifest].map((key) =>
        Buffer.from(key).toString("hex"),
      ),
    ).size !== 3
  )
    throw issue("FULL_BACKUP_DISTINCT_KEYS_REQUIRED");
  return {
    database: Buffer.from(config.database),
    artifacts: Buffer.from(config.artifacts),
    manifest: Buffer.from(config.manifest),
  };
}
function encrypt(bytes, key, aad) {
  if (bytes.length > maximum - 28) throw issue("FULL_BACKUP_TOO_LARGE");
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    nonce,
    cipher.update(bytes),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
function decrypt(bytes, key, aad) {
  try {
    if (bytes.length < 28) throw Error();
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      cipher.update(bytes.subarray(12, -16)),
      cipher.final(),
    ]);
  } catch {
    throw issue("FULL_BACKUP_AUTHENTICATION_FAILED");
  }
}
async function rows(client, shape, budget = { total: 0 }) {
  const table = shape.schema + "." + shape.name;
  const overlay = shape.columns
    .filter(
      (column) =>
        column.type.startsWith("numeric") ||
        column.type === "bigint" ||
        column.type.startsWith("timestamp"),
    )
    .flatMap((column) => {
      const key = "'" + column.name.replaceAll("'", "''") + "'",
        column_ = q(column.name);
      return [
        key,
        column.type.startsWith("timestamp")
          ? `CASE WHEN ${column_} IS NULL THEN NULL ELSE to_char(${column_}${column.type.includes("with time zone") ? " AT TIME ZONE 'UTC'" : ""},'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`
          : `${column_}::text`,
      ];
    });
  const jsonColumns = shape.columns.filter(
    (column) => column.type === "jsonb" || column.type === "json",
  );
  const nulls = jsonColumns.length
    ? `array_remove(ARRAY[${jsonColumns.map((column) => `CASE WHEN ${q(column.name)} IS NOT NULL AND ${q(column.name)}::jsonb='null'::jsonb THEN '${column.name.replaceAll("'", "''")}' END`).join(",")}],NULL)`
    : `ARRAY[]::text[]`;
  await query(
    client,
    `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)${overlay.length ? "||jsonb_build_object(" + overlay.join(",") + ")" : ""} data,${nulls} "jsonNulls" FROM ${relation(table)} t`,
  );
  const output = [];
  try {
    for (;;) {
      const read = (await query(client, "FETCH 1 FROM backup_rows")).rows;
      if (!read.length) break;
      const size = Buffer.byteLength(canonical(read[0]));
      budget.total += size;
      if (size > 32 * 1024 * 1024 || budget.total > maximum)
        throw issue("FULL_BACKUP_CAPTURE_BOUND_EXCEEDED");
      output.push(read[0]);
      if (output.length > 10000) throw issue("FULL_BACKUP_ROW_BOUND_EXCEEDED");
    }
  } finally {
    await query(client, "CLOSE backup_rows");
  }
  return output;
}
async function loadRows(client, shape, data) {
  const columns = shape.columns.filter((column) => !column.generated),
    fields = columns.map((column) => q(column.name)).join(",");
  for (const packet of data) {
    const values = columns
      .map((column) =>
        packet.jsonNulls.includes(column.name)
          ? "'null'::" + column.type
          : `r.${q(column.name)}`,
      )
      .join(",");
    await query(
      client,
      `INSERT INTO ${relation(shape.schema + "." + shape.name)}(${fields}) SELECT ${values} FROM jsonb_populate_record(NULL::${relation(shape.schema + "." + shape.name)},$1::jsonb) r`,
      [JSON.stringify(packet.data)],
    );
  }
}
function differences(a, b, path = "", out = []) {
  if (out.length >= 20 || canonical(a) === canonical(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      differences(a[key], b[key], path + "/" + key, out);
  } else
    out.push({
      path,
      actual: typeof a === "string" && a.length < 500 ? a : typeof a,
      expected: typeof b === "string" && b.length < 500 ? b : typeof b,
    });
  return out;
}
function supported(actual, profile) {
  const missing = actual.tables
    .filter(
      (table) => !fullBackupKnownTables.has(table.schema + "." + table.name),
    )
    .map((table) => table.schema + "." + table.name);
  if (missing.length)
    throw issue("MISSING_FULL_BACKUP_ADAPTER", { tables: missing });
  if (canonical(actual) !== canonical(profile))
    throw issue("FULL_BACKUP_CATALOG_ADAPTER_MISMATCH", {
      actual: sha(canonical(actual)),
      expected: sha(canonical(profile)),
      differences: differences(actual, profile),
    });
}
export async function createFullBackup(
  lab,
  source,
  { directory, journal, keyset, profile },
) {
  lab.assertDirectory(directory);
  await checkRoot(directory);
  const key = keys(keyset),
    id = randomUUID(),
    point = join(directory, id);
  await mkdir(point, { mode: 0o700 });
  const client = await lab.connect(source),
    sourceEntry = owned(source);
  let projection;
  try {
    await query(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const clock = (
      await query(
        client,
        `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,pg_export_snapshot() snapshot`,
      )
    ).rows[0];
    const shape = await catalog(client);
    supported(shape, profile);
    const tables = {},
      budget = { total: 0 };
    for (const table of shape.tables) {
      const name = table.schema + "." + table.name;
      tables[name] = fullBackupOmittedTables.has(name)
        ? []
        : await rows(client, table, budget);
    }
    const projected = projectBackupTables(tables, {
      at: clock.at,
      phase: "BACKUP",
    });
    const schema = await command([
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      sourceEntry.name,
      "--schema-only",
      "--no-tablespaces",
      "--snapshot=" + clock.snapshot,
    ]);
    await query(client, "COMMIT");
    projection = await lab.create({ purpose: "PROJECTION" });
    await command(
      [
        "psql",
        "-X",
        "-U",
        "postgres",
        "-d",
        owned(projection).name,
        "-v",
        "ON_ERROR_STOP=1",
      ],
      schema,
    );
    const target = await lab.connect(projection);
    try {
      await query(target, "BEGIN");
      await query(target, "SET LOCAL session_replication_role=replica");
      for (const table of shape.tables)
        await loadRows(
          target,
          table,
          projected.tables[table.schema + "." + table.name] ?? [],
        );
      await query(target, "COMMIT");
      // Generated clocks are never loaded from caller values. Verify their exact
      // original value after PostgreSQL recomputes them from preserved anchors.
      for (const table of shape.tables.filter((table) =>
        table.columns.some((column) => column.generated),
      )) {
        const actual = await rowsInTransaction(target, table),
          expected = projected.tables[table.schema + "." + table.name] ?? [];
        if (
          canonical(actual.map((packet) => packet.data).sort(compare)) !==
          canonical(expected.map((packet) => packet.data).sort(compare))
        )
          throw issue("FULL_BACKUP_GENERATED_CLOCK_CHANGED");
      }
    } finally {
      await lab.close(target);
    }
    const dump = await command([
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      owned(projection).name,
      "--format=custom",
      "--no-tablespaces",
    ]);
    const artifacts = Buffer.from(canonical(projected.artifacts)),
      createdAt = new Date().toISOString(),
      expiresAt = new Date(Date.parse(createdAt) + 7 * 86400000).toISOString();
    const aad = id + ":" + FULL_BACKUP_ADAPTER,
      databaseCipher = encrypt(dump, key.database, aad + ":database"),
      artifactCipher = encrypt(artifacts, key.artifacts, aad + ":artifacts");
    await writePrivate(join(point, "database.enc"), databaseCipher);
    await writePrivate(join(point, "artifacts.enc"), artifactCipher);
    const manifest = {
      version: 1,
      profile: "LOCAL_FULL_LOGICAL_32_V1",
      adapter: FULL_BACKUP_ADAPTER,
      id,
      createdAt,
      expiresAt,
      snapshotAt: clock.at,
      catalogHash: sha(canonical(shape)),
      journal: await journal.watermark(),
      database: {
        hash: sha(dump),
        cipherHash: sha(databaseCipher),
        length: dump.length,
      },
      artifacts: {
        hash: sha(artifacts),
        cipherHash: sha(artifactCipher),
        length: artifacts.length,
        items: projected.artifacts.map(({ bytes, ...artifact }) => artifact),
      },
      rows: Object.fromEntries(
        Object.entries(projected.tables).map(([table, rows_]) => [
          table,
          rows_.length,
        ]),
      ),
      redactions: projected.redactions,
      omissions: [
        "EPHEMERAL_RAW_SOURCE_BYTES",
        "LIVE_CREDENTIALS_SESSIONS_HMAC_AND_REPLAY_KEYS",
      ],
      deletionAdmission: "UNQUALIFIED_DISABLED",
      replaySetup: "PRIVILEGED_SYNTHETIC_FIXTURE_ONLY",
      operationalReopenAllowed: false,
    };
    const body = canonical(manifest),
      mac = createHmac("sha256", key.manifest).update(body).digest("hex");
    await writePrivate(
      join(point, "manifest.json"),
      Buffer.from(JSON.stringify({ manifest, mac })),
    );
    await syncDirectory(point);
    await syncDirectory(directory);
    return { id, directory: point, manifest };
  } catch (error) {
    await query(client, "ROLLBACK").catch(() => {});
    await rm(point, { recursive: true, force: true });
    throw error;
  } finally {
    await lab.close(client);
    if (projection) await lab.drop(projection);
  }
}
const compare = (a, b) => canonical(a).localeCompare(canonical(b));
async function rowsInTransaction(client, shape) {
  await query(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = await rows(client, shape);
    await query(client, "COMMIT");
    return result;
  } catch (error) {
    await query(client, "ROLLBACK");
    throw error;
  }
}
export async function verifyFullBackup(point, keyset) {
  await checkRoot(point.directory);
  const key = keys(keyset);
  let envelope;
  try {
    envelope = JSON.parse(
      (await readPrivate(join(point.directory, "manifest.json"))).toString(),
    );
  } catch {
    throw issue("FULL_BACKUP_MANIFEST_INVALID");
  }
  const { manifest, mac } = envelope,
    actual = createHmac("sha256", key.manifest)
      .update(canonical(manifest))
      .digest();
  if (
    !/^[a-f0-9]{64}$/.test(mac ?? "") ||
    !timingSafeEqual(actual, Buffer.from(mac, "hex")) ||
    manifest.id !== point.id ||
    manifest.profile !== "LOCAL_FULL_LOGICAL_32_V1" ||
    manifest.adapter !== FULL_BACKUP_ADAPTER
  )
    throw issue("FULL_BACKUP_MANIFEST_AUTHENTICATION_FAILED");
  if (
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    Date.parse(manifest.expiresAt) !==
      Date.parse(manifest.createdAt) + 7 * 86400000 ||
    !Number.isFinite(Date.parse(manifest.snapshotAt)) ||
    Date.parse(manifest.snapshotAt) > Date.parse(manifest.createdAt)
  )
    throw issue("FULL_BACKUP_MANIFEST_CLOCK_INVALID");
  if (Date.parse(manifest.expiresAt) <= Date.now())
    throw issue("FULL_BACKUP_POINT_EXPIRED");
  const databaseCipher = await readPrivate(
      join(point.directory, "database.enc"),
    ),
    artifactCipher = await readPrivate(join(point.directory, "artifacts.enc"));
  if (
    sha(databaseCipher) !== manifest.database.cipherHash ||
    sha(artifactCipher) !== manifest.artifacts.cipherHash
  )
    throw issue("FULL_BACKUP_CIPHERTEXT_MISMATCH");
  const aad = manifest.id + ":" + manifest.adapter,
    database = decrypt(databaseCipher, key.database, aad + ":database"),
    artifactBytes = decrypt(artifactCipher, key.artifacts, aad + ":artifacts");
  if (
    database.length !== manifest.database.length ||
    sha(database) !== manifest.database.hash ||
    artifactBytes.length !== manifest.artifacts.length ||
    sha(artifactBytes) !== manifest.artifacts.hash
  )
    throw issue("FULL_BACKUP_PAYLOAD_MISMATCH");
  const artifacts = JSON.parse(artifactBytes.toString());
  if (artifacts.length !== manifest.artifacts.items.length)
    throw issue("FULL_BACKUP_ARTIFACT_MISSING");
  for (let index = 0; index < artifacts.length; index++) {
    const artifact = artifacts[index],
      bytes = Buffer.from(artifact.bytes, "base64"),
      { bytes: _, ...metadata } = artifact;
    if (
      canonical(metadata) !== canonical(manifest.artifacts.items[index]) ||
      bytes.length !== artifact.length ||
      sha(bytes) !== artifact.sha256
    )
      throw issue("FULL_BACKUP_ARTIFACT_MISMATCH");
  }
  return { manifest, database, artifacts };
}
export async function restoreFullBackup(
  lab,
  point,
  { keyset, journal, trustedLatest, profile },
) {
  const verified = await verifyFullBackup(point, keyset),
    events = await journal.replay(verified.manifest.journal, trustedLatest);
  const restored = await lab.create({ purpose: "RESTORE" }),
    artifactRoot = await lab.privateDirectory("restored-artifacts");
  try {
    // Only authenticated complete bytes reach pg_restore; this target is new and
    // has CONNECT revoked before any schema/data is installed.
    await command(
      [
        "pg_restore",
        "-U",
        "postgres",
        "-d",
        owned(restored).name,
        "--single-transaction",
        "--exit-on-error",
        "--no-tablespaces",
      ],
      verified.database,
    );
    await lab.checkpoint(restored, "RESTORE_SCHEMA_LOADED");
    const client = await lab.connect(restored);
    let result;
    try {
      const shape = await catalog(client);
      supported(shape, profile);
      await query(client, "BEGIN ISOLATION LEVEL REPEATABLE READ");
      const tables = {},
        budget = { total: 0 };
      for (const table of shape.tables) {
        const name = table.schema + "." + table.name;
        tables[name] = fullBackupOmittedTables.has(name)
          ? []
          : await rows(client, table, budget);
      }
      await lab.checkpoint(restored, "RESTORE_BEFORE_REPLAY");
      const at = new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000Z"),
        projected = projectBackupTables(tables, {
          at,
          phase: "RESTORE",
          events,
        });
      for (const artifact of verified.artifacts) {
        const report = projected.tables["public.EvidenceReport"]?.find(
          (packet) =>
            packet.data.id === artifact.reportId &&
            packet.data.workspaceId === artifact.workspaceId &&
            packet.data.siteId === artifact.siteId,
        );
        if (!report) continue;
        const bytes = Buffer.from(artifact.bytes, "base64"),
          path = join(
            artifactRoot,
            sha(artifact.reportId + ":" + artifact.format),
          );
        await writePrivate(path, bytes);
        if (artifact.format === "pdf")
          report.data.pdf = "\\x" + bytes.toString("hex");
        else report.data.csv = bytes.toString("utf8");
      }
      await query(client, "SET LOCAL session_replication_role=replica");
      for (const table of [...shape.tables].reverse())
        await query(
          client,
          `DELETE FROM ${relation(table.schema + "." + table.name)}`,
        );
      for (const table of shape.tables)
        await loadRows(
          client,
          table,
          projected.tables[table.schema + "." + table.name] ?? [],
        );
      await query(client, "COMMIT");
      await lab.checkpoint(restored, "RESTORE_REPLAYED");
      // Validate every FK again after scoped replay and generated-column loading.
      const foreign = (
        await query(
          client,
          `SELECT n.nspname schema,c.relname table_,k.conname name,pg_get_constraintdef(k.oid) definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE k.contype='f' ORDER BY n.nspname,c.relname,k.conname`,
        )
      ).rows;
      for (const fk of foreign) {
        await query(
          client,
          `ALTER TABLE ${relation(fk.schema + "." + fk.table_)} DROP CONSTRAINT ${q(fk.name)}`,
        );
        await query(
          client,
          `ALTER TABLE ${relation(fk.schema + "." + fk.table_)} ADD CONSTRAINT ${q(fk.name)} ${fk.definition} NOT VALID`,
        );
        await query(
          client,
          `ALTER TABLE ${relation(fk.schema + "." + fk.table_)} VALIDATE CONSTRAINT ${q(fk.name)}`,
        );
      }
      const after = await catalog(client);
      supported(after, profile);
      const runtimeConnect = (
        await query(
          client,
          "SELECT has_database_privilege('lyraseo_runtime',current_database(),'CONNECT') allowed",
        )
      ).rows[0].allowed;
      if (runtimeConnect) throw issue("RESTORE_RUNTIME_CONNECT_NOT_REVOKED");
      const restoreReceipt = {
        profile: "LOCAL_FULL_LOGICAL_32_V1",
        pointId: point.id,
        manifestHash: sha(canonical(verified.manifest)),
        sourceSnapshotAt: verified.manifest.snapshotAt,
        restoredAt: at,
        journal: trustedLatest,
        replayedEvents: events.length,
        deletionClocks: events
          .filter(
            (event) =>
              event.phase === "APPLIED" &&
              event.intent.action === "DELETE_SITE",
          )
          .map((event) => ({
            caseId: event.intent.caseId,
            workspaceId: event.intent.workspaceId,
            siteId: event.intent.siteId,
            incarnation: event.intent.incarnation,
            ...event.receiptClock,
          })),
        unresolvedIntents: projected.blockers.length,
        deletionAdmission: "UNQUALIFIED_DISABLED",
        replaySetup: "PRIVILEGED_SYNTHETIC_FIXTURE_ONLY",
        operationalReopenAllowed: false,
        rawOriginRestored: false,
      };
      const signed = {
        receipt: restoreReceipt,
        mac: createHmac("sha256", keys(keyset).manifest)
          .update(canonical(restoreReceipt))
          .digest("hex"),
      };
      const literal = (
        await query(client, "SELECT quote_literal($1::text) value", [
          canonical(signed),
        ])
      ).rows[0].value;
      await query(
        client,
        `COMMENT ON DATABASE ${q(owned(restored).name)} IS ${literal}`,
      );
      const persisted = (
        await query(
          client,
          "SELECT shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') value",
        )
      ).rows[0].value;
      if (persisted !== canonical(signed))
        throw issue("RESTORE_REPLAY_RECEIPT_NOT_DURABLE");
      await syncDirectory(artifactRoot);
      const counts = Object.fromEntries(
        Object.entries(projected.tables).map(([name, packets]) => [
          name,
          packets.length,
        ]),
      );
      result = {
        handle: restored,
        artifactRoot,
        counts,
        blockers: projected.blockers,
        journal: trustedLatest,
        profile: "LOCAL_FULL_LOGICAL_32_V1",
        runtimeConnect: false,
        deletionAdmission: "UNQUALIFIED_DISABLED",
        replaySetup: "PRIVILEGED_SYNTHETIC_FIXTURE_ONLY",
        operationalReopenAllowed: false,
        rawOriginRestored: false,
        artifactCount: (await readdir(artifactRoot)).length,
        replayReceiptHash: sha(persisted),
      };
    } finally {
      await lab.close(client);
    }
    return result;
  } catch (error) {
    await lab.drop(restored);
    await rm(artifactRoot, { recursive: true, force: true });
    throw error;
  }
}
