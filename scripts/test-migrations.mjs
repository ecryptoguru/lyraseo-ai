import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Only disposable databases in the validated local test container are touched.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const container = "lyraseo-phase1-postgres";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0)
    throw new Error(`Migration check command failed: ${command}`);
  return result;
}
const inspected = run("docker", ["inspect", container], {
  encoding: "utf8",
  stdio: "pipe",
});
const instance = JSON.parse(inspected.stdout)[0];
if (
  instance.Config.Image !== "postgres:17-alpine" ||
  instance.HostConfig.PortBindings["5432/tcp"]?.length !== 1 ||
  instance.HostConfig.PortBindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
  instance.HostConfig.PortBindings["5432/tcp"][0].HostPort !== "54329"
)
  throw new Error("Unexpected database container; leaving it untouched.");
const migrationRoot = join(root, "packages/db/prisma/migrations");
const migrations = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const baseline = migrations.filter(
  (name) => name <= "202611020002_request_input",
);
if (baseline.length !== 7)
  throw new Error("Expected the seven-migration published baseline.");
const scratch = join(
  root,
  "packages/db/tmp",
  `migration-replay-${randomUUID()}`,
);
function prefixConfig(label, prefix) {
  const directory = join(scratch, label);
  mkdirSync(directory, { recursive: true });
  for (const migration of prefix)
    cpSync(join(migrationRoot, migration), join(directory, migration), {
      recursive: true,
    });
  cpSync(
    join(migrationRoot, "migration_lock.toml"),
    join(directory, "migration_lock.toml"),
  );
  const config = join(scratch, label + ".config.ts");
  writeFileSync(
    config,
    `import {defineConfig} from "prisma/config";export default defineConfig({schema:${JSON.stringify(join(root, "packages/db/prisma/schema.prisma"))},migrations:{path:${JSON.stringify(directory)}},datasource:{url:process.env.DIRECT_URL}});`,
  );
  return config;
}
const oldConfig = prefixConfig("seven", baseline);
const currentConfig = prefixConfig(
  "twenty",
  migrations.filter((name) => name <= "202611020015_gsc_import_leases"),
);
const kernelConfig = prefixConfig(
  "twenty-one",
  migrations.filter((name) => name <= "202611020016_worker_dispatch"),
);
const bridgeConfig = prefixConfig(
  "twenty-two",
  migrations.filter((name) => name <= "202611020017_signed_audit_bridge"),
);
const retentionConfig = prefixConfig(
  "twenty-three",
  migrations.filter((n) => n <= "202611030001_evidence_retention"),
);
const auditArtifactConfig = prefixConfig(
  "twenty-four",
  migrations.filter((n) => n <= "202611030002_private_audit_artifacts"),
);
const observationArtifactConfig = prefixConfig(
  "twenty-five",
  migrations.filter((n) => n <= "202611030003_private_observation_artifacts"),
);
const originConfig = prefixConfig(
  "twenty-six",
  migrations.filter((n) => n <= "202611030004_artifact_origin_binding"),
);
const expiryConfig = prefixConfig(
  "twenty-seven",
  migrations.filter((n) => n <= "202611030005_private_artifact_expiry"),
);
if (
  createHash("sha256")
    .update(
      readFileSync(
        join(
          migrationRoot,
          "202611030004_artifact_origin_binding/migration.sql",
        ),
      ),
    )
    .digest("hex") !==
  "16ad4be15f46ca07e6a71484ceb6b5a9681a853023c9e700825260ece0c6cea7"
)
  throw Error("Accepted migration 26 changed bytes");
const databases = [];
function sql(database, statement, capture = false) {
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
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    {
      input: statement,
      stdio: ["pipe", "inherit", "inherit"],
      ...(capture ? { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] } : {}),
    },
  ).stdout;
}
function migrate(database, config) {
  run(
    "pnpm",
    [
      "--filter",
      "@lyraseo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      ...(config ? ["--config", config] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DIRECT_URL: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${database}`,
      },
    },
  );
}
function login(database, role, password, statement) {
  return run(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `PGPASSWORD=${password}`,
      container,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      role,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
    ],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).stdout.trim();
}
// Project only columns introduced by a specific transition on the exact table
// that owns them. Every other key (including same-named unknown keys) is kept.
function projection(table, baseline, current) {
  const additions = [
    [23, "AuditRun", "resultExpiresAt"],
    [23, "VisibilityRun", "resultExpiresAt"],
    [23, "SearchSnapshot", "resultExpiresAt"],
    [23, "SearchImport", "resultExpiresAt"],
    [23, "AnalyticsImport", "resultExpiresAt"],
    [23, "ContentDraft", "evidenceFormat"],
    [23, "EvidenceReport", "evidenceFormat"],
    [24, "AuditRun", "storageFormat"],
    [25, "VisibilityRun", "storageFormat"],
    ...["ownerKind", "recordingId", "runId", "panelId", "promptId"].map(
      (column) => [25, "ArtifactBlob", column],
    ),
    ...["recordingId", "runId", "panelId", "promptId"].map((column) => [
      25,
      "ArtifactRef",
      column,
    ]),
    [29, "Operation", "ledgerMode"],
    [29, "Operation", "ledgerVersion"],
    [31, "Workspace", "accessRevision"],
    [31, "PageJournal", "assigneeUserId"],
    [32, "ContentRevision", "historyExpiresAt"],
    [35, "EvidenceReport", "identifierKey"],
  ];
  return additions
    .filter(
      ([stage, target]) =>
        stage > baseline && stage <= current && target === table,
    )
    .map(([, , column]) => `-'${column}'`)
    .join("");
}
function snapshot(database, withAudit, baseline, current) {
  const tables = [
    "ProductUser",
    "Workspace",
    "Membership",
    "Site",
    "BudgetPeriod",
    "Operation",
    "OperationQuote",
    "UsageReceipt",
    "OutboxEvent",
    ...(withAudit ? ["AuditRun", "AuditPage"] : []),
  ];
  return (
    tables
      .map((table) => {
        // Exclude only columns introduced on this table by this transition.
        // Later comparisons include those columns as historical values.
        const added = projection(table, baseline, current);
        return sql(
          database,
          `SELECT coalesce(jsonb_agg(to_jsonb(t)${added} ORDER BY (to_jsonb(t)${added})::text),'[]') FROM "${table}" t;`,
          true,
        );
      })
      .join("\n") +
    sql(
      database,
      'SELECT id, "requestInput" IS NULL FROM "Operation" ORDER BY id;',
      true,
    )
  );
}
// Snapshot full column metadata for every historical table, including empty
// tables. Only separately asserted 27-to-head additions are removed.
// EvidenceReport.pdf/csv were NOT NULL until 202611030013 relaxed them for legacy
// reports; the replay fingerprint normalizes that reviewed relaxation to true
// on both sides so the gate still detects any other metadata change.
function historySchema(database, afterHead = false) {
  return sql(
    database,
    `SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'column',a.attname,
      'number',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'notNull', CASE WHEN c.relname='EvidenceReport' AND a.attname IN ('pdf','csv') THEN true ELSE a.attnotnull END,
      'generated',a.attgenerated,'identity',a.attidentity,'default',pg_get_expr(d.adbin,d.adrelid))
      ORDER BY n.nspname,c.relname,a.attnum)
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
     LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
     WHERE ((n.nspname='public' AND c.relname = ANY(ARRAY[
       'ProductUser','Workspace','Membership','Site','BudgetPeriod','Operation','OperationQuote','UsageReceipt','OutboxEvent',
       'AuditRun','AuditPage','WorkDispatch','InternalRequest','RuntimePolicy','SearchSnapshot','SearchImport','AnalyticsImport',
       'VisibilityPanel','VisibilityRun','ContentDraft','ContentRevision','EvidenceReport','AuditPageRetention','ArtifactBlob','ArtifactRef',
       'VisibilityRecording','VisibilityObservationSlot','AuditEvaluationScratch','PageIdentity','PageJournal'
     ])) OR (n.nspname='lyraseo_origin' AND c.relname = ANY(ARRAY['store_registration','source_store_key','store_namespace','blob_store_binding'])))
     ${afterHead ? `AND NOT (n.nspname='public' AND ((c.relname='Workspace' AND a.attname='accessRevision') OR (c.relname='Operation' AND a.attname IN ('ledgerMode','ledgerVersion')) OR (c.relname='PageJournal' AND a.attname='assigneeUserId') OR (c.relname='ContentRevision' AND a.attname='historyExpiresAt') OR (c.relname='EvidenceReport' AND a.attname='identifierKey')))` : ""};`,
    true,
  );
}
function assertAdditiveDefaults(database) {
  const result = sql(
    database,
    `SELECT NOT EXISTS (SELECT FROM "Workspace" WHERE "accessRevision" IS DISTINCT FROM 0);
     SELECT NOT EXISTS (SELECT FROM "Operation" WHERE "ledgerMode" IS DISTINCT FROM 'LEGACY' OR "ledgerVersion" IS DISTINCT FROM 0);
     SELECT NOT EXISTS (SELECT FROM "PageJournal" WHERE "assigneeUserId" IS NOT NULL);
     SELECT count(*) = 4 FROM information_schema.columns WHERE table_schema='public' AND (
       (table_name='Workspace' AND column_name='accessRevision' AND is_nullable='NO' AND column_default='0') OR
       (table_name='Operation' AND column_name='ledgerMode' AND is_nullable='NO' AND column_default='''LEGACY''::text') OR
       (table_name='Operation' AND column_name='ledgerVersion' AND is_nullable='NO' AND column_default='0') OR
       (table_name='PageJournal' AND column_name='assigneeUserId' AND is_nullable='YES' AND column_default IS NULL)
     );`,
    true,
  ).trim();
  if (result !== "t\nt\nt\nt")
    throw new Error(
      "Unexpected workspace/ledger/journal historical defaults: " + result,
    );
}
const fixture = (name) =>
  readFileSync(join(root, "tests/fixtures/migrations", name), "utf8");
try {
  // Upgrade a populated, already closed 016 installation, including its
  // existing replay and paid dispatch history and legacy browser grants.
  const kernelDatabase =
    "lyraseo_expiry_" + randomUUID().replaceAll("-", "").slice(0, 12);
  run("docker", [
    "exec",
    container,
    "createdb",
    "-U",
    "postgres",
    kernelDatabase,
  ]);
  databases.push(kernelDatabase);
  migrate(kernelDatabase, currentConfig);
  sql(kernelDatabase, fixture("dispatch-paid.sql"));
  sql(kernelDatabase, fixture("dispatch-audits.sql"));
  migrate(kernelDatabase, kernelConfig);
  sql(
    kernelDatabase,
    'GRANT SELECT,INSERT,UPDATE ON "AuditRun" TO lyraseo_runtime; GRANT SELECT,INSERT ON "AuditPage" TO lyraseo_runtime;',
  );
  login(
    kernelDatabase,
    "lyraseo_dispatch",
    "local_dispatch_only",
    `SELECT lyraseo_kernel.command(gen_random_uuid(),'lyraseo-kernel-a','/api/internal/runtime/dispatch','{"limit":1}',statement_timestamp(),statement_timestamp()+interval '60 seconds');`,
  );
  const kernelHistory = (baseline, current) =>
    snapshot(kernelDatabase, true, baseline, current) +
    ["WorkDispatch", "InternalRequest", "RuntimePolicy"]
      .map((table) =>
        sql(
          kernelDatabase,
          `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM "${table}" t`,
          true,
        ),
      )
      .join("\n");
  const historyBeforeBridge = kernelHistory(21, 21);
  migrate(kernelDatabase, bridgeConfig);
  migrate(kernelDatabase, bridgeConfig);
  if (historyBeforeBridge !== kernelHistory(21, 22))
    throw new Error(
      "Bridge migration changed prior audit, paid or kernel history.",
    );
  const webRights = login(
    kernelDatabase,
    "lyraseo_runtime",
    "local_runtime_only",
    `SELECT has_table_privilege(current_user,'"AuditRun"','UPDATE'), has_table_privilege(current_user,'"AuditPage"','INSERT'),has_table_privilege(current_user,'"AuditRun"','INSERT'),has_function_privilege(current_user,'lyraseo_audit.web_can_run(text)','EXECUTE');`,
  );
  const serviceRights = login(
    kernelDatabase,
    "lyraseo_dispatch",
    "local_dispatch_only",
    `SELECT has_any_column_privilege(current_user,'"AuditRun"','SELECT,INSERT,UPDATE'),has_any_column_privilege(current_user,'"AuditPage"','SELECT,INSERT,UPDATE'),has_function_privilege(current_user,'lyraseo_audit.check_step(uuid,text)','EXECUTE');`,
  );
  if (webRights !== "f|f|t|t" || serviceRights !== "f|f|t")
    throw new Error("Bridge privilege cutover failed.");
  console.log(
    "PASS: populated 21 → 22, identical audit, ledger, replay and dispatch history; restricted reconnect and precise grants.",
  );

  sql(kernelDatabase, fixture("pre-retention.sql"));
  const retentionHistory = (baseline, current) =>
    kernelHistory(baseline, current) +
    [
      "SearchSnapshot",
      "SearchImport",
      "AnalyticsImport",
      "VisibilityPanel",
      "VisibilityRun",
      "ContentDraft",
      "ContentRevision",
      "EvidenceReport",
    ]
      .map((table) => {
        const added = projection(table, baseline, current);
        return sql(
          kernelDatabase,
          `SELECT md5(jsonb_agg(to_jsonb(t)${added} ORDER BY id)::text) FROM "${table}" t`,
          true,
        );
      })
      .join("");
  const oldDigests = retentionHistory(22, 22);
  migrate(kernelDatabase, retentionConfig);
  if (oldDigests !== retentionHistory(22, 23))
    throw new Error(
      "P1 changed original typed historical evidence, report bytes or financial/dispatch history",
    );
  const clocks = sql(
    kernelDatabase,
    `SELECT string_agg("pageId"||'='||"clockStatus",',' ORDER BY "pageId") FROM "AuditPageRetention";
    SELECT "rawExpiresAt" FROM "AuditPageRetention" WHERE "pageId"='clock-known';
    SELECT ("evidenceFormat" IS NULL) FROM "EvidenceReport" WHERE id='old-report';
    SELECT count(*) FROM "ContentRevisionPin";
    SELECT "resultExpiresAt" FROM "AnalyticsImport" WHERE id='old-ga4';`,
    true,
  ).trim();
  if (
    clocks !==
    "clock-future=unknown,clock-invalid=unknown,clock-known=known,clock-offset=unknown,immutable-page=unknown\n2024-11-30 12:13:14.456\nt\n0\n2025-11-30 12:13:14.456"
  )
    throw new Error("Unexpected P1 historical clock metadata: " + clocks);
  const rights = sql(
    kernelDatabase,
    `SELECT has_table_privilege('lyraseo_runtime','"AuditPageRetention"','INSERT,UPDATE,DELETE'),
    has_table_privilege('lyraseo_dispatch','"ContentRevisionPin"','SELECT,INSERT,UPDATE,DELETE'),
    has_table_privilege('lyraseo_identity','"AuditPageRetention"','SELECT'),
    has_function_privilege('lyraseo_runtime','lyraseo_audit.insert_capture_clock()','EXECUTE'),
    has_table_privilege('lyraseo_runtime','"AuditPageRetention"','SELECT');`,
    true,
  ).trim();
  if (rights !== "f|f|f|f|t")
    throw new Error("Unexpected P1 role privileges " + rights);
  console.log(
    "PASS: populated 22 → 23, typed original evidence and bytes identical, active controlled job intact, unknown receipts closed, no legacy pins, narrow grants.",
  );
  const clockRows = () =>
    sql(
      kernelDatabase,
      'SELECT jsonb_agg(to_jsonb(t) ORDER BY "pageId") FROM "AuditPageRetention" t',
      true,
    );
  // Exercise an extension already installed outside public. Its identity/schema must survive.
  sql(
    kernelDatabase,
    "CREATE SCHEMA private_crypto_fixture; CREATE EXTENSION pgcrypto WITH SCHEMA private_crypto_fixture",
  );
  const cryptoIdentity = () =>
    sql(
      kernelDatabase,
      "SELECT e.oid||'/'||n.nspname||'/'||e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'",
      true,
    );
  const originalCrypto = cryptoIdentity();
  const before24 = retentionHistory(23, 23) + clockRows();
  migrate(kernelDatabase, auditArtifactConfig);
  if (cryptoIdentity() !== originalCrypto)
    throw Error("Existing pgcrypto installation changed");
  if (before24 !== retentionHistory(23, 24) + clockRows())
    throw Error(
      "Artifact migration changed historical measurements or capture clocks",
    );
  const privateGrants = sql(
    kernelDatabase,
    `SELECT count(*) FROM "AuditRun" WHERE "storageFormat" IS NOT NULL;
    SELECT count(*) FROM "ArtifactBlob"; SELECT count(*) FROM "ArtifactRef"; SELECT count(*) FROM "AuditEvaluationScratch";
    SELECT count(*) FROM lyraseo_audit.artifact_verifier; SELECT count(*) FROM lyraseo_audit.unavailable_observation;
    SELECT bool_or(has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE')) FROM unnest(ARRAY['lyraseo_runtime','lyraseo_dispatch','lyraseo_identity']) r CROSS JOIN unnest(ARRAY['"ArtifactBlob"','"ArtifactRef"','"AuditEvaluationScratch"','lyraseo_audit.artifact_verifier','lyraseo_audit.unavailable_observation']) t;`,
    true,
  ).trim();
  if (privateGrants !== "0\n0\n0\n0\n0\n0\nf")
    throw Error(
      "Unexpected artifacts, enabled legacy runs, or privileges: " +
        privateGrants,
    );
  console.log(
    "PASS: populated 23 → 24, identical historical measurements, clocks and financial/dispatch history; no artifact backfill or role table access.",
  );
  // Admin-created historical metadata fixture, not provider capture or physical-object proof.
  sql(
    kernelDatabase,
    `
    INSERT INTO "AuditPage"(id,"auditId","workspaceId","requestedUrl",evidence,provenance)
    VALUES ('00000000-0000-4000-8000-000000000025','active-controlled','controlled-workspace','https://example.com/artifact-history','{}','{"acquiredAt":"2024-10-31T12:13:14.456Z"}');
    INSERT INTO "ArtifactBlob"(id,"workspaceId","siteId","auditId","requestedUrl","pageId",fence,"capturedAt","expiresAt","factHash","sourceHash","sourceLength","storedHash","storedLength",state)
    VALUES('00000000-0000-4000-8000-000000000026','controlled-workspace','controlled-site','active-controlled','https://example.com/artifact-history','00000000-0000-4000-8000-000000000025',1,'2024-10-31 12:13:14.456','2024-11-30 12:13:14.456',repeat('a',64),repeat('b',64),1,repeat('b',64),1,'READY');
    INSERT INTO "ArtifactRef"("workspaceId","siteId","auditId","pageId",anchors,"slotPageId","blobId",generation,"capturedAt","expiresAt")
    SELECT "workspaceId","siteId","auditId","pageId"::text,'[]',"pageId",id,generation,"capturedAt","expiresAt" FROM "ArtifactBlob";
  `,
  );
  const auditArtifactHistory = (baseline, current) =>
    retentionHistory(baseline, current) +
    clockRows() +
    sql(
      kernelDatabase,
      `
    SELECT jsonb_agg(to_jsonb(b)${projection("ArtifactBlob", baseline, current)} ORDER BY id) FROM "ArtifactBlob" b;
    SELECT jsonb_agg(to_jsonb(f)${projection("ArtifactRef", baseline, current)} ORDER BY id) FROM "ArtifactRef" f;
  `,
      true,
    );
  const before25 = auditArtifactHistory(24, 24);
  migrate(kernelDatabase, observationArtifactConfig);
  if (before25 !== auditArtifactHistory(24, 25))
    throw Error(
      "Observation migration changed historical audit artifacts, measurements, clocks or financial history",
    );
  const observationGrants = sql(
    kernelDatabase,
    `
    SELECT count(*) FROM "VisibilityRecording"; SELECT count(*) FROM "VisibilityObservationSlot";
    SELECT count(*) FROM "VisibilityRun" WHERE "storageFormat" IS NOT NULL;
    SELECT bool_or((has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE') OR has_table_privilege(r,t,'DELETE'))) FROM unnest(ARRAY['lyraseo_runtime','lyraseo_dispatch','lyraseo_identity']) r CROSS JOIN unnest(ARRAY['"VisibilityRecording"','"VisibilityObservationSlot"']) t;
  `,
    true,
  ).trim();
  if (observationGrants !== "0\n0\n0\nf")
    throw Error(
      "Observation migration backfilled private data or widened grants: " +
        observationGrants,
    );
  console.log(
    "PASS: populated 24 → 25 preserves audit artifact/ref tuples, legacy answers, measurements, P1 clocks and financial history; private observation rows start empty, with no direct product-login grants.",
  );
  const originHistory = (baseline, current) =>
    auditArtifactHistory(baseline, current) +
    sql(
      kernelDatabase,
      `
    SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "VisibilityRecording" t;
    SELECT jsonb_agg(to_jsonb(t) ORDER BY "promptId") FROM "VisibilityObservationSlot" t;
    SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM "AuditEvaluationScratch" t;
    SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "PageIdentity" t;
    SELECT jsonb_agg(to_jsonb(t)${projection("PageJournal", baseline, current)} ORDER BY id) FROM "PageJournal" t;
  `,
      true,
    );
  const before26 = originHistory(25, 25);
  migrate(kernelDatabase, originConfig);
  if (before26 !== originHistory(25, 26))
    throw Error(
      "Origin migration changed historical rows, clocks, measurement or financial history",
    );
  const originState = sql(
    kernelDatabase,
    `
    SELECT count(*) FROM lyraseo_origin.store_registration;
    SELECT count(*) FROM lyraseo_origin.source_store_key;
    SELECT count(*) FROM lyraseo_origin.store_namespace;
    SELECT count(*) FROM lyraseo_origin.blob_store_binding;
    SELECT bool_or(has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE') OR has_table_privilege(r,t,'DELETE'))
    FROM unnest(ARRAY['lyraseo_runtime','lyraseo_dispatch','lyraseo_identity','anon','authenticated']) r
    CROSS JOIN unnest(ARRAY['lyraseo_origin.store_registration','lyraseo_origin.source_store_key','lyraseo_origin.store_namespace','lyraseo_origin.blob_store_binding']) t;
    SELECT bool_or(lyraseo_audit.version_descriptor(b) ? 'origin') FROM "ArtifactBlob" b;
  `,
    true,
  ).trim();
  if (originState !== "0\n0\n0\n0\nf\nf")
    throw Error(
      "Origin migration adopted legacy generations or widened runtime grants: " +
        originState,
    );
  console.log(
    "PASS: populated 25 -> 26 preserves all prior histories and clocks, performs no origin enrollment/backfill, and denies product roles registration/binding access.",
  );
  // Admin-authored synthetic 26 origin metadata is replay evidence only. No
  // physical root is enrolled and no expiry claim is made for this fixture.
  sql(
    kernelDatabase,
    `
    INSERT INTO lyraseo_origin.store_registration(id,root_identity,assertion_version,backend,qualification,provenance_digest)
    VALUES('00000000-0000-4000-8000-000000000027',
      '{"identity":["1","2"],"stamp":["3","4"],"instance":"synthetic-replay-only"}',
      'STORE_ORIGIN_V1','POSIX_FD_V1','LOCAL_TEST_ONLY',repeat('a',64));
    INSERT INTO lyraseo_origin.source_store_key(key_id,store_id,provenance_digest)
    VALUES('00000000-0000-4000-8000-000000000028','00000000-0000-4000-8000-000000000027',repeat('b',64));
    INSERT INTO lyraseo_origin.store_namespace(id,store_id,workspace_id,namespace_identity,provenance_digest)
    VALUES('00000000-0000-4000-8000-000000000029','00000000-0000-4000-8000-000000000027',
      'controlled-workspace','{"identity":["5","6"],"stamp":["7","8"]}',repeat('c',64));
    INSERT INTO lyraseo_origin.blob_store_binding(blob_id,generation,workspace_id,store_id,namespace_id,assertion_version,provenance_digest)
    SELECT id,generation,"workspaceId",'00000000-0000-4000-8000-000000000027',
      '00000000-0000-4000-8000-000000000029','STORE_ORIGIN_V1',repeat('d',64)
    FROM "ArtifactBlob" WHERE id='00000000-0000-4000-8000-000000000026';
    INSERT INTO "PageIdentity" (id,"workspaceId","siteId","originalUrl","normalizedUrl","createdBy")
    VALUES ('historic-page','migration-workspace','migration-site','https://example.com/page','https://example.com/page','migration-owner');
    INSERT INTO "PageJournal" (id,"workspaceId","siteId","pageId",revision,action,note,"userId","idempotencyKey","inputHash")
    VALUES ('historic-journal','migration-workspace','migration-site','historic-page',2,'change','retained historical note','migration-owner','historic-change','fixture');
  `,
  );
  const originMetadata = () =>
    sql(
      kernelDatabase,
      `SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM lyraseo_origin.store_registration t;
       SELECT jsonb_agg(to_jsonb(t) ORDER BY key_id) FROM lyraseo_origin.source_store_key t;
       SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM lyraseo_origin.store_namespace t;
       SELECT jsonb_agg(to_jsonb(t) ORDER BY blob_id) FROM lyraseo_origin.blob_store_binding t;
       SELECT lyraseo_audit.version_descriptor(b) FROM "ArtifactBlob" b WHERE id='00000000-0000-4000-8000-000000000026';`,
      true,
    );
  const before27 = originHistory(26, 26) + originMetadata();
  const schemaBefore27 = historySchema(kernelDatabase);
  migrate(kernelDatabase, expiryConfig);
  const after27 = originHistory(26, 27) + originMetadata();
  if (before27 !== after27)
    throw Error(
      "Expiry migration changed accepted source, origin, authored, measurement or financial history",
    );
  if (schemaBefore27 !== historySchema(kernelDatabase))
    throw Error("Expiry migration changed historical column metadata.");
  const expiryState = () =>
    sql(
      kernelDatabase,
      `SELECT count(*) FROM "ArtifactExpiryPlan";
     SELECT count(*) FROM "ArtifactExpiryItem";
     SELECT count(*) FROM "ArtifactExpiryEvent";
     SELECT count(*) FROM lyraseo_expiry.environment;
     SELECT count(*) FROM lyraseo_expiry.absence_verifier;
     SELECT has_table_privilege('lyraseo_artifact_maintenance','"ArtifactExpiryPlan"','SELECT,INSERT,UPDATE,DELETE');
     SELECT has_function_privilege('lyraseo_artifact_maintenance','lyraseo_expiry.claim(jsonb,uuid,uuid,text)','EXECUTE');
     SELECT has_function_privilege('lyraseo_artifact_maintenance','lyraseo_expiry.record_pending(uuid,uuid,text)','EXECUTE');
     SELECT to_regprocedure('lyraseo_expiry.record_pending(uuid,text)') IS NULL;`,
      true,
    ).trim();
  const expiryAt27 = expiryState();
  if (expiryAt27 !== "0\n0\n0\n0\n0\nf\nt\nt\nt")
    throw Error(
      "Expiry migration enrolled data, widened login grants or lost bounded function access: " +
        expiryAt27,
    );
  console.log(
    "PASS: populated accepted 26 -> 27 preserves source/origin/measurement/finance/dispatch bytes; no backfill, no enrollment, bounded maintenance function only.",
  );
  // Compare the populated 27 baseline with the assembled head separately:
  // later additive columns must receive their exact legacy defaults, while
  // every older field and any unexpected new field remain part of the snapshot.
  const beforeHead = originHistory(27, 27) + originMetadata();
  const schemaBeforeHead = historySchema(kernelDatabase);
  migrate(kernelDatabase);
  assertAdditiveDefaults(kernelDatabase);
  const expiryAtHead = expiryState();
  if (expiryAtHead !== "0\n0\n0\n0\n0\nf\nt\nt\nt")
    throw Error(
      "Later migrations changed expiry security or enrollment: " + expiryAtHead,
    );
  if (beforeHead !== originHistory(27, 99) + originMetadata())
    throw new Error("Later migrations changed accepted historical data.");
  if (schemaBeforeHead !== historySchema(kernelDatabase, true))
    throw new Error("Later migrations changed historical column metadata.");
  console.log(
    "PASS: populated 27 -> head preserves historical values and applies exact workspace/ledger/journal defaults.",
  );
  for (const scenario of ["empty", "seven", "twenty"]) {
    const database = `lyraseo_expiry_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    run("docker", ["exec", container, "createdb", "-U", "postgres", database]);
    databases.push(database);
    let history;
    if (scenario !== "empty") {
      migrate(database, scenario === "seven" ? oldConfig : currentConfig);
      sql(database, fixture("dispatch-paid.sql"));
      if (scenario === "twenty") sql(database, fixture("dispatch-audits.sql"));
      history = snapshot(
        database,
        scenario === "twenty",
        scenario === "seven" ? 7 : 20,
        scenario === "seven" ? 7 : 20,
      );
      // Emulate a stopped old publisher, after it has read a pending row in a
      // separate restricted connection. Drop all buffered refs at the barrier.
      const old = login(
        database,
        "lyraseo_runtime",
        "local_runtime_only",
        `BEGIN; SET LOCAL app.actor_id='migration-owner'; SELECT id FROM "OutboxEvent" WHERE "deliveredAt" IS NULL ORDER BY id LIMIT 1; COMMIT;`,
      );
      if (old !== "archive-absent")
        throw new Error("Legacy authority rehearsal failed.");
    }
    migrate(database);
    assertAdditiveDefaults(database);
    const applied = Number(
      sql(
        database,
        'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;',
        true,
      ).trim(),
    );
    if (applied !== migrations.length)
      throw new Error("Migration count does not match source.");
    if (history !== undefined) {
      if (
        history !==
        snapshot(
          database,
          scenario === "twenty",
          scenario === "seven" ? 7 : 20,
          99,
        )
      )
        throw new Error(
          "Historical identity, audit, receipt, ledger or outbox state changed.",
        );
      const matrix = sql(
        database,
        `SELECT "operationId",eligibility,profile,disposition,"archiveId" FROM "WorkDispatch" ORDER BY "operationId";`,
        true,
      )
        .trim()
        .split("\n");
      const expected = [
        "absent|QUARANTINED|ABSENT_INPUT",
        "accepted|RECONCILIATION_ONLY|JSON_NULL",
        "active|QUARANTINED|UNQUALIFIED_INPUT",
        "ambiguous|RECONCILIATION_ONLY|ABSENT_INPUT",
        "intent|RECONCILIATION_ONLY|ABSENT_INPUT",
        "json-null|QUARANTINED|JSON_NULL",
      ].map((entry) => entry + "|INERT|archive-" + entry.split("|")[0]);
      if (JSON.stringify(matrix) !== JSON.stringify(expected))
        throw new Error(
          "Incorrect quarantine or reconciliation classification.",
        );
      // This terminal receipt's legacy Operation has neither archive nor
      // dispatch. Reject a cascading identifier rewrite via the receipt itself.
      sql(
        database,
        `DO $$ BEGIN
        BEGIN
          UPDATE "Operation" SET id='receipt-cascade' WHERE id='terminal';
          RAISE EXCEPTION 'cascade was accepted';
        EXCEPTION WHEN raise_exception THEN
          IF SQLERRM<>'IMMUTABLE_HISTORY' THEN RAISE; END IF;
        END;
      END $$;`,
      );
      const privileges = login(
        database,
        "lyraseo_runtime",
        "local_runtime_only",
        `SELECT has_table_privilege(current_user,'"OutboxEvent"','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'"UsageReceipt"','UPDATE,DELETE,TRUNCATE');`,
      );
      if (privileges !== "f")
        throw new Error(
          "Old publisher or receipt mutation privileges survived.",
        );
    }
    const command = (path) =>
      login(
        database,
        "lyraseo_dispatch",
        "local_dispatch_only",
        `SELECT lyraseo_kernel.command(gen_random_uuid(),'lyraseo-kernel-a','/api/internal/runtime/${path}','{"limit":20}',statement_timestamp(),statement_timestamp()+interval '60 seconds');`,
      );
    const claimed = JSON.parse(command("dispatch"));
    if (claimed.disposition !== "PAUSED" || claimed.refs.length !== 0)
      throw new Error("Upgraded database was not closed.");
    login(
      database,
      "lyraseo_operator",
      "local_operator_only",
      `SELECT lyraseo_kernel.change_policy('global',0,true); SELECT lyraseo_kernel.change_policy('audits',0,true);`,
    );
    if (JSON.parse(command("dispatch")).disposition !== "PAUSED")
      throw new Error("Policy alone enabled an unmarked database.");
    if (scenario !== "empty") {
      if (
        JSON.parse(command("recover")).reconciliation !== 3 ||
        JSON.parse(command("recover")).reconciliation !== 0
      )
        throw new Error(
          "Ledger-only handoff did not progress while persisting all balances.",
        );
      assertAdditiveDefaults(database);
      if (
        history !==
        snapshot(
          database,
          scenario === "twenty",
          scenario === "seven" ? 7 : 20,
          99,
        )
      )
        throw new Error("Ledger-only recovery changed financial facts.");
    }
    if (scenario === "twenty") {
      run(
        "docker",
        [
          "exec",
          "-i",
          "--user",
          "postgres",
          container,
          "sh",
          "-s",
          "--",
          database,
        ],
        {
          input: fixture("dispatch-restore.sh"),
          stdio: ["pipe", "inherit", "inherit"],
        },
      );
      sql(database, fixture("dispatch-recovery-load.sql"));
      for (const phase of ["due", "drained"]) {
        const raw = sql(database, fixture("dispatch-recovery-plan.sql"), true);
        const [{ Plan: plan }] = JSON.parse(
          raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1),
        );
        const nodes = [];
        function visit(node) {
          nodes.push(node);
          for (const child of node.Plans ?? []) visit(child);
        }
        visit(plan);
        const indexes = nodes
          .filter((n) => n["Index Name"])
          .map((n) => n["Index Name"]);
        if (
          nodes.some(
            (n) =>
              n["Node Type"] === "Seq Scan" &&
              n["Relation Name"] === "WorkDispatch",
          ) ||
          plan["Actual Rows"] !== (phase === "due" ? 4 : 0) ||
          indexes.length !== 4 ||
          plan["Shared Hit Blocks"] + plan["Shared Read Blocks"] >= 128
        )
          throw new Error("Recovery did not use bounded indexed lanes: " + raw);
        console.log(`PASS: ${phase} recovery plan, ${plan["Actual Rows"]} candidates,
          ${plan["Shared Hit Blocks"]} buffer hits + ${plan["Shared Read Blocks"]} reads, indexes ${indexes.join(", ")}.`);
        if (phase === "due") {
          const result = JSON.parse(command("recover"));
          if (
            result.reconciliation !== 1 ||
            result.suppressed !== 1 ||
            result.reopened !== 2
          )
            throw new Error(
              "Expected bounded ledger, expiry and stale delivery transitions.",
            );
        }
      }
    }
    // A freshly connected new binary sees already-applied migration, one authority.
    migrate(database);
    console.log(
      `PASS: ${scenario} → ${applied} migrations, restricted restart, closed dispatch${history !== undefined ? ", exact historical snapshot and 6 inert classifications retained" : ""}.`,
    );
  }
} finally {
  for (const database of databases)
    run("docker", ["exec", container, "dropdb", "-U", "postgres", database]);
  rmSync(scratch, { recursive: true, force: true });
}
