import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
function snapshot(database, withAudit) {
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
      .map((table) =>
        sql(
          database,
          `SELECT coalesce(jsonb_agg(to_jsonb(t)-'resultExpiresAt'-'storageFormat' ORDER BY (to_jsonb(t)-'resultExpiresAt'-'storageFormat')::text),'[]') FROM "${table}" t;`,
          true,
        ),
      )
      .join("\n") +
    sql(
      database,
      'SELECT id, "requestInput" IS NULL FROM "Operation" ORDER BY id;',
      true,
    )
  );
}
const fixture = (name) =>
  readFileSync(join(root, "tests/fixtures/migrations", name), "utf8");
try {
  // Upgrade a populated, already closed 016 installation, including its
  // existing replay and paid dispatch history and legacy browser grants.
  const kernelDatabase =
    "lyraseo_replay_kernel_" + randomUUID().replaceAll("-", "");
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
  const kernelHistory = () =>
    snapshot(kernelDatabase, true) +
    ["WorkDispatch", "InternalRequest", "RuntimePolicy"]
      .map((table) =>
        sql(
          kernelDatabase,
          `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM "${table}" t`,
          true,
        ),
      )
      .join("\n");
  const historyBeforeBridge = kernelHistory();
  migrate(kernelDatabase, bridgeConfig);
  migrate(kernelDatabase, bridgeConfig);
  if (historyBeforeBridge !== kernelHistory())
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
  const retentionHistory = () =>
    kernelHistory() +
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
      .map((table) =>
        sql(
          kernelDatabase,
          `SELECT md5(jsonb_agg(to_jsonb(t)-'evidenceFormat'-'resultExpiresAt'-'storageFormat' ORDER BY id)::text) FROM "${table}" t`,
          true,
        ),
      )
      .join("");
  const oldDigests = retentionHistory();
  migrate(kernelDatabase, retentionConfig);
  if (oldDigests !== retentionHistory())
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
  const before24 = retentionHistory() + clockRows();
  migrate(kernelDatabase, auditArtifactConfig);
  if (cryptoIdentity() !== originalCrypto)
    throw Error("Existing pgcrypto installation changed");
  if (before24 !== retentionHistory() + clockRows())
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
  const auditArtifactHistory = () =>
    retentionHistory() +
    clockRows() +
    sql(
      kernelDatabase,
      `
    SELECT jsonb_agg(to_jsonb(b)-ARRAY['ownerKind','recordingId','runId','panelId','promptId'] ORDER BY id) FROM "ArtifactBlob" b;
    SELECT jsonb_agg(to_jsonb(f)-ARRAY['recordingId','runId','panelId','promptId'] ORDER BY id) FROM "ArtifactRef" f;
  `,
      true,
    );
  const before25 = auditArtifactHistory();
  migrate(kernelDatabase);
  if (before25 !== auditArtifactHistory())
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
  for (const scenario of ["empty", "seven", "twenty"]) {
    const database = `lyraseo_replay_${scenario}_${randomUUID().replaceAll("-", "")}`;
    run("docker", ["exec", container, "createdb", "-U", "postgres", database]);
    databases.push(database);
    let history;
    if (scenario !== "empty") {
      migrate(database, scenario === "seven" ? oldConfig : currentConfig);
      sql(database, fixture("dispatch-paid.sql"));
      if (scenario === "twenty") sql(database, fixture("dispatch-audits.sql"));
      history = snapshot(database, scenario === "twenty");
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
      if (history !== snapshot(database, scenario === "twenty"))
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
      if (history !== snapshot(database, scenario === "twenty"))
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
