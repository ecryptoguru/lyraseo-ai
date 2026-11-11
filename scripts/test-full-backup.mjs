import { register } from "node:module";
register(new URL("./privacy-ts-loader.mjs", import.meta.url), import.meta.url);
const {
  createLocalBackupLab,
  catalog,
  createFullBackup,
  verifyFullBackup,
  restoreFullBackup,
} = await import("./lib/full-backup.mjs");
const { createDatabase } = await import("../packages/db/src/index.ts");
const { openRecoveryJournal } =
  await import("../packages/db/src/recovery-journal.ts");
const { previewSiteDeletion, acceptSiteDeletion } =
  await import("../packages/db/src/site-deletion.ts");
const { reviewSiteContext, emptySiteContext } =
  await import("../packages/db/src/sites.ts");
const {
  createContentDraft,
  captureEvidenceReport,
  storeEvidenceReport,
  readContentDrafts,
  readEvidenceReports,
} = await import("../packages/db/src/content.ts");
const { readAuditRun } = await import("../packages/db/src/audits.ts");
const { listSites } = await import("../packages/db/src/tenants.ts");
const { evaluateAudit } = await import("../packages/visibility/src/index.ts");
const { renderEvidenceReport } =
  await import("../apps/lyraseo-web/src/server/editorial/reports.ts");
const { stagePrivilegedSyntheticDeletion } =
  await import("../tests/helpers/recovery-operator.ts");
const { randomBytes, randomUUID, createHash } = await import("node:crypto");
const { readFile, writeFile, unlink, readdir } =
  await import("node:fs/promises");
const { resolve, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const assert = (await import("node:assert/strict")).default;
const { isDeepStrictEqual } = await import("node:util");
const root = resolve(fileURLToPath(new URL("..", import.meta.url))),
  profilePath = join(root, "tests/fixtures/backup/current-39-catalog.json");
if (
  process.argv.length > 3 ||
  (process.argv[2] && process.argv[2] !== "--emit-catalog")
)
  throw Error("INVALID_FULL_BACKUP_TEST_OPTION");
const quarantine = {
    attempts: 0,
    denied: 0,
    connected: 0,
    competingAttempts: 0,
    stages: [],
  },
  monitors = [];
let lab;
async function runtimeProbe(handle, stage) {
  quarantine.attempts++;
  if (stage === "COMPETING_RESTORE") quarantine.competingAttempts++;
  let client;
  try {
    client = await lab.connect(handle, "lyraseo_runtime");
  } catch (error) {
    if (!["42501", "55000"].includes(error.code)) throw error;
    quarantine.denied++;
    return;
  }
  quarantine.connected++;
  await lab.close(client);
  throw Error("RUNTIME_QUARANTINE_BREACH_" + stage);
}
lab = await createLocalBackupLab({
  onDatabaseStage: async ({ handle, stage, purpose }) => {
    const state = await lab.inspectQuarantine(handle);
    await runtimeProbe(handle, stage);
    if (stage !== "DATABASE_CREATED") assert.equal(state.runtimeConnect, false);
    assert.equal(state.nonAdminSessions, 0);
    assert.equal(
      state.allowConnections,
      !["DATABASE_CREATED", "DATABASE_ACL_CONFIGURED"].includes(stage),
    );
    quarantine.stages.push({
      stage,
      purpose,
      competingAttempts: quarantine.competingAttempts,
      ...state,
    });
    if (purpose === "RESTORE" && stage === "DATABASE_CREATED") {
      const monitor = { active: true, error: null, promise: null };
      monitors.push(monitor);
      monitor.promise = (async () => {
        while (monitor.active) {
          await runtimeProbe(handle, "COMPETING_RESTORE");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })().catch((error) => {
        monitor.error = error;
        monitor.active = false;
      });
    }
    for (const monitor of monitors) if (monitor.error) throw monitor.error;
    if (purpose === "RESTORE" && stage === "RESTORE_REPLAYED") {
      for (const monitor of monitors) monitor.active = false;
      await Promise.all(monitors.map((monitor) => monitor.promise));
      for (const monitor of monitors) if (monitor.error) throw monitor.error;
    }
  },
});
const prisma = [];
let phase = "create-source";
const start = Date.now(),
  receipt = {
    qualification: "LOCAL_SYNTHETIC_ONLY",
    deletionAdmission: "UNQUALIFIED_DISABLED",
    replaySetup: "PRIVILEGED_SYNTHETIC_FIXTURE_ONLY",
    checks: [],
  };
function done(value) {
  receipt.checks.push(value);
  process.stdout.write(JSON.stringify({ passed: value }) + "\n");
}
try {
  // Negative control on an empty lab-owned database: revoking CONNECT does not
  // evict an already authenticated session. No product schema/data is present.
  phase = "negative-control-existing-session";
  const control = await lab.create(),
    controlAdmin = await lab.connect(control);
  await controlAdmin.query(
    `GRANT CONNECT ON DATABASE "${control.name}" TO PUBLIC`,
  );
  const preexisting = await lab.connect(control, "lyraseo_runtime");
  await controlAdmin.query(
    `REVOKE CONNECT ON DATABASE "${control.name}" FROM PUBLIC`,
  );
  await assert.rejects(lab.connect(control, "lyraseo_runtime"));
  assert.equal(
    (await preexisting.query("SELECT 1::integer still_connected")).rows[0]
      .still_connected,
    1,
  );
  await lab.close(preexisting);
  await lab.close(controlAdmin);
  await lab.drop(control);
  done(
    "negative control confirms CONNECT revocation alone does not evict an existing restricted session",
  );
  phase = "create-source";
  const source = await lab.create();
  phase = "install-source";
  await lab.install(source);
  const adminPg = await lab.connect(source),
    profile = await catalog(adminPg);
  await lab.close(adminPg);
  if (process.argv[2] === "--emit-catalog") {
    await writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n", {
      flag: "wx",
      mode: 0o644,
    });
    done("emitted fresh known39 catalog metadata; no fixture data exported");
  } else {
    const registered = JSON.parse(await readFile(profilePath, "utf8"));
    for (const key of Object.keys(profile)) {
      if (!isDeepStrictEqual(profile[key], registered[key])) {
        receipt.catalogMismatch = {
          section: key,
          actualCount: profile[key].length,
          expectedCount: registered[key]?.length ?? null,
          firstDifferingIndex: profile[key].findIndex(
            (entry, index) =>
              !isDeepStrictEqual(entry, registered[key]?.[index]),
          ),
        };
        throw new Error("FULL_BACKUP_REGISTERED_CATALOG_MISMATCH");
      }
    }
    assert.deepEqual(profile, registered);
    const admin = createDatabase(lab.url(source)),
      db = createDatabase(lab.url(source, "lyraseo_runtime"));
    prisma.push(admin, db);
    phase = "seed-real-producers";
    const now = new Date(),
      actor = {
        userId: "backup-founder",
        sessionId: "synthetic-session",
        securityVersion: 0,
        authenticatedAt: now.toISOString(),
        mfaVerified: true,
        mfaAuthenticatedAt: now.toISOString(),
        authProvider: "supabase",
      };
    const clientActor = {
        ...actor,
        userId: "backup-client",
        sessionId: "synthetic-client-session",
      },
      otherActor = {
        ...actor,
        userId: "backup-other",
        sessionId: "synthetic-other-session",
      };
    phase = "seed-users";
    await admin.productUser.createMany({
      data: [
        { id: actor.userId },
        { id: clientActor.userId },
        { id: otherActor.userId },
      ],
    });
    phase = "seed-workspaces";
    await admin.workspace.createMany({
      data: [
        { id: "backup-alpha", name: "Synthetic Alpha" },
        { id: "backup-beta", name: "Synthetic Beta" },
      ],
    });
    phase = "seed-memberships";
    await admin.membership.createMany({
      data: [
        { workspaceId: "backup-alpha", userId: actor.userId, role: "OWNER" },
        {
          workspaceId: "backup-alpha",
          userId: clientActor.userId,
          role: "VIEWER",
        },
        {
          workspaceId: "backup-beta",
          userId: otherActor.userId,
          role: "OWNER",
        },
      ],
    });
    const scopes = [
      {
        workspaceId: "backup-alpha",
        siteId: "backup-active",
        origin: "https://backup-active.example",
      },
      {
        workspaceId: "backup-alpha",
        siteId: "backup-delete",
        origin: "https://backup-delete.example",
      },
      {
        workspaceId: "backup-beta",
        siteId: "backup-foreign",
        origin: "https://backup-foreign.example",
      },
    ];
    phase = "seed-sites-enrollment";
    for (const scope of scopes) {
      await admin.site.create({
        data: {
          id: scope.siteId,
          workspaceId: scope.workspaceId,
          origin: scope.origin,
          verifiedAt: now,
        },
      });
      await admin.$executeRaw`INSERT INTO lyraseo_history.environment(workspace_id,site_id,database_oid,postmaster_started_at,policy_version,enabled) SELECT ${scope.workspaceId},${scope.siteId},oid,pg_postmaster_start_time(),'HISTORY_EXPIRY_LOCAL_V1',true FROM pg_database WHERE datname=current_database()`;
    }
    phase = "seed-site-grant";
    await admin.siteGrant.create({
      data: {
        workspaceId: "backup-alpha",
        siteId: "backup-active",
        userId: clientActor.userId,
      },
    });
    const rawMarker = "FULL_SOURCE_ONLY_MUST_NOT_SURVIVE",
      secretMarker = "CREDENTIAL_ONLY_MUST_NOT_SURVIVE",
      authored = "Founder authored original exact bytes å😀";
    const saved = [];
    for (const [index, scope] of scopes.entries()) {
      const current = index === 2 ? otherActor : actor,
        url = scope.origin + "/";
      phase = "seed-context-" + index;
      await reviewSiteContext(db, current, scope, 0, {
        ...emptySiteContext(),
        brandName: "Synthetic restore fixture",
        audience: "Controlled test",
        conversionGoal: "Test saved work",
        keyPages: [url],
      });
      const page = {
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        contentType: "text/html",
        acquired: true,
        headComplete: false,
        bodyComplete: false,
        titleElements: ["Fixture"],
        h1Texts: [],
        headingLevels: [],
        headingTexts: [],
        linkNames: [],
        jsonLd: [],
        jsonLdComplete: false,
      };
      const evaluation = evaluateAudit({
        siteOrigin: scope.origin,
        brandName: "Synthetic restore fixture",
        manifest: [url],
        pages: [page],
        profile: "LOCAL_RAW_V1",
        methodologyVersion: "readiness-v2",
      });
      const auditId = "backup-audit-" + index;
      phase = "seed-audit-" + index;
      await admin.auditRun.create({
        data: {
          id: auditId,
          workspaceId: scope.workspaceId,
          siteId: scope.siteId,
          userId: current.userId,
          securityVersion: 0,
          idempotencyKey: auditId,
          inputHash: "synthetic",
          manifest: [url],
          profile: "LOCAL_RAW_V1",
          declarations: {},
          methodologyVersion: "readiness-v2",
          status: "COMPLETED",
          completedAt: now,
          evaluation: JSON.parse(JSON.stringify(evaluation)),
        },
      });
      phase = "seed-page-" + index;
      await admin.auditPage.create({
        data: {
          id: "backup-page-" + index,
          workspaceId: scope.workspaceId,
          auditId,
          requestedUrl: url,
          evidence: { ...page, legacyRawCopy: rawMarker },
          provenance: {
            channel: "raw-http",
            acquiredAt: now.toISOString(),
            rawHtml: "<html>" + rawMarker + "</html>",
            sha256: createHash("sha256").update(rawMarker).digest("hex"),
          },
        },
      });
      phase = "seed-draft-" + index;
      const draft = await createContentDraft(db, current, scope, {
        kind: "draft",
        title: "Authored fixture",
        body: authored,
        assumptions: [],
        citations: [],
        auditIds: [auditId],
        searchSnapshotIds: [],
      });
      phase = "seed-report-capture-" + index;
      const snapshot = await captureEvidenceReport(db, current, scope, {
        auditIds: [auditId],
        searchSnapshotIds: [],
      });
      phase = "seed-report-render-" + index;
      const report = await storeEvidenceReport(db, current, scope, {
        title: "Synthetic saved final",
        snapshot,
        render: renderEvidenceReport,
      });
      const bytes = await admin.evidenceReport.findUniqueOrThrow({
        where: { id: report.id },
        select: { pdf: true, csv: true },
      });
      saved.push({
        scope,
        auditId,
        draftId: draft.id,
        reportId: report.id,
        pdfHash: createHash("sha256").update(bytes.pdf).digest("hex"),
        csvHash: createHash("sha256").update(bytes.csv).digest("hex"),
        evaluation,
      });
    }
    phase = "seed-session";
    await admin.productSession.create({
      data: {
        sessionId: secretMarker,
        userId: actor.userId,
        securityVersion: 0,
        createdAt: now,
        refreshedAt: now,
      },
    });
    phase = "seed-google";
    await admin.googleConnection.create({
      data: {
        id: "backup-google",
        workspaceId: "backup-alpha",
        siteId: "backup-active",
        encryptedRefreshToken: secretMarker,
      },
    });
    phase = "seed-hmac";
    await admin.$executeRaw`INSERT INTO lyraseo_audit.artifact_verifier(id,secret,db_oid,started) SELECT ${randomUUID()}::uuid,${Buffer.alloc(32, 19)},oid,pg_postmaster_start_time() FROM pg_database WHERE datname=current_database()`;
    const period = now.toISOString().slice(0, 7),
      settled = "backup-settled",
      uncertain = "backup-uncertain";
    phase = "seed-financial";
    for (const [id, complete] of [
      [settled, true],
      [uncertain, false],
    ])
      await admin.operation.create({
        data: {
          id,
          workspaceId: "backup-alpha",
          siteId: "backup-delete",
          userId: actor.userId,
          sessionId: actor.sessionId,
          securityVersion: 0,
          kind: "API_OBSERVATION",
          provider: "AZURE",
          period,
          route: "SYNTHETIC_BACKUP",
          idempotencyKey: id,
          inputHash: "synthetic",
          requestInput: { private: rawMarker },
          tariffVersion: "SYNTHETIC_NOT_PROVIDER_BILLING",
          reservedCost: "0.020000001",
          actualCost: complete ? "0.010000001" : null,
          status: complete ? "COMPLETED" : "RECONCILING",
          createdAt: new Date(+now - 540000),
          expiresAt: new Date(+now + 3600000),
          settledAt: complete ? now : null,
          attemptState: complete ? "ACCEPTED" : "INTENT",
          fence: 7,
          providerTaskId: complete ? "SYNTHETIC_TASK_ID" : null,
        },
      });
    await admin.usageReceipt.create({
      data: {
        id: "backup-receipt",
        operationId: settled,
        workspaceId: "backup-alpha",
        userId: actor.userId,
        provider: "AZURE",
        receiptId: "SYNTHETIC_RECEIPT_NOT_PROVIDER",
        amount: "0.010000001",
        acceptedOutput: true,
      },
    });
    await admin.budgetPeriod.createMany({
      data: [
        ...[
          { bucket: "COMBINED", limit: "10" },
          { bucket: "AZURE", limit: "8" },
        ].map((entry) => ({
          id: randomUUID(),
          userId: actor.userId,
          period,
          ...entry,
          spent: "0.010000001",
          reserved: "0.020000001",
        })),
        ...[
          { bucket: "PARALLEL", limit: "1" },
          { bucket: "DATAFORSEO", limit: "1" },
          { bucket: "API_OBSERVATION", limit: "25" },
          { bucket: "CHATGPT_OBSERVATION", limit: "100" },
          { bucket: "GEMINI_OBSERVATION", limit: "100" },
        ].map((entry) => ({
          id: randomUUID(),
          userId: actor.userId,
          period,
          ...entry,
        })),
      ],
    });
    // Populated recovery graphs, not empty table-count or live-provider claims.
    phase = "seed-populated-recovery-graphs";
    const batchCreated = new Date(+now - 600000),
      batchExpiry = new Date(+now - 480000),
      batchConfirmed = new Date(+now - 540000);
    await admin.operationQuote.create({
      data: {
        id: "backup-batch-quote",
        workspaceId: "backup-alpha",
        siteId: "backup-delete",
        userId: actor.userId,
        kind: "API_OBSERVATION",
        provider: "AZURE",
        route: "SYNTHETIC_BACKUP",
        inputHash: "synthetic",
        requestInput: { private: rawMarker },
        maximumCost: "0.020000001",
        tariffVersion: "SYNTHETIC_NOT_PROVIDER_BILLING",
        securityVersion: 0,
        createdAt: batchCreated,
        expiresAt: batchExpiry,
        consumedOperationId: settled,
      },
    });
    const batchPreview = {
      batchQuoteId: "backup-batch",
      expiresAt: batchExpiry.toISOString(),
      inputHash: "a".repeat(64),
      currency: "USD",
      budgetOwnerId: actor.userId,
      unavailable: false,
      combinedMaximum: "0.020000001",
      totalsByProvider: { AZURE: "0.020000001" },
      items: [
        {
          siteId: "backup-delete",
          ordinal: 0,
          quoteId: "backup-batch-quote",
          maximumCost: "0.020000001",
          provider: "AZURE",
          tariffVersion: "SYNTHETIC_NOT_PROVIDER_BILLING",
          status: "QUOTED",
          errorCode: null,
        },
      ],
    };
    await admin.$executeRaw`INSERT INTO "AgencyBatchQuote"(id,"workspaceId","userId","securityVersion","requestInput","inputHash","confirmationHash",preview,"createdAt","expiresAt","confirmedAt","confirmationKey") VALUES('backup-batch','backup-alpha',${actor.userId},0,'{}','synthetic','synthetic',${JSON.stringify(batchPreview)}::jsonb,${batchCreated},${batchExpiry},${batchConfirmed},'backup-batch-confirmation')`;
    await admin.$executeRaw`INSERT INTO "AgencyBatchItem"("batchQuoteId","workspaceId","userId","siteId",ordinal,"quoteId","operationId",status) VALUES('backup-batch','backup-alpha',${actor.userId},'backup-delete',0,'backup-batch-quote',${settled},'ADMITTED')`;
    const billingGraph = await lab.connect(source);
    try {
      await billingGraph.query(`INSERT INTO lyraseo_billing.merchant(provider,merchant_id) VALUES('RAZORPAY','synthetic-backup');
        INSERT INTO lyraseo_billing.account(id,workspace_id) VALUES('00000000-0000-4000-8000-000000000301','backup-alpha');
        INSERT INTO lyraseo_billing.binding(provider,merchant_id,resource_id,customer_id,account_id) VALUES('RAZORPAY','synthetic-backup','synthetic-resource','synthetic-customer','00000000-0000-4000-8000-000000000301');
        INSERT INTO lyraseo_billing.event(id,provider,merchant_id,external_id,payload_hash,key_version,event_type,resource_id,account_id,references_json,occurred_at,contract,collision)
          VALUES('00000000-0000-4000-8000-000000000302','RAZORPAY','synthetic-backup','synthetic-event',repeat('a',64),'synthetic','subscription.updated','synthetic-resource','00000000-0000-4000-8000-000000000301','{"accountVerified":true}',now(),'SYNTHETIC_BACKUP_ONLY',false);
        INSERT INTO lyraseo_billing.discovery(event_id,state) VALUES('00000000-0000-4000-8000-000000000302','PENDING');
        INSERT INTO lyraseo_billing.inbox(provider,merchant_id,resource_id,state,token,lease_until,fence) VALUES('RAZORPAY','synthetic-backup','synthetic-resource','READING',gen_random_uuid(),now()+interval '1 minute',3);`);
    } finally {
      await lab.close(billingGraph);
    }
    phase = "financial-source-invariants";
    const financialBefore =
      await admin.$queryRaw`SELECT id,"reservedCost"::text reserved,"actualCost"::text actual,status,fence,"attemptState","providerTaskId","createdAt","settledAt" FROM "Operation" ORDER BY id`;
    const auditClocksBefore =
      await admin.$queryRaw`SELECT id,"createdAt","resultExpiresAt" FROM "AuditRun" WHERE "siteId"<>'backup-delete' ORDER BY id`;
    const budgetsBefore =
      await admin.$queryRaw`SELECT id,bucket,"limit"::text "limit",spent::text spent,reserved::text reserved FROM "BudgetPeriod" ORDER BY id`;
    const journalRoot = await lab.privateDirectory("external-journal"),
      journal = await openRecoveryJournal({
        root: journalRoot,
        key: randomBytes(32),
        enabled: true,
      });
    const keyset = {
        database: randomBytes(32),
        artifacts: randomBytes(32),
        manifest: randomBytes(32),
      },
      directory = await lab.privateDirectory("points");
    phase = "create-full-encrypted-point";
    const point = await createFullBackup(lab, source, {
      directory,
      journal,
      keyset,
      profile: registered,
    });
    const verified = await verifyFullBackup(point, keyset);
    assert.equal(verified.artifacts.length, 6);
    done(
      "full sanitized logical database and separately authenticated saved PDF/CSV bundle verified",
    );
    phase = "post-backup-deletion";
    const target = scopes[1],
      preview = await previewSiteDeletion(db, actor, target);
    await assert.rejects(
      acceptSiteDeletion(
        db,
        actor,
        target,
        {
          caseId: randomUUID(),
          requestId: randomUUID(),
          confirmSiteId: target.siteId,
          confirmIncarnation: preview.incarnation,
          permanent: true,
        },
        { journal, resolveActor: async () => actor, enabled: true },
      ),
      /DELETION_ADMISSION_UNQUALIFIED/,
    );
    const deletionAccepted = await stagePrivilegedSyntheticDeletion(
      admin,
      actor,
      target,
      {
        caseId: randomUUID(),
        requestId: randomUUID(),
        confirmIncarnation: preview.incarnation,
      },
      journal,
    );
    done(
      "user deletion admission is disabled; privileged synthetic fixture stages the replay event",
    );
    const originalTombstone = await admin.site.findUniqueOrThrow({
      where: { id: target.siteId },
      select: { deletedAt: true },
    });
    const latest = await journal.watermark();
    assert.equal(latest.sequence, 2);
    await Promise.all(prisma.splice(0).map((client) => client.$disconnect()));
    await lab.drop(source);
    done(
      "original source database removed after point; independent later deletion journal remains",
    );
    phase = "restore-closed-database";
    const restored = await restoreFullBackup(lab, point, {
      keyset,
      journal,
      trustedLatest: latest,
      profile: registered,
    });
    assert.equal(restored.runtimeConnect, false);
    assert.equal(restored.operationalReopenAllowed, false);
    assert.equal(restored.rawOriginRestored, false);
    assert.equal(restored.artifactCount, 4);
    await assert.rejects(lab.connect(restored.handle, "lyraseo_runtime"));
    done(
      "new isolated restore initially denies runtime connection and recreates surviving private artifacts",
    );
    const restoredAdmin = createDatabase(lab.url(restored.handle));
    prisma.push(restoredAdmin);
    phase = "verify-populated-recovery-graphs";
    assert.deepEqual(
      await restoredAdmin.$queryRaw`SELECT "operationId",status FROM "AgencyBatchItem" WHERE "batchQuoteId"='backup-batch'`,
      [{ operationId: settled, status: "ADMITTED" }],
    );
    assert.deepEqual(
      await restoredAdmin.$queryRaw`SELECT "confirmedAt","confirmationKey" FROM "AgencyBatchQuote" WHERE id='backup-batch'`,
      [
        {
          confirmedAt: batchConfirmed,
          confirmationKey: "backup-batch-confirmation",
        },
      ],
    );
    assert.deepEqual(
      await restoredAdmin.$queryRaw`SELECT state,token,"lease_until" AS lease,"next_at"::text AS next FROM lyraseo_billing.inbox`,
      [{ state: "READING", token: null, lease: null, next: "infinity" }],
    );
    assert.deepEqual(
      await restoredAdmin.$queryRaw`SELECT state,next_at::text AS next FROM lyraseo_billing.discovery`,
      [{ state: "PENDING", next: "infinity" }],
    );
    for (const table of [
      "lyraseo_billing.event",
      "lyraseo_billing.binding",
      "lyraseo_billing.account",
      "public.AgencyBatchItem",
      "public.AgencyBatchQuote",
    ])
      assert.equal(restored.counts[table], 1, `populated graph lost: ${table}`);
    done(
      "populated billing queues and expired committed batch survive deletion replay; claims remain quarantined and FKs validate",
    );
    phase = "assert-original-financial-facts";
    assert.deepEqual(
      await restoredAdmin.$queryRaw`SELECT id,"reservedCost"::text reserved,"actualCost"::text actual,status,fence,"attemptState","providerTaskId","createdAt","settledAt" FROM "Operation" ORDER BY id`,
      financialBefore,
    );
    assert.deepEqual(
      await restoredAdmin.$queryRaw`SELECT id,bucket,"limit"::text "limit",spent::text spent,reserved::text reserved FROM "BudgetPeriod" ORDER BY id`,
      budgetsBefore,
    );
    phase = "assert-original-clocks";
    assert.deepEqual(
      await restoredAdmin.$queryRaw`SELECT id,"createdAt","resultExpiresAt" FROM "AuditRun" ORDER BY id`,
      auditClocksBefore,
    );
    phase = "assert-original-site-tombstone";
    const [tombstone] =
      await restoredAdmin.$queryRaw`SELECT "deletedAt" FROM "Site" WHERE id='backup-delete'`;
    assert.equal(
      tombstone.deletedAt.toISOString(),
      originalTombstone.deletedAt.toISOString(),
    );
    assert.equal(await restoredAdmin.productSession.count(), 0);
    assert.equal(await restoredAdmin.apiToken.count(), 0);
    assert.equal(await restoredAdmin.googleConnection.count(), 0);
    assert.equal(
      (
        await restoredAdmin.$queryRaw`SELECT count(*)::integer n FROM lyraseo_audit.artifact_verifier`
      )[0].n,
      0,
    );
    assert.equal(
      (
        await restoredAdmin.$queryRaw`SELECT count(*)::integer n FROM "RuntimePolicy" WHERE enabled`
      )[0].n,
      0,
    );
    assert.equal(
      (
        await restoredAdmin.$queryRaw`SELECT count(*)::integer n FROM "WorkDispatch" WHERE disposition<>'SUPPRESSED'`
      )[0].n,
      0,
    );
    assert.equal(
      await restoredAdmin.auditRun.count({
        where: { siteId: "backup-delete" },
      }),
      0,
    );
    assert.equal(
      await restoredAdmin.evidenceReport.count({
        where: { siteId: "backup-delete" },
      }),
      0,
    );
    assert.equal(
      await restoredAdmin.contentDraft.count({
        where: { siteId: "backup-delete" },
      }),
      0,
    );
    assert.equal(
      (
        await restoredAdmin.$queryRaw`SELECT count(*)::integer n FROM "AuditPage" WHERE provenance?'rawHtml' OR evidence?'legacyRawCopy'`
      )[0].n,
      0,
    );
    done(
      "post-backup deletion, no raw-source copies, disabled credentials/dispatch, exact original financial balances/fences/receipts",
    );
    // This is a controlled permission probe, not an operational reopen: only the
    // two named synthetic users are unsuspended and only runtime CONNECT is granted.
    const recoveryPg = await lab.connect(restored.handle);
    await recoveryPg.query(
      `GRANT CONNECT ON DATABASE "${restored.handle.name}" TO lyraseo_runtime`,
    );
    await lab.close(recoveryPg);
    await restoredAdmin.productUser.updateMany({
      where: { id: { in: [actor.userId, clientActor.userId] } },
      data: { suspended: false },
    });
    const restoredDb = createDatabase(
      lab.url(restored.handle, "lyraseo_runtime"),
    );
    prisma.push(restoredDb);
    const freshActor = { ...actor, securityVersion: 1 },
      freshClient = { ...clientActor, securityVersion: 1 };
    await assert.rejects(
      readContentDrafts(restoredDb, actor, scopes[0], saved[0].draftId),
    );
    const draft = (
      await readContentDrafts(
        restoredDb,
        freshActor,
        scopes[0],
        saved[0].draftId,
      )
    )[0];
    assert.equal(draft.history[0].content.body, authored);
    const report = await readEvidenceReports(
      restoredDb,
      freshClient,
      scopes[0],
      saved[0].reportId,
      "pdf",
    );
    assert.equal(
      createHash("sha256").update(report.pdf).digest("hex"),
      saved[0].pdfHash,
    );
    const csv = await readEvidenceReports(
      restoredDb,
      freshClient,
      scopes[0],
      saved[0].reportId,
      "csv",
    );
    assert.equal(
      createHash("sha256").update(csv.csv).digest("hex"),
      saved[0].csvHash,
    );
    await assert.rejects(
      readEvidenceReports(
        restoredDb,
        freshClient,
        scopes[0],
        saved[2].reportId,
        "pdf",
      ),
    );
    await assert.rejects(
      readContentDrafts(restoredDb, freshActor, scopes[1], saved[1].draftId),
    );
    const audit = await readAuditRun(restoredDb, freshClient, {
      ...scopes[0],
      auditId: saved[0].auditId,
    });
    assert.equal(audit.evaluation.score, saved[0].evaluation.score);
    assert.equal(audit.pages[0].sourceAvailability, "unavailable");
    assert.equal(
      (await listSites(restoredDb, freshClient, "backup-alpha")).some(
        (site) => site.id === "backup-delete",
      ),
      false,
    );
    done(
      "current-epoch authorized reads preserve authored bytes/report hashes/audit score; stale epoch, deleted scope and foreign report denied",
    );
    await restoredDb.$disconnect();
    await restoredAdmin.productUser.updateMany({ data: { suspended: true } });
    const quarantinePg = await lab.connect(restored.handle);
    await quarantinePg.query(
      `REVOKE CONNECT ON DATABASE "${restored.handle.name}" FROM lyraseo_runtime`,
    );
    const signedReceipt = JSON.parse(
      (
        await quarantinePg.query(
          "SELECT shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') value",
        )
      ).rows[0].value,
    );
    assert.equal(
      signedReceipt.receipt.deletionClocks[0].acceptedAt,
      deletionAccepted.acceptedAt,
    );
    assert.equal(
      signedReceipt.receipt.deletionClocks[0].deadline,
      deletionAccepted.deadline,
    );
    assert.equal(
      signedReceipt.receipt.deletionClocks[0].recordExpiresAt,
      deletionAccepted.recordExpiresAt,
    );
    await lab.close(quarantinePg);
    await assert.rejects(lab.connect(restored.handle, "lyraseo_runtime"));
    done(
      "original audit and deletion clocks preserved; controlled permission probe re-quarantined",
    );
    phase = "corruption-tests";
    const ciphertextPath = join(point.directory, "artifacts.enc"),
      ciphertext = await readFile(ciphertextPath);
    ciphertext[ciphertext.length - 1] ^= 1;
    await writeFile(ciphertextPath, ciphertext);
    await assert.rejects(verifyFullBackup(point, keyset));
    ciphertext[ciphertext.length - 1] ^= 1;
    await writeFile(ciphertextPath, ciphertext);
    await assert.rejects(
      restoreFullBackup(lab, point, {
        keyset,
        journal,
        trustedLatest: { ...latest, hash: "f".repeat(64) },
        profile: registered,
      }),
    );
    done(
      "corrupt artifact and untrusted latest watermark fail before a restore target is created",
    );
    await assert.rejects(
      verifyFullBackup(point, { ...keyset, database: randomBytes(32) }),
    );
    const manifestPath = join(point.directory, "manifest.json"),
      manifestBytes = await readFile(manifestPath);
    const tampered = JSON.parse(manifestBytes);
    tampered.manifest.expiresAt = "2099-01-01T00:00:00.000Z";
    await writeFile(manifestPath, JSON.stringify(tampered));
    await assert.rejects(verifyFullBackup(point, keyset));
    await writeFile(manifestPath, manifestBytes);
    const artifactBytes = await readFile(ciphertextPath);
    await unlink(ciphertextPath);
    await assert.rejects(verifyFullBackup(point, keyset));
    await writeFile(ciphertextPath, artifactBytes, { mode: 0o600 });
    done(
      "wrong key, tampered expiry manifest and missing artifact bundle fail closed",
    );
    assert.equal(quarantine.connected, 0);
    assert.ok(quarantine.competingAttempts > 0);
    assert.equal(quarantine.denied, quarantine.attempts);
    assert.ok(
      quarantine.stages.some((item) => item.stage === "RESTORE_BEFORE_REPLAY"),
    );
    assert.ok(
      quarantine.stages.some((item) => item.stage === "RESTORE_REPLAYED"),
    );
    receipt.quarantine = quarantine;
    done(
      "actual competing runtime connections denied across database creation, schema restore and journal replay",
    );
    receipt.elapsedMs = Date.now() - start;
    receipt.restoredCounts = restored.counts;
    receipt.rawOriginRestored = false;
    receipt.operationalReopenAllowed = false;
    receipt.sourceUnavailable = true;
    receipt.artifactCount = restored.artifactCount;
    receipt.catalogHash = point.manifest.catalogHash;
  }
} catch (error) {
  receipt.failedPhase = phase;
  receipt.error = /^[A-Z0-9_:., -]{1,200}$/.test(error.message)
    ? error.message
    : "UNEXPECTED_FULL_BACKUP_FAILURE";
  receipt.errorType = error.name;
  receipt.code = error.code;
  receipt.sqlstate = /^[A-Z0-9]{5}$/.test(error.meta?.code ?? "")
    ? error.meta.code
    : undefined;
  receipt.model = /^[A-Za-z0-9_]+$/.test(error.meta?.modelName ?? "")
    ? error.meta.modelName
    : undefined;
  receipt.errorHash = createHash("sha256")
    .update(error.stack ?? String(error))
    .digest("hex");
  if (error.receipt) receipt.commandReceipt = error.receipt;
  process.exitCode = 1;
} finally {
  for (const monitor of monitors) monitor.active = false;
  await Promise.all(monitors.map((monitor) => monitor.promise));
  receipt.quarantine = quarantine;
  await Promise.all(prisma.map((client) => client.$disconnect()));
  await lab.cleanup();
  process.stdout.write(JSON.stringify(receipt) + "\n");
}
