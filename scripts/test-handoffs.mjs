import { LOCAL_GRANT_BOOTSTRAP } from "./lib/local-grants.mjs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  cpSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const container = "lyraseo-phase1-postgres";
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...options });
  if (r.status !== 0) throw Error(`HANDOFF_CHECK_FAILED: ${cmd}`);
  return r;
}
const inspected = JSON.parse(
  run("docker", ["inspect", container], { stdio: "pipe", encoding: "utf8" })
    .stdout,
)[0];
const bindings = inspected.HostConfig.PortBindings["5432/tcp"];
if (
  inspected.Config.Image !== "postgres:17-alpine" ||
  bindings?.length !== 1 ||
  bindings[0].HostIp !== "127.0.0.1" ||
  bindings[0].HostPort !== "54329"
)
  throw Error("UNSAFE_LOCAL_DATABASE");
const name = "lyraseo_handoff_" + randomBytes(6).toString("hex");
function sql(db, input) {
  return run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
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
sql("postgres", `CREATE DATABASE ${name} TEMPLATE template0;`);
mkdirSync(resolve(root, "output/handoffs"), { recursive: true });
writeFileSync(
  resolve(root, "output/handoffs/owned-db.json"),
  JSON.stringify(
    {
      name,
      createdAt: new Date().toISOString(),
      owner: "phase1_external_handoffs",
      scope: "disposable local fixture only",
    },
    null,
    2,
  ),
);
run(
  "pnpm",
  ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
  {
    env: {
      ...process.env,
      DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
    },
  },
);
sql(name, LOCAL_GRANT_BOOTSTRAP);
sql(
  name,
  `DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_handoff_fixture') THEN CREATE ROLE lyraseo_handoff_fixture LOGIN PASSWORD 'local_handoff_fixture_only' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lyraseo_handoff_fixture' AND(NOT rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) OR EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid IN(m.member,m.roleid) WHERE r.rolname='lyraseo_handoff_fixture') THEN RAISE EXCEPTION 'UNSAFE_FIXTURE_ROLE'; END IF;
 END $$;
 INSERT INTO lyraseo_handoff.fixture_environment SELECT oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database();
 GRANT USAGE ON SCHEMA lyraseo_handoff TO lyraseo_handoff_fixture;
 GRANT EXECUTE ON FUNCTION lyraseo_handoff.fixture_claim(uuid),lyraseo_handoff.fixture_before_socket(uuid,integer),lyraseo_handoff.fixture_finish(uuid,integer,text,integer,text,bigint,text) TO lyraseo_handoff_fixture;`,
);
console.log("Required handoff suite using independently owned database", name);
run("pnpm", ["exec", "vitest", "run", "tests/handoffs"], {
  env: { ...process.env, LYRA_HANDOFF_DB_NAME: name },
});
console.log("Retained local fixture database for review:", name);

// Rehearse additive upgrade on populated pre-handoff data independently of the
// empty replay above. Never copy/reset the shared canonical database.
const historyName = "lyraseo_handoff_" + randomBytes(6).toString("hex");
sql("postgres", `CREATE DATABASE ${historyName} TEMPLATE template0;`);
const temporary = resolve(
  root,
  "packages/db/tmp/handoff-replay-" + randomBytes(6).toString("hex"),
);
const migrationRoot = resolve(root, "packages/db/prisma/migrations");
mkdirSync(resolve(temporary, "migrations"), { recursive: true });
for (const file of readdirSync(migrationRoot, { withFileTypes: true })) {
  if (file.isDirectory() && file.name < "202611030008_external_handoffs")
    cpSync(
      resolve(migrationRoot, file.name),
      resolve(temporary, "migrations", file.name),
      { recursive: true },
    );
}
cpSync(
  resolve(migrationRoot, "migration_lock.toml"),
  resolve(temporary, "migrations/migration_lock.toml"),
);
const config = resolve(temporary, "prisma.config.ts");
writeFileSync(
  config,
  `import {defineConfig} from "prisma/config";export default defineConfig({schema:${JSON.stringify(resolve(root, "packages/db/prisma/schema.prisma"))},migrations:{path:${JSON.stringify(resolve(temporary, "migrations"))}},datasource:{url:process.env.DIRECT_URL}});`,
);
function historyMigrate(extra = []) {
  run(
    "pnpm",
    [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      ...extra,
    ],
    {
      env: {
        ...process.env,
        DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${historyName}`,
      },
    },
  );
}
try {
  historyMigrate(["--config", config]);
  sql(
    historyName,
    `INSERT INTO public."ProductUser"(id) VALUES('handoff-history-owner');
 INSERT INTO public."Workspace"(id,name) VALUES('handoff-history','History');
 INSERT INTO public."Site"(id,"workspaceId",origin) VALUES('handoff-history-site','handoff-history','https://history.example.com');
 INSERT INTO public."ContentDraft"(id,"workspaceId","siteId",kind,snapshot) VALUES('handoff-history-draft','handoff-history','handoff-history-site','draft','{"sources":[]}');
 INSERT INTO public."ContentRevision"(id,"workspaceId","draftId",revision,content,"userId") VALUES('handoff-history-revision','handoff-history','handoff-history-draft',1,'{"title":"Preserved","body":"Original authored history"}','handoff-history-owner');
 CREATE TABLE public.handoff_baseline_guard(draft_hash text,revision_hash text);
 INSERT INTO public.handoff_baseline_guard SELECT md5(row(d.id,d."workspaceId",d."siteId",d.kind,d.snapshot)::text),md5(row(r.id,r."workspaceId",r."draftId",r.revision,r.content,r."userId")::text) FROM public."ContentDraft" d JOIN public."ContentRevision" r ON r."draftId"=d.id;`,
  );
  historyMigrate();
  sql(
    historyName,
    `DO $$ BEGIN IF NOT EXISTS(SELECT FROM public.handoff_baseline_guard g JOIN public."ContentDraft" d ON md5(row(d.id,d."workspaceId",d."siteId",d.kind,d.snapshot)::text)=g.draft_hash JOIN public."ContentRevision" r ON md5(row(r.id,r."workspaceId",r."draftId",r.revision,r.content,r."userId")::text)=g.revision_hash) THEN RAISE EXCEPTION 'POPULATED_BASELINE_CHANGED'; END IF; END $$;DROP TABLE public.handoff_baseline_guard;`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const manifestPath = resolve(root, "output/handoffs/owned-db-history.json");
const prior = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : [];
prior.push({
  at: new Date().toISOString(),
  emptyAndIntegration: name,
  populatedUpgrade: historyName,
});
writeFileSync(manifestPath, JSON.stringify(prior, null, 2));
console.log(
  "Populated baseline bytes preserved; retained fixture:",
  historyName,
);
